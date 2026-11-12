/**
 * bkw-ai-saas：弹窗“页面能力”的只读检测。
 *
 * detectPageTools 由 chrome.scripting.executeScript 序列化后注入当前标签页顶层文档的 main world
 * 执行，因此必须完全自包含：函数体内不得引用本模块的其他函数、常量或任何导入，否则注入后变量不存在。
 *
 * 边界：
 * - 只读：读取 SDK 桥接的 describe() 与浏览器 WebMCP 的工具列表，绝不调用 invoke / executeTool，
 *   也不改写页面上的 registerTool 等 API。
 * - describe() 会执行页面提供的上下文读取函数，所以只在用户打开面板或点击重新检测时调用一次，不轮询。
 * - 工具描述与站点说明是页面数据，仅用于展示，不代表授权；展示前截断长度，避免撑爆弹窗。
 * - agentChannel 与 bsk webmcp 固定桥接（crates/bsk-cli/src/cli/webmcp_bridge.js）的选择顺序一致：
 *   SDK v1 → document.modelContext(getTools+executeTool) → navigator.modelContextTesting，
 *   让用户看到的就是 Agent 实际会走的通道。只有 registerTool 的原生实现 Agent 无法调用，记为 none。
 */

export type AgentChannel = "sdk" | "native" | "legacy" | "none";

export interface PageToolInfo {
  name: string;
  description: string;
  /** 仅 SDK 提供：query / ui / draft / submit。 */
  kind?: string;
  /** 仅 SDK 提供；原生 WebMCP 没有可用性字段。 */
  available?: boolean;
  unavailableReason?: string;
}

export type SdkReport =
  | {
      status: "ok";
      app: { id: string; name: string; contractVersion: string };
      instructions?: string;
      tools: PageToolInfo[];
      truncated: boolean;
    }
  /** 页面挂了同名桥接但版本或形态不符，Agent 不会使用它。 */
  | { status: "incompatible"; version: string }
  | { status: "error"; message: string };

export interface WebMcpReport {
  /** 注册入口：document.modelContext（当前规范）或 navigator.modelContext / modelContextTesting（旧实现）。 */
  api: "document" | "navigator";
  /** null 表示浏览器没有提供读取工具列表的接口，只能确认页面支持 WebMCP。 */
  tools: PageToolInfo[] | null;
  truncated: boolean;
  error?: string;
}

export interface PageToolsReport {
  url: string;
  /** bsk 只在安全上下文（HTTPS / localhost）调用页面工具。 */
  secure: boolean;
  agentChannel: AgentChannel;
  sdk: SdkReport | null;
  webmcp: WebMcpReport | null;
}

/** 页面检测的默认等待上限；页面实现卡住时不让弹窗一直转圈。 */
export const DETECT_TIMEOUT_MS = 3000;
export const MAX_TOOLS = 100;
export const MAX_DESCRIPTION_CHARS = 500;
/** 与 SDK 的 INSTRUCTIONS_MAX_CHARS 一致；SDK 已校验，这里只防御非官方实现。 */
export const MAX_INSTRUCTIONS_CHARS = 4000;

export async function detectPageTools(timeoutMs: number): Promise<PageToolsReport> {
  // 以下常量与模块级导出保持一致；注入后无法访问模块作用域，只能在函数内重复声明。
  const maxTools = 100;
  const maxDescription = 500;
  const maxInstructions = 4000;
  const g = globalThis as unknown as Record<PropertyKey, unknown>;
  const doc = document as unknown as Record<string, unknown>;
  const nav = navigator as unknown as Record<string, unknown>;
  type Api = Record<string, unknown>;
  const isFn = (value: unknown): value is (...args: unknown[]) => unknown =>
    typeof value === "function";
  const asApi = (value: unknown): Api | undefined =>
    value && typeof value === "object" ? (value as Api) : undefined;
  const text = (value: unknown, max: number) => {
    const s = typeof value === "string" ? value.trim() : "";
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };
  const message = (error: unknown) =>
    text(error instanceof Error ? error.message : String(error), 200);
  const within = <T>(run: () => T | Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  // 列表结构异常（非数组、缺名称）时宁可报错，不展示猜测出的工具。
  const toolList = (value: unknown, sdk: boolean) => {
    if (!Array.isArray(value)) throw new Error("tool catalog is not an array");
    const tools: PageToolInfo[] = [];
    for (const raw of value) {
      const tool = asApi(raw);
      if (!tool || typeof tool.name !== "string" || !tool.name) continue;
      // 与 bsk 一致：只展示顶层文档注册的工具，不把 iframe 工具算进当前页。
      if (!sdk && tool.source && tool.source !== globalThis) continue;
      const info: PageToolInfo = {
        name: text(tool.name, 128),
        description: text(tool.description, maxDescription),
      };
      if (sdk) {
        if (typeof tool.kind === "string") info.kind = tool.kind;
        info.available = tool.available !== false;
        if (tool.available === false)
          info.unavailableReason = text(tool.unavailableReason, maxDescription);
      }
      tools.push(info);
    }
    return { tools: tools.slice(0, maxTools), truncated: tools.length > maxTools };
  };

  const sdkApi = asApi(g[Symbol.for("agent-ready.sdk.bridge.v1")]);
  const sdkUsable = Boolean(
    sdkApi && sdkApi.version === 1 && isFn(sdkApi.describe) && isFn(sdkApi.invoke),
  );
  let sdk: SdkReport | null = null;
  if (sdkApi && !sdkUsable) sdk = { status: "incompatible", version: String(sdkApi.version) };
  else if (sdkApi) {
    try {
      const catalog = asApi(await within(() => (sdkApi.describe as () => unknown)()));
      const app = asApi(catalog?.app) ?? {};
      const instructions = text(app.instructions, maxInstructions);
      sdk = {
        status: "ok",
        app: {
          id: text(app.id, 128),
          name: text(app.name, 128),
          contractVersion: text(app.contractVersion, 64),
        },
        ...(instructions ? { instructions } : {}),
        ...toolList(catalog?.actions, true),
      };
    } catch (error) {
      sdk = { status: "error", message: message(error) };
    }
  }

  const docContext = asApi(doc.modelContext);
  const navContext = asApi(nav.modelContext);
  const testing = asApi(nav.modelContextTesting);
  const nativeUsable = Boolean(
    docContext && isFn(docContext.getTools) && isFn(docContext.executeTool),
  );
  const legacyUsable = Boolean(testing && isFn(testing.listTools) && isFn(testing.executeTool));
  let webmcp: WebMcpReport | null = null;
  if (
    (docContext && (isFn(docContext.registerTool) || isFn(docContext.getTools))) ||
    (navContext && isFn(navContext.registerTool)) ||
    (testing && isFn(testing.listTools))
  ) {
    webmcp = { api: docContext ? "document" : "navigator", tools: null, truncated: false };
    try {
      // 优先使用当前规范的读取接口；没有时退回实验开关提供的测试接口，与 SDK 适配层的选择一致。
      const list =
        docContext && isFn(docContext.getTools)
          ? await within(() => (docContext.getTools as () => unknown)())
          : testing && isFn(testing.listTools)
            ? await within(() => (testing.listTools as () => unknown)())
            : undefined;
      if (list !== undefined) Object.assign(webmcp, toolList(list, false));
    } catch (error) {
      webmcp.error = message(error);
    }
  }

  return {
    url: location.href,
    secure: Boolean(globalThis.isSecureContext),
    agentChannel: sdkUsable ? "sdk" : nativeUsable ? "native" : legacyUsable ? "legacy" : "none",
    sdk,
    webmcp,
  };
}
