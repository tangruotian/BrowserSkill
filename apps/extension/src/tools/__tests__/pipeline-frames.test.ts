import { expect, it, vi } from "vitest";
import { resolvePipelineDocument } from "../pipeline-frames";
import type { CdpRunner } from "../shared";
function fixture(oopif = false) {
  const target = { tabId: 1, ...(oopif ? { sessionId: "child-session" } : {}) };
  const frames = [
    { frameId: "root", target: { tabId: 1 }, url: "https://host.test" },
    { frameId: "child", parentFrameId: "root", url: "https://child.test/form", target },
  ];
  const send = vi.fn(async (_address: unknown, method: string) => {
    if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
    if (method === "Runtime.evaluate") return { result: { objectId: "document" } };
    if (method === "DOM.requestNode") return { nodeId: 20 };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 200 } };
    throw new Error(method);
  });
  const cdp = {
    send,
    sendToTarget: send,
    getFrameGraph: vi.fn(async () => ({ rootFrameId: "root", frames })),
  } as unknown as CdpRunner;
  return { cdp, send, frames };
}
it.each([
  false,
  true,
])("resolves a unique child document with correct target routing (oopif=%s)", async (oopif) => {
  const s = fixture(oopif);
  const result = await resolvePipelineDocument(
    s.cdp,
    1,
    [{ origin: "https://child.test", pathPrefix: "/form" }],
    "test",
  );
  expect(result.backendNodeId).toBe(200);
  expect(result.frame?.frameId).toBe("child");
  expect(s.send).toHaveBeenCalledWith(
    oopif ? { tabId: 1, sessionId: "child-session" } : 1,
    "Page.createIsolatedWorld",
    expect.objectContaining({ frameId: "child" }),
  );
});
it("rejects ambiguous sibling frames before executing script", async () => {
  const s = fixture();
  s.frames.push({ ...s.frames[1]!, frameId: "duplicate" });
  await expect(
    resolvePipelineDocument(s.cdp, 1, [{ origin: "https://child.test", pathPrefix: "/" }], "test"),
  ).rejects.toThrow("exactly once");
  expect(s.send).not.toHaveBeenCalled();
});
it("does not fall back to top document when a frame is missing", async () => {
  const s = fixture();
  await expect(
    resolvePipelineDocument(
      s.cdp,
      1,
      [{ origin: "https://missing.test", pathPrefix: "/" }],
      "test",
    ),
  ).rejects.toThrow("matched 0");
});
