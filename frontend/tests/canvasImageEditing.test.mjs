import assert from "node:assert/strict";
import test from "node:test";
import { canvasEditCapability, canvasReferenceError, canvasGenerationSize, canvasReferencePayload, isMaskAnnotation, canvasSelectionRegions } from "../src/lib/canvasImageEditing.js";
import { APIMART_IMAGE_MODELS, IMAGE_MODEL_OPTIONS } from "../src/lib/provider.js";

test("all seven canvas frame proportions use named ratios for the asynchronous models", () => {
  const frames = ["square", "landscape_3_2", "portrait_2_3", "landscape_4_3", "portrait_3_4", "landscape_16_9", "portrait_9_16"];
  for (const { value: model } of APIMART_IMAGE_MODELS) for (const ratio of frames) {
    assert.deepEqual(canvasGenerationSize(model, 1360, 1024, ratio), { size: ratio === "square" ? "square_1_1" : ratio });
  }
  assert.deepEqual(canvasGenerationSize("gpt-image-2.5-flare", 1792, 1008, "landscape_16_9"), { size: "custom", custom_width: 1792, custom_height: 1008 });
});

test("arbitrary reference images follow source proportions without rounded custom pixels", () => {
  for (const model of ["gemini-nano-banana-2.1", "grok-imagine-image-2.0"]) {
    for (const size of [[1600, 900], [400, 300], [1376, 768], [997, 431]]) assert.deepEqual(canvasGenerationSize(model, ...size), { size: "" });
  }
});

test("annotations never disappear at the reference limit and text-only editing stays blocked", () => {
  for (const { value: model } of IMAGE_MODEL_OPTIONS) {
    if (model === "grok-imagine-2.0-ext") continue;
    if (canvasEditCapability(model).kind === "disabled") { assert.ok(canvasReferenceError(model,1,0)); continue; }
    const { referenceLimit } = canvasEditCapability(model);
    if (!referenceLimit) { assert.ok(canvasReferenceError(model, 1, 0)); continue; }
    assert.equal(canvasReferenceError(model, referenceLimit, 0), "");
    assert.ok(canvasReferenceError(model, referenceLimit, 1));
    assert.equal(canvasReferenceError(model, referenceLimit - 1, 1), "");
    assert.ok(canvasReferenceError(model, referenceLimit + 1, 0));
  }
  assert.equal(canvasEditCapability("custom-model").mask, false);
});

test("Grok Ext only accepts one source with explicit rectangular or elliptical regions", () => {
  const shape={posterflowType:"annotation-shape",width:80,height:40,calcTransformMatrix:()=>[1,0,0,1,20,30]};
  const target={getBoundingRect:()=>({left:0,top:0,width:100,height:100})};
  const model="grok-imagine-2.0-ext";
  assert.equal(canvasReferenceError(model,1,1,[shape]),"");
  assert.ok(canvasReferenceError(model,2,1,[shape]));
  assert.ok(canvasReferenceError(model,1,0,[]));
  assert.ok(canvasReferenceError(model,1,2,[shape,{posterflowType:"annotation-brush"}]));
  const regions=canvasSelectionRegions(target,[shape]);
  assert.deepEqual(regions[0].outer.points,[0,0.1,0.6,0.1,0.6,0.5,0,0.5]);
  assert.throws(()=>canvasSelectionRegions(target,[]));
});

test("mask is an independent upload and never consumes an image-reference slot", () => {
  const paths = ["main", "secondary", "annotation"];
  const payload = canvasReferencePayload(paths, "mask");
  paths.push("cleanup-only");
  assert.deepEqual(payload, { reference_storage_paths: ["main", "secondary", "annotation"], mask_storage_path: "mask" });
});

test("only shapes and brush strokes define edit masks, never instruction text or arrows", () => {
  for (const type of ["annotation-text", "annotation-arrow", "image"]) assert.equal(isMaskAnnotation({ posterflowType: type }), false);
  for (const type of ["annotation-shape", "annotation-brush"]) assert.equal(isMaskAnnotation({ posterflowType: type }), true);
});
