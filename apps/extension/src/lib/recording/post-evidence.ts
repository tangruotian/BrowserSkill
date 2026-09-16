import { resolvePipelineDocument } from "@/tools/pipeline-frames";
import { type CdpRunner, sendToCdpTarget } from "@/tools/shared";
import type { TargetEvidenceV3 } from "@/transport/types";
import { captureSelection } from "./selection-evidence";
import type { TargetedRecordingDraft } from "./types";

// Runs in the target document; all selectors and expected text are data.
export function localAfter(this: Element, expected?: string) {
  const text = (this.textContent ?? "").trim();
  if (expected !== undefined && text !== expected) return null;
  const ancestors: { selector: string; classes: string[]; attributes: Record<string, string> }[] =
    [];
  let node: Element | null = this;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    const classes = [...node.classList]
      .filter((c) => /^[a-zA-Z_-][a-zA-Z0-9_-]{0,99}$/.test(c))
      .slice(0, 12);
    const stable = classes.filter(
      (c) => !/(selected|checked|active|hover|focus|disabled|highlight)/i.test(c),
    );
    const attributes: Record<string, string> = {};
    for (const key of [
      "role",
      "aria-selected",
      "aria-checked",
      "aria-expanded",
      "aria-multiselectable",
    ])
      if (node.hasAttribute(key)) attributes[key] = node.getAttribute(key)!;
    ancestors.push({
      selector: node.tagName.toLowerCase() + stable.map((c) => "." + CSS.escape(c)).join(""),
      classes,
      attributes,
    });
  }
  const input = this as HTMLInputElement;
  return {
    selection: captureSelection(this),
    status: "observed" as const,
    observedAt: Date.now(),
    url: location.href,
    text: text.slice(0, 1000),
    textTruncated: text.length > 1000,
    value:
      // 文件选择后的 value 是浏览器生成的 fakepath，不属于可移植录制参数。
      // 与密码一样不保存，由 Pipeline 的 file:ID 在运行宿主解析实际文件。
      input.type === "password" || input.type === "file"
        ? null
        : "value" in this
          ? String(input.value).slice(0, 1000)
          : null,
    checked: input.type === "checkbox" || input.type === "radio" ? input.checked : undefined,
    ancestors,
  };
}
export async function captureAfter(
  cdp: CdpRunner,
  tabId: number,
  draft: TargetedRecordingDraft,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const initial = draft.matchedTarget?.evidence ?? draft.captureTarget?.evidence;
  if (!initial?.selector || initial.frame === undefined) return;
  const group = "record-after-" + crypto.randomUUID();
  let target: { tabId: number; sessionId?: string } | undefined;
  let stopped = false;
  const read = async (): Promise<NonNullable<TargetEvidenceV3["after"]>> => {
    const doc = await resolvePipelineDocument(cdp, tabId, initial.frame!, group);
    target = doc.target;
    const send = <T>(method: string, args?: object) =>
      sendToCdpTarget<T>(cdp, doc.target, method, args);
    // frame 解析已获得文档对象时直接复用；主文档使用稳定 backendNodeId，
    // 不再依赖可因 DOM 更新失效的前端 nodeId。这里只重读证据，从不再次派发动作。
    const resolved = doc.objectId
      ? { object: { objectId: doc.objectId } }
      : await send<{ object: { objectId?: string } }>("DOM.resolveNode", {
          backendNodeId: doc.backendNodeId,
          objectGroup: group,
        });
    if (!resolved.object.objectId) throw new Error("Post-action document missing");
    const reader =
      "function(selector, expected) { const captureSelection = " +
      captureSelection.toString() +
      "; const read = " +
      localAfter.toString() +
      "; const fail=code=>({status:'unavailable',observedAt:Date.now(),code,reason:code,url:this.URL}); if(this.defaultView?.document!==this)return fail('document-changed'); const nodes=[...this.querySelectorAll(selector)]; if(nodes.length>100)return fail('ambiguous-target'); const matches=nodes.length===1?nodes:nodes.filter(n=>expected!==undefined && (n.textContent??'').trim()===expected); if(matches.length!==1)return fail(matches.length?'ambiguous-target':'target-detached'); return read.call(matches[0]); }";
    const result = await send<{
      result?: { value?: NonNullable<TargetEvidenceV3["after"]> };
      exceptionDetails?: unknown;
    }>("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: reader,
      arguments: [{ value: initial.selector }, { value: initial.text }],
      returnByValue: true,
    });
    if (result.exceptionDetails || !result.result?.value)
      throw new Error("Post-action target missing or ambiguous");
    // 同 URL 刷新也必须校验文档身份；不能仅凭地址相同接受旧文档的读取结果。
    if (stopped || signal?.aborted) throw new Error("capture-timeout");
    const current = await resolvePipelineDocument(cdp, tabId, initial.frame!, group);
    if (
      current.backendNodeId !== doc.backendNodeId ||
      current.frame?.frameId !== doc.frame?.frameId ||
      current.target.sessionId !== doc.target.sessionId
    )
      throw new Error("document-changed");
    return result.result.value;
  };
  const codeFor = (error: unknown): NonNullable<TargetEvidenceV3["after"]>["code"] => {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out|capture-timeout/i.test(message)) return "capture-timeout";
    if (/Frame must match.*matched 0|Missing frame/i.test(message)) return "frame-navigated";
    if (/ambiguous|Frame must match/i.test(message)) return "ambiguous-target";
    if (
      /document-changed|context.*(destroy|not found)|node.*(invalid|not found)|Could not find node/i.test(
        message,
      )
    )
      return "document-changed";
    if (/target missing|detached/i.test(message)) return "target-detached";
    return "capture-failed";
  };
  // 最多重新观察一次，每次重取当前文档。超时后迟到的 CDP 返回不再触发下一轮读取。
  const observe = async (): Promise<NonNullable<TargetEvidenceV3["after"]>> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await read();
        if (value.status === "observed" || attempt || value.code === "ambiguous-target")
          return value;
      } catch (error) {
        if (
          attempt ||
          !["document-changed", "target-detached", "frame-navigated"].includes(codeFor(error)!)
        )
          throw error;
      }
      if (stopped || signal?.aborted) throw new Error("capture-timeout");
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let after: NonNullable<TargetEvidenceV3["after"]>;
  try {
    after = await Promise.race([
      observe().finally(() => {
        if (target)
          void sendToCdpTarget(cdp, target, "Runtime.releaseObjectGroup", {
            objectGroup: group,
          }).catch(() => {});
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Post-action capture timed out")), 1500);
      }),
    ]);
  } catch (error) {
    after = {
      status: "unavailable",
      observedAt: Date.now(),
      reason: error instanceof Error ? error.message : "capture failed",
      code: codeFor(error),
    };
  } finally {
    stopped = true;
    clearTimeout(timer);
    if (target)
      void sendToCdpTarget(cdp, target, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(
        () => {},
      );
  }
  if (signal?.aborted) return;
  if (after.status === "unavailable" && initial.after?.status === "observed") return;
  if (draft.captureTarget)
    draft.captureTarget.evidence = { ...draft.captureTarget.evidence, after };
  if (draft.matchedTarget)
    draft.matchedTarget.evidence = { ...draft.matchedTarget.evidence, after };
}
