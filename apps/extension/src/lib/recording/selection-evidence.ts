import type { TargetEvidenceV3 } from "@/transport/types";

/**
 * 固定控件读取器，既用于内容脚本也可序列化到已解析的目标文档执行。
 * 只从真实 DOM 构建唯一选择器，不保存 input 值或网络数据。未知结构返回缺口，
 * 不把可见窗口的选中项冒充完整集合。CSS 裁剪不影响 textContent，但省略标记会拒绝。
 */
export function captureSelection(
  element: Element,
  // 运行时仅传入录制过的容器/选项。允许弹层尚未展开时读取独立标签源；
  // 录制默认仍只在展开后输出完整适配器证据，保持旧格式兼容。
  expected?: { container: string; option: string },
): TargetEvidenceV3["selection"] {
  const doc = element.ownerDocument;
  const unique = (node: Element): string | undefined => {
    for (const key of ["data-testid", "id", "name"]) {
      const value = node.getAttribute(key);
      if (!value || value.length > 100 || /[0-9a-f]{16,}/i.test(value)) continue;
      const selector = node.tagName.toLowerCase() + "[" + key + "=" + JSON.stringify(value) + "]";
      if (doc.querySelectorAll(selector).length === 1) return selector;
    }
    // 多个表单控件可能共享 class，逐层加入真实祖先；不使用 nth-child 或动态序号。
    const part = (item: Element) =>
      item.tagName.toLowerCase() +
      [...item.classList]
        .filter(
          (c) =>
            /^[a-zA-Z_-][a-zA-Z0-9_-]{0,63}$/.test(c) &&
            !/(selected|checked|active|hover|focus|disabled|highlight)/i.test(c),
        )
        .map((c) => "." + CSS.escape(c))
        .join("");
    let selector = part(node);
    let parent = node.parentElement;
    for (let depth = 0; depth < 5; depth++) {
      if (doc.querySelectorAll(selector).length === 1) return selector;
      if (!parent) break;
      selector = part(parent) + " > " + selector;
      parent = parent.parentElement;
    }
    return undefined;
  };
  let root = element.closest(".bk-select");
  if (!root) {
    const owners = [
      ...doc.querySelectorAll('.bk-select[aria-expanded="true"], .bk-select.is-focus'),
    ];
    if (owners.length === 1) root = owners[0]!;
  }
  if (!root) return undefined;
  // bk-select-name 是已渲染的完整标签源；缺少该结构时保持未知，不从弹层选项推测已选值。
  const source = root.querySelector(".bk-select-name");
  const sourceSelector = source && unique(source);
  const trigger = unique(root);
  if (!source || !sourceSelector || !trigger) return undefined;
  const raw = (source.textContent ?? "").trim();
  if (raw.length > 16000 || /…|\.\.\.|\+\s*\d+/.test(raw)) return undefined;
  const emptyText = source.classList.contains("is-placeholder") ? raw : undefined;
  const selected = raw && emptyText === undefined ? raw.split(",").map((s) => s.trim()) : [];
  if (
    selected.length > 100 ||
    selected.some((s) => !s || s.length > 1000) ||
    new Set(selected).size !== selected.length
  )
    return undefined;
  const panels = [
    ...doc.querySelectorAll(expected?.container ?? ".bk-select-dropdown-content"),
  ].filter((node) => {
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(node).display !== "none";
  });
  if (panels.length > 1 || (!expected && panels.length !== 1)) return undefined;
  const panel = panels[0];
  // 无弹层时只能证明当前集合；展开、搜索或滚动之后每次重新读取，不复用旧文档节点。
  // 可见弹层必须确属 bk-select。若有多个展开控件，不能把另一个控件的面板借来使用。
  const openOwners = [
    ...doc.querySelectorAll('.bk-select[aria-expanded="true"], .bk-select.is-focus'),
  ];
  if (
    panel &&
    (!panel.classList.contains("bk-select-dropdown-content") ||
      openOwners.length > 1 ||
      (openOwners.length === 1 && openOwners[0] !== root))
  )
    return undefined;
  const container = expected?.container ?? (panel && unique(panel));
  const optionNode = panel?.querySelector(expected?.option ?? "li.bk-option");
  if (
    !container ||
    (!expected && !optionNode) ||
    (optionNode && !optionNode.classList.contains("bk-option"))
  )
    return undefined;
  // 选项 selector 表达整个集合，允许多匹配；具体点击时还会按标签精确过滤并检查唯一。
  const option = expected?.option ?? optionNode!.tagName.toLowerCase() + ".bk-option";
  const search = panel?.querySelector('input:not([type="password"]):not([type="hidden"])');
  const searchTarget = search && unique(search);
  const scrolling = (panel ? [panel, ...panel.querySelectorAll("*")] : []).find(
    (node) =>
      node.scrollHeight > node.clientHeight + 1 &&
      /auto|scroll/.test(getComputedStyle(node).overflowY),
  );
  const scrollTarget = scrolling && unique(scrolling);
  return {
    trigger,
    complete: true,
    selected,
    config: {
      container,
      option,
      selectedSource: {
        kind: "text",
        selector: sourceSelector,
        separator: ",",
        ...(emptyText ? { emptyText } : {}),
      },
      ...(searchTarget
        ? { discovery: { mode: "search", target: searchTarget, maxSteps: 20 } }
        : scrollTarget
          ? { discovery: { mode: "scroll", target: scrollTarget, maxSteps: 20 } }
          : {}),
    },
  };
}
