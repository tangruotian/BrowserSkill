import { afterEach, expect, it, vi } from "vitest";
import { facts, pipelineFactsSource } from "../pipeline";

// 直接执行传入浏览器的固定读取函数，覆盖真实 CSS/within/identity 组合，避免只模拟 count。
// fixture 有五个相同样式的按钮，其中多个区域都有“执行”，正文另有“执行全部”。
function fixture() {
  document.body.innerHTML = `
    <aside class="other"><button class="bk-primary bk-button-normal bk-button">执行</button></aside>
    <aside class="pipeline-history-right-aside">
      <button id="wanted" class="bk-primary bk-button-normal bk-button">执行</button>
      <button class="bk-primary bk-button-normal bk-button">执行全部</button>
      <button class="bk-primary bk-button-normal bk-button">编辑</button>
    </aside>
    <footer><button class="bk-primary bk-button-normal bk-button">执行</button></footer>`;
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
  return {
    selector: "button.bk-primary.bk-button-normal.bk-button",
    within: "aside.pipeline-history-right-aside",
    identity: [{ property: "text", expected: "执行" }],
  };
}
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
const injectedFacts = new Function("return (" + pipelineFactsSource() + ")")() as typeof facts;
const matching = (target: ReturnType<typeof fixture>) =>
  [...document.querySelectorAll(target.selector)].filter(
    (element) => injectedFacts.call(element, target).matches,
  );

it("五个同样式按钮通过区域与精确文字收窄为唯一目标", () => {
  const target = fixture();
  expect(document.querySelectorAll(target.selector)).toHaveLength(5);
  expect(matching(target).map((element) => element.id)).toEqual(["wanted"]);
});

it("区域内仍有两个同名按钮时保留歧义，不默选第一个", () => {
  const target = fixture();
  const wanted = document.querySelector("#wanted")!;
  wanted.parentElement!.append(wanted.cloneNode(true));
  expect(matching(target)).toHaveLength(2);
});

it("范围消失或不唯一时不扩大到其他区域", () => {
  const target = fixture();
  const scope = document.querySelector(target.within)!;
  const duplicate = scope.cloneNode(true);
  document.body.append(duplicate);
  expect(matching(target)).toHaveLength(0);
  scope.remove();
  duplicate.parentNode!.removeChild(duplicate);
  expect(matching(target)).toHaveLength(0);
});
