import { apimartImageModel, IMAGE_TIER_MODELS } from "./provider.js";

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

export async function readImageTask(requestId, headers, signal, model = new Headers(headers).get("X-Provider-Model"), route) {
  const buytoken = route ? route === 'buytoken' : usesBuyToken(model, headers);
  let response = await boundedFetch(`${buytoken ? BUYTOKEN_IMAGES_BASE : APIMART_IMAGES_BASE}/tasks/${encodeURIComponent(requestId)}`, { headers, signal, cache: "no-store" }, 230000);
  // Pre-migration GPT2.6 tasks keep their original APIMart query path and Key.
  // This is a GET-only recovery fallback, never another generation submission.
  if (buytoken && response.status === 404) {
    const missing = await response.clone().json();
    if (missing.code === "IMAGE_TASK_NOT_FOUND") response = await boundedFetch(`${APIMART_IMAGES_BASE}/tasks/${encodeURIComponent(requestId)}`, { headers, signal, cache: "no-store" }, 230000);
  }
  const data = await response.json();
  if (!response.ok || data.error) throw Object.assign(new Error(data.detail || data.error || "图片任务暂时无法查询。"), { code: data.code });
  return data;
}

// The synchronous route has the same owned GET recovery, including terminal
// states. Keep those states so an already-refunded task is not left pending.
export async function readLegacyImageTask(requestId, headers) {
  const response = await boundedFetch(`/api/generations/${encodeURIComponent(requestId)}`, {headers, credentials:'include', cache:'no-store'}, 20000);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error('原任务暂时无法查询，请稍后重试。');
  return data;
}

// Read owned metadata only. Each provider can fail independently; never submit
// or reconcile a task while listing. No provider credentials are needed here.
export async function listImageTasks(headers, signal) {
  const results = await Promise.allSettled(['buytoken', 'apimart'].map(async route => {
    const base = route === 'buytoken' ? BUYTOKEN_IMAGES_BASE : APIMART_IMAGES_BASE;
    const response = await boundedFetch(`${base}/tasks`, {headers, signal, cache:'no-store'}, 20000);
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.jobs)) throw new Error('TASK_LIST_UNAVAILABLE');
    return data.jobs.map(job => imageJobMetadata(job, route));
  }));
  return {jobs:results.flatMap(result => result.status === 'fulfilled' ? result.value : []), unavailable:results.some(result => result.status === 'rejected')};
}

export function imageJobMetadata(job, route) {
  const status = job.status === 'completed' ? 'completed' : job.status === 'failed' ? 'failed' : 'pending';
  const pendingCode = ['submitting', 'submission_unknown'].includes(job.status) ? 'IMAGE_SUBMISSION_UNKNOWN'
    : ['submitted', 'processing'].includes(job.status) ? job.error_code || 'IMAGE_TASK_PENDING' : job.error_code || 'IMAGE_TASK_REVIEW_REQUIRED';
  return {id:job.request_id, model:job.model, billingMode:job.billing_mode, createdAt:Date.parse(job.created_at), route,
    status, images:(Array.isArray(job.image_keys) ? job.image_keys : []).map(filename => ({filename})),
    ...(['pending','failed'].includes(status) ? {error:{code:status==='failed'?job.error_code || 'IMAGE_TASK_FAILED':pendingCode,submission_unknown:status==='pending'}} : {})};
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
  if (requestImageModel(body, init.headers) === "gpt-image-2") return responseJson({error:"GPT Image 2 已下线，请重新选择模型。",code:"MODEL_RETIRED"},400);
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
  let response;
  try {
    response = await boundedFetch(`${buytoken ? BUYTOKEN_IMAGES_BASE : APIMART_IMAGES_BASE}/generations`, init, buytoken ? 230000 : 90000);
  } catch {
    return responseJson({ error: "提交连接未完成，请在图片任务窗口查询原任务，不要重复生成。", code: "IMAGE_SUBMISSION_UNKNOWN" }, 503);
  } finally {
    window.dispatchEvent(new Event("posterflow:image-tasks"));
  }
  if (!response.ok) return response;
  let data = await response.json();
  const start = Date.now();
  while (data.job && !["completed", "failed", "submission_unknown", "submitting"].includes(data.job.status)) {
    if (Date.now() - start >= maxWait) return responseJson({ error: "任务仍在处理，可在图片任务窗口查询；请勿重复生成。", code: "IMAGE_TASK_PENDING" }, 202);
    await sleep(pollInterval);
    try {
      data = await readImageTask(body.request_id, init.headers, undefined, model);
    } catch (error) {
      return responseJson({ error: error.message + " 可在图片任务窗口继续查询，请勿重复生成。", code: error.code || "IMAGE_TASK_QUERY_FAILED", submission_unknown:true }, 503);
    }
  }
  window.dispatchEvent(new Event("posterflow:image-tasks"));
  if (data.job?.status !== "completed") return responseJson({ ...data, error: data.job?.status === "failed" ? data.job.failure_reason || "图片服务未完成本次任务，已按实际结果退回预留积分。" : "提交结果待确认，请保留原任务并核对服务商记录，不要重复生成。", code: data.job?.status === "failed" ? data.job.error_code || "APIMART_TASK_FAILED" : "IMAGE_SUBMISSION_UNKNOWN", detail:data.job?.failure_reason, recovery:data.job?.recovery }, 409);
  return responseJson({ ...data, prompt: body.prompt });
}
