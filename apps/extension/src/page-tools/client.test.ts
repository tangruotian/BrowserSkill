import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectActiveTab } from "./client";
import { DETECT_TIMEOUT_MS, detectPageTools } from "./detect";

function stubChrome(tabs: unknown[], executeScript: (...args: unknown[]) => unknown) {
  const api = {
    tabs: { query: vi.fn(async () => tabs) },
    scripting: { executeScript: vi.fn(executeScript) },
  };
  vi.stubGlobal("chrome", api);
  return api;
}

describe("inspectActiveTab", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("injects the read-only detector into the top frame main world of the active tab", async () => {
    const report = { url: "https://saas.example/", agentChannel: "sdk" };
    const api = stubChrome([{ id: 7 }], async () => [{ result: report }]);
    expect(await inspectActiveTab()).toEqual({ ok: true, report });
    expect(api.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(api.scripting.executeScript).toHaveBeenCalledExactlyOnceWith({
      target: { tabId: 7 },
      world: "MAIN",
      func: detectPageTools,
      args: [DETECT_TIMEOUT_MS],
    });
  });

  it.each([
    ["Cannot access a chrome:// URL", "restricted"],
    ["The extensions gallery cannot be scripted.", "restricted"],
    ["Frame with ID 0 was removed.", "failed"],
  ])("maps injection error %s to %s", async (message, error) => {
    stubChrome([{ id: 1 }], async () => {
      throw new Error(message);
    });
    expect(await inspectActiveTab()).toEqual({ ok: false, error });
  });

  it("reports a missing tab or empty injection result without throwing", async () => {
    stubChrome([], async () => []);
    expect(await inspectActiveTab()).toEqual({ ok: false, error: "noTab" });
    stubChrome([{ id: 2 }], async () => [{}]);
    expect(await inspectActiveTab()).toEqual({ ok: false, error: "failed" });
  });
});
