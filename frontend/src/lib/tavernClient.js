// Credentials are supplied by the caller from session state; never persist here.
import { normalizeTavernBilling, normalizeTavernUsage } from "./tavernUsage.js";

export const DEFAULT_TAVERN_SETTINGS = Object.freeze({
  billingMode: "platform",
  model: "deepseek-v4.1-flash",
  endpoint: "https://api.buytoken.work/v1/chat/completions",
  apiKey: "",
  temperature: 0.8,
  maxTokens: 1024,
});
const activeRequests = new Set();
const validRequestId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function normalizeBillingRequest(value) {
  if (!value || !validRequestId(value.request_id)) throw new Error('平台记录格式无效，请稍后核对。');
  const billing = normalizeTavernBilling(value.billing || { ...value, status: value.billing_status || value.status });
  if (!billing || billing.request_id !== value.request_id.toLowerCase()) throw new Error('平台账务状态暂时无法确认。');
  return { request_id: value.request_id.toLowerCase(), billing, status: billing.status,
    request_status: ['reserved', 'completed', 'failed', 'unknown'].includes(value.request_status) ? value.request_status : null,
    model: typeof value.model === 'string' ? value.model.slice(0, 128) : '',
    kind: ['summary', 'assist'].includes(value.kind) ? value.kind : 'chat', usage: normalizeTavernUsage(value.usage),
    content: typeof value.content === 'string' && value.content.length <= 65536 ? value.content : null,
    created_at: typeof value.created_at === 'string' ? value.created_at.slice(0, 50) : '',
    error_code: typeof value.error_code === 'string' ? value.error_code.slice(0, 100) : null,
    ...(validRequestId(value.user_id) ? { user_id: value.user_id.toLowerCase() } : {}) };
}

async function billingFetch(path, authHeaders = {}, body) {
  const headers = new Headers({ Accept: 'application/json' }), auth = new Headers(authHeaders);
  for (const key of ['Authorization', 'X-Client-Id']) if (auth.has(key)) headers.set(key, auth.get(key));
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers,
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) throw new Error(typeof data?.error === 'string' ? data.error : '暂时无法核对平台账单，请稍后重试。');
    return data;
  } finally { clearTimeout(timer); }
}

export async function fetchTavernRequest(requestId, authHeaders = {}) {
  if (!validRequestId(requestId)) throw new Error('平台请求编号无效。');
  const data = await billingFetch(`/api/tavern/requests/${requestId}`, authHeaders);
  return { success: true, request: normalizeBillingRequest(data.request || data.requests?.[0]) };
}

export async function fetchTavernRequests(authHeaders = {}, { admin = false } = {}) {
  const data = await billingFetch(admin ? '/api/tavern/admin/requests' : '/api/tavern/requests', authHeaders);
  if (!Array.isArray(data.requests) || data.requests.length > 100) throw new Error('平台账单列表格式无效。');
  return { success: true, requests: data.requests.map(normalizeBillingRequest) };
}

export async function resolveTavernRequest(requestId, { user_id, action, usage, reason } = {}, authHeaders = {}) {
  if (!validRequestId(requestId) || !validRequestId(user_id) || !['refund', 'settle'].includes(action)
      || typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 500) throw new Error('请填写有效的核对方式、目标账户和 5–500 字处理原因。');
  const normalized = action === 'settle' ? normalizeTavernUsage(usage) : null;
  if (action === 'settle' && normalized.status !== 'confirmed') throw new Error('请提供已核实的输入、输出和总 Token；缓存明细未返回时按标准输入价。');
  const data = await billingFetch(`/api/tavern/admin/requests/${requestId}/resolve`, authHeaders,
    { user_id, action, reason: reason.trim(), ...(normalized ? { usage: normalized } : {}) });
  return { success: true, request: normalizeBillingRequest(data.request || data.requests?.[0]) };
}

function notSubmitted(message) {
  const error = new Error(message);
  error.code = "TAVERN_NOT_SUBMITTED";
  error.submission_unknown = false;
  return error;
}

export async function fetchTavernConfig(signal) {
  const response = await fetch("/api/tavern/config", { signal, cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error("暂时无法读取对话服务配置。");
  return response.json();
}

export async function requestTavernImport({ url, kind, signal }) {
  if (!["character", "lorebook"].includes(kind)) throw new Error("请选择角色卡或世界书。");
  let target;
  try {
    target = new URL(String(url || "").trim());
    if (target.protocol !== "https:" || target.username || target.password || target.hash
      || target.href.length > 4096 || (target.port && target.port !== "443")) throw new Error();
  } catch {
    throw new Error("请填写无需登录的公开 HTTPS 下载链接或 Chub 详情页。");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 50000);
  try {
    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    // No provider key/auth options: the backend downloads public data only.
    const response = await fetch("/api/tavern/import", { method: "POST", credentials: "omit", redirect: "error",
      referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: target.href, kind }) });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const error = new Error(typeof data?.error === "string" ? data.error : "资源下载失败，请使用下载链接或下载文件导入。");
      error.code = "TAVERN_IMPORT_FAILED";
      throw error;
    }
    const type = response.headers.get("Content-Type")?.split(";")[0].trim();
    if (type !== "application/json" && type !== "image/png") {
      const error = new Error("链接未返回 JSON/PNG 文件，请使用下载链接或下载文件导入。");
      error.code = "TAVERN_IMPORT_FAILED";
      throw error;
    }
    const bytes = await response.arrayBuffer();
    const maximum = type === "image/png" ? 8 * 1024 * 1024 : 1024 * 1024;
    if (!bytes.byteLength || bytes.byteLength > maximum) {
      const error = new Error("文件大小不符合要求：JSON 最多 1 MB，PNG 最多 8 MB。");
      error.code = "TAVERN_IMPORT_FAILED";
      throw error;
    }
    return new File([bytes], `${kind === "character" ? "character" : "lorebook"}.${type === "image/png" ? "png" : "json"}`, { type });
  } catch (error) {
    if (error?.code === "TAVERN_IMPORT_FAILED") throw error;
    if (signal?.aborted) throw new Error("已取消导入。");
    throw new Error(controller.signal.aborted ? "资源下载超时，请下载文件后导入。" : "资源下载失败，请检查链接或下载文件导入。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function requestTavernReply({ settings = DEFAULT_TAVERN_SETTINGS, messages, signal, onDelta, authHeaders = {}, requestId, kind = 'chat' }) {
  const mode = settings.billingMode ?? settings.billing_mode ?? "platform";
  if (!['platform', 'own_key'].includes(mode)) throw notSubmitted('请选择平台积分或自带 API Key 模式。');
  if (mode === 'platform' && (!validRequestId(requestId) || !['chat', 'summary', 'assist'].includes(kind))) throw notSubmitted('本次平台调用缺少有效请求编号，请重新打开对话。');
  const headers = new Headers({ "Content-Type": "application/json" });
  // Forward only site auth to our own backend, never unrelated provider keys.
  const auth = new Headers(authHeaders);
  for (const name of ["Authorization", "X-Client-Id"]) if (auth.has(name)) headers.set(name, auth.get(name));
  if (mode === 'platform') headers.set('X-Request-Id', requestId);
  if (mode === "own_key") {
    const key = String(settings.apiKey || "").trim();
    if (!/^[!-~]{1,4096}$/.test(key)) throw notSubmitted("请在对话服务设置中填写有效的 API Key。");
    let endpoint;
    try {
      endpoint = new URL(String(settings.endpoint || DEFAULT_TAVERN_SETTINGS.endpoint).trim());
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || (endpoint.port && endpoint.port !== "443") || !endpoint.pathname.endsWith("/chat/completions")) throw new Error();
    } catch {
      throw notSubmitted("请填写以 /chat/completions 结尾的公网 HTTPS 接口地址。");
    }
    headers.set("X-Tavern-Api-Key", key);
    headers.set("X-Tavern-Endpoint", endpoint.href);
  }
  const body = JSON.stringify({ billing_mode: mode, model: settings.model || DEFAULT_TAVERN_SETTINGS.model,
    messages, temperature: settings.temperature ?? 0.8,
    max_tokens: settings.maxTokens ?? settings.max_tokens ?? 1024,
    ...(mode === 'platform' ? { request_id: requestId, kind } : {}) });
  // Ephemeral only, without keys: block the same in-flight intent in this page.
  // This does not claim durable/server-wide idempotency or retry unknown calls.
  const intentParameters = JSON.parse(body);
  delete intentParameters.request_id;
  const intent = `${headers.get("X-Tavern-Endpoint") || "platform"}\n${JSON.stringify(intentParameters)}`;
  if (activeRequests.has(intent)) {
    const error = new Error("这条对话正在等待回复，请勿重复发送。");
    error.code = "TAVERN_ALREADY_SENDING";
    error.submission_unknown = false;
    throw error;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, mode === 'platform' ? 180000 : 125000);
  let started = false;
  activeRequests.add(intent);
  try {
    if (controller.signal.aborted) {
      const error = new Error("本次发送已取消，尚未提交对话。");
      error.code = "TAVERN_NOT_SUBMITTED";
      error.submission_unknown = false;
      throw error;
    }
    started = true;
    const response = await fetch("/api/tavern/chat", {
      method: "POST", headers, signal: controller.signal, credentials: "same-origin", cache: "no-store",
      redirect: "error", referrerPolicy: "no-referrer", body,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) {
      const error = new Error(data?.error || "对话结果暂未确认，请核对服务记录，不要重复发送。");
      error.code = data?.code || "TAVERN_RESULT_UNKNOWN";
      error.tavernResponse = true;
      error.submission_unknown = typeof data?.submission_unknown === 'boolean' ? data.submission_unknown : true;
      if (mode === 'platform') {
        error.request_id = requestId;
        const billing = normalizeTavernBilling(data?.billing);
        if (billing?.request_id === requestId.toLowerCase()) error.billing = billing;
      }
      throw error;
    }
    if (typeof data.content !== "string" || !data.content.trim()) {
      const error = new Error('对话服务未返回有效文字，请核对平台账单或服务商记录。');
      error.code = 'TAVERN_RESPONSE_INVALID'; error.submission_unknown = true;
      if (mode === 'platform') {
        error.request_id = requestId;
        const billing = normalizeTavernBilling(data.billing);
        if (billing?.request_id === requestId.toLowerCase()) error.billing = billing;
      }
      throw error;
    }
    // First version is explicitly non-streaming: notify once with the complete reply.
    try { onDelta?.(data.content); } catch { /* A view callback must not relabel a completed paid reply as unknown. */ }
    const billing = mode === 'platform' ? normalizeTavernBilling(data.billing) : null;
    return { content: data.content, usage: normalizeTavernUsage(data.usage),
      ...(mode === 'platform' ? { request_id: requestId, billing: billing?.request_id === requestId.toLowerCase() ? billing : null } : {}) };
  } catch (reason) {
    if (reason?.tavernResponse === true || reason?.code?.startsWith?.("TAVERN_")) throw reason;
    const error = new Error(started
      ? "对话连接中断或等待已停止，结果暂未确认；上游可能已计费，请核对服务记录，不要重复发送。"
      : "对话尚未发送，请检查服务设置。");
    error.code = "TAVERN_RESULT_UNKNOWN";
    error.submission_unknown = started;
    if (mode === 'platform') error.request_id = requestId;
    throw error;
  } finally {
    clearTimeout(timer);
    activeRequests.delete(intent);
    signal?.removeEventListener("abort", abort);
  }
}

export async function fetchAdminTavernOverview(authHeaders = {}, days = 30) {
  if (![7, 30, 90].includes(days)) throw new Error('请选择近7、30或90天。');
  const data = await billingFetch(`/api/tavern/admin/overview?days=${days}`, authHeaders);
  if (!data.stats || typeof data.stats !== 'object' || !Array.isArray(data.requests) || data.requests.length > 50) throw new Error('酒馆运营数据格式无效。');
  return { stats: data.stats, requests: data.requests.map(normalizeBillingRequest) };
}
