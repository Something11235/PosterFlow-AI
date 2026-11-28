import { creditUnits, CREDIT_SCALE } from "./credits.js";

export function isPptStep(action) {
  return action === "outline" || action === "page";
}

function nextStep(generation, id = crypto.randomUUID()) {
  return { id, action: generation.outline ? "page" : "outline", at: Date.now(), model: generation.settings.model };
}

function generationSettings(project, topic, count) {
  return { topic, model: project.model, references: project.references, page_count: count,
    ...(project.motionEnabled && !project.originalPptx && { motion_enabled: true }),
    template: project.template?.template, ...(project.template?.source?.text && { template_source: project.template.source }) };
}

export function startPptGeneration(project, topic) {
  if (project.originalPptx) throw new Error("请在原稿中选择要修改的页面。");
  if (project.pending || project.generation?.status === "paused") throw new Error("请先处理当前生成任务。");
  const generation = {
    status: "running", outline: null, completed: 0, chargedUnits: 0, releasedSteps: 0,
    settings: generationSettings(project, topic.trim(), project.autoPageCount ? "auto" : project.pageCount),
    templateFile: project.template?.file || project.template?.template || null,
  };
  return { ...project, topic, lastTask: null, view: "preview", generation, pending: nextStep(generation) };
}

function excerpt(text, limit) {
  return text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
}

// Rebuild the outline in the actual slide order, including manually inserted or edited pages.
function currentOutline(project) {
  const { deck, generation } = project;
  const title = project.name?.trim() || deck.title;
  const oldOutline = generation?.outline;
  const prior = oldOutline?.title === deck.title || oldOutline?.title === title ? oldOutline : null;
  const slides = deck.slides.map((slide, index) => {
    const page = prior?.slides?.[index];
    const matched = page?.title === slide.title ? page : null;
    const text = slide.elements.filter(item => item.type === "text").map(item => item.text).join("\n").trim();
    const brief = [text, matched?.brief].filter(Boolean).join("\n");
    return { ...matched, title: slide.title, brief: excerpt(brief || slide.title, 1200) };
  });
  return { title, slides, ...(prior?.design && { design: prior.design }) };
}

function pageForModel(slide) {
  const fields = ["id", "type", "x", "y", "w", "h", "fill", "fontSize", "color", "align", "bold"];
  let textRemaining = 12000;
  const elements = slide.elements.map(item => {
    const summary = Object.fromEntries(fields.filter(key => item[key] !== undefined).map(key => [key, item[key]]));
    if (item.type === "text") {
      // Each existing block remains identifiable even on unusually dense imported pages.
      summary.text = excerpt(item.text.trim(), Math.min(textRemaining, 6000)) || "…";
      textRemaining -= Math.min(textRemaining, summary.text.length);
    }
    return summary;
  });
  return { id: slide.id, title: slide.title, background: slide.background, elements };
}

export function pptStepPageIndex(run) {
  return run?.targets?.[run.completed]?.index ?? run?.completed ?? 0;
}

function titleOutline(project) {
  return {
    title: excerpt(project.name?.trim() || project.deck.title || "演示稿", 240),
    slides: project.deck.slides.map((slide, i) => ({ title: excerpt(slide.title?.trim() || `第 ${i + 1} 页`, 240) })),
  };
}

// Only slide-local PowerPoint objects may enter the animation sequence. In an
// imported document several preview elements may represent one native group.
function motionTargets(slide, original) {
  if (slide.nativeTiming) return [];
  const targets = new Map();
  for (const el of slide.elements) {
    const id = original ? el.motionTargetId : el.id;
    if (!id) continue;
    let target = targets.get(id);
    if (!target) {
      if (targets.size >= 256) continue;
      target = { id, type: el.motionTargetType || el.type };
      targets.set(id, target);
    }
    const label = el.type === "text" && el.text?.trim();
    if (label && (target.text?.length || 0) < 400) {
      target.text = excerpt([target.text, label].filter(Boolean).join(" · "), 400);
    }
  }
  return Array.from(targets.values());
}

export function pptMotionPendingPages(project) {
  const original = Boolean(project.originalPptx);
  return (project.deck?.slides || []).flatMap((slide, index) => {
    if (slide.motion) return [];
    const available = !slide.nativeTransition || (!slide.nativeTiming && slide.elements.some(el => !original || el.motionTargetId));
    return available ? [index] : [];
  });
}

export function startPptMotion(project) {
  if (project.pending || project.generation?.status === "paused") throw new Error("请先处理当前任务。");
  const indexes = pptMotionPendingPages(project);
  if (!indexes.length) throw new Error("所有页面的动效都已配置。");
  const original = Boolean(project.originalPptx);
  const outline = titleOutline(project);
  const targets = indexes.map(index => {
    const page = project.deck.slides[index];
    if (original && (typeof page.nativeTiming !== "boolean" || typeof page.nativeTransition !== "boolean")) {
      throw new Error("原稿动效信息尚未读取，请重试。");
    }
    return { index, pageId: page.id, motionOnly: {
      page_id: page.id, title: outline.slides[index].title, deck_title: outline.title,
      native_timing: Boolean(page.nativeTiming), native_transition: Boolean(page.nativeTransition),
      targets: motionTargets(page, original),
    } };
  });
  const generation = { mode: "motion", status: "running", outline, completed: 0, chargedUnits: 0, releasedSteps: 0,
    targets, settings: { model: project.model, page_count: project.deck.slides.length } };
  return { ...project, generation, motionEnabled: true, pending: nextStep(generation), view: "preview", lastTask: null };
}

function originalPageTarget(slide, index, elementIds) {
  const wanted = elementIds ? new Set(elementIds) : null;
  const blocks = slide.elements
    .filter(el => typeof el.originalText === "string" && (!wanted || wanted.has(el.id)))
    .map(({ id, text }) => ({ id, text }));
  if (!blocks.length || (wanted && wanted.size !== blocks.length)) {
    throw new Error(`第 ${index + 1} 页没有对应的可修改文字，请重新选择。`);
  }
  if (blocks.length > 256 || blocks.some(b => Array.from(b.text).length > 12000)) {
    throw new Error(`第 ${index + 1} 页的文字超出单次修改范围。请在预览中选取部分文本框，每框最多 12,000 字。`);
  }
  return { index, slide: { id: slide.id }, blocks };
}

export function startPptRegeneration(project, selectedIds, instruction = "", topic = project.topic, { elementIds } = {}) {
  if (project.pending || project.generation?.status === "paused") throw new Error("请先处理当前生成任务。");
  const ids = new Set(selectedIds);
  const slides = project.deck?.slides || [];
  const original = Boolean(project.originalPptx);
  if (elementIds && (!original || ids.size !== 1)) throw new Error("请选择同一原稿页内的文本框。");
  const targets = slides.flatMap((slide, index) => {
    if (!ids.has(slide.id)) return [];
    return [original ? originalPageTarget(slide, index, elementIds) : { index, slide: pageForModel(slide) }];
  });
  if (!targets.length || targets.length !== ids.size) throw new Error("请重新选择要生成的页面。");
  const outline = original ? titleOutline(project) : currentOutline(project);
  const generation = { mode: "regenerate", status: "running", outline, completed: 0, chargedUnits: 0, releasedSteps: 0,
    ...(original && { originalEdit: true }), targets, instruction: instruction.trim(),
    settings: generationSettings(project, topic.trim() || outline.title, slides.length) };
  return { ...project, topic, view: "preview", lastTask: null, generation, pending: nextStep(generation) };
}

export function pptStepBody(project) {
  const { generation, pending } = project;
  const body = { ...generation.settings, request_id: pending.id };
  if (generation.mode === "motion") {
    const target = generation.targets[generation.completed];
    return { ...body, page_index: target.index, motion_only: target.motionOnly };
  }
  if (pending.action === "outline") delete body.motion_enabled;
  if (generation.originalEdit) {
    const { index, slide, blocks } = generation.targets[generation.completed];
    const { outline } = generation;
    return { ...body, page_index: index, original_edit: {
      page_id: slide.id, title: outline.slides[index].title, deck_title: outline.title, blocks,
      instruction: generation.instruction,
      nearby_titles: outline.slides.slice(Math.max(0, index - 2), index + 3).map(page => page.title),
    } };
  }
  if (pending.action === "page") Object.assign(body, { outline: generation.outline, page_index: pptStepPageIndex(generation) });
  if (generation.mode === "regenerate") {
    body.regenerate = { slide: generation.targets[generation.completed].slide, instruction: generation.instruction };
  }
  return body;
}

export function pausePptStep(project, id, message, retrySameId) {
  if (project.pending?.id !== id || !isPptStep(project.pending.action)) return project;
  return { ...project, pending: null, generation: { ...project.generation, status: "paused",
    error: message, retryId: retrySameId ? id : undefined } };
}

export function resumePptGeneration(project) {
  if (project.pending || project.generation?.status !== "paused") return project;
  const { retryId, ...generation } = project.generation;
  return { ...project, generation: { ...generation, status: "running", error: "" }, pending: nextStep(generation, retryId) };
}

function finishedRun(run, status) {
  const { outline, completed, chargedUnits, releasedSteps } = run;
  return { status, outline, completed, chargedUnits, releasedSteps,
    ...(run.targets && { mode: run.mode, targets: run.targets.map(({ index }) => ({ index })) }),
    ...(run.originalEdit && { originalEdit: true }) };
}

function applyOriginalEdits(slide, target, result) {
  if (result?.id !== slide.id || !Array.isArray(result.original_edits)) throw new Error("无法核对原稿修改结果，请查询原任务。");
  const scope = new Map(target.blocks.map(b => [b.id, b.text]));
  const changes = new Map();
  for (const edit of result.original_edits) {
    if (!scope.has(edit?.id) || changes.has(edit.id) || typeof edit.text !== "string" || Array.from(edit.text).length > 12000) {
      throw new Error("返回的修改与原稿选区不一致，请查询原任务。");
    }
    changes.set(edit.id, edit.text);
  }
  if (!changes.size) return slide;
  const elements = slide.elements.map(el => {
    if (!changes.has(el.id)) return el;
    if (typeof el.originalText !== "string" || el.text !== scope.get(el.id)) throw new Error("修改期间原文已变更，请核对当前页。");
    return { ...el, text: changes.get(el.id) };
  });
  const newTitle = changes.get(slide.originalTitleId)?.trim();
  return { ...slide, elements, ...(newTitle && { title: excerpt(newTitle, 240) }) };
}

export function endPausedGeneration(project) {
  const run = project.generation;
  if (project.pending || run?.status !== "paused") return project;
  if (!run.outline) return { ...project, generation: null };
  // Keep the already delivered outline available even when no pages were finished.
  return { ...project, generation: finishedRun(run, "ended"),
    lastTask: { action: "partial", status: "succeeded", billing: { status: "settled", charged_credits: run.chargedUnits / CREDIT_SCALE } } };
}

export function finishPptStep(project, id, result) {
  const { pending, generation } = project;
  if (pending?.id !== id || !isPptStep(pending.action)) return project;
  if (result.status === "failed") return pausePptStep(project, id, result.error?.message || "这一步未能完成。", false);
  if (result.status !== "succeeded") return project;
  const settled = result.billing?.status === "settled";
  const chargedUnits = generation.chargedUnits + (settled ? creditUnits(result.billing.charged_credits) : 0);
  const next = { ...generation, chargedUnits, releasedSteps: generation.releasedSteps + (settled ? 0 : 1) };
  if (pending.action === "outline") {
    if (!result.outline?.slides?.length) throw new Error("大纲尚不完整，请查询原任务。");
    next.outline = result.outline;
    return { ...project, generation: next, pending: nextStep(next) };
  }
  const addingMotion = generation.mode === "motion";
  if (!result.slide?.id || (!addingMotion && !generation.originalEdit && !result.slide.elements?.length)) throw new Error("页面结果尚不完整，请查询原任务。");
  const regenerating = generation.mode === "regenerate";
  let deck;
  if (addingMotion) {
    const target = generation.targets[generation.completed];
    const slides = project.deck.slides.slice();
    const page = slides[target.index];
    if (page?.id !== target.pageId || result.slide.id !== page.id || !Array.isArray(result.slide.motion?.groups)) {
      throw new Error("无法核对页面的动效方案，请查询原任务。");
    }
    slides[target.index] = { ...page, motion: result.slide.motion };
    deck = { ...project.deck, slides };
  } else if (regenerating) {
    const target = generation.targets[generation.completed];
    const original = project.deck?.slides[target.index];
    if (original?.id !== target.slide.id) throw new Error("待替换页面已变更，请核对当前演示稿。");
    const slides = project.deck.slides.slice();
    if (generation.originalEdit) {
      slides[target.index] = applyOriginalEdits(original, target, result.slide);
    } else {
      const images = new Map(original.elements.filter(el => el.type === "image").map(el => [el.id, el.src]));
      const elements = result.slide.elements.map(el => {
        if (el.type !== "image") return el;
        if (!images.get(el.id)) throw new Error("页面图片与原稿不符，请查询原任务。");
        return { ...el, src: images.get(el.id) };
      });
      slides[target.index] = { ...result.slide, id: original.id, elements };
    }
    deck = { ...project.deck, slides };
  } else {
    const slides = generation.completed ? project.deck.slides : [];
    if (slides.length !== generation.completed) throw new Error("已保存的页数发生变化，请核对当前演示稿。");
    deck = { title: generation.outline.title, slides: [...slides, result.slide] };
  }
  next.completed++;
  const done = next.completed === (next.targets?.length ?? next.outline.slides.length);
  return {
    ...project, deck, ...(!generation.targets && { deckTemplate: generation.templateFile, deckFont: generation.settings.template?.font || null }),
    generation: done ? finishedRun(next, "done") : next,
    pending: done ? null : nextStep(next),
    lastTask: done ? { id, action: generation.mode || "generate", status: "succeeded",
      billing: { status: "settled", charged_credits: chargedUnits / CREDIT_SCALE },
      ...(next.releasedSteps > 0 && { note: "部分步骤的用量未能核实，已释放对应预留积分" }) } : null,
  };
}
