/**
 * 固定页面程序，由 Rust include_str! 内嵌。参数只通过 JSON 数据传入；不接受 Agent 源码。
 * 沿用 tool.evaluate 的目标解析及 main world，不创建第二套扩展通信。
 * binding 绑定会话、文档、API 实例及目录版本：发现之后发生导航、通道切换或契约变化时拒绝派发。
 * 页面保存最多 32 份发现记录；令牌仅防止误操作，不是权限凭据。
 */
async function webmcpBridge(request) {
  const fail = (code, message, dispatched = false) => ({
    webmcp: true, protocol_version: 1, ok: false, code, message, dispatched,
    outcome: dispatched ? 'unknown' : 'not_started',
  });
  let dispatched = false;
  let timer;
  const controller = new AbortController();
  const onPageHide = () => controller.abort();
  // 保持 JSON 可解析，不截断 Schema 或成功回执。输出过滤不构成对任意业务机密的完整识别。
  const sensitive = /(?:api[-_]?key|auth(?:orization)?|cookie|credential|password|passwd|private[-_]?key|pwd|secret|token)/i;
  function clean(value, depth = 0) {
    if (depth > 40) throw new Error('输出嵌套超过上限');
    if (typeof value === 'string') return value
      .replace(/-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/g, '[REDACTED_PRIVATE_KEY]')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [REDACTED]')
      .replace(/([?&](?:access_token|api_key|apikey|auth|authorization|code|credential|jwt|password|secret|session|token)=)[^&#\s"']+/gi, '$1[REDACTED]')
      .replace(/(["']?(?:api[-_]?key|authorization|cookie|credential|password|passwd|private[-_]?key|pwd|secret|token)["']?\s*[:=]\s*)(["']?)[^\s,;&}\]"']+\2/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
    if (Array.isArray(value)) return value.map(v => clean(v, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, sensitive.test(k) && (typeof v !== 'object' || v === null || Array.isArray(v)) ? '[REDACTED]' : clean(v, depth + 1)]));
    return value;
  }
  function finish(value) {
    try {
      const safe = clean(value);
      if (new TextEncoder().encode(JSON.stringify(safe)).length > 262144)
        return fail('output_too_large', '结果超过 256 KiB，请缩小查询；写操作不要重试。', dispatched);
      return safe;
    } catch {
      return fail('invalid_result', '结果无法安全序列化；请核对业务状态。', dispatched);
    }
  }
  try {
    if (!globalThis.isSecureContext) return fail('insecure_context', '需要 HTTPS 或 localhost 安全上下文。');
    const key = Symbol.for('bsk.webmcp.document.v1');
    if (!document[key]) Object.defineProperty(document, key, { value: { id: crypto.randomUUID(), href: location.href, bindings: new Map() } });
    const state = document[key];
    if (state.href !== location.href) {
      state.id = crypto.randomUUID(); state.href = location.href; state.bindings.clear();
    }
    const href = location.href;
    const documentId = state.id;
    if (request.action === 'call' && request.document_id !== documentId)
      return fail('stale_document', '文档已变化，请重新 webmcp list；未派发。');
    let api, mode;
    const sdk = globalThis[Symbol.for('agent-ready.sdk.bridge.v1')];
    if (sdk?.version === 1 && typeof sdk.describe === 'function' && typeof sdk.invoke === 'function') {
      api = sdk; mode = 'sdk';
    } else if (typeof document.modelContext?.getTools === 'function' && typeof document.modelContext?.executeTool === 'function') {
      api = document.modelContext; mode = 'native';
    } else if (typeof navigator.modelContextTesting?.listTools === 'function' && typeof navigator.modelContextTesting?.executeTool === 'function') {
      api = navigator.modelContextTesting; mode = 'legacy';
    } else return fail('unsupported', '未发现页面 SDK 或可调用的原生 WebMCP。');
    const binding = request.action === 'call' ? state.bindings.get(request.binding_id) : undefined;
    if (request.action === 'call' && (!binding || binding.session !== request.session_id || binding.api !== api || binding.mode !== mode))
      return fail('stale_binding', '发现记录已失效或不属于此会话，请重新 webmcp list。');
    addEventListener('pagehide', onPageHide, { once: true });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new Error('页面能力等待超时；请查询状态，不要重复提交。'));
    }, request.timeout_ms); });
    const result = await Promise.race([timeout, (async () => {
      const catalog = mode === 'sdk' ? await api.describe() : undefined;
      const all = mode === 'sdk' ? catalog?.actions : mode === 'native' ? await api.getTools() : await api.listTools();
      if (controller.signal.aborted) throw new Error('调用已取消');
      if (!Array.isArray(all)) return fail('invalid_catalog', '工具目录不是数组。');
      // 首版只处理顶层文档，iframe 工具不按同名猜测。当前协议没有 frame 选择器。
      const tools = mode === 'sdk' ? all : all.filter(t => !t.source || t.source === globalThis);
      const descriptions = tools.map(t => ({
        name: t.name, description: t.description,
        inputSchema: typeof t.inputSchema === 'string' ? JSON.parse(t.inputSchema) : t.inputSchema,
        ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
        annotations: t.annotations || {},
        ...(mode === 'sdk' ? { kind: t.kind, available: t.available !== false,
          ...(t.available === false ? { unavailable_reason: t.unavailableReason } : {}) } : {}),
      }));
      if (descriptions.some(t => typeof t.name !== 'string' || !t.name || typeof t.description !== 'string' || !t.inputSchema))
        return fail('invalid_catalog', '工具描述缺少名称、说明或输入 Schema。');
      const signature = JSON.stringify({ mode, app: catalog?.app, version: catalog?.catalogVersion, tools: descriptions });
      if (state.id !== documentId || state.href !== href || location.href !== href)
        return fail('stale_document', '发现期间页面已变化，未派发。');
      const base = { webmcp: true, protocol_version: 1, ok: true, mode, document_id: documentId, url: href };
      if (request.action === 'list') {
        const id = crypto.randomUUID();
        while (state.bindings.size >= 32) state.bindings.delete(state.bindings.keys().next().value);
        state.bindings.set(id, { session: request.session_id, api, mode, signature });
        // bkw-ai-saas：SDK 可在 app.instructions 提供站点级说明，提升为顶层字段便于 Agent 先读。
        // 只接受非空字符串；它属于页面数据，同样经过 clean 脱敏，且已计入目录签名，变化后旧绑定失效。
        const { instructions, ...app } = mode === 'sdk' && catalog.app && typeof catalog.app === 'object' ? catalog.app : {};
        const guide = typeof instructions === 'string' ? instructions.trim() : '';
        return { ...base, binding_id: id, tools: descriptions,
          ...(mode === 'sdk' ? { app, catalog_version: catalog.catalogVersion, context: catalog.context,
            ...(guide ? { instructions: guide } : {}) } : {}) };
      }
      if (binding.signature !== signature) return fail('stale_catalog', '工具目录或可用性已变化，请重新发现；未派发。');
      const matches = tools.filter(t => t.name === request.name);
      if (matches.length !== 1) return fail('tool_unavailable', '工具不存在或重名。');
      const tool = matches[0];
      if (tool.available === false) return fail('action_unavailable', String(tool.unavailableReason || '动作不可用。'));
      // 先标记后调用；只有 SDK 明确证明未派发时才允许下调。失败不切换通道、不更换参数再试。
      dispatched = true;
      if (mode === 'sdk') {
        const reply = await api.invoke(request.name, request.input, { signal: controller.signal });
        if (!reply || typeof reply.ok !== 'boolean') return fail('invalid_result', 'SDK 回执无效；请核对业务状态。', true);
        if (!reply.ok) {
          dispatched = reply.dispatched !== false;
          return fail(String(reply.code || 'execution_failed'), String(reply.message || '动作执行失败。'), dispatched);
        }
        return { ...base, binding_id: request.binding_id, dispatched: true, outcome: 'returned', result: reply.result, context_version: reply.contextVersion };
      }
      const major = Number(navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1] || 155);
      const value = mode === 'native'
        ? await api.executeTool(tool, major < 155 ? JSON.stringify(request.input) : request.input, { signal: controller.signal })
        : await api.executeTool(request.name, JSON.stringify(request.input));
      return { ...base, binding_id: request.binding_id, dispatched: true, outcome: value === null ? 'unknown' : 'returned', result: value };
    })()]);
    return finish(result);
  } catch (error) {
    return finish(fail('execution_failed', error instanceof Error ? error.message : String(error), dispatched));
  } finally {
    clearTimeout(timer);
    removeEventListener('pagehide', onPageHide);
  }
}
