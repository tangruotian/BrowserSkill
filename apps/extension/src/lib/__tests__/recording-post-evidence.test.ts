import { expect, it, vi } from "vitest";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import type { RecordingObservationSession } from "../recording/observation-session";
import { captureAfter, localAfter, postEvidenceSource } from "../recording/post-evidence";
import { captureSelection } from "../recording/selection-evidence";
import { SettleController } from "../recording/settle-controller";
import type { TargetedRecordingDraft } from "../recording/types";

it("captures selected class after click without including transient classes in the locator", () => {
  document.body.innerHTML =
    '<ul class="bk-options"><li class="bk-option is-highlight is-selected"><div class="label">auth</div></li></ul>';
  const after = localAfter.call(document.querySelector(".label")!, "auth");
  expect(after?.ancestors.find((a) => a.selector === "li.bk-option")?.classes).toContain(
    "is-selected",
  );
  expect(after?.observedAt).toBeGreaterThan(0);
  expect(localAfter.call(document.querySelector(".label")!, "env")).toBeNull();
});
it("refreshes the final state at stop even if it already has a post-state", async () => {
  const capture = vi.fn(async () => ({ stateId: "fresh" }));
  const controller = new SettleController({
    session: { capture } as unknown as RecordingObservationSession,
    cdp: {} as CdpRunner,
    tabsApi: {} as ChromeTabsApi,
    tabId: 1,
  });
  const drafts = [{ op: "click" as const, preStateId: "before", postStateId: "stale" }];
  await controller.settleTrailing(drafts);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(drafts[0]?.postStateId).toBe("fresh");
});

// CDP 协议 fixture 用不同 backend ID 模拟同 URL 刷新；读取可以重试，但不得派发 Input。
it.each([false, true])("后置采集使用 backend 身份，文档替换=%s 时仅重读一次", async (replace) => {
  const draft: TargetedRecordingDraft = {
    op: "click",
    matchedTarget: { evidence: { selector: "#execute", frame: [] } },
  };
  let documents = 0;
  const send = vi.fn(async (_tab: number, method: string, args?: Record<string, unknown>) => {
    if (method === "DOM.getDocument")
      return { root: { nodeId: 10, backendNodeId: replace && ++documents > 1 ? 200 : 100 } };
    if (method === "DOM.resolveNode") {
      expect(args).not.toHaveProperty("nodeId");
      return { object: { objectId: "doc" } };
    }
    if (method === "Runtime.callFunctionOn")
      return {
        result: {
          value: {
            status: "observed",
            observedAt: Date.now(),
            url: "https://example.test/console",
          },
        },
      };
    if (method === "Runtime.releaseObjectGroup") return {};
    throw new Error("不应派发 " + method);
  });
  await captureAfter({ send } as unknown as CdpRunner, 4, draft);
  expect(draft.matchedTarget?.evidence?.after?.status).toBe("observed");
  expect(send.mock.calls.filter((call) => call[1] === "Runtime.callFunctionOn")).toHaveLength(
    replace ? 2 : 1,
  );
  expect(send.mock.calls.every((call) => call[0] === 4 && !call[1].startsWith("Input."))).toBe(
    true,
  );
});
it("后置目标歧义是具体缺口，不反复采集也不覆盖已有有效证据", async () => {
  const draft: TargetedRecordingDraft = {
    op: "click",
    matchedTarget: { evidence: { selector: ".execute", frame: [] } },
  };
  const send = vi.fn(async (_tab: number, method: string) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 10, backendNodeId: 100 } };
    if (method === "DOM.resolveNode") return { object: { objectId: "doc" } };
    if (method === "Runtime.callFunctionOn")
      return {
        result: { value: { status: "unavailable", code: "ambiguous-target", observedAt: 1 } },
      };
    return {};
  });
  await captureAfter({ send } as unknown as CdpRunner, 1, draft);
  expect(draft.matchedTarget?.evidence?.after?.code).toBe("ambiguous-target");
  expect(send.mock.calls.filter((call) => call[1] === "Runtime.callFunctionOn")).toHaveLength(1);
});
it("采集真实搜索目标及独立完整已选集合，拒绝省略文字", () => {
  document.body.innerHTML =
    '<div id="services" class="bk-select is-focus"><span id="selected" class="bk-select-name">auth, env</span></div><div id="panel" class="bk-select-dropdown-content"><input id="search"><ul><li class="bk-option">auth</li></ul></div>';
  const panel = document.querySelector("#panel")!;
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  } as DOMRect);
  const evidence = captureSelection(document.querySelector("#services")!);
  expect(evidence?.complete).toBe(true);
  expect(evidence?.selected).toEqual(["auth", "env"]);
  expect(evidence?.config.discovery?.mode).toBe("search");
  expect(document.querySelector(evidence!.config.discovery!.target)?.id).toBe("search");
  document.querySelector("#selected")!.textContent = "auth +2";
  expect(captureSelection(document.querySelector("#services")!)).toBeUndefined();
});

// 必须执行完整的 CDP 序列化源，直接调用 localAfter 会掩盖 import 闭包在浏览器侧丢失。
it("后置采集序列化函数在无模块闭包时仍能调用集合读取器", () => {
  document.body.innerHTML = '<button id="recorded">更新后的文字</button>';
  const read = new Function("return (" + postEvidenceSource() + ")")();
  expect(read.call(document, "#recorded", "旧文字")).toMatchObject({
    status: "observed",
    text: "更新后的文字",
  });
});
