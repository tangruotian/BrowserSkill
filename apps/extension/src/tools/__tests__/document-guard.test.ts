import { describe, expect, it, vi } from "vitest";
import { guardedCdp } from "../document-guard";
import type { CdpRunner } from "../shared";
import { RefStore } from "@/session-manager/ref-store";
import type { SessionContext } from "@/session-manager/manager";

/** 最后一刻输入边界：页面已换文档时必须零 Input 派发，清理命令仍能执行。 */
describe("document guard", () => {
  function fixture() {
    let epoch = 100;
    const send = vi.fn(async (_tab: number, method: string) =>
      method === "DOM.getDocument" ? { root: { backendNodeId: epoch } } : {},
    );
    const cdp: CdpRunner = { send: send as CdpRunner["send"], getAttachmentId: () => "attachment" };
    const ctx: SessionContext = {
      sessionId: "session",
      mode: "current_tab",
      agentWindowId: 1,
      attachedTabId: 7,
      fallbackCreated: false,
      refStore: new RefStore(),
      borrowedTabs: new Map(),
      agentCreatedTabs: new Set(),
      createdAtMs: 0,
      browserGuard: { tabId: 7, documentEpoch: 100, attachmentId: "attachment" },
    };
    return {
      send,
      proxy: guardedCdp(cdp, ctx),
      change: () => {
        epoch++;
      },
    };
  }
  it("validates document immediately before input", async () => {
    const f = fixture();
    await f.proxy.send(7, "Input.dispatchMouseEvent", {});
    expect(f.send.mock.calls.map((call) => call[1])).toEqual([
      "DOM.getDocument",
      "Input.dispatchMouseEvent",
    ]);
  });
  it("changed document blocks input and still permits cleanup", async () => {
    const f = fixture();
    f.change();
    await expect(f.proxy.send(7, "Input.dispatchKeyEvent", {})).rejects.toThrow("文档已变化");
    await f.proxy.send(7, "Emulation.setFocusEmulationEnabled", { enabled: false });
    expect(f.send.mock.calls.some((call) => call[1].startsWith("Input."))).toBe(false);
  });
  it("cannot redirect a guarded action to another tab", async () => {
    const f = fixture();
    await expect(f.proxy.send(8, "Runtime.evaluate", {})).rejects.toThrow("跨页签");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("releases an already pressed button after navigation without allowing another press", async () => {
    const f = fixture();
    await f.proxy.send(7, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
    f.change();
    await f.proxy.send(7, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left" });
    await expect(
      f.proxy.send(7, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left" }),
    ).rejects.toThrow("文档已变化");
    expect(f.send.mock.calls.filter((call) => call[1] === "Input.dispatchMouseEvent")).toHaveLength(
      2,
    );
  });
});
