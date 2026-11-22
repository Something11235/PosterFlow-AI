import { test } from "node:test";
import assert from "node:assert/strict";
import { finishPptRequest, isPptPreflightError, newPptProject } from "../src/lib/pptProject.js";

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
