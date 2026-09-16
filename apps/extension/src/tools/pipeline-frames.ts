import type { CdpFrame, CdpTarget } from "@/browser-driver/frame-graph";
import { type CdpRunner, sendToCdpTarget } from "./shared";

export interface FrameScope {
  origin: string;
  pathPrefix: string;
}
export interface PipelineDocument {
  frame?: CdpFrame;
  target: CdpTarget;
  nodeId: number;
  backendNodeId: number;
  /** 当前 isolated world 中的文档句柄，仅在本次 objectGroup 生命周期内使用。 */
  objectId?: string;
}
export async function resolvePipelineDocument(
  cdp: CdpRunner,
  tabId: number,
  path: FrameScope[],
  group: string,
): Promise<PipelineDocument> {
  if (!path.length) {
    const doc = await cdp.send<{ root: { nodeId: number; backendNodeId: number } }>(
      tabId,
      "DOM.getDocument",
      { depth: 0 },
    );
    return { target: { tabId }, ...doc.root };
  }
  if (!cdp.getFrameGraph) throw new Error("Frame routing unavailable; update BrowserSkill");
  const graph = await cdp.getFrameGraph(tabId);
  let parent = graph.rootFrameId;
  let selected: CdpFrame | undefined;
  for (const scope of path) {
    const matches = graph.frames.filter((frame) => {
      if (frame.parentFrameId !== parent || !frame.url) return false;
      try {
        const url = new URL(frame.url);
        return url.origin === scope.origin && url.pathname.startsWith(scope.pathPrefix);
      } catch {
        return false;
      }
    });
    if (matches.length !== 1)
      throw new Error("Frame must match exactly once; matched " + matches.length);
    selected = matches[0];
    parent = selected!.frameId;
  }
  if (!selected) throw new Error("Missing frame");
  if (selected.target.sessionId && !cdp.sendToTarget) throw new Error("OOPIF routing unavailable");
  const world = await sendToCdpTarget<{ executionContextId: number }>(
    cdp,
    selected.target,
    "Page.createIsolatedWorld",
    { frameId: selected.frameId, worldName: "bsk-pipeline" },
  );
  const evaluated = await sendToCdpTarget<{ result: { objectId?: string } }>(
    cdp,
    selected.target,
    "Runtime.evaluate",
    { expression: "document", contextId: world.executionContextId, objectGroup: group },
  );
  if (!evaluated.result.objectId) throw new Error("Cannot resolve frame document");
  // 子文档所在 CDP session 必须先启用 DOM 树映射，否则 requestNode 可能返回
  // 无效的前端 nodeId。对象句柄与后端 ID 同时保留，后续读取不必再次 resolveNode。
  await sendToCdpTarget(cdp, selected.target, "DOM.getDocument", { depth: 0 });
  const requested = await sendToCdpTarget<{ nodeId: number }>(
    cdp,
    selected.target,
    "DOM.requestNode",
    { objectId: evaluated.result.objectId },
  );
  const described = await sendToCdpTarget<{ node: { backendNodeId: number } }>(
    cdp,
    selected.target,
    "DOM.describeNode",
    { nodeId: requested.nodeId },
  );
  return {
    frame: selected,
    target: selected.target,
    nodeId: requested.nodeId,
    backendNodeId: described.node.backendNodeId,
    objectId: evaluated.result.objectId,
  };
}
