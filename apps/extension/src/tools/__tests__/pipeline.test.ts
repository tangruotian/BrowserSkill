import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { InteractionDeps } from "../interaction";
import { handlePipeline, type PipelineParams } from "../pipeline";
import type { CdpRunner } from "../shared";

const action = vi.hoisted(() => vi.fn());
vi.mock("../interaction", () => ({
  handleClick: action,
  handleBlur: action,
  handleFill: action,
  handleSelect: action,
  handlePress: action,
  handleHover: action,
}));
beforeEach(() => {
  action.mockReset();
  action.mockImplementation(async (_manager, p, deps: InteractionDeps) => {
    await deps.cdp.send(p.tab_id, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 10.25,
      y: 10.75,
    });
    return { tab_id: p.tab_id };
  });
});
async function setup(
  options: {
    count?: number;
    needsScroll?: boolean;
    blocked?: boolean;
    enabled?: boolean;
    epochChange?: boolean;
    loseAck?: boolean;
    frame?: boolean;
    frameChange?: boolean;
    occluded?: boolean;
    checkable?: boolean;
    checked?: boolean;
  } = {},
) {
  const manager = new SessionManager({
    agentWindow: {
      create: vi.fn(async () => 100),
      remove: vi.fn(async () => {}),
      ensureActiveTab: vi.fn(async () => 1),
    },
  });
  await manager.start("test-session");
  let scrolled = false;
  let reads = 0;
  let frameReads = 0;
  const send = vi.fn(async (_tab: number, method: string, params?: object): Promise<unknown> => {
    if (method === "DOM.scrollIntoViewIfNeeded") {
      scrolled = true;
      return {};
    }
    if (method === "DOM.getDocument")
      return { root: { nodeId: 1, backendNodeId: options.epochChange && reads++ > 0 ? 20 : 10 } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
    if (method === "Runtime.evaluate") return { result: { objectId: "document" } };
    if (method === "DOM.requestNode") return { nodeId: 20 };
    if (method === "DOM.getNodeForLocation") {
      expect(params).toEqual({ x: 10, y: 11 });
      return { backendNodeId: 102, frameId: options.occluded ? "root" : "child" };
    }
    if (method === "DOM.describeNode" && (params as { nodeId: number }).nodeId === 20)
      return { node: { backendNodeId: options.frameChange && frameReads++ > 0 ? 201 : 200 } };
    if (
      method === "Runtime.callFunctionOn" &&
      (params as { functionDeclaration: string }).functionDeclaration.includes(
        "this.contains(other)",
      )
    )
      return { result: { value: true } };
    if (method === "DOM.querySelectorAll")
      return { nodeIds: Array.from({ length: options.count ?? 1 }, (_, i) => i + 2) };
    if (method === "DOM.describeNode")
      return { node: { backendNodeId: (params as { nodeId: number }).nodeId + 100 } };
    if (method === "DOM.resolveNode")
      return {
        object: { objectId: "object-" + (params as { backendNodeId: number }).backendNodeId },
      };
    if (method === "Runtime.callFunctionOn")
      return {
        result: {
          value: {
            matches: true,
            connected: true,
            enabled: options.enabled ?? true,
            visible: true,
            editable: true,
            hit: !options.blocked && (!options.needsScroll || scrolled),
            text: "C-42",
            value: "C-42",
            checked: false,
            ...(options.checkable ? { checkable: true, checked: options.checked ?? false } : {}),
          },
        },
      };
    if (method === "Runtime.releaseObjectGroup") return {};
    if (method === "Input.dispatchMouseEvent") {
      if (options.loseAck) throw new Error("transport disconnected");
      return {};
    }
    throw new Error("Unexpected CDP method " + method);
  });
  const cdp = {
    send,
    getFrameGraph: async () => ({
      rootFrameId: "root",
      frames: [
        { frameId: "root", target: { tabId: 1 }, url: "https://example.test/customers" },
        {
          frameId: "child",
          parentFrameId: "root",
          target: { tabId: 1 },
          url: "https://child.test/form",
        },
      ],
    }),
  } as unknown as CdpRunner;
  const tab = {
    id: 1,
    windowId: 100,
    active: true,
    url: "https://example.test/customers",
  } as chrome.tabs.Tab;
  const deps: InteractionDeps = {
    cdp,
    tabsApi: { get: vi.fn(async () => tab), query: vi.fn(async () => [tab]) },
  };
  const params: PipelineParams = {
    session_id: "test-session",
    tab_id: 1,
    request: {
      version: 1,
      op: "click",
      requestId: "attempt-1",
      documentEpoch: 10,
      page: { origin: "https://example.test", pathPrefix: "/customers" },
      target: { selector: "#save", identity: [] },
    },
  };
  if (options.frame) {
    params.request.target!.frame = [{ origin: "https://child.test", pathPrefix: "/form" }];
    params.request.frameId = "child";
    params.request.frameEpoch = 200;
  }
  return { manager, params, deps, send };
}
describe("guarded Pipeline RPC", () => {
  it("输入提交保留 fill 与 blur 两个原生阶段", async () => {
    const s = await setup();
    s.params.request.op = "fill";
    s.params.request.value = "value";
    s.params.request.commit = "blur";
    expect(await handlePipeline(s.manager, s.params, false, s.deps)).toMatchObject({ ok: true });
    expect(action).toHaveBeenCalledTimes(2);
  });
  it("双击与右键直接传给原生动作，不能降级成默认左键", async () => {
    const s = await setup();
    s.params.request.button = "right";
    s.params.request.clickCount = 2;
    expect(await handlePipeline(s.manager, s.params, false, s.deps)).toMatchObject({ ok: true });
    expect(action.mock.calls[0]?.[1]).toMatchObject({ button: "right", click_count: 2 });
  });
  it("达到期望勾选状态时不再点击，不把已选中的控件取消选中", async () => {
    const s = await setup({ checkable: true, checked: true });
    s.params.request.checked = true;
    expect(await handlePipeline(s.manager, s.params, false, s.deps)).toMatchObject({
      ok: true,
      phase: "input_acknowledged",
    });
    expect(action).not.toHaveBeenCalled();
  });
  it("勾选动作已派发但状态未生效时回报未知，不能返回成功回执", async () => {
    const s = await setup({ checkable: true });
    s.params.request.checked = true;
    expect(await handlePipeline(s.manager, s.params, false, s.deps)).toMatchObject({
      ok: false,
      phase: "may_have_executed",
    });
  });
  it("rejects mutation through the passive-read endpoint", async () => {
    const s = await setup();
    expect(await handlePipeline(s.manager, s.params, true, s.deps)).toMatchObject({
      ok: false,
      phase: "not_started",
    });
    expect(action).not.toHaveBeenCalled();
  });
  it("requires unique matching targets instead of choosing the first", async () => {
    const s = await setup({ count: 2 });
    expect(await handlePipeline(s.manager, s.params, false, s.deps)).toMatchObject({
      ok: false,
      phase: "not_started",
    });
    expect(action).not.toHaveBeenCalled();
  });
  it("rejects page identity mismatch before any gesture", async () => {
    const s = await setup();
    s.params.request.page!.origin = "https://other.test";
    expect(await handlePipeline(s.manager, s.params, false, s.deps)).toMatchObject({
      ok: false,
      phase: "not_started",
    });
    expect(action).not.toHaveBeenCalled();
  });
  it("rejects stale document observations and disabled controls", async () => {
    const stale = await setup();
    stale.params.request.documentEpoch = 999;
    expect(await handlePipeline(stale.manager, stale.params, false, stale.deps)).toMatchObject({
      ok: false,
      phase: "not_started",
    });
    const disabled = await setup({ enabled: false });
    expect(
      await handlePipeline(disabled.manager, disabled.params, false, disabled.deps),
    ).toMatchObject({ ok: false, phase: "not_started" });
    expect(action).not.toHaveBeenCalled();
  });
  it("rechecks document identity immediately before Input dispatch", async () => {
    const s = await setup({ epochChange: true });
    expect(await handlePipeline(s.manager, s.params, false, s.deps)).toMatchObject({
      ok: false,
      phase: "not_started",
    });
    expect(s.send.mock.calls.some((c) => c[1] === "Input.dispatchMouseEvent")).toBe(false);
  });
  it("marks a lost Input acknowledgement as possibly executed", async () => {
    const s = await setup({ loseAck: true });
    expect(await handlePipeline(s.manager, s.params, false, s.deps)).toMatchObject({
      ok: false,
      phase: "may_have_executed",
      requestId: "attempt-1",
    });
  });
  it("returns correlated input acknowledgement, not business success", async () => {
    const s = await setup();
    expect(await handlePipeline(s.manager, s.params, false, s.deps)).toMatchObject({
      ok: true,
      phase: "input_acknowledged",
      requestId: "attempt-1",
      tabId: 1,
      documentEpoch: 10,
    });
  });
  it("reports zero matches as read evidence without executing a gesture", async () => {
    const s = await setup({ count: 0 });
    s.params.request.op = "read";
    expect(await handlePipeline(s.manager, s.params, true, s.deps)).toMatchObject({
      ok: true,
      count: 0,
      facts: null,
    });
    expect(action).not.toHaveBeenCalled();
  });
});

it("returns child document identity with read evidence", async () => {
  const s = await setup({ frame: true });
  s.params.request.op = "read";
  expect(await handlePipeline(s.manager, s.params, true, s.deps)).toMatchObject({
    ok: true,
    frameId: "child",
    frameEpoch: 200,
    count: 1,
  });
  expect(s.send).toHaveBeenCalledWith(1, "DOM.querySelectorAll", { nodeId: 20, selector: "#save" });
});
it("dispatches a validated frame click", async () => {
  const s = await setup({ frame: true });
  expect(await handlePipeline(s.manager, s.params, false, s.deps)).toMatchObject({
    ok: true,
    phase: "input_acknowledged",
  });
});
it.each([
  { frameChange: true },
  { occluded: true },
])("rejects frame changes and overlays before Input (%j)", async (option) => {
  const s = await setup({ frame: true, ...option });
  expect(await handlePipeline(s.manager, s.params, false, s.deps)).toMatchObject({
    ok: false,
    phase: "not_started",
  });
  expect(s.send.mock.calls.some((c) => c[1] === "Input.dispatchMouseEvent")).toBe(false);
});

it("scrolls a unique iframe target before testing obstruction, without clicking", async () => {
  const s = await setup({ frame: true, needsScroll: true });
  s.params.request.op = "read";
  s.params.request.target!.prepare = true;
  const result = await handlePipeline(s.manager, s.params, true, s.deps);
  expect(result).toMatchObject({ ok: true, prepared: true, count: 1, facts: { hit: true } });
  expect(s.send).toHaveBeenCalledWith(1, "DOM.scrollIntoViewIfNeeded", { backendNodeId: 102 });
  expect(action).not.toHaveBeenCalled();
});
it("preserves a real obstruction after scrolling", async () => {
  const s = await setup({ needsScroll: true, blocked: true });
  s.params.request.op = "read";
  s.params.request.target!.prepare = true;
  expect(await handlePipeline(s.manager, s.params, true, s.deps)).toMatchObject({
    facts: { hit: false },
  });
  expect(action).not.toHaveBeenCalled();
});
it.each([0, 2])("does not scroll missing or ambiguous targets (count=%s)", async (count) => {
  const s = await setup({ count });
  s.params.request.op = "read";
  s.params.request.target!.prepare = true;
  await handlePipeline(s.manager, s.params, true, s.deps);
  expect(s.send.mock.calls.some((call) => call[1] === "DOM.scrollIntoViewIfNeeded")).toBe(false);
});
