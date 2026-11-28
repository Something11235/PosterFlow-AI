import { test } from "node:test";
import assert from "node:assert/strict";
import { newPptProject, requestPpt, restorePptProject } from "../src/lib/pptProject.js";
import { endPausedGeneration, finishPptStep, pausePptStep, pptMotionPendingPages, pptStepBody, resumePptGeneration, startPptGeneration, startPptMotion, startPptRegeneration } from "../src/lib/pptGeneration.js";
import { insertPptPage, removePptPage } from "../src/lib/pptPageActions.js";

const outline = { title: "研究汇报", slides: [{ title: "问题", brief: "论点一" }, { title: "验证", brief: "论点二" }] };
const slide = index => ({ id: "s" + index, title: "页 " + index, elements: [{ id: "title", type: "text", text: "可编辑正文" }] });
const billed = (data, cost) => ({ ...data, status: "succeeded", billing: { status: "settled", charged_credits: cost } });

test("motion opt-in before generation arrives in the same paid page request only", () => {
  for (const motionEnabled of [false, true]) {
    const p = { ...newPptProject(), motionEnabled };
    const start = startPptGeneration(p, "研究汇报");
    assert.equal(pptStepBody(start).motion_enabled, undefined);
    const pages = finishPptStep(start, start.pending.id, billed({ outline }, 0.01));
    assert.equal(pptStepBody(pages).motion_enabled, motionEnabled || undefined);
    const plan = { transition: "fade", groups: [{ ids: ["title"], effect: "wipe", trigger: "after-previous" }] };
    const page = { ...slide(1), ...(motionEnabled && { motion: plan }) };
    const finishedPage = finishPptStep(pages, pages.pending.id, billed({ slide: page }, 0.02));
    assert.deepEqual(finishedPage.deck.slides[0].motion, motionEnabled ? plan : undefined);
  }
});

test("planning motion for an existing original preserves source plans, groups, slide contents and billing on refresh", () => {
  const repeated = { id: "t1", type: "text", text: "E=mc²", motionTargetType: "group", motionTargetId: "native-9" };
  const pages = [
    { ...slide(1), nativeTiming: true, nativeTransition: true },
    { ...slide(2), nativeTiming: false, nativeTransition: true, elements: [repeated, { ...repeated, id: "i2", type: "image", src: "data:image/png;base64,PRIVATE" }] },
    { ...slide(3), nativeTiming: true, nativeTransition: false },
  ];
  const project = { ...newPptProject(), deckTemplate: { font: "Aptos" }, deckFont: "Aptos", originalPptx: new Blob(["original"]), deck: { title: "论文", slides: pages } };
  assert.deepEqual(pptMotionPendingPages(project), [1,2]);
  const first = startPptMotion(project);
  assert.equal(first.pending.action, "page");
  const wire = pptStepBody(first);
  assert.deepEqual(wire.motion_only.targets, [{ id: "native-9", type: "group", text: "E=mc²" }]);
  assert(!JSON.stringify(wire).includes("PRIVATE"));
  const motion = { transition: "none", groups: [{ ids: ["native-9"], effect: "fade", trigger: "on-click" }] };
  const part = finishPptStep(first, first.pending.id, billed({slide: {id:"s2", motion}}, 0.02));
  assert.equal(part.deck.slides[0], pages[0]); assert.equal(part.deck.slides[1].elements, pages[1].elements);
  assert.deepEqual(pptMotionPendingPages(part), [2]);
  const finalWire = pptStepBody(part);
  assert.deepEqual(finalWire.motion_only.targets, []);
  assert.equal(finalWire.motion_only.native_timing, true);
  assert.equal(finalWire.motion_only.native_transition, false);
  assert.deepEqual(pptStepBody(restorePptProject(structuredClone(part))), finalWire);
  assert.equal(finishPptStep(part, first.pending.id, billed({}, 2)), part);
  const final = finishPptStep(part, part.pending.id, billed({slide: {id:"s3", motion:{transition:"push",groups:[]}}}, 0.03));
  assert.equal(final.lastTask.action,"motion");
  assert.equal(final.lastTask.billing.charged_credits,0.05);
  assert.equal(final.deckFont,project.deckFont);
  assert.equal(final.deckTemplate,project.deckTemplate);
  assert.equal(final.originalPptx,project.originalPptx);
  assert.deepEqual(pptMotionPendingPages({...final, motionEnabled:false}), []);
  assert.throws(()=>startPptMotion(final), /已配置/);
});

test("original PPTX edits send only the selected text and apply a sparse patch in place, even past page 16", () => {
  const pages = Array.from({ length: 24 }, (_, i) => ({
    id: "original-" + (i + 1), title: "页 " + (i + 1), originalTitleId: "t1",
    elements: [
      { id: "t1", type: "text", text: "原标题", originalText: "原标题", fontSize: 48 },
      { id: "t2", type: "text", text: "当前修改稿", originalText: "最初的版本", x: 170, y: 200 },
      { id: "logo", type: "image", src: "data:image/png;base64,PRIVATE" },
    ],
  }));
  const project = { ...newPptProject(), originalPptx: new Blob(["source"]), deck: { title: "底稿", slides: pages } };
  const run = startPptRegeneration(project, ["original-20"], "润色", "", { elementIds: ["t2"] });
  const { original_edit, ...request } = pptStepBody(run);
  assert.equal(request.page_count, 24);
  assert.equal(request.page_index, 19);
  assert.equal(request.outline, undefined);
  assert.deepEqual(original_edit.blocks, [{ id: "t2", text: "当前修改稿" }]);
  assert.equal(original_edit.page_id, "original-20");
  assert.equal(original_edit.instruction, "润色");
  assert.ok(!JSON.stringify(original_edit).includes("PRIVATE"));
  const reply = original_edits => billed({ slide: { id: "original-20", original_edits } }, 0.01);
  assert.throws(() => finishPptStep(run, run.pending.id, reply([{ id: "t1", text: "越界" }])), /选区/);
  const done = finishPptStep(run, run.pending.id, reply([{ id: "t2", text: "  改写正文\n" }]));
  for (const [i, slide] of done.deck.slides.entries()) if (i !== 19) assert.equal(slide, pages[i]);
  assert.equal(done.deck.slides[19].elements[0], pages[19].elements[0]);
  assert.deepEqual(done.deck.slides[19].elements[1], { ...pages[19].elements[1], text: "  改写正文\n" });
  assert.equal(done.deck.slides[19].elements[2], pages[19].elements[2]);
  assert.equal(done.originalPptx, project.originalPptx);
  assert.equal(done.pending, null);
  assert.equal(finishPptStep(run, run.pending.id, reply([])).deck.slides[19], pages[19]);
  assert.throws(() => startPptGeneration(project, "覆盖"), /原稿/);
  assert.throws(() => startPptRegeneration(project, ["original-1"], "", "", { elementIds: ["logo"] }), /文字/);
  assert.throws(() => startPptRegeneration(project, ["original-1", "original-2"], "", "", { elementIds: ["t1"] }), /同一/);
});

test("non-adjacent regeneration uses current pages and sources, survives refresh, and replaces just the confirmed pages", async () => {
  const pages = [slide(1), slide(2), slide(3), slide(4)];
  const image = { id: "photo", type: "image", x: 22, y: 40, w: 400, h: 250, src: "data:image/png;base64,ORIGINAL" };
  pages[1].elements.push(image);
  const original = { ...newPptProject(), name: "已命名的汇报", deck: { title: "旧标题", slides: pages }, deckFont: "原稿字体",
    model: "gpt-6.2-sol", autoPageCount: true, topic: "比较实验", deckTemplate: new Blob(["old"]),
    template: { template: { font: "当前模板" }, source: { name: "模板", text: "参考内容" }, file: new Blob(["new"]) },
    references: [{ name: "文献.pdf", text: "实验结果" }], generation: { status: "done", outline } };
  const start = startPptRegeneration(original, ["s4", "s2"], " 加一张对比图 ");
  assert.equal(start.pending.action, "page");
  assert.equal(start.deck, original.deck);
  const first = pptStepBody(start);
  assert.equal(first.page_index, 1);
  assert.equal(first.page_count, 4);
  assert.equal(first.outline.title, original.name);
  assert.deepEqual(first.outline.slides.map(s => s.title), pages.map(s => s.title));
  assert.equal(first.model, original.model);
  assert.deepEqual(first.references, original.references);
  assert.deepEqual(first.template_source, original.template.source);
  assert.equal(first.regenerate.slide.id, "s2");
  assert.equal(first.regenerate.instruction, "加一张对比图");
  assert.ok(!JSON.stringify(first).includes("data:image"));
  assert.equal(first.regenerate.slide.elements.at(-1).id, image.id);
  assert.deepEqual(pptStepBody(restorePptProject(structuredClone(start))), first);
  const replacement = { id: "s2", title: "已更新二", elements: [{ ...first.regenerate.slide.elements.at(-1), w: 200 }] };
  const partial = finishPptStep(start, first.request_id, billed({ slide: replacement }, 0.1234));
  assert.equal(partial.deck.slides[1].elements[0].src, image.src);
  assert.equal(partial.deck.slides[1].elements[0].w, 200);
  for (const i of [0, 2, 3]) assert.equal(partial.deck.slides[i], pages[i]);
  const second = pptStepBody(partial);
  assert.equal(second.page_index, 3);
  assert.notEqual(second.request_id, first.request_id);
  assert.equal(finishPptStep(partial, first.request_id, billed({ slide: replacement }, 9)), partial);
  const paused = pausePptStep(partial, second.request_id, "余额不足", true);
  assert.throws(() => insertPptPage(paused, pages[2], { id: "new", title: "新增", body: "" }));
  assert.throws(() => removePptPage(paused, pages[0]));
  assert.equal(endPausedGeneration(paused).deck, partial.deck);
  const restored = restorePptProject(structuredClone(paused));
  const resumed = resumePptGeneration(restored);
  assert.deepEqual(pptStepBody(resumed), second);
  const confirmedFailure = finishPptStep(resumed, second.request_id, { status: "failed", error: { message: "本页超时" } });
  const retry = resumePptGeneration(confirmedFailure);
  assert.notEqual(retry.pending.id, second.request_id);
  assert.equal(pptStepBody(retry).page_index, 3);
  const end = finishPptStep(retry, retry.pending.id, billed({ slide: { ...slide(99), title: "已更新四" } }, 0.0234));
  assert.equal(end.pending, null);
  assert.equal(end.lastTask.action, "regenerate");
  assert.equal(end.lastTask.billing.charged_credits, 0.1468);
  assert.equal(end.deck.title, original.deck.title);
  assert.equal(end.name, original.name);
  assert.equal(end.deckFont, original.deckFont);
  assert.equal(await end.deckTemplate.text(), "old");
  assert.deepEqual(end.deck.slides.map(s => s.id), pages.map(s => s.id));
  assert.deepEqual(end.deck.slides.map(s => s.title), ["页 1", "已更新二", "页 3", "已更新四"]);
  assert.deepEqual(end.generation.targets, [{ index: 1 }, { index: 3 }]);
  assert.equal(finishPptStep(end, retry.pending.id, billed({ slide: slide(99) }, 9)), end);
});

test("a single manually inserted page is regenerable without a topic or existing outline, and its uuid is preserved", () => {
  const draft = insertPptPage(newPptProject(), null, { id: crypto.randomUUID(), title: "方案比较", body: "现场数据" });
  const current = draft.deck.slides[0];
  const start = startPptRegeneration(draft, [current.id]);
  const body = pptStepBody(start);
  assert.equal(body.request_id, start.pending.id);
  assert.equal(body.page_index, 0);
  assert.equal(body.page_count, 1);
  assert.equal(body.topic, draft.deck.title);
  assert.match(body.outline.slides[0].brief, /现场数据/);
  const end = finishPptStep(start, start.pending.id, billed({ slide: slide(1) }, 0.0001));
  assert.equal(end.deck.slides[0].id, current.id);
  assert.equal(end.generation.completed, 1);
  assert.throws(() => startPptRegeneration(start, [current.id]));
  assert.throws(() => startPptRegeneration(draft, []));
  assert.throws(() => startPptRegeneration(draft, ["absent", current.id]));
});

test("outline and each page commit atomically with the next request id; reloads and duplicate results cannot append or charge twice", () => {
  const old = { title: "旧演示稿", slides: [slide(9)] };
  const project = { ...newPptProject(), deck: old, pageCount: 2, autoPageCount: true,
    references: [{ name: "论文.pdf", text: "论文原文" }],
    template: { template: { font: "模板字体" }, source: { name: "参考.pptx", text: "模板原文" }, file: new Blob(["pptx"]) } };
  const start = startPptGeneration(project, "研究");
  assert.equal(start.pending.action, "outline");
  assert.equal(start.deck, old);
  const snapshot = pptStepBody(start);
  assert.deepEqual(snapshot.references, project.references);
  assert.deepEqual(snapshot.template_source, project.template.source);
  assert.equal(snapshot.page_count, "auto");
  const outlineResult = billed({ outline }, 0.1001);
  const planned = finishPptStep(start, start.pending.id, outlineResult);
  assert.equal(planned.deck, old);
  assert.equal(planned.pending.action, "page");
  assert.deepEqual(pptStepBody(planned), { ...snapshot, request_id: planned.pending.id, page_index: 0, outline });
  assert.equal(finishPptStep(planned, start.pending.id, outlineResult), planned);
  const partial = finishPptStep(planned, planned.pending.id, billed({ slide: slide(1) }, 0.2002));
  assert.deepEqual(partial.deck.slides, [slide(1)]);
  assert.equal(partial.deckFont, "模板字体");
  assert.equal(partial.deckTemplate, project.template.file);
  const recovered = restorePptProject(structuredClone(partial));
  assert.deepEqual(pptStepBody(recovered), pptStepBody(partial));
  const end = finishPptStep(recovered, recovered.pending.id, billed({ slide: slide(2) }, 0.0001));
  assert.equal(end.pending, null);
  assert.deepEqual(end.deck.slides, [slide(1), slide(2)]);
  assert.equal(end.generation.status, "done");
  assert.equal(end.lastTask.billing.charged_credits, 0.3004);
  assert.equal(end.generation.settings, undefined);
  assert.equal(finishPptStep(end, recovered.pending.id, billed({ slide: slide(2) }, 1)), end);
});

test("a settled failure resumes only its page with a fresh ID; a rejected submission safely keeps its ID", () => {
  const start = startPptGeneration(newPptProject(), "研究");
  const noBalance = pausePptStep(start, start.pending.id, "余额不足", true);
  assert.deepEqual(pptStepBody(resumePptGeneration(noBalance)), pptStepBody(start));
  assert.throws(() => startPptGeneration(noBalance, "其他"));
  const planned = finishPptStep(start, start.pending.id, billed({ outline }, 1));
  const partial = finishPptStep(planned, planned.pending.id, billed({ slide: slide(1) }, 2));
  const failed = finishPptStep(partial, partial.pending.id, { status: "failed", error: { message: "本页超时" } });
  assert.equal(failed.pending, null);
  assert.equal(failed.generation.chargedUnits, 30000);
  assert.equal(failed.generation.completed, 1);
  assert.equal(failed.generation.error, "本页超时");
  const resume = resumePptGeneration(failed);
  assert.notEqual(resume.pending.id, partial.pending.id);
  assert.equal(pptStepBody(resume).page_index, 1);
  assert.deepEqual(resumePptGeneration(resume), resume);
  assert.deepEqual(endPausedGeneration(failed).deck.slides, [slide(1)]);
});

test("NDJSON delivers text and visual elements before the terminal result, including split Unicode", async t => {
  const frames = [];
  let start, controller;
  const ready = new Promise(resolve => { start = resolve; });
  const stream = new ReadableStream({ start(c) { controller = c; } });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.get("Accept"), "application/x-ndjson");
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
  });
  const request = requestPpt("page", {}, {}, event => {
    frames.push(event); if (frames.length === 2) start();
  });
  const progress = { type: "progress", text: "正在写💡" };
  const element = { type: "element", element: slide(1).elements[0] };
  const bytes = new TextEncoder().encode([progress, element].map(JSON.stringify).join("\n") + "\n");
  for (let n = 0; n < bytes.length; n += 3) controller.enqueue(bytes.slice(n, n + 3));
  await ready;
  assert.deepEqual(frames, [progress, element]);
  const data = billed({ slide: slide(1) }, 1);
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "result", data })));
  controller.close();
  assert.deepEqual(await request, data);
});

test("a truncated stream has no terminal outcome; a JSON replay still uses the saved result", async t => {
  const response = t.mock.method(globalThis, "fetch", async () =>
    new Response('{"type":"progress","text":"draft"}\n', { headers: { "Content-Type": "application/x-ndjson" } }));
  await assert.rejects(requestPpt("outline", {}, {}, () => {}), /确认结果/);
  response.mock.mockImplementation(async () => Response.json(billed({ outline }, 1)));
  assert.deepEqual(await requestPpt("outline", {}, {}, () => {}), billed({ outline }, 1));
});
