import test from 'node:test';
import assert from 'node:assert/strict';
import {IMAGE_MODEL_OPTIONS, imageResolutionSpec, imageCreditCost, imageSelectedPricingLabel} from '../src/lib/provider.js';
import {MODEL_CATALOG} from '../src/lib/studioCatalog.js';
import {canvasEditCapability, canvasGenerationSize} from '../src/lib/canvasImageEditing.js';

test('resolution prices match supplier price tiers and preserve existing image-input surcharge', () => {
  const matrix = {
    'gpt-image-2.5-flare': [[1,1.5,2],[1,1.5,2]],
    'gpt-image-2.5-sunburst': [[1,1.5,2],[1,1.5,2]],
    'gpt-image-2.6-flare': [[1,1.5,2],[1.5,2,2.5]],
    'gpt-image-2.6-sunburst': [[1,1.5,2],[1.5,2,2.5]],
    'gemini-nano-banana-2.1': [[1,1.5,2],[1,1.5,2]],
    'grok-imagine-image-2.0': [[1,1.5],[2,2.5]],
    'seedream-5-5': [[1,1,1.5],[1,1,1.5]],
    'seedream-5-0-pro': [[2,2,2.5],[2,2,2.5]],
    'seedream-5-0-lite': [[1,1,1],[1,1,1]],
    'seedream-5-0-flash': [[.5,.5,.5],[.5,.5,.5]],
  };
  for (const [model, [text, refs]] of Object.entries(matrix)) {
    imageResolutionSpec(model).resolutions.forEach((res, index) => {
      assert.equal(imageCreditCost(model,0,res),text[index],`${model} ${res}`);
      for (const count of [1,3]) assert.equal(imageCreditCost(model,count,res),refs[index],`${model} ${res} refs=${count}`);
    });
    assert.equal(imageCreditCost(model),text[0]);
  }
});
test('creation price labels show only the selected tier and active image-input price', () => {
  assert.equal(imageSelectedPricingLabel('gpt-image-2.6-flare',0,'1K'),'1K · 1 积分 / 张');
  assert.equal(imageSelectedPricingLabel('gpt-image-2.6-flare',1,'2K'),'2K · 2 积分 / 张');
  assert.equal(imageSelectedPricingLabel('seedream-5-5',8,'2K'),'2K · 1.5 积分 / 张');
  assert.equal(imageSelectedPricingLabel('grok-imagine-2.0-ext',0,'4K'),'1 积分 / 张');
  assert.equal(imageSelectedPricingLabel('seedream-5-0-lite',0,'1K'),'2K · 1 积分 / 张');
});
test('Seedream 5.5 precedes Pro everywhere and enables reference/interactive canvas without claiming masks', () => {
  for (const ids of [IMAGE_MODEL_OPTIONS.map(m=>m.value), MODEL_CATALOG.map(m=>m.id)]) assert.equal(ids.indexOf('seedream-5-5')+1,ids.indexOf('seedream-5-0-pro'));
  const spec=imageResolutionSpec('seedream-5-5');
  assert.equal(spec.maxCount,1); assert.equal(spec.maxReferences,8);
  assert.deepEqual(spec.resolutions,['1K','1.5K','2K']);
  assert.equal(canvasEditCapability(spec.value).kind,'interactive');
  assert.equal(Boolean(spec.maskEdit),false);
  assert.deepEqual(canvasGenerationSize(spec.value,2048,2048,'square'),{size:'square_1_1'});
  assert.deepEqual(canvasGenerationSize(spec.value,2048,2048),{size:''});
});
