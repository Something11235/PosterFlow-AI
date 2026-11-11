import test from "node:test";
import assert from "node:assert/strict";
import { apimartImageModel, imageCreditCost, imagePricingLabel, IMAGE_MODEL_OPTIONS } from "../src/lib/provider.js";
import { MODEL_CATALOG } from "../src/lib/studioCatalog.js";

test("Grok uses one text credit or two reference credits with three reference limit", () => {
  assert.equal(apimartImageModel("grok-imagine-image-2.0").maxReferences, 3);
  assert.equal(imageCreditCost("grok-imagine-image-2.0", 0), 1);
  for (const count of [1, 2, 3]) assert.equal(imageCreditCost("grok-imagine-image-2.0", count), 2);
  for (const model of IMAGE_MODEL_OPTIONS.filter(m => m.value !== "grok-imagine-image-2.0" && !m.value.startsWith("seedream-") && !m.value.startsWith("gpt-image-2.6-"))) assert.equal(imageCreditCost(model.value, 1), 1);
});
test("Nano tiers are one, one-and-half and two, independent of reference count", () => {
  for (const refs of [0, 1, 8]) {
    for (const [resolution, cost] of [["1K",1],["2K",1.5],["4K",2]]) assert.equal(imageCreditCost("gemini-nano-banana-2.1",refs,resolution),cost);
  }
  const label=imagePricingLabel("gemini-nano-banana-2.1");
  assert.match(label,/2K 1.5 积分/);
  assert.equal(MODEL_CATALOG.find(model=>model.id==="nano-banana-2.1").pricing,label);
});
test("all image cards describe capabilities without migration or configuration jargon", () => {
  const images = MODEL_CATALOG.filter(model => model.area === "image");
  assert.equal(images.length, 11);
  for (const model of images) {
    assert.ok(model.summary && model.capability);
    assert.doesNotMatch(model.summary + model.capability, /沿用|现有图像功能|已接入|需配置/);
  }
});
