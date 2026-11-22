import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TAVERN_SETTINGS, requestTavernReply, requestTavernImport, fetchAdminTavernTotals } from '../src/lib/tavernClient.js';

// Every fetch is mocked. No real API keys, network requests or storage.
const settings = { ...DEFAULT_TAVERN_SETTINGS, billingMode: 'own_key', apiKey: 'synthetic-only-key' };
const messages = [{ role: 'user', content: 'Synthetic question' }];
const usage = { status: 'confirmed', input_tokens: 100, output_tokens: 20, total_tokens: 120,
  cache_read_tokens: 80, cache_miss_tokens: 20, reasoning_tokens: 12 };
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('invalid paid reply keeps actual usage and matched settlement without replay or invented text', async t => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  const billing = { request_id: requestId, status: 'settled', reserved_credits: '0.1000', charged_credits: '0.0012' };
  const fetch = t.mock.method(globalThis, 'fetch', async () => response({ success: false,
    code: 'TAVERN_RESPONSE_INVALID', error: '未返回有效文字，已结算', submission_unknown: false,
    billing, usage: { ...usage, raw_response: 'must not persist' } }, 502));
  const onDelta = t.mock.fn();
  await assert.rejects(requestTavernReply({ settings: DEFAULT_TAVERN_SETTINGS, requestId, messages, onDelta }), error => {
    assert.equal(error.code, 'TAVERN_RESPONSE_INVALID');
    assert.deepEqual(error.usage, usage);
    assert.deepEqual(error.billing, billing);
    assert.equal(error.submission_unknown, false);
    return true;
  });
  assert.equal(onDelta.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 1);
});

test('invalid text success envelope still preserves usage but rejects another request billing', async t => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  const fetch = t.mock.method(globalThis, 'fetch', async () => response({ success: true, content: null, usage,
    billing: { request_id: '22222222-2222-4222-8222-222222222222', status: 'settled', reserved_credits: '1', charged_credits: '0.1' } }));
  await assert.rejects(requestTavernReply({ settings: DEFAULT_TAVERN_SETTINGS, requestId, messages }), error => {
    assert.equal(error.billing, undefined);
    assert.equal(error.submission_unknown, true);
    assert.deepEqual(error.usage, usage);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test('admin lifetime totals have no date filter and expose six counters only',async t=>{
  const stats={requests:105,users:4,chat:80,summary:10,assist:15,credits_spent:'1.0637'};
  const fetch=t.mock.method(globalThis,'fetch',async()=>response({success:true,scope:'all',stats:{...stats,input_tokens:999},requests:[{content:'must not expose'}]}));
  assert.deepEqual(await fetchAdminTavernTotals({Authorization:'Bearer synthetic'}),{stats});
  const [url,init]=fetch.mock.calls[0].arguments;
  assert.equal(url,'/api/tavern/admin/overview?scope=all');assert.equal(init.method,'GET');
  assert.equal(new Headers(init.headers).get('Authorization'),'Bearer synthetic');
});

test('admin cumulative metrics reject partial data instead of inventing zero',async t=>{
  const fetch=t.mock.method(globalThis,'fetch',async()=>response({success:true,scope:'all',stats:{requests:1}}));
  await assert.rejects(fetchAdminTavernTotals(),/数据格式无效/);
  fetch.mock.mockImplementation(async()=>response({success:true,scope:'all',stats:{requests:1,users:1,chat:1,summary:0,assist:0,credits_spent:null}}));
  await assert.rejects(fetchAdminTavernTotals(),/数据格式无效/);
});

test('reply returns structured actual usage and one complete text notification', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => response({ success: true, content: 'Completed reply', usage }));
  const deltas = [];
  const result = await requestTavernReply({ settings, messages, onDelta: text => deltas.push(text),
    authHeaders: { Authorization: 'Bearer synthetic-site-session', 'X-Unrelated-Key': 'must-not-forward' } });
  assert.deepEqual(result, { content: 'Completed reply', usage });
  assert.deepEqual(deltas, ['Completed reply']);
  assert.equal(fetch.mock.callCount(), 1);
  const [path, options] = fetch.mock.calls[0].arguments;
  assert.equal(path, '/api/tavern/chat');
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.headers.get('X-Tavern-Api-Key'), settings.apiKey);
  assert.equal(options.headers.has('X-Unrelated-Key'), false);
  assert.equal(options.body.includes(settings.apiKey), false);
});

test('missing, malformed and partial usage never discard successful reply text', async t => {
  let supplied;
  const fetch = t.mock.method(globalThis, 'fetch', async () => response({ success: true, content: 'Keep content', usage: supplied }));
  for (const [value, status] of [[undefined, 'missing'], [null, 'missing'], ['malformed', 'invalid'],
    [{ ...usage, status: 'partial', total_tokens: null }, 'partial'], [{ ...usage, total_tokens: 5 }, 'partial']]) {
    supplied = value;
    const result = await requestTavernReply({ settings, messages });
    assert.equal(result.content, 'Keep content');
    assert.equal(result.usage.status, status);
    assert.equal(result.usage.total_tokens, null);
    if (status === 'partial') assert.equal(result.usage.input_tokens, 100);
    else assert.ok(Object.entries(result.usage).every(([key, count]) => key === 'status' || count === null));
  }
  assert.equal(fetch.mock.callCount(), 5);
});

test('local key, endpoint and pre-abort failures are explicitly not submitted', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must never fetch'); });
  const isNotSubmitted = error => error.code === 'TAVERN_NOT_SUBMITTED' && error.submission_unknown === false;
  for (const invalid of [{ ...settings, apiKey: '' }, { ...settings, apiKey: 'bad key' },
    { ...settings, endpoint: 'http://private.example/chat/completions' },
    { ...settings, endpoint: 'https://user:pass@public.example/v1/chat/completions' }]) {
    await assert.rejects(requestTavernReply({ settings: invalid, messages }), isNotSubmitted);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestTavernReply({ settings, messages, signal: controller.signal }), isNotSubmitted);
  assert.equal(fetch.mock.callCount(), 0);
});

test('cancelling a submitted request is unknown and never retries', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const controller = new AbortController();
  const reply = requestTavernReply({ settings, messages, signal: controller.signal });
  assert.equal(fetch.mock.callCount(), 1);
  controller.abort();
  await assert.rejects(reply, error => error.code === 'TAVERN_RESULT_UNKNOWN' && error.submission_unknown === true);
  assert.equal(fetch.mock.callCount(), 1);
});

test('network and invalid response failures are unknown, sanitized and not retried', async t => {
  let mode = 'network';
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'network') throw new Error('synthetic-private-secret https://private.invalid');
    if (mode === 'invalid') return new Response('not-json synthetic-private-secret', { status: 502 });
    return response({ success: true, content: '' });
  });
  for (mode of ['network', 'invalid', 'empty']) {
    await assert.rejects(requestTavernReply({ settings, messages }), error => error.submission_unknown === true
      && !error.message.includes('synthetic-private-secret') && !error.message.includes('private.invalid'));
  }
  assert.equal(fetch.mock.callCount(), 3);
});

test('explicit backend rejection remains distinguishable from unknown billing', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => response({ success: false, code: 'TAVERN_REQUEST_REJECTED',
    error: 'Service rejected request', submission_unknown: false }, 502));
  await assert.rejects(requestTavernReply({ settings, messages }), error => error.code === 'TAVERN_REQUEST_REJECTED'
    && error.submission_unknown === false);
  assert.equal(fetch.mock.callCount(), 1);
});

test('view callback failure cannot relabel a completed provider reply as unknown', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => response({ success: true, content: 'Completed reply', usage }));
  const result = await requestTavernReply({ settings, messages, onDelta: () => { throw new Error('Synthetic view error'); } });
  assert.deepEqual(result, { content: 'Completed reply', usage });
  assert.equal(fetch.mock.callCount(), 1);
});

test('same in-flight intent cannot submit twice, and completes with structured reply', async t => {
  let resolveFetch;
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { resolveFetch = resolve; }));
  const first = requestTavernReply({ settings, messages });
  try {
    await assert.rejects(requestTavernReply({ settings, messages }), error => error.code === 'TAVERN_ALREADY_SENDING'
      && error.submission_unknown === false);
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    resolveFetch(response({ success: true, content: 'One result', usage }));
  }
  assert.deepEqual(await first, { content: 'One result', usage });
});

function tavernStream() {
  let writer;
  const stream = new ReadableStream({ start(controller) { writer = controller; } });
  const encoder = new TextEncoder();
  return { response: new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } }),
    bytes: part => writer.enqueue(part), line: event => writer.enqueue(encoder.encode(JSON.stringify(event) + '\n')),
    close: () => writer.close() };
}

test('chat exposes ordered UTF-8 deltas before the terminal record; only final content and usage are authoritative', async t => {
  const stream = tavernStream();
  const fetch = t.mock.method(globalThis, 'fetch', async () => stream.response);
  const deltas = [];
  let showFirst;
  const firstVisible = new Promise(resolve => { showFirst = resolve; });
  const reply = requestTavernReply({ settings, messages, onDelta(text) { deltas.push(text); showFirst(); } });
  const fragment = new TextEncoder().encode('\r\n' + JSON.stringify({ type: 'delta', text: '星🌠' }) + '\r\n');
  for (const byte of fragment) stream.bytes(Uint8Array.of(byte));
  await firstVisible;
  assert.deepEqual(deltas, ['星🌠']);
  stream.line({ type: 'delta', text: '光' });
  stream.line({ type: 'done', success: true, content: '星🌠光。', usage });
  assert.deepEqual(await reply, { content: '星🌠光。', usage });
  assert.deepEqual(deltas, ['星🌠', '光']);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fetch.mock.calls[0].arguments[1].headers.get('Accept'), 'application/x-ndjson');
});

test('an abort, EOF or malformed terminal after partial text is unknown and is never replayed', async t => {
  let source;
  const fetch = t.mock.method(globalThis, 'fetch', async () => source.response);
  for (const ending of ['abort', 'eof', 'invalid']) {
    source = tavernStream();
    let notify;
    const rendered = new Promise(resolve => { notify = resolve; });
    const controller = new AbortController();
    const result = requestTavernReply({ settings, messages, onDelta: notify, signal: controller.signal });
    source.line({ type: 'delta', text: '部分' });
    assert.equal(await rendered, '部分');
    if (ending === 'abort') controller.abort();
    else if (ending === 'invalid') source.line({ type: 'done', success: false, error: 'private' });
    else source.close();
    await assert.rejects(result, error => error.code === 'TAVERN_RESULT_UNKNOWN' && error.submission_unknown === true);
  }
  assert.equal(fetch.mock.callCount(), 3);
});

test('a terminal stream error retains matched billing and actual usage after deltas', async t => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  const billing = { request_id: requestId, status: 'settled', reserved_credits: '0.1000', charged_credits: '0.0012' };
  const stream = tavernStream();
  t.mock.method(globalThis, 'fetch', async () => stream.response);
  stream.line({ type: 'delta', text: '部分' });
  stream.line({ type: 'error', success: false, code: 'TAVERN_RESPONSE_INVALID', error: '未完成', billing, usage, submission_unknown: false });
  const onDelta = t.mock.fn();
  await assert.rejects(requestTavernReply({ settings: DEFAULT_TAVERN_SETTINGS, requestId, messages, onDelta }),
    error => error.code === 'TAVERN_RESPONSE_INVALID' && error.submission_unknown === false
      && error.billing?.request_id === requestId && error.usage.total_tokens === 120);
  assert.equal(onDelta.mock.callCount(), 1);
});

test('public import remains credential-free and returns either PNG kind as File', async t => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
  for (const kind of ['character', 'lorebook']) {
    const file = await requestTavernImport({ url: 'https://public.example/download', kind });
    assert.equal(file.name, `${kind}.png`);
    assert.equal(file.type, 'image/png');
  }
  for (const call of fetch.mock.calls) {
    const [path, options] = call.arguments;
    assert.equal(path, '/api/tavern/import');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
  }
});
