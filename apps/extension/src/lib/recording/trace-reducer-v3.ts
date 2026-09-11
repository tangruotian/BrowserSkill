import type { NavigationCause, StepV3 } from "@/transport/types";
import { shouldIncludeDraft } from "./draft-policy";
import { hasRedirectQualifier } from "./navigation-policy";
import { unmatchedTarget } from "./target-matcher";
import type { RecordingDraftStep } from "./types";

interface CollapsedDraft {
  draft: RecordingDraftStep;
  draftIds: number[];
}

const TRANSITION_CAUSES: Record<string, NavigationCause> = {
  typed: "user_typed",
  generated: "user_typed",
  keyword: "user_typed",
  keyword_generated: "user_typed",
  link: "link",
  form_submit: "form_submit",
  reload: "reload",
  auto_bookmark: "browser",
  start_page: "browser",
};

function isRedirect(step: Extract<RecordingDraftStep, { op: "navigate" }>): boolean {
  return hasRedirectQualifier(step.transitionQualifiers);
}

function collapseRedirects(steps: RecordingDraftStep[]): CollapsedDraft[] {
  // 排除 observedAt/after 等每次都会变化的字段，否则真实双击永远无法合并。
  const targetIdentity = (step: RecordingDraftStep) =>
    "captureTarget" in step
      ? JSON.stringify({
          selector: step.captureTarget?.evidence?.selector,
          role: step.captureTarget?.role,
          name: step.captureTarget?.name,
          geometry: step.captureTarget?.evidence?.selector ? undefined : step.targetHint?.geometry,
        })
      : undefined;
  const output: CollapsedDraft[] = [];
  steps.forEach((step, index) => {
    const previous = output[output.length - 1];
    if (
      step.op === "navigate" &&
      previous?.draft.op === "navigate" &&
      isRedirect(step) &&
      step.pageIdentity === previous.draft.pageIdentity
    ) {
      previous.draft = {
        ...previous.draft,
        url: step.url,
        postStateId: step.postStateId ?? previous.draft.postStateId,
      };
      previous.draftIds.push(index + 1);
      return;
    }
    // 浏览器先派发 detail=1 再派发 detail=2。合并为一个原生双击，保留第一次前态和第二次后态。
    // 页面身份必须明确且相同，不能跨页签/刷新合并同名控件，不能吞掉中间其他操作。
    if (
      step.op === "click" &&
      step.clickCount === 2 &&
      previous?.draft.op === "click" &&
      (previous.draft.clickCount ?? 1) === 1 &&
      (step.button ?? "left") === (previous.draft.button ?? "left") &&
      step.checked === undefined &&
      previous.draft.checked === undefined &&
      !!step.pageIdentity &&
      step.pageIdentity === previous.draft.pageIdentity &&
      targetIdentity(step) === targetIdentity(previous.draft) &&
      step.capturedAt !== undefined &&
      previous.draft.capturedAt !== undefined &&
      step.capturedAt >= previous.draft.capturedAt &&
      step.capturedAt - previous.draft.capturedAt <= 1000
    ) {
      previous.draft = {
        ...step,
        preStateId: previous.draft.preStateId,
        capturedAt: previous.draft.capturedAt,
      };
      previous.draftIds.push(index + 1);
      return;
    }
    output.push({ draft: { ...step }, draftIds: [index + 1] });
    if (step.op === "click" && step.clickCount === 2) {
      // detail=2 却没有可合并的首击时，重放为双击会额外触发一次点击。
      // 保留原始步骤供诊断，并显式阻塞编译，不能猜测两次事件属于同一个目标。
      output.at(-1)!.draft.qualityIssues = ["双击的首击无法与同文档目标对应，请重新录制该动作"];
    }
  });
  return output;
}

function navigationCause(step: Extract<RecordingDraftStep, { op: "navigate" }>): NavigationCause {
  if (step.cause) return step.cause;
  const qualifiers = step.transitionQualifiers ?? [];
  if (qualifiers.includes("forward_back")) return "history";
  if (qualifiers.includes("from_address_bar")) return "user_typed";
  return TRANSITION_CAUSES[step.transitionType ?? ""] ?? "browser";
}

function selection(values: string[], labels?: string[]): Array<{ value: string; label?: string }> {
  return values.map((value, index) => ({
    value,
    ...(labels?.[index] ? { label: labels[index] } : {}),
  }));
}

interface ReduceDraftOptions {
  includeTabSwitches: boolean;
  redactValues: boolean;
}

function reduceDraft(
  draft: RecordingDraftStep,
  id: number,
  options: ReduceDraftOptions,
): StepV3 | null {
  if (!shouldIncludeDraft(draft)) return null;
  if (draft.op === "switch_tab") {
    if (!options.includeTabSwitches || !draft.preStateId || !draft.postStateId) return null;
    return {
      op: "switch_tab",
      id,
      state: draft.preStateId,
      result: { state: draft.postStateId },
    };
  }
  const state = draft.preStateId ?? draft.postStateId;
  const resultState = draft.postStateId ?? draft.preStateId;
  if (!state || !resultState) return null;
  const common = {
    id,
    state,
    result: { state: resultState },
    ...(draft.qualityIssues?.length ? { qualityIssues: draft.qualityIssues } : {}),
    ...(draft.capturedAt !== undefined ? { capturedAt: draft.capturedAt } : {}),
    ...(draft.pageIdentity ? { pageIdentity: draft.pageIdentity } : {}),
    ...(draft.pageUrl ? { pageUrl: draft.pageUrl } : {}),
  };

  switch (draft.op) {
    case "navigate":
      return { op: "navigate", ...common, to: draft.url, cause: navigationCause(draft) };
    case "click":
      return {
        op: "click",
        ...common,
        target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget),
        ...(draft.button ? { button: draft.button } : {}),
        ...(draft.clickCount !== undefined ? { clickCount: draft.clickCount } : {}),
        ...(draft.checked !== undefined ? { checked: draft.checked } : {}),
      };
    case "upload":
      return {
        op: "upload",
        ...common,
        target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget),
        fileCount: draft.fileCount,
      };
    case "hover":
      return {
        op: "hover",
        ...common,
        target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget),
      };
    case "fill":
      const fillIsRedacted = options.redactValues || draft.redacted === true;
      return {
        op: "fill",
        ...common,
        target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget),
        value: fillIsRedacted ? "***" : draft.value,
        commit: draft.commit ?? "blur",
        ...(fillIsRedacted ? { redacted: true } : {}),
      };
    case "press":
      return {
        op: "press",
        ...common,
        key: draft.key,
        ...(draft.captureTarget || draft.matchedTarget
          ? { target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget) }
          : {}),
        ...(draft.modifiers?.length ? { modifiers: draft.modifiers } : {}),
      };
    case "select":
      return {
        op: "select",
        ...common,
        target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget),
        ...(!options.redactValues ? { selection: selection(draft.values, draft.labels) } : {}),
      };
    case "scroll":
      return { op: "scroll", ...common };
  }
}

export interface ReducedTraceV3 {
  steps: StepV3[];
  stepIdByDraftId: Map<number, number>;
}

export function reduceTraceStepsV3(
  steps: RecordingDraftStep[],
  options: { includeTabSwitches?: boolean; redactValues?: boolean } = {},
): ReducedTraceV3 {
  const output: StepV3[] = [];
  const stepIdByDraftId = new Map<number, number>();
  for (const { draft, draftIds } of collapseRedirects(steps)) {
    const step = reduceDraft(draft, output.length + 1, {
      includeTabSwitches: options.includeTabSwitches === true,
      redactValues: options.redactValues === true,
    });
    if (!step) continue;
    output.push(step);
    for (const draftId of draftIds) stepIdByDraftId.set(draftId, step.id);
  }
  return { steps: output, stepIdByDraftId };
}
