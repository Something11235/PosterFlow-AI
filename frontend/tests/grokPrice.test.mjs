import test from "node:test";
import assert from "node:assert/strict";
import { apimartImageModel, imageCreditCost, imagePricingLabel, IMAGE_MODEL_OPTIONS } from "../src/lib/provider.js";
import { MODEL_CATALOG } from "../src/lib/studioCatalog.js";

test("Grok uses one text credit or two reference credits with three reference limit", () => {
  assert.equal(apimartImageModel("grok-imagine-image-2.0").maxReferences, 3);
  assert.equal(imageCreditCost("grok-imagine-image-2.0", 0), 1);
  for (const count of [1, 2, 3]) assert.equal(imageCreditCost("grok-imagine-image-2.0", count), 2);
  for (const model of IMAGE_MODEL_OPTIONS.filter(m => m.value !== "grok-imagine-image-2.0" && !m.value.startsWith("seedream-"))) assert.equal(imageCreditCost(model.value, 1), 1);
});
test("Nano 4K costs two per output regardless of reference count; lower tiers stay one", () => {
  for (const refs of [0, 1, 8]) {
    for (const resolution of ["1K", "2K", ""]) assert.equal(imageCreditCost("gemini-nano-banana-2.1", refs, resolution), 1);
    for (const resolution of ["4K", "4k"]) assert.equal(imageCreditCost("gemini-nano-banana-2.1", refs, resolution), 2);
  }
  for (const model of IMAGE_MODEL_OPTIONS.filter(item => item.value !== "gemini-nano-banana-2.1" && !item.value.startsWith("seedream-"))) {
    assert.equal(imageCreditCost(model.value, 0, "4K"), 1);
    assert.equal(imageCreditCost(model.value, 1, "4K"), model.referenceCreditCost || 1);
  }
  const label = imagePricingLabel("gemini-nano-banana-2.1");
  assert.match(label, /1K、2K 1 积分 \/ 张/);
  assert.match(label, /4K 2 积分 \/ 张/);
  assert.equal(MODEL_CATALOG.find(model => model.id === "nano-banana-2.1").pricing, label);
});
test("all image cards describe capabilities without migration or configuration jargon", () => {
  const images = MODEL_CATALOG.filter(model => model.area === "image");
  assert.equal(images.length, 10);
  for (const model of images) {
    assert.ok(model.summary && model.capability);
    assert.doesNotMatch(model.summary + model.capability, /沿用|现有图像功能|已接入|需配置/);
  }
});
