import { apimartImageModel, IMAGE_TIER_MODELS, isRetiredImageModel } from "./provider.js";
import { imageRefundError } from './imageRefund.js';
import { imageTransportDiagnostic } from './imageGenerationError.js';

export const APIMART_IMAGES_BASE = "/api/apimart-images";
export const BUYTOKEN_IMAGES_BASE = "/api/buytoken-images";
export function usesBuyToken(model, headers) {
  if (!model?.startsWith("gpt-image-2.6-")) return false;
  const values = new Headers(headers);
  if (values.get("X-Billing-Mode") === "platform") return true;
  try { return new URL(values.get("X-Provider-Endpoint")).hostname === "api.buytoken.work"; } catch { return false; }
}
export function requestImageModel(body, headers) {
  const values = new Headers(headers);
  return values.get("X-Billing-Mode") === "platform" ? body.platform_model : values.get("X-Provider-Model");
}
const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));
const responseJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function boundedFetch(url, init, milliseconds) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, milliseconds);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // Include the entire JSON body in the deadline, not only response headers.
    const body = await response.text();
    return new Response(body, { status: response.status, headers: response.headers });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

async function readTaskReply(response) {
  const data = await response.json().catch(() => null);
  if (response.ok && typeof (data?.job?.status ?? data?.status) === 'string' && !data.error) return data;
  const code = typeof data?.code === 'string' ? data.code :
    response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : undefined;
  const reason = data?.detail || data?.error;
  const detail = typeof reason === 'string' && code ? reason : '原任务暂时无法查询。';
  throw Object.assign(new Error(detail), {code, status:response.status, diagnostic:imageTransportDiagnostic(null, response.status)});
}

export async function readImageTask(requestId, headers, signal, model = new Headers(headers).get("X-Provider-Model"), route, { timeoutMs = 230000, allowLegacyFallback = true } = {}) {
  const buytoken = route ? route === 'buytoken' : usesBuyToken(model, headers);
  const deadline = Date.now() + timeoutMs;
  const readFrom = async (base, timeout) => readTaskReply(await boundedFetch(`${base}/tasks/${encodeURIComponent(requestId)}`, {headers, signal, cache:'no-store'}, timeout));
  // Pre-migration GPT2.6 tasks keep their original APIMart query path and Key.
  // This is a GET-only recovery fallback, never another generation submission.
  try {
    return await readFrom(buytoken ? BUYTOKEN_IMAGES_BASE : APIMART_IMAGES_BASE, timeoutMs);
  } catch (error) {
    if (buytoken && allowLegacyFallback && error.status === 404 && error.code === 'IMAGE_TASK_NOT_FOUND' && Date.now() < deadline) {
      return readFrom(APIMART_IMAGES_BASE, deadline - Date.now());
    }
    throw error;
  }
}

// The synchronous route has the same owned GET recovery, including terminal
// states. Keep those states so an already-refunded task is not left pending.
export async function readLegacyImageTask(requestId, headers) {
  const response = await boundedFetch(`/api/generations/${encodeURIComponent(requestId)}`, {headers, credentials:'include', cache:'no-store'}, 20000);
  return readTaskReply(response);
}

// Read owned metadata only. Each provider can fail independently; never submit
// or reconcile a task while listing. No provider credentials are needed here.
export async function listImageTasks(headers, signal) {
  const results = await Promise.allSettled(['buytoken', 'apimart'].map(async route => {
    const base = route === 'buytoken' ? BUYTOKEN_IMAGES_BASE : APIMART_IMAGES_BASE;
    const response = await boundedFetch(`${base}/tasks`, {headers, signal, cache:'no-store'}, 20000);
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      throw Object.assign(new Error('任务列表读取失败'), {status: response.status, code: failure?.code});
    }
    const data = await response.json();
    if (!Array.isArray(data?.jobs)) throw new Error('任务列表格式无效');
    return data.jobs.map(job => imageJobMetadata(job, route));
  }));
  const failures = results.filter(result => result.status === 'rejected');
  let warning = '';
  if (failures.length) {
    const scope = failures.length === results.length ? '任务列表' : '部分任务';
    if (failures.every(result => result.reason?.status === 401)) {
      warning = `${scope}暂未通过登录验证，请先刷新网页后再查看。`;
    } else if (failures.every(result => result.reason?.code === 'AUTH_VERIFY_UNAVAILABLE')) {
      warning = '登录验证服务暂时不可用，请稍后刷新任务列表。';
    } else if (failures.every(result => result.reason?.code === 'IMAGE_TASK_LIST_READ_FAILED')) {
      warning = `${scope}暂时无法从数据库读取，请稍后刷新。已有记录仍可查看。`;
    } else {
      warning = `${scope}暂未同步，请稍后刷新。已有记录仍可查看。`;
    }
  }
  return {jobs:results.flatMap(result => result.status === 'fulfilled' ? result.value : []), unavailable:Boolean(warning), warning};
}

const unknownSubmission = () => ({
  code:'IMAGE_SUBMISSION_UNKNOWN', message:'暂时未确认原任务结果，可查询原任务；请勿重复生成。',
  submission_unknown:true,recovery_confirmed:false,
});

// A durable processing task is not a failed submission. The availability flag
// only says whether output has arrived; polling the owned task is safe before it.
export function imageTaskPendingState(job, route) {
  if (['submission_unknown', 'unknown'].includes(job?.status)) return unknownSubmission();
  if (['submitting','processing','saving'].includes(job?.status) || (route === 'apimart' && job?.status === 'submitted')) {
    const available = job.status === 'saving' || job.status !== 'submitting' && job.result_available === true;
    const saving = job.status === 'saving' || available && job.error_code === 'IMAGE_SAVE_PENDING';
    return {
      code:saving ? 'IMAGE_SAVE_PENDING' : 'IMAGE_TASK_PENDING',
      message:saving ? '图片已返回，正在保存原任务图片。' : job.status === 'submitting' ? '原任务已记录，正在提交生成。' : '原任务正在生成，请稍候。',
      submission_unknown:false,recovery_confirmed:available || route === 'apimart' && job.status !== 'submitting',
    };
  }
  return null;
}

export function imageJobMetadata(job, route) {
  const status = job.status === 'completed' ? 'completed' : job.status === 'failed' ? 'failed' : 'pending';
  const pendingState = imageTaskPendingState(job, route) || {code:'IMAGE_TASK_REVIEW_REQUIRED',submission_unknown:true};
  return {id:job.request_id, model:job.model, billingMode:job.billing_mode, createdAt:Date.parse(job.created_at), route,
    status, images:(Array.isArray(job.image_keys) ? job.image_keys : []).map(filename => ({filename})),
    ...(status==='pending' ? {error:pendingState} : status==='failed' ? {error:imageRefundError(job) || {code:job.error_code || 'IMAGE_TASK_FAILED',message:job.failure_reason,recovery:job.recovery,submission_unknown:false,billing_mode:job.billing_mode}} : {})};
}

// Legacy requests remain byte-for-byte on their existing routes. New model
// requests submit once, then only GET the durable task; never retry a paid POST.
export async function imageGenerationFetch(endpoint, init, { pollInterval = 4000, maxWait = 240000 } = {}) {
  let body = JSON.parse(init.body);
  const model = requestImageModel(body, init.headers);
  const buytoken = usesBuyToken(model, init.headers);
  if (IMAGE_TIER_MODELS.has(model)) {
    body = {...body, pricing_version: 3};
    init = {...init, body: JSON.stringify(body)};
  }
  if (isRetiredImageModel(model)) return responseJson({error: model === "seedream-5-0-lite" ? "Seedream 5.0 Lite 已下架，请刷新页面后选择其他模型。" : "GPT Image 2 已下线，请重新选择模型。",code:"MODEL_RETIRED",generation_submitted:false},400);
  if (!apimartImageModel(requestImageModel(body, init.headers))) return fetch(endpoint, init);
  if (requestImageModel(body, init.headers).startsWith('gpt-image-2.6-')) {
    body = { ...body, pricing_version: 3 };
    init = { ...init, body: JSON.stringify(body) };
  }
  if (requestImageModel(body, init.headers) === "grok-imagine-2.0-ext" && body.operation === "region_edit") {
    // Segment is free and separate from the single paid edit intent. Never
    // resubmit either intent automatically, including ambiguous connections.
    try {
      let response = await boundedFetch(`${APIMART_IMAGES_BASE}/segments`, init, 90000);
      if (!response.ok) return response;
      let segment = await response.json();
      const start = Date.now();
      while (segment.status !== "completed") {
        if (!segment.receipt || Date.now() - start > Math.min(maxWait, 60000)) throw new Error("原图准备尚未完成，尚未提交收费编辑，请稍后再试。");
        await sleep(pollInterval);
        response = await boundedFetch(`${APIMART_IMAGES_BASE}/segments/status`, { ...init, body: JSON.stringify({receipt:segment.receipt, platform_model:body.platform_model}) }, 30000);
        if (!response.ok) return response;
        segment = await response.json();
      }
      if (!segment.segment_receipt) throw new Error("原图准备未返回有效结果，尚未提交收费编辑。");
      body = {request_id:body.request_id, platform_model:body.platform_model, prompt:body.prompt,
        operation:"region_edit", selection_regions:body.selection_regions, segment_receipt:segment.segment_receipt, count:1};
      init = {...init, body:JSON.stringify(body)};
    } catch {
      return responseJson({error:"原图准备尚未确认，尚未提交收费编辑，请稍后再试。",code:"IMAGE_REGION_PENDING",generation_submitted:false},503);
    }
  }
  const route = buytoken ? 'buytoken' : 'apimart';
  const recoverUnknown = new Headers(init.headers).get('X-Billing-Mode') === 'platform';
  const recoverableCodes = new Set(['IMAGE_SUBMISSION_UNKNOWN','IMAGE_TASK_UNAVAILABLE','IMAGE_DATABASE_UNAVAILABLE','IMAGE_REFUND_PENDING','IMAGE_SAVE_PENDING','IMAGE_TASK_QUERY_FAILED']);
  let response, data, submissionUncertain = false;
  let diagnostic, diagnosticPhase = 'submission';
  try {
    response = await boundedFetch(`${buytoken ? BUYTOKEN_IMAGES_BASE : APIMART_IMAGES_BASE}/generations`, init, buytoken ? 230000 : 90000);
    try { data = await response.clone().json(); }
    catch { /* A gateway may send HTML instead of the task response. */ }
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || !data.job && !data.refunded && (typeof data.code !== 'string' || typeof data.error === 'object')) {
      if ([401,403].includes(response.status)) return responseJson({error:response.status === 401 ? '登录状态需要更新，请先刷新网页后重试。' : '当前请求没有访问权限，请确认账户权限。',code:response.status === 401 ? 'AUTH_REQUIRED' : 'ACCESS_DENIED',submission_unknown:false},response.status);
      diagnostic = imageTransportDiagnostic(null, response.status);
      submissionUncertain = true;
      data = {};
    }
  } catch (error) {
    diagnostic = imageTransportDiagnostic(error);
    submissionUncertain = true;
  } finally {
    window.dispatchEvent(new Event("posterflow:image-tasks"));
  }
  if (response && !response.ok && !submissionUncertain) {
    const rejectedBeforeSubmission = data?.generation_submitted === false && data?.submission_unknown !== true;
    if (!recoverUnknown || data?.refunded || rejectedBeforeSubmission || ['failed','completed'].includes(data?.job?.status)
      || !recoverableCodes.has(data?.code)) return response;
    submissionUncertain = !data?.job;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  if (!imageTaskPendingState(data.job,route) && !['completed','failed'].includes(data.job?.status)) submissionUncertain = true;
  const pendingState = () => imageTaskPendingState(data.job, route) || (submissionUncertain ? unknownSubmission() : null);
  const waiting = () => {
    if (init.signal?.aborted) return responseJson({error:'已停止本页等待，原任务可能仍在处理中；可手动查询结果。',code:'IMAGE_QUERY_CANCELLED',submission_unknown:true,recovery_confirmed:false},202);
    const state = pendingState() || unknownSubmission();
    return responseJson({...data,error:state.message,...state,...(diagnostic && {diagnostic, diagnostic_phase:diagnosticPhase})},202);
  };
  if (submissionUncertain && (!recoverUnknown || init.signal?.aborted)) return waiting();
  const deadline = Date.now() + maxWait;
  let queryFailures = 0;
  while (pendingState()) {
    if (pendingState().submission_unknown && !recoverUnknown || init.signal?.aborted || Date.now() >= deadline) return waiting();
    await sleep(Math.min(pollInterval, deadline - Date.now()));
    if (init.signal?.aborted || Date.now() >= deadline) return waiting();
    try {
      data = await readImageTask(body.request_id, init.headers, init.signal, model, route, {timeoutMs:Math.min(230000, deadline-Date.now()),allowLegacyFallback:false});
      if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
      if (data.job?.status) diagnostic = undefined;
      submissionUncertain = !imageTaskPendingState(data.job,route) && !['completed','failed'].includes(data.job?.status);
      queryFailures = 0;
    } catch (error) {
      // An uncertain POST may still be running on the server. Only read its
      // original ID; a short not-found race is not permission to submit again.
      if (init.signal?.aborted) return waiting();
      const transient = !error.status || error.diagnostic === 'RESPONSE_INVALID' || error.status === 408 || error.status === 429 || error.status >= 500
        || recoverUnknown && error.status === 404 && error.code === 'IMAGE_TASK_NOT_FOUND';
      if (error.code === 'IMAGE_SUBMISSION_UNKNOWN') { data = {}; submissionUncertain = true; }
      if (pendingState() && transient && !init.signal?.aborted) {
        if (error.status !== 404 && error.code !== 'IMAGE_SUBMISSION_UNKNOWN') {
          diagnostic = ['AUTH_VERIFY_UNAVAILABLE','IMAGE_DATABASE_UNAVAILABLE'].includes(error.code)
            ? error.code : error.diagnostic || imageTransportDiagnostic(error, error.status);
          diagnosticPhase = 'query';
        }
        if (++queryFailures < 3 && Date.now() < deadline) continue;
        return waiting();
      }
      return responseJson({ error: error.message + " 可在图片任务窗口继续查询，请勿重复生成。", code: error.code || "IMAGE_TASK_QUERY_FAILED", diagnostic:error.diagnostic, diagnostic_phase:'query', submission_unknown:true, recovery_confirmed:false }, error.status || 503);
    }
  }
  window.dispatchEvent(new Event("posterflow:image-tasks"));
  if (data.job?.status !== "completed") return responseJson({ ...data, ...(data.job?.status !== 'failed' ? unknownSubmission() : {}), error: data.job?.status === "failed" ? data.job.failure_reason || "图片服务未完成本次任务。" : "提交结果待确认，请查询原任务，不要重复生成。", code: data.job?.status === "failed" ? data.job.error_code || "APIMART_TASK_FAILED" : "IMAGE_SUBMISSION_UNKNOWN", detail:data.job?.failure_reason, recovery:data.job?.recovery }, 409);
  return responseJson({ ...data, prompt: body.prompt });
}
