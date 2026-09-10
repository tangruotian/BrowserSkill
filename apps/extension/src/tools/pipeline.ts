import type { CdpTarget } from "@/browser-driver/frame-graph";
import type { SessionManager } from "@/session-manager/manager";
import {
  handleClick,
  handleFill,
  handleHover,
  handlePress,
  handleSelect,
  type InteractionDeps,
} from "./interaction";
import { type FrameScope, resolvePipelineDocument } from "./pipeline-frames";
import {
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
  sendToCdpTarget,
} from "./shared";

type Scalar = string | number | boolean;
interface SelectedSource {
  kind: "text" | "value" | "tags";
  selector: string;
  itemSelector?: string;
  separator?: string;
  emptyText?: string;
}
interface Target {
  prepare?: boolean;
  selector?: string;
  role?: string;
  name?: string;
  within?: string;
  frame?: FrameScope[];
  identity: { property: string; attribute?: string; expected: Scalar }[];
  selectionOpenExpected?: boolean;
  selectionGuard?: {
    source?: SelectedSource;
    label?: string;
    selectedAttribute?: "aria-selected" | "aria-checked" | "checked";
    selectedClass?: string;
    expected: boolean;
  };
  selection?: {
    selectedSource?: SelectedSource;
    container: string;
    option: string;
    selectedAttribute?: "aria-selected" | "aria-checked" | "checked";
    selectedClass?: string;
  };
}
export interface PipelineParams {
  session_id: string;
  tab_id?: number;
  request: {
    version: 1;
    op: string;
    requestId?: string;
    value?: Scalar;
    page?: { origin: string; pathPrefix: string };
    target?: Target;
    documentEpoch?: number;
    frameId?: string;
    frameEpoch?: number;
  };
}
interface Facts {
  matches: boolean;
  connected: boolean;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  text: string;
  value: string | null;
  checked: boolean;
  hit: boolean;
  rect: { x: number; y: number; width: number; height: number };
  textTruncated: boolean;
  valueTruncated: boolean;
  selection?: string[] | null;
  selectionOptions?: { label: string; selected: boolean }[] | null;
  selectionOpen?: boolean;
  selectionError?: string;
}
// Only this fixed reader is evaluated. User configuration supplies data arguments, never JS.
export function facts(this: Element, target: Target, point?: { x: number; y: number }): Facts {
  const scopes = target.within ? document.querySelectorAll(target.within) : null;
  const scoped = !scopes || (scopes.length === 1 && scopes[0]?.contains(this));
  const input = this as HTMLInputElement;
  const value = input.type === "password" ? null : "value" in this ? String(input.value) : "";
  const text = (this.textContent ?? "").trim();
  const rect = this.getBoundingClientRect();
  const style = getComputedStyle(this);
  const visible =
    rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const inView = center.x >= 0 && center.y >= 0 && center.x < innerWidth && center.y < innerHeight;
  // Off-screen targets are scrolled by the interaction driver; dispatch rechecks the actual hit.
  const hit = point
    ? document.elementFromPoint(point.x, point.y)
    : inView && visible
      ? document.elementFromPoint(center.x, center.y)
      : this;
  const readSource = (source: SelectedSource): string[] => {
    const roots = document.querySelectorAll(source.selector);
    if (roots.length !== 1) throw new Error("已选集合来源不唯一");
    const root = roots[0]!;
    if (root instanceof HTMLInputElement && root.type === "password")
      throw new Error("不能读取密码为集合");
    const raw =
      source.kind === "value"
        ? "value" in root
          ? String((root as HTMLInputElement).value)
          : null
        : (root.textContent ?? "").trim();
    if (raw === null || raw.length > 16000) throw new Error("集合值不可读或被截断");
    const items =
      source.kind === "tags"
        ? [...root.querySelectorAll(source.itemSelector!)].map((n) => (n.textContent ?? "").trim())
        : raw === "" || raw === source.emptyText
          ? []
          : raw.split(source.separator ?? ",").map((s) => s.trim());
    if (
      items.length > 100 ||
      items.some((s) => !s || s.length > 1000) ||
      new Set(items).size !== items.length
    )
      throw new Error("集合标签为空、重复或过长");
    return items;
  };
  let selectionFields: Partial<Facts> = {};
  if (target.selection) {
    const config = target.selection;
    selectionFields = { selection: null, selectionOptions: null, selectionOpen: false };
    try {
      const selectedValues = config.selectedSource ? readSource(config.selectedSource) : undefined;
      if (selectedValues) selectionFields.selection = selectedValues;
      const containers = document.querySelectorAll(config.container);
      if (containers.length > 1) throw new Error("多选容器不唯一");
      const container = containers[0];
      if (
        container &&
        container.getBoundingClientRect().width > 0 &&
        container.getBoundingClientRect().height > 0 &&
        getComputedStyle(container).display !== "none" &&
        getComputedStyle(container).visibility !== "hidden"
      ) {
        const nodes = [...container.querySelectorAll(config.option)];
        if (!nodes.length || nodes.length > 500) throw new Error("多选选项为空或超过 500 个");
        const options = nodes.map((node) => {
          const label = (node.textContent ?? "").trim();
          if (!label || label.length > 1000) throw new Error("选项文字为空或过长");
          const total = Number(
            node.getAttribute("aria-setsize") ??
              container.getAttribute("aria-setsize") ??
              nodes.length,
          );
          if (total !== nodes.length) throw new Error("选项集合不完整，暂不支持虚拟列表");
          let selected: boolean;
          if (selectedValues) selected = selectedValues.includes(label);
          else if (config.selectedClass) selected = node.classList.contains(config.selectedClass);
          else if (config.selectedAttribute === "checked") {
            if (!(node instanceof HTMLInputElement) || node.type !== "checkbox")
              throw new Error("选项不是 checkbox");
            selected = node.checked;
          } else {
            const value = node.getAttribute(config.selectedAttribute!);
            if (value !== "true" && value !== "false") throw new Error("选项缺少明确选中状态");
            selected = value === "true";
          }
          return { label, selected };
        });
        if (new Set(options.map((o) => o.label)).size !== options.length)
          throw new Error("选项文字不唯一");
        if (selectedValues?.some((label) => !options.some((o) => o.label === label)))
          throw new Error("已选值不在完整选项列表中");
        selectionFields = {
          selectionOpen: true,
          selectionOptions: options,
          selection: options.filter((o) => o.selected).map((o) => o.label),
        };
      }
    } catch (error) {
      selectionFields.selectionError = error instanceof Error ? error.message : "读取多选状态失败";
    }
  }
  return {
    ...selectionFields,
    matches:
      this.ownerDocument === document &&
      Boolean(scoped) &&
      (target.selectionOpenExpected === undefined ||
        selectionFields.selectionOpen === target.selectionOpenExpected) &&
      (!target.selectionGuard ||
        (() => {
          const guard = target.selectionGuard;
          if (guard.source) {
            try {
              return readSource(guard.source).includes(guard.label!) === guard.expected;
            } catch {
              return false;
            }
          }
          const raw = guard.selectedClass
            ? this.classList.contains(guard.selectedClass)
            : guard.selectedAttribute === "checked"
              ? this instanceof HTMLInputElement && this.type === "checkbox"
                ? this.checked
                : null
              : this.getAttribute(guard.selectedAttribute!);
          return (
            (typeof raw === "boolean"
              ? raw
              : raw === "true"
                ? true
                : raw === "false"
                  ? false
                  : null) === guard.expected
          );
        })()) &&
      target.identity.every((p) => {
        const actual =
          p.property === "text"
            ? text
            : p.property === "value"
              ? value
              : p.property === "checked"
                ? Boolean(input.checked)
                : this.getAttribute(p.attribute ?? "");
        return actual === p.expected;
      }),
    connected: this.isConnected,
    visible,
    enabled: !input.disabled && this.getAttribute("aria-disabled") !== "true",
    editable:
      !input.readOnly &&
      (this.matches("input:not([type=password]),textarea") ||
        (this as HTMLElement).isContentEditable),
    text: text.slice(0, 4000),
    value: value?.slice(0, 4000) ?? null,
    checked: Boolean(input.checked),
    textTruncated: text.length > 4000,
    valueTruncated: (value?.length ?? 0) > 4000,
    hit: Boolean(hit && (hit === this || this.contains(hit))),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}
function validRequest(p: PipelineParams, read: boolean): boolean {
  const r = p?.request;
  if (!r || r.version !== 1) return false;
  if (
    !(
      read ? ["capabilities", "page", "read"] : ["click", "fill", "select", "press", "hover"]
    ).includes(r.op)
  )
    return false;
  if (r.op === "capabilities" || r.op === "page") return read;
  if (!r.page || typeof r.page.origin !== "string" || typeof r.page.pathPrefix !== "string")
    return false;
  const t = r.target;
  if (
    !t ||
    (t.prepare !== undefined && typeof t.prepare !== "boolean") ||
    Boolean(t.selector) === Boolean(t.role) ||
    !Array.isArray(t.identity) ||
    t.identity.length > 10
  )
    return false;
  if (t.role && typeof t.name !== "string") return false;
  if (
    t.selectionOpenExpected !== undefined &&
    (typeof t.selectionOpenExpected !== "boolean" || !t.selection)
  )
    return false;
  const validSource = (s: SelectedSource | undefined) =>
    !s ||
    (["text", "value", "tags"].includes(s.kind) &&
      typeof s.selector === "string" &&
      !!s.selector &&
      s.selector.length <= 2000 &&
      (s.kind !== "tags" ||
        (typeof s.itemSelector === "string" &&
          !!s.itemSelector &&
          s.itemSelector.length <= 2000)) &&
      (s.separator === undefined ||
        (typeof s.separator === "string" && s.separator.length > 0 && s.separator.length <= 10)) &&
      (s.emptyText === undefined ||
        (typeof s.emptyText === "string" && s.emptyText.length <= 1000)));
  if (t.selectionGuard) {
    const g = t.selectionGuard;
    if (
      typeof g.expected !== "boolean" ||
      [g.selectedAttribute, g.selectedClass, g.source].filter(Boolean).length !== 1 ||
      !validSource(g.source) ||
      (g.source && (typeof g.label !== "string" || g.label.length > 1000)) ||
      (g.selectedAttribute &&
        !["aria-selected", "aria-checked", "checked"].includes(g.selectedAttribute)) ||
      (g.selectedClass && !/^[a-zA-Z_-][a-zA-Z0-9_-]{0,99}$/.test(g.selectedClass))
    )
      return false;
  }
  if (t.selection) {
    const s = t.selection;
    if (
      typeof s.container !== "string" ||
      !s.container ||
      s.container.length > 2000 ||
      typeof s.option !== "string" ||
      !s.option ||
      s.option.length > 2000 ||
      [s.selectedAttribute, s.selectedClass, s.selectedSource].filter(Boolean).length !== 1 ||
      !validSource(s.selectedSource) ||
      (s.selectedAttribute &&
        !["aria-selected", "aria-checked", "checked"].includes(s.selectedAttribute)) ||
      (s.selectedClass && !/^[a-zA-Z_-][a-zA-Z0-9_-]{0,99}$/.test(s.selectedClass))
    )
      return false;
  }
  if (
    t.frame !== undefined &&
    (!Array.isArray(t.frame) ||
      t.frame.length > 8 ||
      t.frame.some((f) => {
        try {
          const u = new URL(f.origin);
          return (
            !["http:", "https:"].includes(u.protocol) ||
            u.origin !== f.origin ||
            typeof f.pathPrefix !== "string" ||
            !f.pathPrefix.startsWith("/")
          );
        } catch {
          return true;
        }
      }))
  )
    return false;
  if (
    [t.selector, t.role, t.name, t.within].some(
      (v) => v !== undefined && (typeof v !== "string" || v.length > 2000),
    )
  )
    return false;
  if (
    t.identity.some(
      (v) =>
        !["text", "value", "checked", "attribute"].includes(v.property) ||
        !["string", "boolean", "number"].includes(typeof v.expected),
    )
  )
    return false;
  return (
    read ||
    (typeof r.requestId === "string" &&
      r.requestId.length <= 150 &&
      (!["fill", "select", "press"].includes(r.op) || typeof r.value === "string"))
  );
}
export async function handlePipeline(
  manager: SessionManager,
  params: PipelineParams,
  read: boolean,
  deps: InteractionDeps,
): Promise<Record<string, unknown>> {
  let phase = "not_started";
  const fail = (message: string) => ({
    ok: false,
    phase,
    error: message,
    requestId: params?.request?.requestId,
  });
  if (!validRequest(params, read)) return fail("Invalid or unsupported pipeline request");
  if (params.request.op === "capabilities")
    return {
      ok: true,
      version: 1,
      actions: ["click", "fill", "select", "press", "hover"],
      targets: ["css", "role"],
      frames: ["main", "path", "oopif"],
      phases: true,
      selection: true,
      selectionSources: true,
    };
  const ctx = lookupSession(manager, params, "pipeline");
  if (isRpcError(ctx)) return fail(ctx.message);
  const tab = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(tab)) return fail(tab.message);
  const denied = enforceAgentWindow(ctx, tab, "pipeline");
  if (denied) return fail(denied.message);
  const { cdp } = deps;
  const tid = tab.tabId;
  const r = params.request;
  const group = "pipeline-" + crypto.randomUUID();
  let frameTarget: CdpTarget | undefined;
  try {
    deps.signal?.throwIfAborted();
    cdp.trackSessionTab?.(ctx.sessionId, tid);
    const document = await cdp.send<{ root: { nodeId: number; backendNodeId: number } }>(
      tid,
      "DOM.getDocument",
      { depth: 0 },
    );
    const epoch = document.root.backendNodeId;
    const currentTab = await deps.tabsApi.get(tid);
    const page = {
      tabId: tid,
      url: currentTab.url ?? "",
      documentEpoch: epoch,
      observedAt: Date.now(),
    };
    if (r.op === "page") return { ok: true, ...page };
    const url = new URL(page.url);
    if (url.origin !== r.page?.origin || !url.pathname.startsWith(r.page.pathPrefix))
      return fail(
        "Page identity mismatch: expected " +
          r.page?.origin +
          r.page?.pathPrefix +
          "; actual " +
          page.url,
      );
    if (r.documentEpoch !== undefined && epoch !== r.documentEpoch)
      return fail("Document changed; observe again");
    const target = r.target as Target;
    const scope = target.frame?.length
      ? await resolvePipelineDocument(cdp, tid, target.frame, group)
      : { target: { tabId: tid }, ...document.root, frame: undefined };
    frameTarget = scope.target;
    const scopedSend = <T = unknown>(method: string, args?: object) =>
      sendToCdpTarget<T>(cdp, scope.target, method, args);
    if (
      scope.frame &&
      !read &&
      (r.frameId !== scope.frame.frameId || r.frameEpoch !== scope.backendNodeId)
    )
      return fail("Frame document changed; observe again");
    const frameEvidence = scope.frame
      ? { frameId: scope.frame.frameId, frameEpoch: scope.backendNodeId }
      : {};
    let backendIds: number[];
    if (target.selector) {
      const nodes = await scopedSend<{ nodeIds: number[] }>("DOM.querySelectorAll", {
        nodeId: scope.nodeId,
        selector: target.selector,
      });
      if (nodes.nodeIds.length > 200) return fail("Too many candidates");
      backendIds = [];
      for (const nodeId of nodes.nodeIds) {
        const node = await scopedSend<{ node: { backendNodeId: number } }>("DOM.describeNode", {
          nodeId,
        });
        backendIds.push(node.node.backendNodeId);
      }
    } else {
      const ax = await scopedSend<{
        nodes: {
          backendDOMNodeId?: number;
          ignored?: boolean;
          role?: { value: string };
          name?: { value: string };
        }[];
      }>("Accessibility.queryAXTree", {
        nodeId: scope.nodeId,
        role: target.role,
        accessibleName: target.name,
      });
      backendIds = [
        ...new Set(
          ax.nodes
            .filter(
              (n) =>
                !n.ignored &&
                n.role?.value === target.role &&
                n.name?.value === target.name &&
                n.backendDOMNodeId,
            )
            .map((n) => n.backendDOMNodeId as number),
        ),
      ];
      if (backendIds.length > 200) return fail("Too many candidates");
    }
    const inspect = async (objectId: string, point?: { x: number; y: number }): Promise<Facts> => {
      const reply = await scopedSend<{ result?: { value?: Facts }; exceptionDetails?: unknown }>(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: facts.toString(),
          arguments: [{ value: target }, ...(point ? [{ value: point }] : [])],
          returnByValue: true,
        },
      );
      if (reply.exceptionDetails || !reply.result?.value) throw new Error("Cannot inspect target");
      return reply.result.value;
    };
    const matches: { backendId: number; objectId: string; facts: Facts }[] = [];
    for (const backendId of backendIds) {
      deps.signal?.throwIfAborted();
      const node = await scopedSend<{ object: { objectId?: string } }>("DOM.resolveNode", {
        backendNodeId: backendId,
        objectGroup: group,
      });
      if (!node.object.objectId) continue;
      const f = await inspect(node.object.objectId);
      if (f.connected && f.matches)
        matches.push({ backendId, objectId: node.object.objectId, facts: f });
    }
    if (read && target.prepare && matches.length === 1) {
      const candidate = matches[0]!;
      if (candidate.facts.visible) {
        await scopedSend("DOM.scrollIntoViewIfNeeded", { backendNodeId: candidate.backendId });
        // Scrolling can trigger lazy rendering; read the same target again before readiness checks.
        candidate.facts = await inspect(candidate.objectId);
        if (!candidate.facts.connected || !candidate.facts.matches) matches.length = 0;
      }
    }
    if (read)
      return {
        ok: true,
        ...page,
        ...frameEvidence,
        prepared: target.prepare === true,
        count: matches.length,
        facts: matches.length === 1 ? matches[0]?.facts : null,
      };
    if (matches.length !== 1)
      return fail("Target must match exactly once; matched " + matches.length);
    const selected = matches[0];
    if (
      !selected ||
      !selected.facts.visible ||
      !selected.facts.enabled ||
      (r.op === "fill" && !selected.facts.editable)
    )
      return fail("Target is not actionable");
    const ref = "pipeline-" + crypto.randomUUID();
    ctx.refStore.set(ref, selected.backendId, {
      tabId: tid,
      ...(scope.frame ? { frameId: scope.frame.frameId } : {}),
      ...(scope.target.sessionId ? { cdpSessionId: scope.target.sessionId } : {}),
    });
    const dispatch = async <T = unknown>(
      address: CdpTarget,
      method: string,
      args?: object,
    ): Promise<T> => {
      deps.signal?.throwIfAborted();
      if (
        method.startsWith("Input.") ||
        method === "DOM.focus" ||
        method === "Runtime.callFunctionOn"
      ) {
        const doc = await cdp.send<{ root: { backendNodeId: number } }>(tid, "DOM.getDocument", {
          depth: 0,
        });
        const current = await deps.tabsApi.get(tid);
        if (doc.root.backendNodeId !== epoch || current.url !== page.url)
          throw new Error("Page changed before dispatch");
        if (scope.frame) {
          const liveScope = await resolvePipelineDocument(cdp, tid, target.frame!, group);
          if (
            liveScope.frame?.frameId !== scope.frame.frameId ||
            liveScope.backendNodeId !== scope.backendNodeId ||
            liveScope.target.sessionId !== scope.target.sessionId
          )
            throw new Error("Frame changed before dispatch");
        }
        const pointArgs = args as { x?: number; y?: number } | undefined;
        const point =
          typeof pointArgs?.x === "number" && typeof pointArgs.y === "number"
            ? { x: pointArgs.x, y: pointArgs.y }
            : undefined;
        const live = await inspect(selected.objectId, scope.frame ? undefined : point);
        if (!live.connected || !live.matches || !live.enabled || !live.visible || !live.hit)
          throw new Error("Target changed or became blocked before dispatch");
        if (scope.frame && point) {
          const hit = await sendToCdpTarget<{ backendNodeId: number; frameId?: string }>(
            cdp,
            address,
            "DOM.getNodeForLocation",
            { x: Math.round(point.x), y: Math.round(point.y) },
          );
          if (hit.frameId !== scope.frame.frameId) throw new Error("Frame target is occluded");
          const node = await scopedSend<{ object: { objectId?: string } }>("DOM.resolveNode", {
            backendNodeId: hit.backendNodeId,
            objectGroup: group,
          });
          if (!node.object.objectId) throw new Error("Cannot inspect pointer hit");
          const contains = await scopedSend<{ result: { value?: boolean } }>(
            "Runtime.callFunctionOn",
            {
              objectId: selected.objectId,
              functionDeclaration:
                "function(other) { return this === other || this.contains(other); }",
              arguments: [{ objectId: node.object.objectId }],
              returnByValue: true,
            },
          );
          if (contains.result.value !== true) throw new Error("Frame target is occluded");
        }
      }
      if (
        method.startsWith("Input.") ||
        method === "DOM.focus" ||
        method === "Runtime.callFunctionOn" ||
        method === "DOM.scrollIntoViewIfNeeded"
      )
        phase = "may_have_executed";
      return sendToCdpTarget<T>(cdp, address, method, args);
    };
    const guardedCdp = {
      ...cdp,
      trackSessionTab: cdp.trackSessionTab?.bind(cdp),
      getFrameGraph: cdp.getFrameGraph?.bind(cdp),
      send: <T = unknown>(tabId: number, method: string, args?: object) =>
        dispatch<T>({ tabId }, method, args),
      sendToTarget: dispatch,
    };
    const actionDeps = { ...deps, cdp: guardedCdp };
    const p = { session_id: params.session_id, tab_id: tid, ref };
    const result =
      r.op === "click"
        ? await handleClick(manager, p, actionDeps)
        : r.op === "fill"
          ? await handleFill(manager, { ...p, value: String(r.value) }, actionDeps)
          : r.op === "select"
            ? await handleSelect(manager, { ...p, values: [String(r.value)] }, actionDeps)
            : r.op === "press"
              ? await handlePress(manager, { ...p, key: String(r.value) }, actionDeps)
              : await handleHover(manager, p, actionDeps);
    if (isRpcError(result)) return fail(result.message);
    return { ok: true, phase: "input_acknowledged", requestId: r.requestId, ...page };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Pipeline failed");
  } finally {
    await cdp.send(tid, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
    if (frameTarget?.sessionId)
      await sendToCdpTarget(cdp, frameTarget, "Runtime.releaseObjectGroup", {
        objectGroup: group,
      }).catch(() => {});
  }
}
