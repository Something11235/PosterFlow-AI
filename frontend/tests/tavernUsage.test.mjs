import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTavernUsage, normalizeTavernUsageRecords, summarizeTavernUsage } from '../src/lib/tavernUsage.js';
import { normalizeTavernState } from '../src/lib/tavernStorage.js';
import { BUILTIN_CHARACTERS, createTavernSession } from '../src/lib/tavern.js';

const usage = (extra = {}) => ({ status: 'confirmed', input_tokens: 100, output_tokens: 20, total_tokens: 120,
  cache_read_tokens: null, cache_miss_tokens: null, reasoning_tokens: null, ...extra });
const record = (extra = {}) => ({ id: 'request-1', messageId: 'reply-1', createdAt: 10,
  model: 'deepseek-v4.1-flash', billingMode: 'own_key', outcome: 'completed', kind: 'chat', usage: usage(), ...extra });
const stateWith = session => ({ characters: [], favorites: [], sessions: [session] });

test('usage keeps only standardized backend counters and distinguishes actual zero from missing', () => {
  const result = normalizeTavernUsage(usage({ apiKey: 'secret', prompt_tokens: 9999, completion_tokens: 9999 }));
  assert.deepEqual(result, usage());
  for (const input of [null, undefined, {}, { prompt_tokens: 300 }, { status: 'missing', extension: 'ignored' }]) {
    const missing = normalizeTavernUsage(input);
    assert.equal(missing.status, 'missing');
    assert.equal(missing.total_tokens, null);
    assert.equal(missing.input_tokens, null);
  }
  const zero = normalizeTavernUsage(usage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }));
  assert.equal(zero.status, 'confirmed');
  assert.equal(zero.total_tokens, 0);
  assert.equal(zero.cache_read_tokens, null);
});

test('usage rejects malformed numbers and never reconstructs missing or inconsistent totals', () => {
  for (const value of [-1, true, '100', 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const result = normalizeTavernUsage({ status: 'confirmed', input_tokens: value });
    assert.equal(result.status, 'invalid');
    assert.equal(result.input_tokens, null);
  }
  for (const input of ['bad', [], false, 1]) assert.equal(normalizeTavernUsage(input).status, 'invalid');
  const missingTotal = normalizeTavernUsage(usage({ status: 'partial', total_tokens: null }));
  assert.equal(missingTotal.status, 'partial');
  assert.equal(missingTotal.total_tokens, null);
  const mismatch = normalizeTavernUsage(usage({ total_tokens: 3 }));
  assert.equal(mismatch.status, 'partial');
  assert.equal(mismatch.total_tokens, null);
  assert.equal(mismatch.input_tokens, 100);
  assert.equal(mismatch.output_tokens, 20);
  assert.equal(normalizeTavernUsage(usage({ status: 'partial' })).status, 'partial');
  assert.equal(normalizeTavernUsage(usage({ status: 'invalid' })).input_tokens, null);
});

test('cache/reasoning contradictions clear only affected detail counters without inflating total', () => {
  const valid = normalizeTavernUsage(usage({ cache_read_tokens: 80, cache_miss_tokens: 20, reasoning_tokens: 5 }));
  assert.equal(valid.status, 'confirmed');
  assert.equal(valid.total_tokens, 120);
  const conflict = normalizeTavernUsage(usage({ cache_read_tokens: 80, cache_miss_tokens: 30, reasoning_tokens: 21 }));
  assert.equal(conflict.status, 'partial');
  assert.equal(conflict.cache_read_tokens, null);
  assert.equal(conflict.cache_miss_tokens, null);
  assert.equal(conflict.reasoning_tokens, null);
  assert.equal(conflict.total_tokens, 120);
  const oversized = normalizeTavernUsage(usage({ cache_read_tokens: 101, cache_miss_tokens: 20 }));
  assert.equal(oversized.cache_read_tokens, null);
  assert.equal(oversized.cache_miss_tokens, 20);
  const absentMiss = normalizeTavernUsage(usage({ cache_read_tokens: 80 }));
  assert.equal(absentMiss.cache_miss_tokens, null);
});

test('usage record persistence is a strict whitelist with unique ids and no message existence requirement', () => {
  const input = record({ messageId: 'removed-regeneration-reply', apiKey: 'secret', endpoint: 'https://private.example',
    usage: usage({ key: 'secret', extra: { apiKey: 'secret' } }) });
  const output = normalizeTavernUsageRecords([input]);
  assert.deepEqual(output, [record({ messageId: input.messageId })]);
  assert.ok(!JSON.stringify(output).includes('secret'));
  assert.notEqual(output[0], input);
  assert.notEqual(output[0].usage, input.usage);
  assert.throws(() => normalizeTavernUsageRecords([record(), record()]), /编号重复/);
  assert.throws(() => normalizeTavernUsageRecords(Array.from({ length: 1001 }, (_, index) => record({ id: `r-${index}` }))), /1000/);
  assert.equal(normalizeTavernUsageRecords(Array.from({ length: 1000 }, (_, index) => record({ id: `r-${index}` }))).length, 1000);
  for (const patch of [{ id: '' }, { id: '../escape' }, { messageId: 3 }, { createdAt: -1 }, { model: '<script>' },
    { model: 'x'.repeat(129) }, { billingMode: 'other' }, { outcome: 'failed' }]) {
    assert.throws(() => normalizeTavernUsageRecords([record(patch)]));
  }
  assert.throws(() => normalizeTavernUsageRecords(null), /格式/);
});

test('summary accumulates reported values only, including all regenerated requests and excluding unknown outcomes', () => {
  const summary = summarizeTavernUsage({ usageRecords: [
    record({ messageId: 'old-removed-reply', usage: usage({ cache_read_tokens: 80, cache_miss_tokens: 20, reasoning_tokens: 5 }) }),
    record({ id: 'regenerated', messageId: 'new-reply', usage: usage({ cache_read_tokens: 90, cache_miss_tokens: 10, reasoning_tokens: 0 }) }),
    record({ id: 'pending-or-cancelled', outcome: 'unknown', messageId: null, usage: usage() }),
    record({ id: 'missing', usage: null }),
    record({ id: 'partial', usage: usage({ status: 'partial', output_tokens: null, total_tokens: null }) }),
  ], legacyReplyCount: 2, messages: [{ id: 'new-reply', role: 'assistant', content: 'newest only' }] });
  assert.equal(summary.requests, 5);
  assert.equal(summary.completed, 4);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.unreported, 2);
  assert.equal(summary.legacy, 2);
  assert.equal(summary.partial, 1);
  assert.equal(summary.missing, 1);
  assert.equal(summary.confirmedTotalTokens, 240);
  assert.equal(summary.inputTokens, 300);
  assert.equal(summary.outputTokens, 40);
  assert.equal(summary.cacheReadTokens, 170);
  assert.equal(summary.cacheMissTokens, 30);
  assert.equal(summary.reasoningTokens, 5);
  assert.equal(summary.reportedCounts.confirmedTotalTokens, 2);
  assert.equal(summary.reportedCounts.inputTokens, 3);
  assert.equal(summary.reportedCounts.reasoningTokens, 2);
  assert.equal(summary.isComplete, false);
});

test('usage kind migrates legacy chat calls and accounts for summary calls without deriving or dropping usage', () => {
  const legacy = record(); delete legacy.kind;
  const input = [legacy, record({ id: 'summary-request', kind: 'summary', messageId: null })];
  const normalized = normalizeTavernUsageRecords(input);
  assert.deepEqual(normalized.map(item => item.kind), ['chat', 'summary']);
  assert.equal(normalized[1].messageId, null);
  assert.equal(summarizeTavernUsage({ usageRecords: normalized }).confirmedTotalTokens, 240);
  for (const kind of ['', null, true, 'image', 'automatic']) assert.throws(() => normalizeTavernUsageRecords([record({ kind })]), /类型/);
});

test('summary reports absent fields as unknown and protects aggregate safe integer boundaries', () => {
  const empty = summarizeTavernUsage({ usageRecords: [], legacyReplyCount: 0 });
  assert.equal(empty.requests, 0);
  assert.equal(empty.confirmedTotalTokens, null);
  const complete = summarizeTavernUsage({ usageRecords: [record()] });
  assert.equal(complete.isComplete, true);
  assert.equal(complete.confirmedTotalTokens, 120);
  assert.equal(complete.cacheReadTokens, null);
  assert.equal(complete.reportedCounts.cacheReadTokens, 0);
  const zero = summarizeTavernUsage({ usageRecords: [record({ usage: usage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }) })] });
  assert.equal(zero.confirmedTotalTokens, 0);
  const huge = usage({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0, total_tokens: Number.MAX_SAFE_INTEGER });
  const overflow = summarizeTavernUsage({ usageRecords: [record({ usage: huge }), record({ id: 'second', usage: huge })] });
  assert.equal(overflow.confirmedTotalTokens, null);
  assert.equal(overflow.inputTokens, null);
  assert.equal(overflow.outputTokens, 0);
  assert.deepEqual(overflow.overflowFields, ['confirmedTotalTokens', 'inputTokens']);
  assert.equal(overflow.isComplete, false);
});

test('storage migrates old replies once, excludes opening message, and keeps legacy count after regeneration', () => {
  const session = createTavernSession(BUILTIN_CHARACTERS[0]);
  delete session.usageRecords;
  delete session.legacyReplyCount;
  session.messages.push({ id: 'user-1', role: 'user', content: '你好', createdAt: 1 });
  session.messages.push({ id: 'reply-1', role: 'assistant', content: '旧回复', createdAt: 2 });
  session.messages.push({ id: 'reply-2', role: 'assistant', content: '另一旧回复', createdAt: 3 });
  const migrated = normalizeTavernState(stateWith(session));
  assert.equal(migrated.sessions[0].legacyReplyCount, 2);
  assert.deepEqual(migrated.sessions[0].usageRecords, []);
  assert.equal(summarizeTavernUsage(session).legacy, 2);
  migrated.sessions[0].messages.pop();
  migrated.sessions[0].usageRecords.push(record({ messageId: 'no-longer-in-messages' }));
  const again = normalizeTavernState(JSON.parse(JSON.stringify(migrated)));
  assert.equal(again.sessions[0].legacyReplyCount, 2);
  assert.equal(again.sessions[0].usageRecords.length, 1);
  assert.equal(summarizeTavernUsage(again.sessions[0]).confirmedTotalTokens, 120);
  const noOpening = { ...session, messages: session.messages.slice(1) };
  assert.equal(normalizeTavernState(stateWith(noOpening)).sessions[0].legacyReplyCount, 2);
  for (const legacyReplyCount of [-1, null, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeTavernState(stateWith({ ...session, legacyReplyCount })), /历史/);
  }
});

test('storage round trip keeps completed and unknown records without credentials or deriving tokens', () => {
  const session = createTavernSession(BUILTIN_CHARACTERS[0]);
  session.legacyReplyCount = 0;
  session.usageRecords = [record({ apiKey: 'secret' }), record({ id: 'timeout', messageId: null, outcome: 'unknown', usage: null })];
  const persisted = normalizeTavernState(JSON.parse(JSON.stringify(stateWith(session))));
  assert.equal(persisted.sessions[0].usageRecords.length, 2);
  assert.equal(persisted.sessions[0].usageRecords[1].outcome, 'unknown');
  assert.equal(persisted.sessions[0].usageRecords[1].usage.total_tokens, null);
  assert.ok(!JSON.stringify(persisted).includes('secret'));
  const summary = summarizeTavernUsage(persisted.sessions[0]);
  assert.equal(summary.completed, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.legacy, 0);
  assert.equal(summary.confirmedTotalTokens, 120);
});
