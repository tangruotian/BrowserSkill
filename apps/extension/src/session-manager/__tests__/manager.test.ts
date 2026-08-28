import { describe, expect, it, vi } from "vitest";
import type { AgentWindowApi, AgentWindowCreateOptions } from "../agent-window";
import { SessionManager } from "../manager";

function fakeAgentWindow(): AgentWindowApi & {
  createMock: ReturnType<typeof vi.fn>;
  removeMock: ReturnType<typeof vi.fn>;
  ensureActiveTabMock: ReturnType<typeof vi.fn>;
} {
  let nextId = 100;
  const createMock = vi.fn(async (_url: string, _opts?: AgentWindowCreateOptions) => {
    const id = nextId++;
    return id;
  });
  const removeMock = vi.fn(async (_id: number) => {});
  const ensureActiveTabMock = vi.fn(async (_windowId: number, _url: string) => {});
  return {
    create: createMock,
    remove: removeMock,
    ensureActiveTab: ensureActiveTabMock,
    createMock,
    removeMock,
    ensureActiveTabMock,
  };
}

describe("SessionManager", () => {
  it("creates an Agent Window when starting a session", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw, now: () => 1700000000000 });
    const ctx = await sm.start("aa11");
    expect(aw.createMock).toHaveBeenCalledOnce();
    expect(aw.createMock).toHaveBeenCalledWith("about:blank", {});
    expect(aw.ensureActiveTabMock).toHaveBeenCalledOnce();
    expect(aw.ensureActiveTabMock).toHaveBeenCalledWith(100, "about:blank");
    expect(ctx.sessionId).toBe("aa11");
    expect(ctx.mode).toBe("agent_window");
    expect(ctx.agentWindowId).toBe(100);
    expect(ctx.createdAtMs).toBe(1700000000000);
    expect(ctx.refStore.isEmpty()).toBe(true);
    expect(ctx.borrowedTabs.size).toBe(0);
  });
  it("forwards an optional window size when starting a session", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11", { size: { width: 1280, height: 800 } });
    expect(aw.createMock).toHaveBeenCalledWith("about:blank", {
      size: { width: 1280, height: 800 },
    });
    expect(ctx.agentWindowId).toBe(100);
  });

  it("forwards an explicit unfocused start to the Agent Window", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });

    await sm.start("aa11", { focused: false });

    expect(aw.createMock).toHaveBeenCalledWith("about:blank", { focused: false });
  });

  it("indexes the session by sessionId and agent window id", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    expect(sm.has("aa11")).toBe(true);
    expect(sm.get("aa11")).toBe(ctx);
    expect(sm.findByWindowId(ctx.agentWindowId)).toBe(ctx);
    expect(sm.findByWindowId(99999)).toBeNull();
    expect(sm.list().length).toBe(1);
  });

  it("rejects starting the same session twice", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
    await sm.start("aa11");
    await expect(sm.start("aa11")).rejects.toThrow(/already exists/);
  });

  it("removes a newly created Agent Window when startup is aborted", async () => {
    const aw = fakeAgentWindow();
    let resolveCreate: (windowId: number) => void = () => {};
    aw.createMock.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const sm = new SessionManager({ agentWindow: aw });
    const controller = new AbortController();
    const pending = sm.start("aa11", { signal: controller.signal });

    controller.abort();
    resolveCreate(777);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(aw.removeMock).toHaveBeenCalledWith(777);
    expect(sm.has("aa11")).toBe(false);
  });

  it("removes an incomplete Agent Window when active-tab setup fails", async () => {
    const aw = fakeAgentWindow();
    aw.ensureActiveTabMock.mockRejectedValueOnce(new Error("tab setup failed"));
    const sm = new SessionManager({ agentWindow: aw });

    await expect(sm.start("aa11")).rejects.toThrow("tab setup failed");

    expect(aw.removeMock).toHaveBeenCalledWith(100);
    expect(sm.has("aa11")).toBe(false);
  });

  it("surfaces the orphan Agent Window id when startup cleanup fails", async () => {
    const aw = fakeAgentWindow();
    aw.ensureActiveTabMock.mockRejectedValueOnce(new Error("tab setup failed"));
    aw.removeMock.mockRejectedValueOnce(new Error("window removal denied"));
    const sm = new SessionManager({ agentWindow: aw });

    await expect(sm.start("aa11")).rejects.toMatchObject({
      name: "SessionStartCleanupError",
      windowId: 100,
      message: expect.stringMatching(/cleanup of Agent Window 100 failed.*window removal denied/),
    });
    expect(sm.has("aa11")).toBe(false);
  });

  it("stop() closes the Agent Window and forgets the session", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    const removed = await sm.stop("aa11");
    expect(removed).toBe(ctx);
    expect(aw.removeMock).toHaveBeenCalledWith(ctx.agentWindowId);
    expect(sm.has("aa11")).toBe(false);
    expect(sm.findByWindowId(ctx.agentWindowId)).toBeNull();
  });

  it("stop({ dropOnly: true }) skips the chrome.windows.remove call", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    await sm.start("aa11");
    await sm.stop("aa11", { dropOnly: true });
    expect(aw.removeMock).not.toHaveBeenCalled();
    expect(sm.has("aa11")).toBe(false);
  });

  it("attaches the last-focused active tab without creating a window", async () => {
    const aw = fakeAgentWindow();
    const currentTab = {
      getLastFocusedActiveTab: vi.fn(async () => ({ windowId: 55, tabId: 77 })),
    };
    const sm = new SessionManager({ agentWindow: aw, currentTab, now: () => 1700000000000 });

    const ctx = await sm.start("aa11", { mode: "current_tab" });

    expect(currentTab.getLastFocusedActiveTab).toHaveBeenCalledOnce();
    expect(aw.createMock).not.toHaveBeenCalled();
    expect(ctx).toMatchObject({
      sessionId: "aa11",
      mode: "current_tab",
      agentWindowId: 55,
      attachedTabId: 77,
      createdAtMs: 1700000000000,
    });
    expect(sm.findByWindowId(55)).toBeNull();
    expect(sm.findByTabId(77)).toBe(ctx);
  });

  it("creates and binds a work tab when the current tab has a restricted URL", async () => {
    const aw = fakeAgentWindow();
    const currentTab = {
      getLastFocusedActiveTab: vi.fn(async () => ({
        windowId: 55,
        tabId: 77,
        url: "chrome://extensions/",
      })),
      createWorkTab: vi.fn(async () => ({
        windowId: 55,
        tabId: 88,
        url: "about:blank",
      })),
      removeWorkTab: vi.fn(async () => {}),
    };
    const sm = new SessionManager({ agentWindow: aw, currentTab });

    const ctx = await sm.start("aa11", { mode: "current_tab" });

    expect(currentTab.createWorkTab).toHaveBeenCalledWith(55, "about:blank");
    expect(currentTab.removeWorkTab).not.toHaveBeenCalled();
    expect(ctx).toMatchObject({
      mode: "current_tab",
      agentWindowId: 55,
      attachedTabId: 88,
      fallbackCreated: true,
    });
    expect(sm.findByTabId(77)).toBeNull();
    expect(sm.findByTabId(88)).toBe(ctx);
  });

  it("stopping an attached session preserves the user's tab and window", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({
      agentWindow: aw,
      currentTab: { getLastFocusedActiveTab: async () => ({ windowId: 55, tabId: 77 }) },
    });
    await sm.start("aa11", { mode: "current_tab" });

    await sm.stop("aa11");

    expect(aw.removeMock).not.toHaveBeenCalled();
    expect(sm.findByTabId(77)).toBeNull();
  });

  it("rejects attaching a tab already controlled by another session", async () => {
    const currentTab = { getLastFocusedActiveTab: async () => ({ windowId: 55, tabId: 77 }) };
    const sm = new SessionManager({ agentWindow: fakeAgentWindow(), currentTab });
    await sm.start("aa11", { mode: "current_tab" });

    await expect(sm.start("bb22", { mode: "current_tab" })).rejects.toThrow(
      /already attached by session aa11/,
    );
  });

  it("treats an attached tab as reserved from other sessions", async () => {
    const sm = new SessionManager({
      agentWindow: fakeAgentWindow(),
      currentTab: { getLastFocusedActiveTab: async () => ({ windowId: 55, tabId: 77 }) },
    });
    await sm.start("aa11", { mode: "current_tab" });

    expect(sm.findBorrowingSession(77, "bb22")).toBe("aa11");
    expect(sm.findBorrowingSession(77, "aa11")).toBeNull();
  });

  it("stopAll() drops every session and returns their ids", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    await sm.start("aa11");
    await sm.start("bb22");
    const dropped = await sm.stopAll();
    expect(dropped.sort()).toEqual(["aa11", "bb22"]);
    expect(sm.list()).toEqual([]);
  });

  describe("findBorrowingSession", () => {
    it("returns null when no session has borrowed the tab", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      await sm.start("aa11");
      expect(sm.findBorrowingSession(42, "aa11")).toBeNull();
      expect(sm.findBorrowingSession(42, null)).toBeNull();
    });

    it("ignores borrows held by the calling session itself", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const ctx = await sm.start("aa11");
      ctx.borrowedTabs.set(42, { tabId: 42, originalWindowId: 7, originalIndex: 3 });
      expect(sm.findBorrowingSession(42, "aa11")).toBeNull();
    });

    it("reports the borrowing session id when a different session holds the tab", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const a = await sm.start("aa11");
      await sm.start("bb22");
      a.borrowedTabs.set(42, { tabId: 42, originalWindowId: 7, originalIndex: 3 });
      expect(sm.findBorrowingSession(42, "bb22")).toBe("aa11");
      // currentSessionId=null asks "is anyone borrowing this tab?"
      expect(sm.findBorrowingSession(42, null)).toBe("aa11");
    });
  });
});
