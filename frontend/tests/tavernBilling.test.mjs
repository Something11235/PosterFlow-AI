import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTavernBilling, normalizeTavernUsageRecords, summarizeTavernUsage } from '../src/lib/tavernUsage.js';
import { DEFAULT_TAVERN_SETTINGS, requestTavernReply, fetchTavernRequest, fetchTavernRequests, resolveTavernRequest } from '../src/lib/tavernClient.js';

const id = '6b24655c-070e-4e3a-a11f-2cb334669c84', owner = '96ca1afc-4ee8-41d6-84ca-aa2a52b01be9';
const billing = (extra = {}) => ({ request_id: id, status: 'settled', reserved_credits: '0.1000', charged_credits: '0.0022', ...extra });
const usage = { status: 'confirmed', input_tokens: 297, output_tokens: 15, total_tokens: 312, cache_read_tokens: 0, cache_miss_tokens: 297, reasoning_tokens: 0 };
const row = (extra = {}) => ({ request_id: id, user_id: owner, status: 'settled', request_status: 'completed', kind: 'chat', model: 'deepseek-v4.1-flash', usage, content: '完成的回复', billing: billing(), created_at: '2026-11-11T12:00:00Z', ...extra });
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('billing preserves four-decimal charges and distinguishes held balances from zero charge', () => {
  assert.deepEqual(normalizeTavernBilling({ ...billing(), apiKey: 'secret' }), billing());
  assert.equal(normalizeTavernBilling(billing({ status: 'held', charged_credits: null })).charged_credits, null);
  assert.equal(normalizeTavernBilling(billing({ status: 'refunded', charged_credits: 0 })).charged_credits, '0.0000');
  for (const extra of [{ status: 'held', charged_credits: 0 }, { status: 'settled', charged_credits: null },
    { charged_credits: '0.1001' }, { charged_credits: '-1' }, { charged_credits: '0.00001' },
    { status: 'refunded', charged_credits: '0.001' }, { request_id: '../other' }, { reserved_credits: true }]) assert.equal(normalizeTavernBilling(billing(extra)), null);
});

test('persisted billing is owner-attempt scoped and rejected calls do not count as unknown usage', () => {
  const record = { id, kind: 'chat', createdAt: 1, model: 'deepseek-v4.1-flash', billingMode: 'platform', outcome: 'rejected', billing: billing({ status: 'refunded', charged_credits: '0.0000' }), usage: null };
  assert.deepEqual(normalizeTavernUsageRecords([record])[0].billing, record.billing);
  assert.equal(normalizeTavernUsageRecords([{ ...record, billingMode: 'own_key' }])[0].billing, undefined);
  assert.equal(normalizeTavernUsageRecords([{ ...record, billing: billing({ request_id: owner }) }])[0].billing, undefined);
  const summary = summarizeTavernUsage({ usageRecords: [record] });
  assert.equal(summary.rejected, 1); assert.equal(summary.completed, 0); assert.equal(summary.unknown, 0); assert.equal(summary.unreported, 0);
});

test('platform requests send durable IDs and kind, with no BYOK credential headers', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => reply({ success: true, content: '完成的回复', usage, billing: billing() }));
  const result = await requestTavernReply({ settings: { ...DEFAULT_TAVERN_SETTINGS, apiKey: 'must-not-forward' }, messages: [{ role: 'user', content: '你好' }], requestId: id, kind: 'summary', authHeaders: { Authorization: 'Bearer synthetic-session', 'X-Tavern-Api-Key': 'never-forward' } });
  const options = fetch.mock.calls[0].arguments[1], body = JSON.parse(options.body);
  assert.equal(body.request_id, id); assert.equal(body.kind, 'summary'); assert.equal(options.headers.get('X-Request-Id'), id);
  assert.equal(options.headers.has('X-Tavern-Api-Key'), false); assert.ok(!options.body.includes('must-not-forward'));
  assert.deepEqual(result.billing, billing());
  await assert.rejects(requestTavernReply({ messages: [], requestId: 'bad' }), error => error.submission_unknown === false);
  assert.equal(fetch.mock.callCount(), 1);
});

test('known refunds and unknown reservations survive HTTP errors without automatically retrying', async t => {
  const refund = billing({ status: 'refunded', charged_credits: '0.0000' });
  const fetch = t.mock.method(globalThis, 'fetch', async () => reply({ success: false, error: '已退款', code: 'TAVERN_REJECTED', submission_unknown: false, billing: refund }, 502));
  await assert.rejects(requestTavernReply({ messages: [{ role: 'user', content: '你好' }], requestId: id }), error => error.submission_unknown === false && error.billing.status === 'refunded' && error.request_id === id);
  assert.equal(fetch.mock.callCount(), 1);
});

test('account rejection stays not-submitted and invalid successful content retains known billing', async t => {
  let invalid = false;
  t.mock.method(globalThis, 'fetch', async () => invalid
    ? reply({ success: true, content: '', billing: billing(), usage })
    : reply({ success: false, error: '余额不足', code: 'INSUFFICIENT_CREDITS', submission_unknown: false }, 409));
  const options = { requestId: id, messages: [{ role: 'user', content: '你好' }] };
  await assert.rejects(requestTavernReply(options), error => error.code === 'INSUFFICIENT_CREDITS' && error.submission_unknown === false);
  invalid = true;
  await assert.rejects(requestTavernReply(options), error => error.billing?.status === 'settled' && error.request_id === id);
});

test('billing lookups are authenticated GETs and strip unexpected private fields', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => reply({ success: true, request: { ...row(), apiKey: 'secret' }, requests: [row()] }));
  const found = await fetchTavernRequest(id, { Authorization: 'Bearer synthetic-session', 'X-Tavern-Api-Key': 'not-a-site-credential' });
  assert.equal(found.request.content, '完成的回复'); assert.ok(!JSON.stringify(found).includes('secret'));
  const options = fetch.mock.calls[0].arguments[1]; assert.equal(options.method, 'GET'); assert.equal(options.cache, 'no-store'); assert.equal(options.headers.has('X-Tavern-Api-Key'), false);
  assert.equal((await fetchTavernRequests({}, { admin: true })).requests.length, 1);
  assert.equal(fetch.mock.calls[1].arguments[0], '/api/tavern/admin/requests');
  await assert.rejects(fetchTavernRequest('../other')); assert.equal(fetch.mock.callCount(), 2);
});

test('admin settlement forwards only the target and confirmed usage, never an actor override', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => reply({ success: true, request: row() }));
  await resolveTavernRequest(id, { user_id: owner, action: 'settle', usage, reason: '已核对供应商记录', actor_id: owner }, { Authorization: 'Bearer synthetic-admin' });
  const options = fetch.mock.calls[0].arguments[1], body = JSON.parse(options.body);
  assert.equal(options.method, 'POST'); assert.equal(body.user_id, owner); assert.equal(body.actor_id, undefined);
  await assert.rejects(resolveTavernRequest(id, { user_id: owner, action: 'settle', usage: { ...usage, cache_read_tokens: null }, reason: '核对' }));
  assert.equal(fetch.mock.callCount(), 1);
});
