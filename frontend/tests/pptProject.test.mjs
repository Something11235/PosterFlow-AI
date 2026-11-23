import { test } from "node:test";
import assert from "node:assert/strict";
import { finishPptRequest, getPptChat, isPptPreflightError, newPptChatSession, newPptProject, pptChatContext,
  restorePptProject, setPptChatDraft } from "../src/lib/pptProject.js";

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
  const draft = setPptChatDraft({ ...newPptProject(), pending, deck }, "initial", pending.body.message);
  const result = { status: "succeeded", reply: "用成果作标题更清晰。" };
  const updated = finishPptRequest(draft, "one", result);
  assert.deepEqual(getPptChat(updated).turns, [{ id: "one", model: pending.model, message: pending.body.message, reply: result.reply }]);
  assert.equal(getPptChat(updated).draft, "");
  assert.equal(updated.lastTask.chatId, "initial");
  assert.equal(updated.deck, deck);
  assert.equal(finishPptRequest(updated, "one", result), updated);
  assert.throws(() => finishPptRequest(draft, "one", { status: "succeeded", deck }));
  const failed = finishPptRequest(draft, "one", { status: "failed" });
  assert.equal(getPptChat(failed).draft, pending.body.message);
  assert.equal(getPptChat(failed).turns.length, 0);
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
    ] }, chatSessions: [{ ...getPptChat(fresh), turns: Array.from({ length: 25 }, (_, id) => ({ message: `q${id}`, reply: `a${id}` })) }] };
  const context = pptChatContext(project, "分享", "继续", "s2");
  assert.equal(context.deck_title, "计划");
  assert.deepEqual(context.slide_titles, ["背景", "成果"]);
  assert.equal(context.slide_text, "访谈摘要");
  assert.equal(context.references, project.references);
  assert.equal(context.history.length, 40);
  assert.deepEqual(context.history[0], { role: "user", content: "q5" });
  assert.deepEqual(context.history.at(-1), { role: "assistant", content: "a24" });
});

test("restoring the single-chat project migrates its turns, draft, request and receipt without resubmitting", () => {
  const legacy = {
    revision: 10, topic: "主题", view: "chat",
    chatTurns: [{ id: "sent", model: "m", message: "第一问", reply: "第一答" }], chatDraft: "第二问",
    pending: { id: "in-flight", action: "chat", at: 123, body: { message: "第二问" } },
    lastTask: { id: "sent", action: "chat", status: "succeeded", billing: { charged_credits: 0.1 } },
  };
  const project = restorePptProject(legacy);
  assert.equal(project.activeChatId, "initial");
  assert.deepEqual(getPptChat(project), { id: "initial", turns: legacy.chatTurns, draft: "第二问", updatedAt: 123 });
  assert.deepEqual(project.pending, { ...legacy.pending, chatId: "initial" });
  assert.deepEqual(project.lastTask, { ...legacy.lastTask, chatId: "initial" });
  assert.equal(project.revision, legacy.revision);
  assert.equal(Object.hasOwn(project, "chatTurns"), false);
  assert.deepEqual(restorePptProject(project), project);
});

test("switching sessions isolates drafts, history and recovery of a pending reply", () => {
  const fresh = newPptProject();
  const prior = getPptChat(fresh);
  const second = newPptChatSession();
  assert.notEqual(second.id, newPptChatSession().id);
  const a = { ...prior, turns: [{ message: "旧话题", reply: "旧回答" }], draft: "正在发送" };
  let project = { ...fresh, chatSessions: [a, second], activeChatId: second.id,
    pending: { id: "one", action: "chat", chatId: a.id, model: "m", body: { message: "正在发送" } } };
  project = setPptChatDraft(project, second.id, "另一个草稿");
  const restored = restorePptProject(project);
  assert.deepEqual(pptChatContext(restored, "", "新问题").history, []);
  assert.deepEqual(pptChatContext(restored, "", "继续", null, a.id).history.map(item => item.content), ["旧话题", "旧回答"]);
  assert.throws(() => pptChatContext(restored, "", "继续", null, "missing"));
  const completed = finishPptRequest(restored, "one", { status: "succeeded", reply: "原任务完成" });
  assert.equal(completed.activeChatId, second.id);
  assert.equal(completed.lastTask.chatId, a.id);
  assert.equal(getPptChat(completed).draft, "另一个草稿");
  assert.deepEqual(getPptChat(completed).turns, []);
  assert.equal(getPptChat(completed, a.id).turns.at(-1).reply, "原任务完成");
  assert.equal(getPptChat(completed, a.id).draft, "");
  assert.equal(finishPptRequest(completed, "one", { status: "succeeded", reply: "重复" }), completed);
});
