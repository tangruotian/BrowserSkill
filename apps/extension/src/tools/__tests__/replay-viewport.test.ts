import { describe, expect, it, vi } from "vitest";
import {
  documentWidths,
  fitReplayViewport,
  restoreReplayViewport,
  type ZoomApi,
} from "../replay-viewport";
import type { CdpRunner } from "../shared";

/** 所有 CDP 与 Chrome tabs API 都是替身；options 可变以模拟动作后同文档动态变宽。 */
function fixture(
  options: {
    content?: number;
    ineffective?: boolean;
    secondLayout?: boolean;
    fixedContainer?: boolean;
  } = {},
) {
  const owner = {};
  const page = { tabId: 1, documentEpoch: 10 };
  const state = {
    zoom: 1,
    epoch: 10,
    settings: { mode: "automatic", scope: "per-origin" } as chrome.tabs.ZoomSettings,
  };
  const controller = new AbortController();
  const zoomApi: ZoomApi = {
    getZoom: vi.fn(async () => state.zoom),
    getZoomSettings: vi.fn(async () => ({ ...state.settings })),
    setZoom: vi.fn(async (_id, zoom) => {
      state.zoom = zoom;
    }),
    setZoomSettings: vi.fn(async (_id, settings) => {
      state.settings = { ...settings };
    }),
  };
  const send = vi.fn(async (_id: number, method: string) => {
    if (method === "DOM.getDocument") return { root: { backendNodeId: state.epoch } };
    if (method === "DOM.resolveNode") return { object: { objectId: "doc" } };
    if (method === "Runtime.releaseObjectGroup") return {};
    if (method === "Runtime.callFunctionOn")
      return {
        result: {
          value: {
            viewportWidth: options.ineffective ? 960 : Math.floor(960 / state.zoom),
            contentWidth: options.fixedContainer
              ? 1280 / state.zoom
              : options.secondLayout && state.zoom < 1
                ? 1400
                : (options.content ?? 1280),
            ready: true,
          },
        },
      };
    throw new Error("Unexpected " + method);
  });
  const deps = { cdp: { send } as unknown as CdpRunner, zoomApi, signal: controller.signal };
  return { owner, page, state, controller, deps, zoomApi, send, options };
}
const fit = (f: ReturnType<typeof fixture>) =>
  fitReplayViewport(f.owner, "turn-test", f.page, f.deps);
const restore = (f: ReturnType<typeof fixture>, runId = "turn-test") =>
  restoreReplayViewport(f.owner, runId, 1, f.deps);

/** 仅伪造布局数字与样式，不读取测试机页面；模拟 DOM 中隐藏/屏外/开放 shadow root。 */
function measuredDocument(
  containers: {
    client: number;
    scroll: number;
    overflow?: string;
    visible?: boolean;
    left?: number;
    shadow?: boolean;
  }[] = [],
) {
  const elements = containers.map((c) => ({
    clientWidth: c.client,
    scrollWidth: c.scroll,
    getBoundingClientRect: () => ({
      left: c.left ?? 0,
      right: (c.left ?? 0) + c.client,
      top: 0,
      bottom: 200,
      width: c.client,
      height: 200,
    }),
    checkVisibility: () => c.visible !== false,
    style: { overflowX: c.overflow ?? "auto", visibility: "visible", opacity: "1" },
  }));
  const doc = {
    compatMode: "CSS1Compat",
    readyState: "complete",
    documentElement: { clientWidth: 960, clientHeight: 600, scrollWidth: 960 },
    body: { clientWidth: 960, scrollWidth: 960 },
    scrollingElement: { scrollWidth: 960 },
    defaultView: { getComputedStyle: (element: (typeof elements)[number]) => element.style },
    querySelectorAll: () =>
      elements.map((el, i) =>
        containers[i]?.shadow
          ? { clientWidth: 0, shadowRoot: { querySelectorAll: () => [el] } }
          : el,
      ),
  };
  return doc as unknown as Document;
}

describe("每步横向滚动检查与整轮缩放", () => {
  it("足够宽时只测一次，不等待额外采样也不调用缩放 API", async () => {
    expect(documentWidths.call(measuredDocument())).toEqual({
      viewportWidth: 960,
      contentWidth: 960,
      ready: true,
    });
    const f = fixture({ content: 960 });
    expect(await fit(f)).toMatchObject({ changed: false, fitted: true });
    expect(
      f.send.mock.calls.filter(([, method]) => method === "Runtime.callFunctionOn"),
    ).toHaveLength(1);
    expect(f.zoomApi.getZoom).not.toHaveBeenCalled();
    expect(f.zoomApi.setZoom).not.toHaveBeenCalled();
    expect(f.zoomApi.setZoomSettings).not.toHaveBeenCalled();
  });

  it("纳入可见滚动容器和 shadow root，按局部溢出比例估算", () => {
    expect(documentWidths.call(measuredDocument([{ client: 600, scroll: 1200 }]))).toMatchObject({
      contentWidth: 1920,
    });
    expect(
      documentWidths.call(measuredDocument([{ client: 600, scroll: 1200, shadow: true }])),
    ).toMatchObject({ contentWidth: 1920 });
  });

  it("隐藏、屏外、被裁剪或只有空滚动条的容器不触发缩放", () => {
    const doc = measuredDocument([
      { client: 600, scroll: 1200, visible: false },
      { client: 600, scroll: 1200, left: 2000 },
      { client: 600, scroll: 1200, overflow: "hidden" },
      { client: 600, scroll: 600, overflow: "scroll" },
      { client: 0, scroll: 1200 },
    ]);
    expect(documentWidths.call(doc)).toMatchObject({ contentWidth: 960 });
  });

  it("960/1280 直接到 75%，整轮后才还原原比例和设置", async () => {
    const f = fixture();
    expect(await fit(f)).toMatchObject({ changed: true, fitted: true, zoom: 0.75 });
    expect(f.zoomApi.setZoom).toHaveBeenCalledExactlyOnceWith(1, 0.75);
    expect(f.zoomApi.setZoomSettings).toHaveBeenNthCalledWith(1, 1, {
      mode: "automatic",
      scope: "per-tab",
    });
    expect(vi.mocked(f.zoomApi.setZoomSettings).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.zoomApi.setZoom).mock.invocationCallOrder[0]!,
    );
    expect(await fit(f)).toMatchObject({ changed: false, fitted: true });
    expect(f.state.zoom).toBe(0.75);
    expect(f.zoomApi.setZoom).toHaveBeenCalledTimes(1);
    expect(await restore(f)).toEqual({ restored: true });
    expect(f.state).toMatchObject({
      zoom: 1,
      settings: { mode: "automatic", scope: "per-origin" },
    });
    expect(await restore(f)).toMatchObject({ restored: false });
  });

  // 同一个 documentEpoch/URL 不是宽度不变的证据：按钮展开表格之后必须继续缩小。
  it("同文档变宽再次缩小，变窄不放大，最后恢复首次原始比例而非中间比例", async () => {
    const f = fixture();
    f.state.zoom = 1.25;
    expect(await fit(f)).toMatchObject({ zoom: 0.75 });
    f.options.content = 1920;
    expect(await fit(f)).toMatchObject({ changed: true, fitted: true, zoom: 0.5 });
    f.options.content = 960;
    expect(await fit(f)).toMatchObject({ changed: false, fitted: true });
    expect(f.state.zoom).toBe(0.5);
    expect(f.zoomApi.setZoomSettings).toHaveBeenCalledTimes(1);
    expect(await restore(f)).toEqual({ restored: true });
    expect(f.state.zoom).toBe(1.25);
  });

  it("动态重排可继续适配，超过 Chrome 25% 下限时如实返回仍溢出", async () => {
    const f = fixture({ secondLayout: true });
    expect(await fit(f)).toMatchObject({ fitted: true, zoom: 0.68 });
    expect(f.zoomApi.setZoom).toHaveBeenCalledTimes(2);
    const huge = fixture({ content: 4000 });
    expect(await fit(huge)).toMatchObject({ fitted: false, zoom: 0.25 });
    expect(huge.zoomApi.setZoom).toHaveBeenCalledTimes(1);
  });

  it("缩放无效果停止且相同布局下一步不继续缩小，低于下限时不反向放大", async () => {
    const f = fixture({ ineffective: true });
    expect(await fit(f)).toMatchObject({ fitted: false });
    expect(await fit(f)).toMatchObject({ changed: false, reason: "ineffective" });
    expect(f.zoomApi.setZoom).toHaveBeenCalledTimes(1);
    const small = fixture({ content: 6000 });
    small.state.zoom = 0.2;
    expect(await fit(small)).toMatchObject({ changed: false, fitted: false });
    expect(small.zoomApi.setZoom).not.toHaveBeenCalled();
  });

  it("固定 CSS 容器同比缩小不算改善，后续检测仍保留原来的比例", async () => {
    const f = fixture({ fixedContainer: true });
    expect(await fit(f)).toMatchObject({ fitted: false, zoom: 0.75 });
    expect(await fit(f)).toMatchObject({ changed: false, fitted: false, reason: "ineffective" });
    expect(f.zoomApi.setZoom).toHaveBeenCalledExactlyOnceWith(1, 0.75);
  });

  it("页面禁用原生缩放时不擅自解除设置", async () => {
    const f = fixture();
    f.state.settings.mode = "disabled";
    expect(await fit(f)).toMatchObject({ changed: false, fitted: false, reason: "zoom_disabled" });
    expect(f.zoomApi.setZoomSettings).not.toHaveBeenCalled();
  });

  it("用户手改后每步不再接管，收尾不覆盖手动设置", async () => {
    const f = fixture();
    await fit(f);
    expect(await restore(f, "another-turn")).toMatchObject({
      restored: false,
      reason: "not_owned",
    });
    f.state.zoom = 0.9;
    expect(await fit(f)).toMatchObject({ changed: false, reason: "user_changed" });
    expect(f.zoomApi.setZoom).toHaveBeenCalledTimes(1);
    expect(await restore(f)).toMatchObject({ restored: false, reason: "user_changed" });
    expect(f.state.zoom).toBe(0.9);
  });

  it("取消或文档已变化不派发缩放，恢复也不修改新文档", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(fit(f)).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.zoomApi.setZoom).not.toHaveBeenCalled();
    const navigated = fixture();
    await fit(navigated);
    navigated.state.epoch = 11;
    expect(await restore(navigated)).toMatchObject({ restored: false, reason: "document_changed" });
    expect(navigated.zoomApi.setZoom).toHaveBeenCalledTimes(1);
  });

  it("导航重置为 100% 后下一步重新适配新文档，收尾只恢复当前文档", async () => {
    const f = fixture();
    await fit(f);
    f.state.epoch++;
    f.page.documentEpoch++;
    f.state.zoom = 1;
    f.state.settings = { mode: "automatic", scope: "per-origin" };
    expect(await fit(f)).toMatchObject({ changed: true, fitted: true, zoom: 0.75 });
    expect(f.zoomApi.setZoom).toHaveBeenCalledTimes(2);
    expect(await restore(f)).toEqual({ restored: true });
    expect(f.state.zoom).toBe(1);
  });

  it("设置页签范围后导航，不能把旧比例写入新页面", async () => {
    const f = fixture();
    vi.mocked(f.zoomApi.setZoomSettings).mockImplementationOnce(async (_id, settings) => {
      f.state.settings = settings;
      f.state.epoch++;
    });
    await expect(fit(f)).rejects.toThrow("文档已变化");
    expect(f.zoomApi.setZoom).not.toHaveBeenCalled();
  });

  it("缩放已生效但回执丢失时保留待定比例用于条件恢复", async () => {
    const f = fixture();
    vi.mocked(f.zoomApi.setZoom).mockImplementationOnce(async (_id, zoom) => {
      f.state.zoom = zoom;
      throw new Error("lost acknowledgement");
    });
    await expect(fit(f)).rejects.toThrow("lost acknowledgement");
    expect(await restore(f)).toMatchObject({ restored: true });
    expect(f.state.zoom).toBe(1);
  });

  it("无需进一步缩小时也可移交归属，迟到的旧请求不能恢复新请求", async () => {
    const f = fixture();
    await fit(f);
    expect(await fitReplayViewport(f.owner, "next-turn", f.page, f.deps)).toMatchObject({
      changed: false,
      fitted: true,
    });
    expect(await restore(f)).toMatchObject({ restored: false, reason: "not_owned" });
    expect(await restore(f, "next-turn")).toEqual({ restored: true });
  });

  // 取消可能阻止恢复；下一轮是新的明确授权，不能永久沿用上一轮 user_changed 状态。
  it("上轮未清理且用户改过比例，新轮从当前比例建立恢复基线", async () => {
    const f = fixture();
    await fit(f);
    f.state.zoom = 0.9;
    expect(await fitReplayViewport(f.owner, "next-turn", f.page, f.deps)).toMatchObject({
      changed: true,
      fitted: true,
    });
    expect(await restore(f)).toMatchObject({ restored: false, reason: "not_owned" });
    expect(await restore(f, "next-turn")).toEqual({ restored: true });
    expect(f.state.zoom).toBe(0.9);
  });
});
