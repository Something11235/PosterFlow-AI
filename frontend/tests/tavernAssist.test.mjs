import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_CHARACTERS, createTavernSession } from '../src/lib/tavern.js';
import { buildTavernAssistMessages, TAVERN_ASSIST_INSTRUCTION } from '../src/lib/tavernAssist.js';
import { normalizeTavernState } from '../src/lib/tavernStorage.js';

test('assist drafts for the user using full story context, without mutating messages or saving secrets', () => {
  const role = BUILTIN_CHARACTERS[0], session = createTavernSession(role);
  session.messages.push({ id: 'last-user', role: 'user', content: '今天想看海', createdAt: 3 });
  const before = structuredClone(session);
  const messages = buildTavernAssistMessages(role, session);
  assert.equal(messages[0].content, TAVERN_ASSIST_INSTRUCTION);
  assert.match(messages[0].content, /不扮演对方角色/);
  assert.ok(messages.some(message => message.content.includes(session.persona)));
  assert.ok(messages.some(message => message.content === '今天想看海'));
  assert.match(messages.at(-1).content, /只写我的话/);
  assert.deepEqual(session, before);
});

test('assist preserves a draft as quoted data and enforces total context before any request', () => {
  const role = BUILTIN_CHARACTERS[0], session = createTavernSession(role);
  const draft = '我想先休息一下，不想去冒险。';
  const messages = buildTavernAssistMessages(role, session, draft);
  assert.ok(messages.at(-1).content.includes(JSON.stringify(draft)));
  assert.match(messages.at(-1).content, /保留原意/);
  assert.ok(messages.reduce((sum, item) => sum + item.content.length, 0) <= session.contextChars);
  assert.throws(() => buildTavernAssistMessages(role, session, 'x'.repeat(6001)), /6000/);
  assert.throws(() => buildTavernAssistMessages(role, { ...session, persona: '设'.repeat(3000), memory: '忆'.repeat(3000), contextChars: 4000 }), /上下文|容量|超过/);
});

test('assist usage persists independently from story messages', () => {
  const session = createTavernSession(BUILTIN_CHARACTERS[0]);
  const original = structuredClone(session.messages);
  session.usageRecords.push({ id: 'draft-call', messageId: null, kind: 'assist', createdAt: 1,
    model: 'deepseek-v4.1-flash', billingMode: 'platform', outcome: 'completed',
    usage: { status: 'confirmed', input_tokens: 10, output_tokens: 5, total_tokens: 15, cache_read_tokens: null } });
  const state = normalizeTavernState({ characters: [], sessions: [session], favorites: [] });
  assert.equal(state.sessions[0].usageRecords[0].kind, 'assist');
  assert.equal(state.sessions[0].usageRecords[0].messageId, null);
  assert.deepEqual(state.sessions[0].messages, original);
});
