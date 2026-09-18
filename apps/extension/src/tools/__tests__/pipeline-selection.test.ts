import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { facts, pipelineFactsSource } from "../pipeline";

beforeEach(() => {
  document.body.innerHTML =
    '<button id="dropdown">services</button><ul id="options"><li class="option" aria-selected="true">auth</li><li class="option" aria-selected="false">env</li></ul>';
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  });
});
afterEach(() => vi.restoreAllMocks());
const target = () => ({
  selector: "#dropdown",
  identity: [],
  selection: {
    container: "#options",
    option: ".option",
    selectedAttribute: "aria-selected" as const,
  },
});
const read = () => facts.call(document.querySelector("#dropdown")!, target());
it("reads selected values and false states without toggling the DOM", () => {
  expect(read()).toMatchObject({
    selectionOpen: true,
    selection: ["auth"],
    selectionOptions: [
      { label: "auth", selected: true },
      { label: "env", selected: false },
    ],
  });
});
it("rejects missing selection state and duplicate option labels", () => {
  document.querySelector(".option")!.removeAttribute("aria-selected");
  expect(read().selectionError).toContain("明确");
  document.querySelector(".option")!.setAttribute("aria-selected", "true");
  document.querySelectorAll(".option")[1]!.textContent = "auth";
  expect(read().selectionError).toContain("不唯一");
});
it("detects incomplete ARIA virtualized lists", () => {
  document.querySelector(".option")!.setAttribute("aria-setsize", "30");
  expect(read().selectionError).toContain("不完整");
});
it("distinguishes a closed popup from an empty selected set", () => {
  document.querySelector("#options")!.remove();
  expect(read()).toMatchObject({ selectionOpen: false, selection: null });
});
it("guards the option state again before dispatch", () => {
  const option = document.querySelector(".option")!;
  const t = {
    selector: ".option",
    identity: [],
    selectionGuard: { selectedAttribute: "aria-selected" as const, expected: false },
  };
  expect(facts.call(option, t).matches).toBe(false);
  option.setAttribute("aria-selected", "false");
  expect(facts.call(option, t).matches).toBe(true);
});
it("supports observed selected classes and guards dropdown open state", () => {
  const t = target();
  const dropdown = document.querySelector("#dropdown")!;
  expect(facts.call(dropdown, { ...t, selectionOpenExpected: false }).matches).toBe(false);
  const option = document.querySelector(".option")!;
  option.classList.add("is-selected");
  expect(
    facts.call(dropdown, {
      ...t,
      selection: { container: "#options", option: ".option", selectedClass: "is-selected" },
    }).selection,
  ).toEqual(["auth"]);
});

it("reads the selected set from control text while popup is closed", () => {
  document.querySelector("#dropdown")!.textContent = "process,auth";
  document.querySelector("#options")!.remove();
  const t = {
    selector: "#dropdown",
    identity: [],
    selection: {
      container: "#options",
      option: ".option",
      selectedSource: { kind: "text" as const, selector: "#dropdown" },
    },
  };
  expect(facts.call(document.querySelector("#dropdown")!, t)).toMatchObject({
    selection: ["process", "auth"],
    selectionOpen: false,
  });
});
it("reads selected tags and rejects duplicate labels", () => {
  document.querySelector("#dropdown")!.innerHTML =
    '<span class="tag">auth</span><span class="tag">env</span>';
  const t = {
    selector: "#dropdown",
    identity: [],
    selection: {
      container: "#options",
      option: ".option",
      selectedSource: { kind: "tags" as const, selector: "#dropdown", itemSelector: ".tag" },
    },
  };
  expect(facts.call(document.querySelector("#dropdown")!, t).selection).toEqual(["auth", "env"]);
  document.querySelectorAll(".tag")[1]!.textContent = "auth";
  expect(facts.call(document.querySelector("#dropdown")!, t).selectionError).toContain("重复");
});
it("rechecks control collection before an option toggle", () => {
  document.querySelector("#dropdown")!.textContent = "auth";
  const option = document.querySelector(".option")!;
  const t = {
    selector: ".option",
    identity: [],
    selectionGuard: {
      source: { kind: "text" as const, selector: "#dropdown" },
      label: "auth",
      expected: false,
    },
  };
  expect(facts.call(option, t).matches).toBe(false);
  document.querySelector("#dropdown")!.textContent = "";
  expect(facts.call(option, t).matches).toBe(true);
});
it("reads a value source and handles an explicit empty placeholder", () => {
  document.body.insertAdjacentHTML("beforeend", '<input id="values" value="auth,env">');
  const t = {
    selector: "#dropdown",
    identity: [],
    selection: {
      container: "#options",
      option: ".option",
      selectedSource: { kind: "value" as const, selector: "#values" },
    },
  };
  expect(facts.call(document.querySelector("#dropdown")!, t).selection).toEqual(["auth", "env"]);
  (document.querySelector("#values") as HTMLInputElement).value = "请选择";
  expect(
    facts.call(document.querySelector("#dropdown")!, {
      ...t,
      selection: {
        ...t.selection,
        selectedSource: { ...t.selection.selectedSource, emptyText: "请选择" },
      },
    }).selection,
  ).toEqual([]);
});

// 虚拟窗口之外的已选服务必须保留，不能把当前窗口当作完整集合。
it("reads a virtual window with an independent complete selected source", () => {
  document.querySelector("#dropdown")!.textContent = "auth,offscreen";
  document.querySelector(".option")!.setAttribute("aria-setsize", "30");
  const t = {
    selector: "#dropdown",
    identity: [],
    selection: {
      container: "#options",
      option: ".option",
      selectedSource: { kind: "text" as const, selector: "#dropdown" },
      discovery: { mode: "scroll" as const, target: "#options", maxSteps: 20 },
    },
  };
  const result = facts.call(document.querySelector("#dropdown")!, t);
  expect(result.selectionError).toBeUndefined();
  expect(result.selection).toEqual(["auth", "offscreen"]);
  expect(result.selectionComplete).toBe(false);
});
it("allows an empty search result without losing the full selected set", () => {
  document.querySelector("#dropdown")!.textContent = "auth";
  document.querySelector("#options")!.innerHTML = '<input id="query" value="missing">';
  const result = facts.call(document.querySelector("#dropdown")!, {
    selector: "#dropdown",
    identity: [],
    selection: {
      container: "#options",
      option: ".option",
      selectedSource: { kind: "text", selector: "#dropdown" },
      discovery: { mode: "search", target: "#query", maxSteps: 10 },
    },
  });
  expect(result.selectionError).toBeUndefined();
  expect(result.selectionOptions).toEqual([]);
  expect(result.selection).toEqual(["auth"]);
});

// 与 CDP 一样在没有模块闭包的函数中执行，覆盖生产压缩改名后遗漏 import 的故障。
const probeTarget = () => ({
  selector: "#service",
  identity: [],
  selectionProbe: {
    adapter: "bk-select" as const,
    container: ".bk-select-dropdown-content",
    option: "li.bk-option",
  },
});
function probeDOM(open = true) {
  document.body.innerHTML =
    '<div id="service" class="bk-select"><span class="bk-select-name">auth,offscreen</span></div>' +
    (open
      ? '<div class="bk-select-dropdown-content"><input id="search"><ul><li class="bk-option">auth</li><li class="bk-option">env</li></ul></div>'
      : "");
  return document.querySelector("#service")!;
}
it("运行时从真实控件读取集合及搜索能力，CDP 序列化函数不依赖模块闭包", () => {
  const node = probeDOM();
  const serialized = new Function("return (" + pipelineFactsSource() + ")")();
  const result = serialized.call(node, probeTarget());
  expect(result.selectionError).toBeUndefined();
  expect(result.selection).toEqual(["auth", "offscreen"]);
  expect(result.selectionOptions.map((o: { label: string }) => o.label)).toEqual(["auth", "env"]);
  expect(result.selectionConfig.discovery).toMatchObject({
    mode: "search",
    target: 'input[id="search"]',
    modelFallback: true,
  });
});
it("运行时探测支持关闭弹层和搜索无结果，不把未知状态冒充空集合", () => {
  const node = probeDOM(false);
  expect(facts.call(node, probeTarget())).toMatchObject({
    selection: ["auth", "offscreen"],
    selectionOpen: false,
  });
  probeDOM();
  document.querySelectorAll("li").forEach((n) => n.remove());
  const result = facts.call(document.querySelector("#service")!, probeTarget());
  expect(result.selectionError).toBeUndefined();
  expect(result.selectionOptions).toEqual([]);
  document.querySelector(".bk-select-name")!.textContent = "auth,+2";
  expect(facts.call(document.querySelector("#service")!, probeTarget()).selectionError).toContain(
    "完整已选集合",
  );
});
it("多个可见弹层或缺少完整标签来源时不派生集合配置", () => {
  const node = probeDOM();
  document.body.insertAdjacentHTML(
    "beforeend",
    '<div class="bk-select-dropdown-content"><li class="bk-option">other</li></div>',
  );
  expect(facts.call(node, probeTarget()).selectionConfig).toBeUndefined();
  expect(facts.call(node, probeTarget()).selectionError).toBeDefined();
});

it("展开派发前读数失效时，不能把未知误认为关闭而继续点击", () => {
  const node = probeDOM(false);
  document.querySelector(".bk-select-name")!.remove();
  const result = facts.call(node, { ...probeTarget(), selectionOpenExpected: false });
  expect(result.selectionError).toBeDefined();
  expect(result.matches).toBe(false);
});
it("不把另一展开控件的面板当作当前控件", () => {
  const node = probeDOM();
  document.body.insertAdjacentHTML(
    "beforeend",
    '<div class="bk-select is-focus"><span class="bk-select-name">other</span></div>',
  );
  expect(facts.call(node, probeTarget()).selectionError).toBeDefined();
});
