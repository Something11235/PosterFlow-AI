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

test('assist quotes the complete reference and draft and includes every historical turn regardless of legacy caps', () => {
  const role = BUILTIN_CHARACTERS[0], session = createTavernSession(role);
  const draft = '我想先休息一下，不想去冒险。';
  const messages = buildTavernAssistMessages(role, session, draft);
  assert.ok(messages.at(-1).content.includes(JSON.stringify(draft)));
  assert.match(messages.at(-1).content, /保留原意/);
  assert.throws(() => buildTavernAssistMessages(role, session, 'x'.repeat(6001)), /6000/);
  const small = { ...session, persona: '设'.repeat(3000), memory: '忆'.repeat(3000), contextChars: 4000 };
  const personality = '\\'.repeat(100000);
  small.messages = Array.from({ length: 251 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: '消息 ' + index }));
  const fullDraft = '字'.repeat(6000);
  const result = buildTavernAssistMessages({ ...role, personality }, small, fullDraft);
  const reference = JSON.parse(result[1].content.split('\n').slice(1).join('\n'));
  for (const field of [personality, small.persona, small.memory]) assert.ok(reference.includes(field));
  assert.deepEqual(result.slice(2, -1), small.messages);
  assert.ok(result.at(-1).content.includes(JSON.stringify(fullDraft)));
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
