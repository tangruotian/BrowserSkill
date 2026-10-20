import { describe, expect, it, vi } from "vitest";
import { documentWidths, fitReplayViewport, restoreReplayViewport, type ZoomApi } from "../replay-viewport";
import type { CdpRunner } from "../shared";

function fixture(options: { content?: number; localOverflow?: boolean; ineffective?: boolean; secondLayout?: boolean } = {}) {
  const owner = {};
  const page = { tabId: 1, documentEpoch: 10 };
  const state = { zoom: 1, epoch: 10, settings: { mode: "automatic", scope: "per-origin" } as chrome.tabs.ZoomSettings };
  const controller = new AbortController();
  const zoomApi: ZoomApi = {
    getZoom: vi.fn(async () => state.zoom),
    getZoomSettings: vi.fn(async () => ({ ...state.settings })),
    setZoom: vi.fn(async (_id, zoom) => { state.zoom = zoom; }),
    setZoomSettings: vi.fn(async (_id, settings) => { state.settings = { ...settings }; }),
  };
  const send = vi.fn(async (_id: number, method: string) => {
    if (method === "DOM.getDocument") return { root: { backendNodeId: state.epoch } };
    if (method === "DOM.resolveNode") return { object: { objectId: "doc" } };
    if (method === "Runtime.releaseObjectGroup") return {};
    if (method === "Runtime.callFunctionOn") return { result: { value: {
      viewportWidth: options.ineffective ? 960 : Math.floor(960 / state.zoom),
      contentWidth: options.secondLayout && state.zoom < 1 ? 1400 : (options.content ?? 1280),
      ready: true,
    } } };
    throw new Error("Unexpected " + method);
  });
  const deps = { cdp: { send } as unknown as CdpRunner, zoomApi, signal: controller.signal };
  return { owner, page, state, controller, deps, zoomApi, send };
}
const fit = (f: ReturnType<typeof fixture>) => fitReplayViewport(f.owner, "run-test", f.page, f.deps);
const restore = (f: ReturnType<typeof fixture>, runId = "run-test") => restoreReplayViewport(f.owner, runId, 1, f.deps);

describe("回放前整页宽度适配", () => {
  // 测宽只访问主文档，局部宽表格不应导致整页被无限缩小。
  it("测宽不扫描内部滚动容器，适配页不触发任何缩放", async () => {
    const doc = {
      compatMode: "CSS1Compat", readyState: "complete",
      documentElement: { clientWidth: 960, scrollWidth: 960 },
      body: { clientWidth: 960, scrollWidth: 960 },
      scrollingElement: { scrollWidth: 960 },
      querySelectorAll: vi.fn(() => [{ scrollWidth: 6000 }]),
    };
    expect(documentWidths.call(doc as unknown as Document)).toEqual({ viewportWidth: 960, contentWidth: 960, ready: true });
    expect(doc.querySelectorAll).not.toHaveBeenCalled();
    const f = fixture({ content: 960 });
    expect(await fit(f)).toMatchObject({ changed: false, fitted: true });
    expect(f.zoomApi.setZoom).not.toHaveBeenCalled();
    expect(f.zoomApi.setZoomSettings).not.toHaveBeenCalled();
  });

  it("960/1280 直接调整到 75%，先限定页签范围，结束还原原比例和设置", async () => {
    const f = fixture();
    expect(await fit(f)).toMatchObject({ changed: true, fitted: true, zoom: 0.75 });
    expect(f.zoomApi.setZoom).toHaveBeenCalledExactlyOnceWith(1, 0.75);
    expect(f.zoomApi.setZoomSettings).toHaveBeenNthCalledWith(1, 1, { mode: "automatic", scope: "per-tab" });
    expect(vi.mocked(f.zoomApi.setZoomSettings).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.zoomApi.setZoom).mock.invocationCallOrder[0]!);
    expect(await restore(f)).toEqual({ restored: true });
    expect(f.state).toMatchObject({ zoom: 1, settings: { mode: "automatic", scope: "per-origin" } });
    expect(await restore(f)).toMatchObject({ restored: false });
  });

  it("布局重排后最多补一次，67% 下限仍溢出时如实返回未适配", async () => {
    const f = fixture({ secondLayout: true });
    expect(await fit(f)).toMatchObject({ fitted: true, zoom: 0.68 });
    expect(f.zoomApi.setZoom).toHaveBeenCalledTimes(2);
    const huge = fixture({ content: 4000 });
    expect(await fit(huge)).toMatchObject({ fitted: false, zoom: 0.67 });
    expect(huge.zoomApi.setZoom).toHaveBeenCalledTimes(1);
  });

  it("缩放无效果时立即停止，用户已小于下限时不反向放大", async () => {
    const f = fixture({ ineffective: true });
    expect(await fit(f)).toMatchObject({ fitted: false });
    expect(f.zoomApi.setZoom).toHaveBeenCalledTimes(1);
    const small = fixture({ content: 4000 });
    small.state.zoom = 0.5;
    expect(await fit(small)).toMatchObject({ changed: false, fitted: false });
    expect(small.zoomApi.setZoom).not.toHaveBeenCalled();
  });

  it("页面禁用原生缩放时保留原有回放检查，不擅自解除设置", async () => {
    const f = fixture();
    f.state.settings.mode = "disabled";
    expect(await fit(f)).toMatchObject({ changed: false, fitted: false, reason: "zoom_disabled" });
    expect(f.zoomApi.setZoomSettings).not.toHaveBeenCalled();
  });

  it("不覆盖用户手改，不允许其他运行恢复本运行缩放", async () => {
    const f = fixture();
    await fit(f);
    expect(await restore(f, "another-run")).toMatchObject({ restored: false, reason: "not_owned" });
    f.state.zoom = 0.9;
    expect(await restore(f)).toMatchObject({ restored: false, reason: "user_changed" });
    expect(f.state.zoom).toBe(0.9);
  });

  it("取消或文档已变化时不派发缩放，恢复也不修改新文档", async () => {
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

  it("设置页签范围后发生导航，不能把旧比例写入新页面", async () => {
    const f = fixture();
    vi.mocked(f.zoomApi.setZoomSettings).mockImplementationOnce(async (_id, settings) => {
      f.state.settings = settings;
      f.state.epoch++;
    });
    await expect(fit(f)).rejects.toThrow("文档已变化");
    expect(f.zoomApi.setZoom).not.toHaveBeenCalled();
  });

  it("缩放已生效但回执丢失时，保留待定比例用于条件恢复", async () => {
    const f = fixture();
    vi.mocked(f.zoomApi.setZoom).mockImplementationOnce(async (_id, zoom) => {
      f.state.zoom = zoom;
      throw new Error("lost acknowledgement");
    });
    await expect(fit(f)).rejects.toThrow("lost acknowledgement");
    expect(await restore(f)).toMatchObject({ restored: true });
    expect(f.state.zoom).toBe(1);
  });
});
