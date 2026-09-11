import { afterEach, beforeEach, expect, it } from "vitest";
import { startRecordCapture, type RecordCaptureController } from "../record-capture";
import type { RecordStepPayload } from "@/lib/record-bridge";
import { localAfter } from "@/lib/recording/post-evidence";

let capture: RecordCaptureController | undefined;
beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  capture?.dispose();
  capture = undefined;
});

it("保留双击计数和右键，且监听器不阻止原生菜单事件", () => {
  // 模拟浏览器真实的两次 click 序列；reducer 负责合并，不能在 capture 端额外生成第三次动作。
  document.body.innerHTML = '<button id="open">打开</button>';
  const steps: RecordStepPayload[] = [];
  capture = startRecordCapture("pointer", (step) => steps.push(step));
  const button = document.querySelector("button")!;
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
  const menu = new MouseEvent("contextmenu", { bubbles: true, button: 2, cancelable: true });
  button.dispatchEvent(menu);
  expect(steps.filter((s) => s.op === "click")).toMatchObject([
    { op: "click" },
    { op: "click", clickCount: 2 },
    { op: "click", button: "right" },
  ]);
  expect(menu.defaultPrevented).toBe(false);
  expect(steps.every((s) => typeof s.capturedAt === "number")).toBe(true);
});

it("checkbox 使用 change 后的最终状态，文件录制不包含本地路径或内容", () => {
  document.body.innerHTML =
    '<label for="agree"><span>同意</span></label><input id="agree" type="checkbox"><input id="file" type="file">';
  const steps: RecordStepPayload[] = [];
  capture = startRecordCapture("form", (step) => steps.push(step));
  const check = document.querySelector<HTMLInputElement>("#agree")!;
  check.checked = true;
  check.dispatchEvent(new Event("change", { bubbles: true }));
  const file = document.querySelector<HTMLInputElement>("#file")!;
  Object.defineProperty(file, "files", {
    value: [new File(["private content"], "private-name.txt")],
  });
  file.dispatchEvent(new Event("change", { bubbles: true }));
  expect(steps).toMatchObject([
    { op: "click", checked: true },
    { op: "upload", fileCount: 1 },
  ]);
  expect(JSON.stringify(steps)).not.toContain("private content");
  expect(JSON.stringify(steps)).not.toContain("private-name.txt");
  // 后态观察也不能把浏览器的 fakepath 再写回录制证据。
  expect(localAfter.call(file)?.value).toBeNull();
});
