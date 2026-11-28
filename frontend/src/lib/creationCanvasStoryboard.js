import { incomingNodes, needsFrameUpdate } from "../components/creationCanvasLayout.js";
import {
  canvasEffectiveControls, canvasGenerationQuoteDetails, canvasGenerationSettings, canvasModelOptions, validateCanvasInputs,
} from "./creationCanvasGeneration.js";
import { canvasInputInfo } from "./creationCanvasMedia.js";
import { connectCanvasNodes } from "./creationCanvasProject.js";
import { buildVideoParameters } from "./video.js";

const fieldsByKind = {
  image: { node: "imageNodeId", prompt: "imagePromptNodeId", label: "生图" },
  video: { node: "videoNodeId", prompt: "videoPromptNodeId", label: "视频" },
};

export function getStoryboard(project) {
  return project?.storyboard || { script: "", shots: [] };
}

export function setStoryboardScript(project, script) {
  return { ...project, storyboard: { ...getStoryboard(project), script } };
}

function findShot(project, shotId) {
  const shot = getStoryboard(project).shots.find(item => item.id === shotId);
  if (!shot) throw new Error("这个镜头已被移除，请刷新分镜列表。");
  return shot;
}

export function getShotNodes(project, shot) {
  const byId = id => project.nodes.find(node => node.id === id);
  return {
    image: byId(shot.imageNodeId), imagePrompt: byId(shot.imagePromptNodeId),
    video: byId(shot.videoNodeId), videoPrompt: byId(shot.videoPromptNodeId),
  };
}

function insertShotNodes(project, shot, row = {}, context = {}) {
  let next = { ...project, nodes: [...project.nodes], edges: [...project.edges] };
  const top = project.nodes.reduce((y, node) => Math.max(y, node.y + 360), 0);
  let column = 0;
  for (const [kind, fields] of Object.entries(fieldsByKind)) {
    const nodeId = shot[fields.node], promptId = shot[fields.prompt];
    if (!next.nodes.some(n => n.id === promptId)) {
      next.nodes.push({ id: promptId, type: "prompt", title: shot.title + " · " + fields.label + "提示词",
        x: column * 640, y: top, text: row[kind + "Prompt"] || "" });
    }
    if (!next.nodes.some(n => n.id === nodeId)) {
      const node = { id: nodeId, type: kind, title: shot.title + " · " + fields.label, x: column * 640 + 280, y: top };
      // Keep script editing available even when a custom provider hasn't been configured yet.
      const options = canvasModelOptions(kind, context);
      if (options.length) {
        const settings = canvasGenerationSettings({ kind, context });
        node.model = settings.model;
        if (kind === "video" && Number.isInteger(row.duration) && row.duration > 0) {
          const duration = canvasEffectiveControls(settings).find(control => control.key === "duration");
          if (duration?.options?.some(option => option.value === row.duration)) node.params = { duration: row.duration };
        }
      }
      next.nodes.push(node);
    }
    if (!next.edges.some(edge => edge.from === promptId && edge.to === nodeId)) next = connectCanvasNodes(next, promptId, nodeId);
    column += 1;
  }
  return next;
}

export function addStoryboardShots(project, rows = [{}], context = {}, importId) {
  const board = getStoryboard(project);
  if (!rows.length || (importId && board.appliedImports?.includes(importId))) return project;
  const shots = [...board.shots];
  let next = project;
  for (const row of rows) {
    const shot = {
      id: crypto.randomUUID(), title: row.title?.trim() || "镜头 " + (shots.length + 1),
      description: row.description || "", camera: row.camera || "",
      ...(Number.isInteger(row.duration) && row.duration > 0 && { suggestedDuration: row.duration }),
      imagePromptNodeId: crypto.randomUUID(), imageNodeId: crypto.randomUUID(),
      videoPromptNodeId: crypto.randomUUID(), videoNodeId: crypto.randomUUID(),
    };
    next = insertShotNodes(next, shot, row, context);
    shots.push(shot);
  }
  return { ...next, storyboard: { ...board, shots,
    ...(importId && { appliedImports: [...(board.appliedImports || []), importId] }) } };
}

export function repairStoryboardShot(project, shotId, context = {}) {
  const shot = findShot(project, shotId);
  return insertShotNodes(project, shot, { duration: shot.suggestedDuration }, context);
}

export function updateStoryboardShot(project, shotId, fields) {
  const shot = findShot(project, shotId);
  const changes = Object.fromEntries(Object.entries(fields).filter(([key]) => ["title", "description", "camera"].includes(key)));
  const updated = { ...shot, ...changes };
  let nodes = project.nodes;
  if (updated.title !== shot.title) {
    const titles = new Map();
    for (const { node, prompt, label } of Object.values(fieldsByKind)) {
      titles.set(shot[node], updated.title + " · " + label);
      titles.set(shot[prompt], updated.title + " · " + label + "提示词");
    }
    nodes = nodes.map(node => titles.has(node.id) ? { ...node, title: titles.get(node.id) } : node);
  }
  const board = getStoryboard(project);
  return { ...project, nodes, storyboard: { ...board, shots: board.shots.map(s => s.id === shotId ? updated : s) } };
}

export function moveStoryboardShot(project, shotId, offset) {
  const board = getStoryboard(project);
  const from = board.shots.findIndex(shot => shot.id === shotId), to = from + offset;
  if (from < 0 || to < 0 || to >= board.shots.length || !Number.isInteger(offset)) return project;
  const shots = [...board.shots];
  shots.splice(to, 0, ...shots.splice(from, 1));
  return { ...project, storyboard: { ...board, shots } };
}

export function removeStoryboardShot(project, shotId) {
  const board = getStoryboard(project);
  return { ...project, storyboard: { ...board, shots: board.shots.filter(shot => shot.id !== shotId) } };
}

function shotTarget(project, shotId, kind) {
  const shot = findShot(project, shotId);
  const target = project.nodes.find(node => node.id === shot[fieldsByKind[kind].node]);
  if (!target) throw new Error("此镜头的生成节点已被移除，请先恢复节点。");
  if (target.run?.status === "pending") throw new Error("请等这个镜头的原任务结束后再修改。");
  return target;
}

function patchNode(project, id, fields) {
  return { ...project, nodes: project.nodes.map(node => node.id === id ? { ...node, ...fields } : node) };
}

export function setShotPrompt(project, shotId, kind, text) {
  shotTarget(project, shotId, kind);
  const shot = findShot(project, shotId), promptId = shot[fieldsByKind[kind].prompt];
  if (!project.nodes.some(node => node.id === promptId)) throw new Error("此镜头的提示词节点已被移除，请先恢复节点。");
  return patchNode(project, promptId, { text });
}

export function setShotModel(project, shotId, kind, model, context = {}) {
  const target = shotTarget(project, shotId, kind);
  const settings = canvasGenerationSettings({ kind, context, model });
  const refs = incomingNodes(project, target.id).filter(n => n.type !== "prompt").map(canvasInputInfo);
  validateCanvasInputs(settings, refs, { partial: true });
  return patchNode(project, target.id, { model, params: {} });
}

export function setShotParam(project, shotId, kind, key, value, context = {}) {
  const target = shotTarget(project, shotId, kind);
  const settings = canvasGenerationSettings({ kind, context, model: target.model, params: target.params });
  const refs = incomingNodes(project, target.id).filter(n => n.type !== "prompt").map(canvasInputInfo);
  const control = canvasEffectiveControls(settings, refs).find(item => item.key === key);
  if (!control || control.disabled) throw new Error("当前模式不支持修改这项参数。");
  const changed = canvasGenerationSettings({ kind, context, model: settings.model, params: { ...settings.params, [key]: value } });
  validateCanvasInputs(changed, refs, { partial: true });
  return patchNode(project, target.id, { model: changed.model, params: changed.params });
}

export function setShotReference(project, shotId, kind, from, enabled, context = {}) {
  const target = shotTarget(project, shotId, kind), to = target.id;
  if (!enabled) return { ...project, edges: project.edges.filter(edge => !(edge.to === to && edge.from === from)) };
  if (project.edges.some(edge => edge.from === from && edge.to === to)) return project;
  const source = project.nodes.find(n => n.id === from);
  if (!source || source.type === "prompt") throw new Error("请选择可用的参考素材。");
  const next = connectCanvasNodes(project, from, to);
  const refs = incomingNodes(next, to).filter(n => n.type !== "prompt").map(canvasInputInfo);
  const settings = canvasGenerationSettings({ kind, context, model: target.model, params: target.params });
  validateCanvasInputs(settings, refs, { partial: true });
  return next;
}

export function canvasNodePrompt(project, nodeId) {
  const texts = incomingNodes(project, nodeId).filter(n => n.type === "prompt").map(n => n.text?.trim()).filter(Boolean);
  const shot = getStoryboard(project).shots.find(s => s.imageNodeId === nodeId || s.videoNodeId === nodeId);
  if (shot?.description?.trim()) texts.push("画面：" + shot.description.trim());
  if (shot?.videoNodeId === nodeId && shot.camera?.trim()) texts.push("运镜：" + shot.camera.trim());
  return texts.join("\n");
}

// Changes to an input must invalidate the confirmation even if the new input has the same price.
export function storyboardItemSignature(project, nodeId) {
  const inputs = incomingNodes(project, nodeId).filter(node => node.type !== "prompt").map(node => {
    const media = node.run || node;
    return [node.id, node.type, node.assetKind, media.requestId, media.status, media.assetId, media.url,
      media.filename, media.duration_ms, node.sourceRequestId, needsFrameUpdate(project, node)];
  });
  return JSON.stringify([project.id, nodeId, canvasNodePrompt(project, nodeId), inputs]);
}

export function getShotQuote(project, shot, kind, context = {}) {
  const node = project.nodes.find(n => n.id === shot[fieldsByKind[kind].node]);
  let quote = { model: node?.model, options: canvasModelOptions(kind, context), controls: [] };
  try {
    if (!node) throw new Error("此镜头的生成节点已被移除，请先恢复节点。");
    const settings = canvasGenerationSettings({ kind, context, model: node.model, params: node.params });
    const info = incomingNodes(project, node.id).filter(n => n.type !== "prompt").map(canvasInputInfo);
    quote = { ...quote, ...settings, controls: canvasEffectiveControls(settings, info), inputSignature: storyboardItemSignature(project, node.id) };
    validateCanvasInputs(settings, info);
    return { ...quote, ...canvasGenerationQuoteDetails({ ...settings, context, referenceInfo: info }) };
  } catch (error) { return { ...quote, error: error.message }; }
}

function readinessError(project, shot, kind, target, quote) {
  if (quote.error) return quote.error;
  if (target.run?.status === "pending") return "原任务仍在处理，请稍后查看结果。";
  const inputs = incomingNodes(project, target.id);
  if (!inputs.some(n => n.id === shot[fieldsByKind[kind].prompt])) return "此镜头的提示词连接已断开，请先恢复节点。";
  const prompt = canvasNodePrompt(project, target.id);
  const sources = inputs.filter(n => n.type !== "prompt");
  if (!prompt && (kind === "image" || !sources.length && !quote.params.link_url)) return "请先填写镜头的画面描述或提示词。";
  if (kind === "image" && Array.from(prompt).length > 6000) return "画面描述与生图提示词合计最多 6000 字，请精简后生成。";
  if (kind === "video") {
    const effective = Object.fromEntries(quote.controls.map(control => [control.key, control.effectiveValue]));
    try { buildVideoParameters({ ...quote.params, ...effective, model: quote.model, prompt }); }
    catch (error) { return error.message; }
  }
  for (const source of sources) {
    const media = source.run || source;
    if (source.run && source.run.status !== "completed" || !media.assetId && !media.url) return "请先为「" + source.title + "」添加或生成参考素材。";
    if (needsFrameUpdate(project, source)) return "请先重新提取「" + source.title + "」的尾帧。";
    if (["audio", "video"].includes(canvasInputInfo(source).kind) && !media.duration_ms) return "请先在画布节点读取参考素材时长。";
  }
  return "";
}

export function storyboardPlan(project, shotIds, kind, context = {}) {
  const selected = new Set(shotIds), rows = getStoryboard(project).shots.filter(shot => selected.has(shot.id));
  const items = rows.map(shot => {
    selected.delete(shot.id);
    const nodeId = shot[fieldsByKind[kind].node], target = project.nodes.find(n => n.id === nodeId);
    const quote = getShotQuote(project, shot, kind, context);
    return { shotId: shot.id, title: shot.title, nodeId, requestId: target?.run?.requestId || null,
      quote, error: readinessError(project, shot, kind, target, quote) };
  });
  for (const id of selected) items.push({ shotId: id, title: "已移除的镜头", quote: {}, error: "所选镜头已移除，请重新选择。" });
  const total = key => Number(items.reduce((sum, item) => sum + (item.quote[key] || 0), 0).toFixed(4));
  const signature = JSON.stringify(items.map(({ shotId, nodeId, requestId, quote, error }) => [shotId, nodeId, requestId,
    quote.billingMode, quote.providerOrigin, quote.model, quote.params, quote.credits, quote.reservedCredits, quote.inputSignature, error]));
  return { items, credits: total("credits"), reservedCredits: total("reservedCredits"), signature };
}
