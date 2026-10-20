import type { CdpRunner } from "./shared";

interface Widths {
  viewportWidth: number;
  contentWidth: number;
  ready: boolean;
}
export interface ReplayPage {
  tabId: number;
  documentEpoch: number;
}
export interface ZoomApi {
  getZoom(tabId: number): Promise<number>;
  getZoomSettings(tabId: number): Promise<chrome.tabs.ZoomSettings>;
  setZoom(tabId: number, factor: number): Promise<void>;
  setZoomSettings(tabId: number, settings: chrome.tabs.ZoomSettings): Promise<void>;
}
interface Deps {
  cdp: CdpRunner;
  signal?: AbortSignal;
  zoomApi: ZoomApi;
}
interface ZoomLease extends ReplayPage {
  runId: string;
  original: number;
  applied: number;
  pending?: number;
  settings: chrome.tabs.ZoomSettings;
}
// 缩放归属于当前浏览器会话、运行和文档，不是站点偏好。WeakMap 不延长会话寿命；
// 会话丢失/扩展重载后不猜测旧归属，Chrome 的 per-tab 缩放在真正导航时自行重置。
const leases = new WeakMap<object, Map<number, ZoomLease>>();
const MIN_ZOOM = 0.67;
const TOLERANCE = 2;

/**
 * 在主文档内读取整页宽度。只看根滚动区和 body，不扫描后代的 scrollWidth，
 * 否则宽表格自身的横向滚动会被误当作整页溢出。本函数通过 CDP 序列化执行，
 * 必须自包含，且不读取正文、表单值，也不接受任意页面脚本。
 */
export function documentWidths(this: Document): Widths {
  const root = this.documentElement;
  const body = this.body;
  return {
    viewportWidth: (this.compatMode === "BackCompat" ? body?.clientWidth : root?.clientWidth) ?? 0,
    contentWidth: Math.max(
      this.scrollingElement?.scrollWidth ?? 0,
      root?.scrollWidth ?? 0,
      body?.scrollWidth ?? 0,
    ),
    ready: this.readyState !== "loading" && !!body,
  };
}

/** 每次变更前复核主文档，不能在等待重排期间把旧页面的缩放写到导航后的页面。 */
async function guard(page: ReplayPage, deps: Deps): Promise<void> {
  deps.signal?.throwIfAborted();
  const doc = await deps.cdp.send<{ root: { backendNodeId: number } }>(
    page.tabId,
    "DOM.getDocument",
    { depth: 0 },
  );
  deps.signal?.throwIfAborted();
  if (doc.root.backendNodeId !== page.documentEpoch)
    throw new Error("视口适配期间文档已变化，尚未派发回放动作");
}

/**
 * 两次间隔采样稳定后立即继续。首次加载沿用常规就绪的 30 秒上限，不能用很短的
 * 重排时间误杀慢加载页面；缩放后的复测最多等 1.5 秒。外层原子取消信号仍优先。
 */
async function settledWidths(page: ReplayPage, deps: Deps, timeoutMs = 30000): Promise<Widths> {
  const deadline = Date.now() + timeoutMs;
  let previous: Widths | undefined;
  do {
    await guard(page, deps);
    const group = "replay-width-" + crypto.randomUUID();
    let widths: Widths | undefined;
    try {
      const node = await deps.cdp.send<{ object: { objectId: string } }>(
        page.tabId,
        "DOM.resolveNode",
        { backendNodeId: page.documentEpoch, objectGroup: group },
      );
      const result = await deps.cdp.send<{
        result: { value?: Widths };
        exceptionDetails?: unknown;
      }>(page.tabId, "Runtime.callFunctionOn", {
        objectId: node.object.objectId,
        functionDeclaration: documentWidths.toString(),
        returnByValue: true,
      });
      if (!result.exceptionDetails) widths = result.result.value;
    } finally {
      await deps.cdp
        .send(page.tabId, "Runtime.releaseObjectGroup", { objectGroup: group })
        .catch(() => {});
    }
    deps.signal?.throwIfAborted();
    if (
      widths?.ready &&
      Number.isFinite(widths.viewportWidth) &&
      widths.viewportWidth > 0 &&
      Number.isFinite(widths.contentWidth) &&
      widths.contentWidth > 0
    ) {
      if (
        previous &&
        Math.abs(previous.viewportWidth - widths.viewportWidth) <= 1 &&
        Math.abs(previous.contentWidth - widths.contentWidth) <= 1
      )
        return widths;
      previous = widths;
    } else previous = undefined;
    // 等待有固定上限；取消后最多等待本次 50ms，下一轮不会再读取或写入页面。
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error("页面布局尚未稳定，未派发本次业务动作");
}

/**
 * 仅 Pipeline 回放显式调用，先估算一次缩放，再最多修正一次。缩放写操作走
 * pipeline_step 中断门禁；失败不会返回业务点击回执，也不会触发业务动作重放。
 * 先存 lease 再改变设置，即使设置/缩放的响应丢失，结束清理仍可检查实际状态。
 */
export async function fitReplayViewport(owner: object, runId: string, page: ReplayPage, deps: Deps) {
  let widths = await settledWidths(page, deps);
  const before = widths;
  if (widths.contentWidth <= widths.viewportWidth + TOLERANCE)
    return { changed: false, fitted: true, ...widths };
  const api = deps.zoomApi;
  let zoom = await api.getZoom(page.tabId);
  const settings = await api.getZoomSettings(page.tabId);
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error("无法读取当前页面缩放");
  if (settings.mode && settings.mode !== "automatic")
    return { changed: false, fitted: false, reason: "zoom_disabled", ...widths };
  const tabs = leases.get(owner) ?? new Map<number, ZoomLease>();
  leases.set(owner, tabs);
  let lease = tabs.get(page.tabId);
  if (
    lease &&
    (lease.documentEpoch !== page.documentEpoch ||
      Math.abs(zoom - lease.applied) > 0.001 ||
      settings.scope !== "per-tab")
  )
    lease = undefined;
  let changed = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (widths.contentWidth <= widths.viewportWidth + TOLERANCE) break;
    const next = Math.max(
      MIN_ZOOM,
      Math.floor(((zoom * widths.viewportWidth) / widths.contentWidth) * 100) / 100,
    );
    // 只缩小，不把用户已经低于下限的页面放大；也不逐档试探或无界缩小。
    if (next >= zoom - 0.005) break;
    await guard(page, deps);
    const current = await api.getZoom(page.tabId);
    if (Math.abs(current - zoom) > 0.001) throw new Error("用户已调整缩放，停止自动适配");
    if (!lease) {
      lease = { ...page, runId, original: zoom, applied: zoom, settings };
      tabs.set(page.tabId, lease);
      deps.signal?.throwIfAborted();
      await api.setZoomSettings(page.tabId, { mode: "automatic", scope: "per-tab" });
    }
    lease.runId = runId;
    // 等待重排期间其他扩展/用户可能改过缩放范围，不能继续以 per-origin 写入。
    const scoped = await api.getZoomSettings(page.tabId);
    if (scoped.mode !== "automatic" || scoped.scope !== "per-tab")
      throw new Error("缩放范围已变化，停止自动适配");
    await guard(page, deps);
    lease.pending = next;
    await api.setZoom(page.tabId, next);
    lease.applied = next;
    delete lease.pending;
    changed = true;
    zoom = await api.getZoom(page.tabId);
    deps.signal?.throwIfAborted();
    if (Math.abs(zoom - next) > 0.001) throw new Error("缩放结果与请求不符，停止自动适配");
    const previousOverflow = widths.contentWidth - widths.viewportWidth;
    widths = await settledWidths(page, deps, 1500);
    if (widths.contentWidth - widths.viewportWidth >= previousOverflow - TOLERANCE) break;
  }
  return {
    changed,
    fitted: widths.contentWidth <= widths.viewportWidth + TOLERANCE,
    zoom,
    originalZoom: lease?.original ?? zoom,
    before,
    ...widths,
  };
}

/**
 * 只恢复本运行仍拥有的缩放。文档变化、用户手改或中断门禁拒绝时不强制覆盖；
 * 必须先在 per-tab 下恢复比例，再恢复原设置，不能以 per-origin 写回污染其他页签。
 */
export async function restoreReplayViewport(owner: object, runId: string, tabId: number, deps: Deps) {
  const tabs = leases.get(owner);
  const lease = tabs?.get(tabId);
  if (!lease || lease.runId !== runId) return { restored: false, reason: "not_owned" };
  deps.signal?.throwIfAborted();
  const doc = await deps.cdp.send<{ root: { backendNodeId: number } }>(
    tabId,
    "DOM.getDocument",
    { depth: 0 },
  );
  deps.signal?.throwIfAborted();
  if (doc.root.backendNodeId !== lease.documentEpoch) {
    // 导航已让 Chrome 重置 per-tab 设置，不再写入新文档，也不误报清理失败。
    tabs?.delete(tabId);
    return { restored: false, reason: "document_changed" };
  }
  const zoom = await deps.zoomApi.getZoom(tabId);
  const settings = await deps.zoomApi.getZoomSettings(tabId);
  if (
    settings.mode !== "automatic" ||
    settings.scope !== "per-tab" ||
    ![lease.applied, lease.pending].some((v) => v !== undefined && Math.abs(zoom - v) < 0.001)
  ) {
    tabs?.delete(tabId);
    return { restored: false, reason: "user_changed" };
  }
  await guard(lease, deps);
  await deps.zoomApi.setZoom(tabId, lease.original);
  await guard(lease, deps);
  await deps.zoomApi.setZoomSettings(tabId, {
    mode: lease.settings.mode ?? "automatic",
    scope: lease.settings.scope ?? "per-origin",
  });
  tabs?.delete(tabId);
  return { restored: true };
}
