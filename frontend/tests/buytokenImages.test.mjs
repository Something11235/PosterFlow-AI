import test from 'node:test';
import assert from 'node:assert/strict';
import {usesBuyToken, imageGenerationFetch, readImageTask} from '../src/lib/apimartImages.js';

const headers = {'X-Billing-Mode': 'platform'};
const model = 'gpt-image-2.6-flare';
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

test('GPT26 platform and explicit BuyToken own-key route to BuyToken; older providers retain their routes', () => {
  assert.equal(usesBuyToken(model, headers), true);
  assert.equal(usesBuyToken('gpt-image-2.6-sunburst', headers), true);
  assert.equal(usesBuyToken(model, {'X-Provider-Endpoint': 'https://api.buytoken.work/v1/images/generations'}), true);
  assert.equal(usesBuyToken(model, {'X-Provider-Endpoint': 'https://api.apimart.ai/v1/images/generations'}), false);
  assert.equal(usesBuyToken('nano-banana-2.1', headers), false);
  assert.equal(usesBuyToken('gpt-image-2.5-flare', headers), false);
});

test('new GPT26 submits once to BuyToken and polls only that original durable task', async t => {
  const prior = globalThis.fetch, window = globalThis.window, calls = [];
  t.after(() => {globalThis.fetch = prior; globalThis.window = window;});
  globalThis.window = {dispatchEvent() {}};
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return json({job: {status: calls.length === 1 ? 'processing' : 'completed'}, images: [{filename: 'fixture.gif'}]});
  };
  const result = await imageGenerationFetch('/api/generate', {method: 'POST', headers, body: JSON.stringify({platform_model: model, request_id: 'fixture', prompt: 'make GIF'})}, {pollInterval: 0});
  assert.equal(result.status, 200);
  assert.deepEqual(calls.map(([url]) => url), ['/api/buytoken-images/generations', '/api/buytoken-images/tasks/fixture']);
  assert.equal(calls.filter(([, init]) => init.method === 'POST').length, 1);
  assert.equal((await result.json()).images[0].filename, 'fixture.gif');
  assert.equal(JSON.parse(calls[0][1].body).pricing_version, 2);
});

test('old GPT26 recovery falls back to the old APIMart GET only when the BuyToken job is absent', async t => {
  const prior = globalThis.fetch, calls = [];
  t.after(() => {globalThis.fetch = prior;});
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return calls.length === 1 ? json({code: 'IMAGE_TASK_NOT_FOUND'}, 404) : json({job: {status: 'completed'}});
  };
  await readImageTask('old-id', headers, undefined, model);
  assert.deepEqual(calls.map(([url]) => url), ['/api/buytoken-images/tasks/old-id', '/api/apimart-images/tasks/old-id']);
  assert.ok(calls.every(([, init]) => !init.method || init.method === 'GET'));
});

test('errors and ambiguous POST never trigger an APIMart generation fallback', async t => {
  const prior = globalThis.fetch, window = globalThis.window;
  t.after(() => {globalThis.fetch = prior; globalThis.window = window;});
  globalThis.window = {dispatchEvent() {}};
  let calls = 0;
  globalThis.fetch = async () => {calls++; throw new Error('synthetic disconnect');};
  const result = await imageGenerationFetch('/api/generate', {method: 'POST', headers, body: JSON.stringify({platform_model: model, request_id: 'fixture', prompt: 'fixture'})});
  assert.equal((await result.json()).code, 'IMAGE_SUBMISSION_UNKNOWN');
  assert.equal(calls, 1);
  calls = 0;
  globalThis.fetch = async () => {calls++; return json({code: 'AUTH_REQUIRED', error: 'synthetic'}, 401);};
  await assert.rejects(readImageTask('fixture', headers, undefined, model));
  assert.equal(calls, 1);
});
