import test from 'node:test';
import assert from 'node:assert/strict';
import {IMAGE_MODEL_OPTIONS, DEFAULT_PLATFORM_MODEL, apimartImageModel, imageCreditCost, loadProviderConfig} from '../src/lib/provider.js';
import {canvasEditCapability} from '../src/lib/canvasImageEditing.js';
import {DEFAULT_MODEL_BADGES} from '../src/lib/modelBadges.js';
import {imageGenerationFetch} from '../src/lib/apimartImages.js';

test('GPT26 versions lead the active catalog, remain single image 1K, and each cost one credit', () => {
  assert.equal(DEFAULT_PLATFORM_MODEL, 'gpt-image-2.6-flare');
  assert.deepEqual(IMAGE_MODEL_OPTIONS.slice(0, 2).map(m => m.label), ['GPT Image 2.6 Flare', 'GPT Image 2.6 Sunburst']);
  assert.equal(IMAGE_MODEL_OPTIONS.some(m => m.value === 'gpt-image-2'), false);
  for (const version of ['flare', 'sunburst']) {
    const id = 'gpt-image-2.6-' + version, spec = apimartImageModel(id);
    assert.equal(spec.upstreamVersion, version);
    assert.equal(spec.maxCount, 4);
    assert.deepEqual(spec.resolutions, ['1K']);
    assert.equal(spec.maxReferences, 8);
    assert.equal(imageCreditCost(id, 0, '1K'), 1);
    assert.equal(imageCreditCost(id, 1, '1K'), 1.5);
    assert.equal(imageCreditCost(id, 8, '1K'), 1.5);
    assert.equal(spec.customSize, false);
    assert.equal(canvasEditCapability(id).kind, 'mask');
    assert.equal(canvasEditCapability(id).mask, true);
  }
  assert.deepEqual(Object.entries(DEFAULT_MODEL_BADGES).filter(([,v]) => v === 'hot').map(([id]) => id), ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']);
});
test('retired model saved in session requires explicit model selection and never sends a paid request', async () => {
  const priorWindow = global.window, priorFetch = global.fetch;
  let called = 0;
  global.window = {sessionStorage: {getItem: () => JSON.stringify({model: 'gpt-image-2', endpoint: 'https://example.invalid', apiKey: 'synthetic'})}};
  global.fetch = async () => { called++; throw new Error('must not submit'); };
  try {
    assert.equal(loadProviderConfig().model, '');
    const response = await imageGenerationFetch('/api/generate', {method: 'POST', headers: {'X-Billing-Mode': 'platform'}, body: JSON.stringify({platform_model: 'gpt-image-2'})});
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'MODEL_RETIRED');
    assert.equal(called, 0);
  } finally { global.window = priorWindow; global.fetch = priorFetch; }
});
test('new official image requests include pricing revision without trusting a caller override', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let submitted;
  globalThis.fetch = async (url, init) => {
    submitted = JSON.parse(init.body);
    return new Response(JSON.stringify({job: {status: 'completed'}, images: []}), {status: 200, headers: {'Content-Type': 'application/json'}});
  };
  globalThis.window = {dispatchEvent() {}};
  t.after(() => { delete globalThis.window; });
  const response = await imageGenerationFetch('/api/modify', {method: 'POST', headers: {'X-Billing-Mode': 'platform'}, body: JSON.stringify({platform_model: 'gpt-image-2.6-flare', request_id: 'fixture', prompt: 'fixture', reference_storage_paths: ['fixture'], pricing_version: 1})}, {pollInterval: 0});
  assert.equal(response.status, 200);
  assert.equal(submitted.pricing_version, 2);
  assert.deepEqual(submitted.reference_storage_paths, ['fixture']);
});
