import assert from "node:assert/strict";
import test from "node:test";
import { insertPptPage, removePptPage } from "../src/lib/pptPageActions.js";
import { newPptProject, restorePptProject } from "../src/lib/pptProject.js";

function add(project, after, id) {
  return insertPptPage(project, after, { id, title: "第 " + id + " 页", body: "页面内容" });
}

test("manual pages keep the template, their order and the project's chat across storage restores", () => {
  const template = { file: new Blob(["template"]), template: { font: "Arial", background: "#082828" } };
  const initial = { ...newPptProject(), topic: "项目复盘", template };
  const first = add(initial, null, "a");
  const withLast = add(first, first.deck.slides[0], "c");
  const edited = add(withLast, withLast.deck.slides[0], "b");
  const restored = restorePptProject(structuredClone(edited));
  assert.equal(restored.deck.title, "项目复盘");
  assert.deepEqual(restored.deck.slides.map(s => s.id), ["a", "b", "c"]);
  assert.equal(restored.deckFont, "Arial");
  assert.equal(restored.deckTemplate.size, template.file.size);
  assert.equal(restored.deck.slides[1].elements[0].color, "#FFFFFF");
  assert.deepEqual(removePptPage(edited, edited.deck.slides[1]).deck.slides.map(s => s.id), ["a", "c"]);
  const empty = removePptPage(first, first.deck.slides[0]);
  assert.equal(empty.deck, null);
  assert.equal(empty.deckTemplate, null);
  assert.equal(empty.template, template);
  assert.deepEqual(empty.chatSessions, initial.chatSessions);
});

test("page operations guard in-flight requests, stale selections and concurrent changes at the page cap", () => {
  let project = add(newPptProject(), null, "first");
  const first = project.deck.slides[0];
  const busy = { ...project, pending: { id: "ongoing" } };
  assert.throws(() => removePptPage(busy, first), /当前任务/);
  assert.throws(() => add(busy, first, "second"), /当前任务/);
  assert.throws(() => removePptPage(project, { ...first, title: "旧版本" }), /重新选择/);
  assert.throws(() => add(project, null, "wrong-first"), /重新选择/);
  for (let n = 2; n <= 16; n++) project = add(project, first, String(n));
  assert.throws(() => add(project, first, "overflow"), /16/);
});

test("a new untitled page has a selectable title element even without a topic or body", () => {
  const project = insertPptPage(newPptProject(), null, { id: "manual", title: " ", body: "" });
  assert.equal(project.deck.slides[0].elements.length, 1);
  assert.equal(project.deck.slides[0].elements[0].type, "text");
  assert.equal(project.deck.slides[0].title, project.deck.slides[0].elements[0].text);
});
