/** 新搜索的恢复入口：不读取旧 tab，不抢占其他会话，也不启动新浏览器窗口。 */
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { handleSessionStart } from "../session";

function fixture(signal?: AbortController) {
  const currentTab = {
    getLastFocusedActiveTab: vi.fn(async () => ({
      windowId: 1,
      tabId: 7,
      url: "https://existing.test",
    })),
    getTab: vi.fn(async () => {
      throw new Error("No tab with id: 7.");
    }),
    createWorkTab: vi.fn(async (windowId: number, url: string) => {
      signal?.abort();
      return { windowId, tabId: 8, url };
    }),
    removeWorkTab: vi.fn(async () => {}),
  };
  const agentWindow = { create: vi.fn(), ensureActiveTab: vi.fn(), remove: vi.fn() };
  return { currentTab, agentWindow, manager: new SessionManager({ currentTab, agentWindow }) };
}

describe("显式新建工作标签页", () => {
  it("活动页被另一会话占用时仍新建工作页，保留原会话", async () => {
    const f = fixture();
    const original = await f.manager.start("old", { mode: "current_tab" });
    const result = await handleSessionStart(f.manager, {
      session_id: "new",
      mode: "current_tab",
      new_tab: true,
    });
    expect(result).toMatchObject({ attached_tab_id: 8, fallback_created: true });
    expect(original.attachedTabId).toBe(7);
    expect(f.currentTab.getTab).not.toHaveBeenCalled();
    expect(f.currentTab.createWorkTab).toHaveBeenCalledExactlyOnceWith(1, "about:blank");
    expect(f.agentWindow.create).not.toHaveBeenCalled();
  });

  it("创建期间取消只移除本次新页，不能关闭用户原页", async () => {
    const cancel = new AbortController(),
      f = fixture(cancel);
    const result = await handleSessionStart(
      f.manager,
      { session_id: "new", mode: "current_tab", new_tab: true },
      { signal: cancel.signal },
    );
    expect(result).toMatchObject({ code: "cancelled" });
    expect(f.currentTab.removeWorkTab).toHaveBeenCalledExactlyOnceWith(8);
    expect(f.agentWindow.remove).not.toHaveBeenCalled();
  });

  it("拒绝精确附着与新建的冲突，以及非 current_tab 新建请求", async () => {
    const f = fixture();
    for (const params of [
      { session_id: "new", mode: "current_tab" as const, new_tab: true, attach_tab_id: 7 },
      { session_id: "new", new_tab: true },
    ])
      expect(await handleSessionStart(f.manager, params)).toMatchObject({ code: "invalid_params" });
    expect(f.currentTab.createWorkTab).not.toHaveBeenCalled();
    expect(f.agentWindow.create).not.toHaveBeenCalled();
  });
});
