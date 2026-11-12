/**
 * 弹窗调用的页面能力检测入口：定位当前窗口的活动标签页，在顶层文档 main world 执行只读检测。
 *
 * 只注入顶层文档（不加 allFrames），与 bsk webmcp 只处理顶层文档的边界一致。
 * chrome://、Chrome 网上应用店等受限页面无法注入脚本，归类为 restricted，界面给出明确说明而不是报错堆栈。
 */
import { DETECT_TIMEOUT_MS, detectPageTools, type PageToolsReport } from "./detect";

export type PageToolsError = "noTab" | "restricted" | "failed";

export type InspectResult =
  | { ok: true; report: PageToolsReport }
  | { ok: false; error: PageToolsError };

const RESTRICTED = /cannot access|cannot be scripted|chrome:\/\/|extensions gallery|not allowed/i;

export async function inspectActiveTab(): Promise<InspectResult> {
  let tabId: number | undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  } catch {
    return { ok: false, error: "failed" };
  }
  if (tabId === undefined) return { ok: false, error: "noTab" };
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: detectPageTools,
      args: [DETECT_TIMEOUT_MS],
    });
    const report = injection?.result as PageToolsReport | undefined;
    // 注入期间发生导航等情况时没有结果，按失败处理，用户可重新检测。
    return report ? { ok: true, report } : { ok: false, error: "failed" };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, error: RESTRICTED.test(text) ? "restricted" : "failed" };
  }
}
