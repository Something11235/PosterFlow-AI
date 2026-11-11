import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_CHARACTERS, createTavernSession, TAVERN_MAX_REPLY_CHARS } from '../src/lib/tavern.js';
import { createReplyVariant, selectReplyVariant, branchTavernSession } from '../src/lib/tavernConversation.js';
import { normalizeTavernState } from '../src/lib/tavernStorage.js';

const reply = (id, content = id, createdAt = 1) => ({ id, role: 'assistant', content, createdAt });
const question = (id, content = id) => ({ id, role: 'user', content, createdAt: 1 });
const session = () => ({ ...createTavernSession(BUILTIN_CHARACTERS[0]), id: 'source-session',
  messages: [reply('opening'), question('q-1'), reply('a-1'), question('q-2'), reply('a-2')],
  contextChars: 48000, autoMemory: true, summary: { text: 'Previous summary', throughMessageId: 'a-1', createdAt: 2 },
  summaryHistory: [null], usageRecords: [{ id: 'paid-request', messageId: 'a-2', createdAt: 2,
    model: 'test-model', billingMode: 'own_key', outcome: 'completed', usage: null, kind: 'chat' }],
});

test('reply variants preserve old and new order, switch the active reply, and never mutate inputs', () => {
  const old = reply('old', '  Original reply\n ', 1), next = reply('new', '  Regenerated reply\n ', 2);
  const snapshot = structuredClone([old, next]);
  const combined = createReplyVariant(old, next);
  assert.deepEqual(combined.alternatives, [{ id: 'old', content: old.content, createdAt: 1 }, { id: 'new', content: next.content, createdAt: 2 }]);
  assert.equal(combined.id, 'new');
  const originalSession = { ...session(), messages: [reply('opening'), question('q'), combined], summary: null };
  const stateSnapshot = structuredClone(originalSession);
  const selected = selectReplyVariant(originalSession, 'new', 'old');
  assert.equal(selected.messages.at(-1).id, 'old');
  assert.equal(selected.messages.at(-1).content, old.content);
  assert.equal(selected.messages.at(-1).createdAt, 1);
  assert.deepEqual(selected.messages.at(-1).alternatives, combined.alternatives);
  selected.messages.at(-1).alternatives[0].content = 'Only a detached copy';
  assert.deepEqual(originalSession, stateSnapshot);
  assert.deepEqual([old, next], snapshot);
});

test('reply version limits, duplicate ids and nonfinal selection fail explicitly', () => {
  let current = reply('v-0');
  for (let index = 1; index < 10; index++) current = createReplyVariant(current, reply(`v-${index}`));
  assert.equal(current.alternatives.length, 10);
  assert.throws(() => createReplyVariant(current, reply('v-10')), /10/);
  assert.throws(() => createReplyVariant(reply('same'), reply('same')), /重复/);
  assert.throws(() => createReplyVariant(question('q'), reply('a')), /角色回复/);
  assert.throws(() => createReplyVariant(reply('old'), reply('new', 'x'.repeat(TAVERN_MAX_REPLY_CHARS + 1))), /过长/);
  const withFollowingUser = { ...session(), messages: [current, question('later-user')] };
  assert.throws(() => selectReplyVariant(withFollowingUser, current.id, 'v-0'), /最后/);
  assert.throws(() => selectReplyVariant({ ...session(), messages: [current] }, current.id, 'unknown'), /找不到/);
});

test('switching last reply preserves earlier summary but clears overlapping or stale summaries and history', () => {
  const original = session();
  original.messages[4] = createReplyVariant(original.messages[4], reply('a-2-new'));
  const selected = selectReplyVariant(original, 'a-2-new', 'a-2');
  assert.deepEqual(selected.summary, original.summary);
  assert.deepEqual(selected.summaryHistory, original.summaryHistory);
  assert.notEqual(selected.summary, original.summary);
  for (const boundary of ['a-2-new', 'missing-boundary']) {
    const source = { ...original, summary: { ...original.summary, throughMessageId: boundary } };
    const patch = selectReplyVariant(source, 'a-2-new', 'a-2');
    assert.equal(patch.summary, null);
    assert.deepEqual(patch.summaryHistory, []);
    assert.equal(source.summary.throughMessageId, boundary);
  }
});

test('branch creates an independent prefix, resets auto summaries and request ledgers, and retains editable context', () => {
  const original = session(), before = structuredClone(original);
  const branch = branchTavernSession(original, 'a-1', { now: 100 });
  assert.notEqual(branch.id, original.id);
  assert.equal(branch.sourceSessionId, original.id);
  assert.equal(branch.createdAt, 100);
  assert.equal(branch.updatedAt, 100);
  assert.equal(branch.messages.length, 3);
  assert.deepEqual(branch.messages, original.messages.slice(0, 3));
  assert.equal(branch.legacyReplyCount, 1);
  assert.deepEqual(branch.usageRecords, []);
  assert.equal(branch.summary, null);
  assert.deepEqual(branch.summaryHistory, []);
  for (const key of ['persona', 'memory', 'scenario', 'contextChars', 'autoMemory']) assert.deepEqual(branch[key], original[key]);
  assert.deepEqual(branch.loreEntries, original.loreEntries);
  branch.loreEntries[0].content = 'Independent world';
  branch.messages[0].content = 'Independent opening';
  assert.deepEqual(original, before);
  const stored = normalizeTavernState({ characters: [], sessions: [original, branch], favorites: [] });
  assert.equal(stored.sessions[0].usageRecords.length, 1);
  assert.equal(stored.sessions[1].usageRecords.length, 0);
});

test('editing a branch point changes only that copied body and clears only its alternatives', () => {
  const original = session();
  original.messages[4] = createReplyVariant(original.messages[4], reply('a-new', 'Current choice', 9));
  const before = structuredClone(original);
  const branch = branchTavernSession(original, 'a-new', { content: '  Edited fork\n ', now: 100 });
  assert.equal(branch.messages.at(-1).content, '  Edited fork\n ');
  assert.equal(branch.messages.at(-1).id, 'a-new');
  assert.equal(branch.messages.at(-1).createdAt, 9);
  assert.equal('alternatives' in branch.messages.at(-1), false);
  assert.deepEqual(branch.messages.slice(0, -1), original.messages.slice(0, -1));
  assert.deepEqual(original, before);
  assert.equal(branchTavernSession(original, 'a-new').messages.at(-1).alternatives.length, 2);
  assert.throws(() => branchTavernSession(original, 'q-1', { content: 'x'.repeat(6001) }), /过长/);
  assert.throws(() => branchTavernSession(original, 'a-new', { content: 'x'.repeat(TAVERN_MAX_REPLY_CHARS + 1) }), /过长/);
  assert.throws(() => branchTavernSession(original, 'not-a-message'), /找不到/);
  assert.throws(() => branchTavernSession(original, 'q-1', { now: true }), /时间/);
});

test('conversation helpers do not copy credentials from source sessions, messages or variants', () => {
  const original = session();
  original.apiKey = 'session-secret';
  original.endpoint = 'private-provider-endpoint';
  original.messages[4].apiKey = 'message-secret';
  original.summary.apiKey = 'summary-secret';
  original.summaryHistory.push({ text: 'Historical context', throughMessageId: 'old-id', createdAt: 0, apiKey: 'history-secret' });
  const current = createReplyVariant(original.messages[4], { ...reply('new-clean'), apiKey: 'reply-secret' });
  original.messages[4] = current;
  original.messages[4].alternatives[0].apiKey = 'variant-secret';
  const branch = branchTavernSession(original, 'new-clean');
  const patch = selectReplyVariant(original, 'new-clean', 'a-2');
  assert.ok(!JSON.stringify(branch).includes('secret'));
  assert.ok(!JSON.stringify(branch).includes('private-provider-endpoint'));
  assert.ok(!JSON.stringify(patch).includes('secret'));
});
