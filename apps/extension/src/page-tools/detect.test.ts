import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DETECT_TIMEOUT_MS, detectPageTools, MAX_DESCRIPTION_CHARS, MAX_TOOLS } from "./detect";

const SDK_KEY = Symbol.for("agent-ready.sdk.bridge.v1");
const g = globalThis as unknown as Record<PropertyKey, unknown>;

function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}

function sdk(catalog: unknown, extra: Record<string, unknown> = {}) {
  const describeFn = vi.fn(async () => catalog);
  const invoke = vi.fn();
  g[SDK_KEY] = { version: 1, describe: describeFn, invoke, ...extra };
  return { describeFn, invoke };
}

/**
 * detectPageTools 会被注入页面执行，这里在 happy-dom 中直接运行同一函数，
 * 覆盖三种页面形态、Agent 通道选择、只读约束与异常/超时边界。不代表真实 Chrome 验收。
 */
describe("page tools detection", () => {
  beforeEach(() => {
    vi.stubGlobal("isSecureContext", true);
  });
  afterEach(() => {
    delete g[SDK_KEY];
    for (const key of ["modelContext"])
      delete (document as unknown as Record<string, unknown>)[key];
    for (const key of ["modelContext", "modelContextTesting"])
      delete (navigator as unknown as Record<string, unknown>)[key];
    vi.unstubAllGlobals();
  });

  it("reads the SDK catalog and site guide without invoking any tool", async () => {
    const { invoke } = sdk({
      app: {
        id: "orbit.workbench",
        name: "Orbit",
        contractVersion: "1",
        instructions: "  先查询再提交。 ",
      },
      actions: [
        { name: "list_tasks", description: "查询任务", kind: "query", available: true },
        {
          name: "create_task",
          description: "创建任务",
          kind: "submit",
          available: false,
          unavailableReason: "存储不可用",
        },
      ],
    });
    const report = await detectPageTools(DETECT_TIMEOUT_MS);
    expect(report).toMatchObject({
      secure: true,
      agentChannel: "sdk",
      webmcp: null,
      sdk: {
        status: "ok",
        app: { id: "orbit.workbench", name: "Orbit", contractVersion: "1" },
        instructions: "先查询再提交。",
        truncated: false,
        tools: [
          { name: "list_tasks", kind: "query", available: true },
          {
            name: "create_task",
            kind: "submit",
            available: false,
            unavailableReason: "存储不可用",
          },
        ],
      },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports register-only browser WebMCP as present but not callable or listable", async () => {
    const registerTool = vi.fn();
    define(document, "modelContext", { registerTool });
    const report = await detectPageTools(DETECT_TIMEOUT_MS);
    expect(report).toMatchObject({
      agentChannel: "none",
      sdk: null,
      webmcp: { api: "document", tools: null },
    });
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("lists native top-level tools and still prefers the SDK channel like bsk", async () => {
    const executeTool = vi.fn();
    define(document, "modelContext", {
      registerTool: vi.fn(),
      executeTool,
      getTools: async () => [
        { name: "search", description: "搜索", source: globalThis },
        { name: "frame_tool", description: "iframe 工具", source: {} },
        { name: "plain", description: "无来源字段" },
      ],
    });
    let report = await detectPageTools(DETECT_TIMEOUT_MS);
    expect(report.agentChannel).toBe("native");
    expect(report.webmcp?.tools?.map((tool) => tool.name)).toEqual(["search", "plain"]);
    expect(report.webmcp?.tools?.[0]).not.toHaveProperty("kind");

    sdk({ app: { id: "a", name: "A", contractVersion: "1" }, actions: [] });
    report = await detectPageTools(DETECT_TIMEOUT_MS);
    expect(report.agentChannel).toBe("sdk");
    expect(report.webmcp?.tools).toHaveLength(2);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("uses the legacy testing API when it is the only callable channel", async () => {
    define(navigator, "modelContextTesting", {
      listTools: () => [{ name: "legacy_tool", description: "旧接口" }],
      executeTool: vi.fn(),
    });
    const report = await detectPageTools(DETECT_TIMEOUT_MS);
    expect(report).toMatchObject({
      agentChannel: "legacy",
      webmcp: { api: "navigator", tools: [{ name: "legacy_tool" }] },
    });
  });

  it("flags an incompatible SDK bridge and does not call it", async () => {
    const { describeFn } = sdk({}, { version: 2 });
    const report = await detectPageTools(DETECT_TIMEOUT_MS);
    expect(report).toMatchObject({
      agentChannel: "none",
      sdk: { status: "incompatible", version: "2" },
    });
    expect(describeFn).not.toHaveBeenCalled();
  });

  it("turns failures, hangs and malformed catalogs into readable errors", async () => {
    g[SDK_KEY] = {
      version: 1,
      invoke: vi.fn(),
      describe: () => {
        throw new Error("上下文读取失败");
      },
    };
    expect((await detectPageTools(DETECT_TIMEOUT_MS)).sdk).toEqual({
      status: "error",
      message: "上下文读取失败",
    });

    g[SDK_KEY] = { version: 1, invoke: vi.fn(), describe: () => new Promise(() => {}) };
    expect((await detectPageTools(10)).sdk).toEqual({ status: "error", message: "timeout" });

    sdk({ app: {}, actions: "not-an-array" });
    expect((await detectPageTools(DETECT_TIMEOUT_MS)).sdk).toMatchObject({ status: "error" });

    delete g[SDK_KEY];
    define(document, "modelContext", {
      getTools: async () => {
        throw new Error("denied");
      },
    });
    expect((await detectPageTools(DETECT_TIMEOUT_MS)).webmcp).toMatchObject({
      tools: null,
      error: "denied",
    });
  });

  it("caps tool count and description length so a page cannot flood the popup", async () => {
    sdk({
      app: { id: "big", name: "Big", contractVersion: "1" },
      actions: Array.from({ length: MAX_TOOLS + 20 }, (_, i) => ({
        name: `tool_${i}`,
        description: "x".repeat(MAX_DESCRIPTION_CHARS + 50),
        kind: "query",
      })),
    });
    const report = await detectPageTools(DETECT_TIMEOUT_MS);
    if (report.sdk?.status !== "ok") throw new Error("expected ok");
    expect(report.sdk.tools).toHaveLength(MAX_TOOLS);
    expect(report.sdk.truncated).toBe(true);
    expect(report.sdk.tools[0].description).toHaveLength(MAX_DESCRIPTION_CHARS + 1);
    expect(report.sdk).not.toHaveProperty("instructions");
  });

  it("reports insecure pages so the popup can explain why Agents cannot call tools", async () => {
    vi.stubGlobal("isSecureContext", false);
    expect((await detectPageTools(DETECT_TIMEOUT_MS)).secure).toBe(false);
  });

  it("stays self-contained so chrome.scripting can serialize it", () => {
    const source = detectPageTools.toString();
    for (const name of [
      "MAX_TOOLS",
      "MAX_DESCRIPTION_CHARS",
      "MAX_INSTRUCTIONS_CHARS",
      "DETECT_TIMEOUT_MS",
    ])
      expect(source).not.toContain(name);
  });
});
