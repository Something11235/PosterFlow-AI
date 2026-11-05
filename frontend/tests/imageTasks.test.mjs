import assert from "node:assert/strict";
import test from "node:test";
import { createImageTaskStore, referenceCapability } from "../src/lib/imageTasks.js";
import { APIMART_IMAGE_MODELS, IMAGE_MODEL_OPTIONS } from "../src/lib/provider.js";

test("concurrent image results retain each request even when completion is reversed", () => {
  const store = createImageTaskStore();
  for (const id of ["a", "b", "c"]) assert.equal(store.start(id, { prompt: id, model: "one", billingMode: "platform", key: "not-public" }), true);
  assert.equal(store.start("d", {}), false);
  store.finish("c", { images: [{ filename: "c.png" }] });
  assert.equal(store.start("d", { prompt: "d" }), true);
  store.finish("b", { images: [{ filename: "b.png" }] });
  store.finish("a", { images: [{ filename: "a.png" }] });
  assert.deepEqual(store.getSnapshot().find(t => t.id === "a").images, [{ filename: "a.png" }]);
  assert.deepEqual(store.getSnapshot().find(t => t.id === "c").images, [{ filename: "c.png" }]);
  assert.ok(!JSON.stringify(store.getSnapshot()).includes("not-public"));
});
test("pending recovery queries the original intent, releases slots and never repeats a terminal result", async () => {
  const store = createImageTaskStore(); let queries = 0;
  store.start("a", { prompt: "first" });
  store.registerRecovery("a", () => { queries++; store.finish("a", { images: [{ filename: "recovered.png" }] }); });
  store.finish("a", { error: { code: "QUERY_FAILED" }, pending: true });
  assert.equal(store.getSnapshot()[0].active, false);
  await store.recover("a");
  store.finish("a", { error: { code: "LATE_ERROR" } });
  assert.equal(store.getSnapshot()[0].status, "completed"); assert.equal(queries, 1);
});
test("identity stores and duplicate request IDs cannot overwrite each other", () => {
  const first = createImageTaskStore(3, "first"), second = createImageTaskStore(3, "second");
  first.start("a", { prompt: "first" });
  assert.equal(first.start("a", { prompt: "changed" }), false);
  first.finish("a", { images: [{ filename: "private.png" }] });
  assert.deepEqual(second.getSnapshot(), []);
});
test("model choices omit retired Nano Banana Pro and reference inputs follow actual UI capabilities", () => {
  assert.equal(IMAGE_MODEL_OPTIONS.length, 10);
  for (const id of ["nano-banana-pro"]) assert.ok(!IMAGE_MODEL_OPTIONS.some(m => m.value === id));
  for (const model of APIMART_IMAGE_MODELS) {
    assert.equal(referenceCapability(model).limit, model.maxReferences);
    assert.equal(referenceCapability(model).disabled, model.maxReferences === 0);
  }
  assert.deepEqual(referenceCapability(null), { limit: 8, disabled: false });
});
