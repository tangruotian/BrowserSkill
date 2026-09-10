import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { facts } from "../pipeline";
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
