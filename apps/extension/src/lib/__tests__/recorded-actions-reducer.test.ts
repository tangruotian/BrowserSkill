import { expect, it } from "vitest";
import { reduceTraceStepsV3 } from "../recording/trace-reducer-v3";
import type { RecordingDraftStep } from "../recording/types";

const click = (time: number, count: number, page = "tab:1:document:a"): RecordingDraftStep => ({
  op: "click",
  capturedAt: time,
  clickCount: count,
  pageIdentity: page,
  pageUrl: "https://example.test",
  preStateId: "s1",
  postStateId: "s2",
  captureTarget: {
    tag: "button",
    role: "button",
    name: "打开",
    evidence: { selector: "#open", frame: [], observedAt: time },
  },
});
it("同一文档的双击合并后保留前后态及全部原始步骤映射", () => {
  const a = click(100, 1);
  const b = click(200, 2);
  b.preStateId = "s2";
  b.postStateId = "s3";
  const reduced = reduceTraceStepsV3([a, b]);
  expect(reduced.steps).toHaveLength(1);
  expect(reduced.steps[0]).toMatchObject({
    state: "s1",
    result: { state: "s3" },
    clickCount: 2,
    capturedAt: 100,
  });
  expect([...reduced.stepIdByDraftId.values()]).toEqual([1, 1]);
});
it("不同页签或文档中的相同按钮绝不合并", () => {
  // URL、按钮名及 CSS 相同也不能作为跨页面去重依据。
  for (const page of ["tab:2:document:a", "tab:1:document:b"]) {
    const reduced = reduceTraceStepsV3([click(100, 1), click(200, 2, page)]);
    expect(reduced.steps).toHaveLength(2);
  }
});
it("上传只导出文件引用需求并保留来源身份", () => {
  const reduced = reduceTraceStepsV3([
    {
      op: "upload",
      fileCount: 1,
      capturedAt: 100,
      pageIdentity: "tab:1:doc",
      preStateId: "s1",
      postStateId: "s2",
      captureTarget: { tag: "input", name: "附件" },
    },
  ]);
  expect(reduced.steps[0]).toMatchObject({
    op: "upload",
    fileCount: 1,
    capturedAt: 100,
    pageIdentity: "tab:1:doc",
  });
});
