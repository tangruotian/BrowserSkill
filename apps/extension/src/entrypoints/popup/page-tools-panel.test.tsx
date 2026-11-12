import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectActiveTab } from "@/page-tools/client";
import type { PageToolsReport } from "@/page-tools/detect";
import { PageToolsPanel } from "./page-tools-panel";

vi.mock("@/page-tools/client", () => ({ inspectActiveTab: vi.fn() }));
const inspect = vi.mocked(inspectActiveTab);

const base: PageToolsReport = {
  url: "https://saas.example/tasks",
  secure: true,
  agentChannel: "none",
  sdk: null,
  webmcp: null,
};

beforeEach(() => inspect.mockReset());
afterEach(() => cleanup());

describe("page tools panel", () => {
  it("shows the SDK app, site guide, tools and the channel Agents will use", async () => {
    inspect.mockResolvedValue({
      ok: true,
      report: {
        ...base,
        agentChannel: "sdk",
        sdk: {
          status: "ok",
          app: { id: "orbit.workbench", name: "Orbit · 产品研发", contractVersion: "2026-10-19" },
          instructions: "先 get_workspace，再 list_tasks。",
          truncated: false,
          tools: [
            { name: "list_tasks", description: "查询任务", kind: "query", available: true },
            {
              name: "create_task",
              description: "创建任务",
              kind: "submit",
              available: false,
              unavailableReason: "存储不可用",
            },
          ],
        },
      },
    });
    render(<PageToolsPanel />);
    expect(await screen.findByText("Orbit · 产品研发")).toBeTruthy();
    expect(screen.getByText("页面 SDK")).toBeTruthy();
    expect(screen.getByText("站点使用说明")).toBeTruthy();
    expect(screen.getByText("先 get_workspace，再 list_tasks。")).toBeTruthy();
    expect(screen.getByText("工具（2）")).toBeTruthy();
    expect(screen.getByText("查询")).toBeTruthy();
    expect(screen.getByText("提交")).toBeTruthy();
    expect(screen.getByText("存储不可用")).toBeTruthy();
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("explains register-only WebMCP and insecure pages instead of inventing tools", async () => {
    inspect.mockResolvedValue({
      ok: true,
      report: {
        ...base,
        secure: false,
        webmcp: { api: "document", tools: null, truncated: false },
      },
    });
    render(<PageToolsPanel />);
    expect(await screen.findByText(/浏览器未提供读取工具列表的接口/)).toBeTruthy();
    expect(screen.getByText("不可调用")).toBeTruthy();
    expect(screen.getByText(/不是安全上下文/)).toBeTruthy();
    expect(document.querySelector('[data-slot="page-tools-list"]')).toBeNull();
  });

  it("shows a hint when nothing is detected and re-detects on request", async () => {
    inspect.mockResolvedValue({ ok: true, report: base });
    render(<PageToolsPanel />);
    expect(await screen.findByText(/未检测到页面能力/)).toBeTruthy();
    inspect.mockResolvedValue({
      ok: true,
      report: {
        ...base,
        agentChannel: "native",
        webmcp: {
          api: "document",
          truncated: false,
          tools: [{ name: "search", description: "搜索文档" }],
        },
      },
    });
    const refresh = screen.getByRole("button", { name: "重新检测" });
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(refresh);
    expect(await screen.findByText("search")).toBeTruthy();
    expect(screen.getByText("浏览器 WebMCP", { selector: "p" })).toBeTruthy();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("reports restricted pages as an alert", async () => {
    inspect.mockResolvedValue({ ok: false, error: "restricted" });
    render(<PageToolsPanel />);
    expect((await screen.findByRole("alert")).textContent).toContain("chrome://");
  });
});
