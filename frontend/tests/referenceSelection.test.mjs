import assert from "node:assert/strict";
import test from "node:test";
import { appendReferenceFiles, MAX_REFERENCE_FILE_BYTES, referenceFileKey, removeReferenceMentions } from "../src/lib/referenceSelection.js";

const image = (name, extra = {}) => ({ name, size: 100, lastModified: 1, type: "image/png", ...extra });

test("separate selections append in order and never replace existing File objects", () => {
  const a = image("a.png"), b = image("b.png"), c = image("c.png");
  const original = Object.freeze([a]);
  const next = appendReferenceFiles(original, [b, c]);
  assert.deepEqual(next.files, [a, b, c]);
  assert.equal(next.files[0], a);
  assert.deepEqual(original, [a]);
});
test("repeat selections are skipped while a changed local file can be added", () => {
  const first = image("same.png");
  const result = appendReferenceFiles([first], [image("same.png"), image("same.png", { lastModified: 2 })]);
  assert.equal(result.duplicates, 1);
  assert.equal(result.added, 1);
  assert.equal(result.files[0], first);
  assert.notEqual(referenceFileKey(first), referenceFileKey(result.files[1]));
});
test("eight-image capacity keeps existing references and accepts only remaining slots", () => {
  const current = Array.from({ length: 7 }, (_, i) => image(`${i}.png`));
  const result = appendReferenceFiles(current, [image("new.png"), image("extra.png")]);
  assert.equal(result.files.length, 8);
  assert.deepEqual(result.files.slice(0, 7), current);
  assert.equal(result.files[7].name, "new.png");
  assert.equal(result.overflow, 1);
  const full = appendReferenceFiles(result.files, [image("more.png")]);
  assert.deepEqual(full.files, result.files);
  assert.equal(full.added, 0);
});
test("invalid images are rejected early without discarding valid mixed selections", () => {
  const valid = image("good.png", { size: MAX_REFERENCE_FILE_BYTES });
  const result = appendReferenceFiles([], [image("big.png", { size: MAX_REFERENCE_FILE_BYTES + 1 }), image("unknown.png", { type: "" }), image("svg.svg", { type: "image/svg+xml" }), valid]);
  assert.deepEqual(result.files, [valid]);
  assert.equal(result.oversized, 1);
  assert.equal(result.unsupported, 2);
});
test("cancelling selection preserves references, and a removed file can be re-added", () => {
  const a = image("a.png"), b = image("b.png");
  assert.deepEqual(appendReferenceFiles([a, b], []).files, [a, b]);
  assert.deepEqual(appendReferenceFiles([b], [a]).files, [b, a]);
});
test("removing a middle image keeps all surviving prompt references aligned", () => {
  const prompt = "用@图1的背景、@图2的衣服和@图3的人物。普通图3文字，@图10与@图30不变。";
  assert.equal(removeReferenceMentions(prompt, 1, 3), "用@图1的背景、的衣服和@图2的人物。普通图3文字，@图10与@图30不变。");
  assert.equal(removeReferenceMentions("@图1 @图2 @图3", 0, 3), " @图1 @图2");
  assert.equal(removeReferenceMentions("@图1 @图2 @图3", 2, 3), "@图1 @图2 ");
  assert.equal(removeReferenceMentions("@图1 @图2 @图3 @图10 普通图1", null, 3), "   @图10 普通图1");
});
