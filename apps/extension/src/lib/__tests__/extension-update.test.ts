import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { ToolDispatcher } from "@/tools/dispatcher";
import type { FrameHandler, Transport } from "@/transport/transport";
import type { ProtocolFrame } from "@/transport/types";
import { ExtensionUpdater, type UpdateCheckResult } from "../extension-update";

function fixture() {
  const listeners = new Set<(details: { version: string }) => void>();
  const runtime = {
    requestUpdateCheck: vi.fn<() => Promise<UpdateCheckResult>>(),
    reload: vi.fn(),
    onUpdateAvailable: {
      addListener: (listener: (details: { version: string }) => void) => listeners.add(listener),
      removeListener: (listener: (details: { version: string }) => void) =>
        listeners.delete(listener),
    },
  };
  const updater = new ExtensionUpdater(runtime);
  return {
    runtime,
    updater,
    available: () => {
      for (const listener of listeners) listener({ version: "0.3.6" });
    },
  };
}

const request = { id: "update", method: "extension.update", params: {} };

describe("managed extension update", () => {
  afterEach(() => vi.restoreAllMocks());

  // 周期自动更新同样直接生效，不需要命令触发，也不检查 session 数量。
  it("reloads immediately on Chrome update notification, once", () => {
    const f = fixture();
    f.available();
    f.available();
    expect(f.runtime.reload).toHaveBeenCalledTimes(1);
    expect(f.runtime.requestUpdateCheck).not.toHaveBeenCalled();
    f.updater.dispose();
  });

  it("sends available version before reload when the callback arrives first", async () => {
    const f = fixture();
    const sent = vi.fn(() => expect(f.runtime.reload).not.toHaveBeenCalled());
    f.runtime.requestUpdateCheck.mockResolvedValue({
      status: "update_available",
      version: "0.3.6",
    });
    await f.updater.handle(request, sent);
    expect(sent).toHaveBeenCalledWith({
      id: "update",
      result: { status: "update_available", version: "0.3.6" },
    });
    expect(f.runtime.reload).toHaveBeenCalledTimes(1);
    f.available();
    expect(f.runtime.reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    "no_update",
    "throttled",
  ] as const)("reports %s without claiming an upgrade or reloading", async (status) => {
    const f = fixture();
    const send = vi.fn();
    f.runtime.requestUpdateCheck.mockResolvedValue({ status });
    await f.updater.handle(request, send);
    expect(send).toHaveBeenCalledWith({ id: "update", result: { status } });
    expect(f.runtime.reload).not.toHaveBeenCalled();
  });

  // 多个部署通知共享检查，但每个请求仍收到独立回执，避免不必要的限频。
  it("coalesces concurrent checks and tolerates a lost reply after reload", async () => {
    const f = fixture();
    let resolve!: (result: UpdateCheckResult) => void;
    f.runtime.requestUpdateCheck.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const send = vi.fn(() => {
      throw new Error("socket closed");
    });
    const first = f.updater.handle(request, send);
    const second = f.updater.handle({ ...request, id: "second" }, send);
    expect(f.runtime.requestUpdateCheck).toHaveBeenCalledTimes(1);
    f.available();
    resolve({ status: "update_available", version: "0.3.6" });
    await Promise.all([first, second]);
    expect(f.runtime.reload).toHaveBeenCalledTimes(1);
  });

  it("reports check failure and allows a later explicit retry", async () => {
    const f = fixture();
    const send = vi.fn();
    f.runtime.requestUpdateCheck.mockRejectedValueOnce(new Error("network failed"));
    await f.updater.handle(request, send);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "protocol_error" }) }),
    );
    f.runtime.requestUpdateCheck.mockResolvedValue({ status: "no_update" });
    await f.updater.handle(request, send);
    expect(f.runtime.requestUpdateCheck).toHaveBeenCalledTimes(2);
  });

  // 真实 dispatcher 路由测试：即使有 session 且审计/普通工具阻塞，更新仍走快路径。
  it("bypasses active sessions and normal tool preparation", async () => {
    const f = fixture();
    f.runtime.requestUpdateCheck.mockResolvedValue({
      status: "update_available",
      version: "0.3.6",
    });
    const handlers = new Set<FrameHandler>();
    const sent: ProtocolFrame[] = [];
    const transport: Transport = {
      state: "connected",
      connect: async () => {},
      disconnect: async () => {},
      send: (frame) => {
        sent.push(frame);
      },
      onMessage: (listener) => {
        handlers.add(listener);
        return { dispose: () => handlers.delete(listener) };
      },
      onConnectionStateChange: () => ({ dispose() {} }),
    };
    const sessions = new SessionManager({
      agentWindow: {
        create: vi.fn(async () => ({ windowId: 20, initialTabIds: [] })),
        remove: vi.fn(),
        ensureActiveTab: vi.fn(),
      },
    });
    await sessions.start("busy");
    const dispatcher = new ToolDispatcher({ transport, sessions, extensionUpdater: f.updater });
    dispatcher.start();
    for (const handler of handlers) handler(request);
    await vi.waitFor(() => expect(f.runtime.reload).toHaveBeenCalledTimes(1));
    expect(sent).toHaveLength(1);
    expect(sessions.list()).toHaveLength(1);
    dispatcher.stop();
  });
});
