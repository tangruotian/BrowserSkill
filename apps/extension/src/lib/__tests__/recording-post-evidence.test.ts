import { expect, it, vi } from "vitest";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import type { RecordingObservationSession } from "../recording/observation-session";
import { localAfter } from "../recording/post-evidence";
import { SettleController } from "../recording/settle-controller";

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
