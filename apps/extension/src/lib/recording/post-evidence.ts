import { resolvePipelineDocument } from "@/tools/pipeline-frames";
import { sendToCdpTarget, type CdpRunner } from "@/tools/shared";
import type { TargetedRecordingDraft } from "./types";
import type { TargetEvidenceV3 } from "@/transport/types";

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
    status: "observed" as const,
    observedAt: Date.now(),
    url: location.href,
    text: text.slice(0, 1000),
    textTruncated: text.length > 1000,
    value:
      input.type === "password"
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
  const read = async (): Promise<NonNullable<TargetEvidenceV3["after"]>> => {
    const doc = await resolvePipelineDocument(cdp, tabId, initial.frame!, group);
    target = doc.target;
    const send = <T>(method: string, args?: object) =>
      sendToCdpTarget<T>(cdp, doc.target, method, args);
    const resolved = await send<{ object: { objectId?: string } }>("DOM.resolveNode", {
      nodeId: doc.nodeId,
      objectGroup: group,
    });
    if (!resolved.object.objectId) throw new Error("Post-action document missing");
    const reader =
      "function(selector, expected) { const read = " +
      localAfter.toString() +
      "; const nodes=[...this.querySelectorAll(selector)]; if(nodes.length>100)throw new Error('Too many candidates'); const matches=nodes.length===1?nodes:nodes.filter(n=>expected!==undefined && (n.textContent??'').trim()===expected); if(matches.length!==1)throw new Error('Post-action target missing or ambiguous'); return read.call(matches[0]); }";
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
    return result.result.value;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let after: NonNullable<TargetEvidenceV3["after"]>;
  try {
    after = await Promise.race([
      read().finally(() => {
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
    };
  } finally {
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
