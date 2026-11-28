import { displayCredits } from "./credits.js";
import { PPT_MODEL_NAMES } from "./pptProject.js";

const modelName = id => PPT_MODEL_NAMES[id] ?? id;

export function canvasTextRouteLabel(config) {
  if (!config?.model || !config.configured) return "";
  const backups = Array.isArray(config.fallback_models) ? config.fallback_models : (config.models || []).map(model => model.id);
  const sequence = [...new Set([config.model, ...backups].filter(id => typeof id === "string" && id))];
  return sequence.length > 1 ? `优先 ${modelName(sequence[0])}，故障时依次切换至 ${sequence.slice(1).map(modelName).join(" → ")}` : `文本模型 ${modelName(config.model)}`;
}

export function canvasTextReceipt({ model, requested_model, billing }) {
  const switched = requested_model && requested_model !== model;
  const label = model ? `回复模型 ${modelName(model)}${switched ? `（由 ${modelName(requested_model)} 自动切换）` : ""}` : "";
  const charged = displayCredits(billing?.charged_credits, "");
  const cost = billing?.status === "refunded" ? "预留积分已退回" : charged && `实扣 ${charged} 积分`;
  return [label, cost].filter(Boolean).join(" · ");
}

export function canvasTextPayload(input, requestId) {
  if (input.action === "split") return {
    request_id: requestId, script: input.script,
    ...(input.shot_count ? { shot_count: input.shot_count } : {}),
  };
  return {
    request_id: requestId, mode: input.action, target: input.kind, text: input.text || "",
    context: input.context || [input.title, input.description, input.camera].filter(Boolean).join("\n"),
    target_model: input.target_model || "",
  };
}

export async function fetchCanvasText(headers, task, submit = false) {
  const path = submit ? (task.input.action === "split" ? "storyboard" : "prompt") : "requests/" + encodeURIComponent(task.id);
  const res = await fetch("/api/canvas-ai/" + path, {
    method: submit ? "POST" : "GET",
    headers: submit ? { ...headers, "Content-Type": "application/json" } : headers,
    body: submit ? JSON.stringify(canvasTextPayload(task.input, task.id)) : undefined,
    // Model failover can use the full 300-second function window. A status lookup only reads the stored row.
    cache: "no-store", signal: AbortSignal.timeout(submit ? 320000 : 20000),
  });
  const data = await res.json().catch(() => null);
  if (data?.request_id === task.id && ["failed", "succeeded", "processing"].includes(data.status)) return data;
  const error = new Error(data?.error?.message || data?.message || "暂时无法查询 AI 任务。");
  error.code = data?.error?.code || data?.code;
  error.status = res.status;
  error.notSubmitted = data?.submission === "not_submitted";
  throw error;
}

export function finishCanvasText(project, task, result) {
  if (project.textRequest?.id !== task.id || result.request_id !== task.id || result.status === "processing") return project;
  if (result.status === "failed") {
    return { ...project, textRequest: null, textError: result.error?.message || "AI 文本任务未完成。" };
  }
  if (result.status !== "succeeded" || (task.input.action === "split" ? !result.shots?.length : !result.prompt?.trim())) {
    throw new Error("AI 结果不完整，请查询原任务。");
  }
  return { ...project, textRequest: null, textError: "",
    textProposal: { id: task.id, input: task.input, model: result.model, requested_model: result.requested_model, billing: result.billing,
      ...(task.input.action === "split" ? { shots: result.shots } : { text: result.prompt }) } };
}
