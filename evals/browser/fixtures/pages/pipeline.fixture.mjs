import { page } from "../../lib/fixtures.mjs";

/**
 * Pipeline 的隔离现场复现页：顶层 /console 与 frame /pipeline 地址不同。
 * 所有服务、计数均为 fixture 数据；最终按钮只修改本页计数，不调用业务服务。
 * scroll 模式每次只渲染窗口中的行，切换/滚动会重建节点，用来验证不复用陈旧句柄。
 */
export default {
  id: "pipeline-selection",
  routes: [
    "/console/pipeline/history",
    "/console/pipeline/preview",
    "/pipeline/history/history/414",
    "/pipeline/preview",
  ],
  render({ pathname }) {
    if (pathname.startsWith("/console/")) {
      const framePath = pathname.endsWith("history")
        ? "/pipeline/history/history/414"
        : "/pipeline/preview";
      return page({
        title: "Pipeline 控制台 fixture",
        body: `<h1>Pipeline 控制台</h1><button id="replace-frame">替换 iframe</button><iframe id="pipeline-frame" title="Pipeline" src="${framePath}" style="width:100%;height:650px;border:1px solid #aaa"></iframe>`,
        script: `document.querySelector("#replace-frame").onclick = () => { const old = document.querySelector("iframe"); old.replaceWith(old.cloneNode()); };`,
      });
    }
    if (pathname.includes("history"))
      return page({
        title: "Pipeline 历史 fixture",
        body: '<button id="execute">执行</button>',
        script:
          'document.querySelector("#execute").onclick = () => { parent.location.href = "/console/pipeline/preview"; };',
      });
    return page({
      title: "Pipeline 多选 fixture",
      body: `
      <h1>服务集合</h1><label>模式<select id="mode"><option value="scroll">虚拟滚动</option><option value="search">搜索</option><option value="full">完整 DOM</option></select></label>
      <label>期望集合<input id="expected" value="auth,env"></label>
      <div id="services" class="bk-select" role="button" tabindex="0"><span id="selected" class="bk-select-name">auth,log</span></div>
      <div id="panel" class="bk-select-dropdown-content" style="display:none"><div id="search-slot"></div><div id="options" style="height:160px;overflow-y:auto;position:relative;border:1px solid #aaa"><ul id="list" style="margin:0;padding:0;list-style:none;position:relative"></ul></div></div>
      <button id="execute" disabled>执行</button><button id="refresh">同 URL 刷新</button><p id="result">提交次数：0</p>`,
      script: `
      const names = ["auth", "log", ...Array.from({length:30},(_,i)=>"service"+i), "env", "engine"];
      const selected = new Set(["auth", "log"]); let submits = 0;
      const one = selector => document.querySelector(selector);
      const mode = one("#mode"), panel = one("#panel"), scroll = one("#options"), list = one("#list");
      function render() {
        const query = one("#search")?.value ?? "";
        const options = names.filter(name => !query || name === query);
        const start = mode.value === "scroll" ? Math.floor(scroll.scrollTop / 32) : 0;
        const visible = mode.value === "scroll" ? options.slice(start, start + 6) : options;
        list.replaceChildren(); list.style.height = options.length * 32 + "px";
        visible.forEach((name,index) => { const item = document.createElement("li"); item.className = "bk-option"; item.textContent = name;
          item.setAttribute("aria-selected", String(selected.has(name))); item.style.cssText = "position:absolute;height:32px;width:100%;top:" + (start+index)*32 + "px;background:" + (selected.has(name)?"#cde":"white");
          item.onclick = () => { selected.has(name) ? selected.delete(name) : selected.add(name); render(); }; list.append(item);
        });
        one("#selected").textContent = [...selected].sort().join(",");
        const wanted = [...new Set(one("#expected").value.split(",").map(x=>x.trim()).filter(Boolean))];
        one("#execute").disabled = wanted.length !== selected.size || wanted.some(x=>!selected.has(x));
      }
      one("#services").onclick = () => { const open = panel.style.display === "none"; panel.style.display = open ? "block" : "none"; one("#services").classList.toggle("is-focus", open); render(); };
      mode.onchange = () => { one("#search-slot").replaceChildren(); if(mode.value === "search") { const input = document.createElement("input"); input.id="search"; input.placeholder="搜索服务"; input.oninput=render; one("#search-slot").append(input); } scroll.scrollTop=0; render(); };
      scroll.onscroll = render; one("#expected").oninput = render;
      one("#execute").onclick = () => { submits++; one("#result").textContent = "提交次数："+submits+"；集合："+[...selected].sort().join(","); };
      one("#refresh").onclick = () => location.reload(); render();
    `,
    });
  },
};
