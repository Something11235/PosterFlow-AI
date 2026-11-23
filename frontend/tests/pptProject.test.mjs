import { test } from "node:test";
import assert from "node:assert/strict";
import { finishPptRequest, isPptPreflightError, newPptProject, pptChatContext } from "../src/lib/pptProject.js";

test("recovering an automatically sized deck preserves the user's manual page count", () => {
  const project = newPptProject();
  assert.equal(project.autoPageCount, false);
  assert.equal(project.pageCount, 6);
  const pending = { id: "one", action: "generate", body: { page_count: "auto" } };
  const draft = { ...project, pageCount: 9, autoPageCount: true, pending };
  const deck = { title: "示例", slides: [{ id: "s1" }, { id: "s2" }] };
  const recovered = finishPptRequest(draft, pending.id, { status: "succeeded", deck });
  assert.equal(recovered.deck.slides.length, 2);
  assert.equal(recovered.pageCount, 9);
  assert.equal(recovered.autoPageCount, true);
});

test("PPT preflight errors unlock the form while unknown billing outcomes retain their request", () => {
  for (const [status, code] of [[409, "INSUFFICIENT_CREDITS"], [503, "PPT_MODEL_UNAVAILABLE"], [403, "EMAIL_UNVERIFIED"], [401, "AUTH_REQUIRED"]]) {
    assert.equal(isPptPreflightError({ status, code }), true);
  }
  for (const [status, code] of [[503, "PPT_DATABASE_UNAVAILABLE"], [409, "PPT_REQUEST_CONFLICT"], [404, undefined], [504, undefined]]) {
    assert.equal(isPptPreflightError({ status, code }), false);
  }
});

test("recovery applies a completed edit once and preserves the other pages", () => {
  const a = { id: "a", elements: [] }, b = { id: "b", elements: [] };
  const draft = { ...newPptProject(), deck: { title: "示例", slides: [a, b] }, pending: { id: "one", action: "edit", slideId: "b" } };
  const result = { status: "succeeded", slide: { ...b, title: "新标题" }, billing: { status: "settled" } };
  const updated = finishPptRequest(draft, "one", result);
  assert.equal(updated.deck.slides[0], a);
  assert.equal(updated.deck.slides[1], result.slide);
  assert.equal(finishPptRequest(updated, "one", result), updated);
  assert.equal(finishPptRequest(draft, "older", result), draft);
  assert.equal(finishPptRequest(draft, "one", { status: "processing" }), draft);
});

test("chat recovers exactly one turn alongside an unchanged deck and preserves a failed question", () => {
  const pending = { id: "one", action: "chat", model: "gpt-6.2-astra", body: { message: "这个标题怎么样？" } };
  const deck = { title: "项目复盘", slides: [{ id: "s1" }] };
  const draft = { ...newPptProject(), pending, deck, chatDraft: pending.body.message };
  const result = { status: "succeeded", reply: "用成果作标题更清晰。" };
  const updated = finishPptRequest(draft, "one", result);
  assert.deepEqual(updated.chatTurns, [{ id: "one", model: pending.model, message: pending.body.message, reply: result.reply }]);
  assert.equal(updated.chatDraft, "");
  assert.equal(updated.deck, deck);
  assert.equal(finishPptRequest(updated, "one", result), updated);
  assert.throws(() => finishPptRequest(draft, "one", { status: "succeeded", deck }));
  const failed = finishPptRequest(draft, "one", { status: "failed" });
  assert.equal(failed.chatDraft, pending.body.message);
  assert.equal(failed.chatTurns.length, 0);
});

test("chat accepts a blank project and only sends text from the active slide with ordered recent history", () => {
  const fresh = newPptProject();
  assert.deepEqual(pptChatContext(fresh, "", " 你好 ", null), {
    topic: "", message: "你好", references: [], deck_title: "", slide_titles: [], slide_text: "", history: [],
  });
  const project = { ...fresh, references: [{ name: "笔记", text: "调查数据" }],
    deck: { title: "计划", slides: [
      { id: "s1", title: "背景", elements: [] },
      { id: "s2", title: "成果", elements: [{ type: "rect", fill: "#fff" }, { type: "text", text: "访谈摘要" }] },
    ] }, chatTurns: Array.from({ length: 25 }, (_, id) => ({ message: `q${id}`, reply: `a${id}` })) };
  const context = pptChatContext(project, "分享", "继续", "s2");
  assert.equal(context.deck_title, "计划");
  assert.deepEqual(context.slide_titles, ["背景", "成果"]);
  assert.equal(context.slide_text, "访谈摘要");
  assert.equal(context.references, project.references);
  assert.equal(context.history.length, 40);
  assert.deepEqual(context.history[0], { role: "user", content: "q5" });
  assert.deepEqual(context.history.at(-1), { role: "assistant", content: "a24" });
});
