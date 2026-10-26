import type { CdpRunner } from "./shared";

interface Widths {
  viewportWidth: number;
  /** 等效所需宽度：整页及可见滚动容器的最大溢出比例乘以当前视口。 */
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
  /** 兼容旧 runId 字段；新版宿主传整轮请求 ID，同轮多个 Pipeline 共用首次原始比例。 */
  runId: string;
  original: number;
  applied: number;
  pending?: number;
  settings: chrome.tabs.ZoomSettings;
  /** 仅阻止对相同布局反复无效缩小；每步仍测宽，布局改变就重新尝试。 */
  ineffective?: Widths;
}
// 标签页/文档级归属，不写站点偏好。真正导航后 Chrome 会重置 per-tab 缩放；下一步
// 必须重新测宽，不能沿用旧文档租约。扩展重载或会话丢失后也不猜测旧状态。
const leases = new WeakMap<object, Map<number, ZoomLease>>();
const MIN_ZOOM = 0.25;
const TOLERANCE = 2;

/**
 * 读取当前界面的横向滚动，不读正文或表单值。本函数由 CDP 序列化，必须自包含。
 * 先用廉价的 clientWidth/scrollWidth 筛选，再检查可见性；只纳入与视口相交、真正
 * 支持横向滚动的容器，避免隐藏模板、纵向列表和 overflow:hidden 被误判。开放的
 * shadow root 一并检查；跨域 iframe 不执行页面脚本，仍由既有 frame 定位/滚动处理。
 * 不使用 overflow-x:scroll 的样式本身判溢出，因为它可在内容已完整时仍显示空滚动条。
 */
export function documentWidths(this: Document): Widths {
  const root = this.documentElement;
  const body = this.body;
  const viewportWidth =
    (this.compatMode === "BackCompat" ? body?.clientWidth : root?.clientWidth) ?? 0;
  const viewportHeight = root?.clientHeight || this.defaultView?.innerHeight || 0;
  let contentWidth = Math.max(
    this.scrollingElement?.scrollWidth ?? 0,
    root?.scrollWidth ?? 0,
    body?.scrollWidth ?? 0,
  );
  const scopes: (Document | ShadowRoot)[] = [this];
  for (const scope of scopes) {
    for (const element of scope.querySelectorAll("*")) {
      if (element.shadowRoot) scopes.push(element.shadowRoot);
      if (
        element === root ||
        element === body ||
        element.clientWidth <= 0 ||
        element.scrollWidth <= element.clientWidth + 2
      )
        continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.right <= 0 ||
        rect.left >= viewportWidth ||
        rect.bottom <= 0 ||
        rect.top >= viewportHeight
      )
        continue;
      const style = this.defaultView?.getComputedStyle(element);
      if (
        !style ||
        !["auto", "scroll", "overlay"].includes(style.overflowX) ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0"
      )
        continue;
      if (
        element.checkVisibility &&
        !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      )
        continue;
      // 按滚动容器自己的可用宽度求比例，不能把表格的绝对宽度误当成整个页面宽度。
      contentWidth = Math.max(
        contentWidth,
        (viewportWidth * element.scrollWidth) / element.clientWidth,
      );
    }
  }
  return { viewportWidth, contentWidth, ready: this.readyState !== "loading" && !!body };
}

/** 每次写入前重新核对主文档，不把旧页面的比例施加到等待期间新导航的页面。 */
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
 * 已就绪且没有横向溢出时一次采样立即继续，不为每一步固定等待。确有溢出则两次
 * 50ms 间隔采样稳定后计算比例；缩放后复测最多等待 1.5 秒。加载中的初次测量仍沿用
 * 30 秒上限和外层动作取消，不能用短重排期限误杀慢页面。读取后再次 guard，避免旧
 * 文档的测量结果误授权下一步动作（包括无需缩放的快速路径）。
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
        {
          backendNodeId: page.documentEpoch,
          objectGroup: group,
        },
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
    await guard(page, deps);
    if (
      widths?.ready &&
      Number.isFinite(widths.viewportWidth) &&
      widths.viewportWidth > 0 &&
      Number.isFinite(widths.contentWidth) &&
      widths.contentWidth > 0
    ) {
      if (
        widths.contentWidth <= widths.viewportWidth + TOLERANCE ||
        (previous &&
          Math.abs(previous.viewportWidth - widths.viewportWidth) <= 1 &&
          Math.abs(previous.contentWidth - widths.contentWidth) <= 1)
      )
        return widths;
      previous = widths;
    } else previous = undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error("页面布局尚未稳定，未派发本次业务动作");
}

/**
 * 每步只缩小、不恢复或反向放大。直接按最严重的横向溢出比例计算，布局有改善但仍
 * 溢出时最多再修正三次，最低采用 Chrome 原生 25%。固定宽度容器可能与缩放同比
 * 缩小，溢出比例不改善时立即止损，后续相同布局只读检查，不在每步继续逐档缩小。
 * 先写租约再写设置/比例，覆盖响应丢失；业务动作仍由原调用链单独决定，不自动重放。
 */
export async function fitReplayViewport(
  owner: object,
  runId: string,
  page: ReplayPage,
  deps: Deps,
) {
  let widths = await settledWidths(page, deps);
  const before = widths;
  const tabs = leases.get(owner) ?? new Map<number, ZoomLease>();
  leases.set(owner, tabs);
  let lease = tabs.get(page.tabId);
  if (lease && lease.documentEpoch !== page.documentEpoch) {
    tabs.delete(page.tabId);
    lease = undefined;
  }
  const fitted = () => widths.contentWidth <= widths.viewportWidth + TOLERANCE;
  if (fitted() && !lease) return { changed: false, fitted: true, ...widths };
  const api = deps.zoomApi;
  let zoom = await api.getZoom(page.tabId);
  const settings = await api.getZoomSettings(page.tabId);
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error("无法读取当前页面缩放");
  if (
    lease &&
    (settings.mode !== "automatic" ||
      settings.scope !== "per-tab" ||
      ![lease.applied, lease.pending].some((v) => v !== undefined && Math.abs(zoom - v) <= 0.001))
  ) {
    // 同轮后续步骤不重新接管用户手改，收尾会返回 user_changed。若上轮被中断而
    // 未能清理，新一轮明确请求可从当前用户比例建立新基线，不能永久卡在旧归属。
    if (lease.runId === runId)
      return { changed: false, fitted: fitted(), reason: "user_changed", ...widths };
    tabs.delete(page.tabId);
    lease = undefined;
  }
  if (settings.mode && settings.mode !== "automatic")
    return { changed: false, fitted: fitted(), reason: "zoom_disabled", ...widths };
  if (lease) lease.runId = runId;
  if (fitted()) return { changed: false, fitted: true, ...widths };
  if (
    lease?.ineffective &&
    Math.abs(lease.ineffective.viewportWidth - widths.viewportWidth) <= TOLERANCE &&
    Math.abs(lease.ineffective.contentWidth - widths.contentWidth) <= TOLERANCE
  )
    return { changed: false, fitted: false, reason: "ineffective", ...widths };
  let changed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (fitted()) break;
    const next = Math.max(
      MIN_ZOOM,
      Math.floor(((zoom * widths.viewportWidth) / widths.contentWidth) * 100) / 100,
    );
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
    const scoped = await api.getZoomSettings(page.tabId);
    if (scoped.mode !== "automatic" || scoped.scope !== "per-tab")
      throw new Error("缩放范围已变化，停止自动适配");
    await guard(page, deps);
    // scoped API 等待期间也可能发生手动调整，写入前再核对，不把它覆盖掉。
    if (Math.abs((await api.getZoom(page.tabId)) - zoom) > 0.001)
      throw new Error("用户已调整缩放，停止自动适配");
    deps.signal?.throwIfAborted();
    lease.pending = next;
    await api.setZoom(page.tabId, next);
    lease.applied = next;
    delete lease.pending;
    changed = true;
    zoom = await api.getZoom(page.tabId);
    deps.signal?.throwIfAborted();
    if (Math.abs(zoom - next) > 0.001) throw new Error("缩放结果与请求不符，停止自动适配");
    const previousRatio = widths.contentWidth / widths.viewportWidth;
    widths = await settledWidths(page, deps, 1500);
    // 比较比例而非像素差：固定 CSS 容器会随缩放同比变化，却不会多显示任何一列。
    if (!fitted() && widths.contentWidth / widths.viewportWidth >= previousRatio - 0.005) {
      lease.ineffective = widths;
      break;
    }
    delete lease.ineffective;
  }
  return {
    changed,
    fitted: fitted(),
    zoom,
    originalZoom: lease?.original ?? zoom,
    before,
    ...widths,
  };
}

/**
 * 只恢复本轮仍拥有的缩放。文档变化、手动修改或写门禁拒绝时不覆盖；恢复到首次
 * 调整前的比例而不是硬编码 100%。先在 per-tab 下恢复，再恢复设置，避免污染同站点
 * 其他页签。旧客户端仍可按运行 ID 使用同一协议，不需要重编译已有 Pipeline/Skill。
 */
export async function restoreReplayViewport(
  owner: object,
  runId: string,
  tabId: number,
  deps: Deps,
) {
  const tabs = leases.get(owner);
  const lease = tabs?.get(tabId);
  if (!lease || lease.runId !== runId) return { restored: false, reason: "not_owned" };
  deps.signal?.throwIfAborted();
  const doc = await deps.cdp.send<{ root: { backendNodeId: number } }>(tabId, "DOM.getDocument", {
    depth: 0,
  });
  deps.signal?.throwIfAborted();
  if (doc.root.backendNodeId !== lease.documentEpoch) {
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
