import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCharacter, createTavernSession, buildTavernMessages, TAVERN_REPLY_LANGUAGE_INSTRUCTION } from '../src/lib/tavern.js';
import { planTavernSummary, applyTavernSummary, restoreTavernSummary, TAVERN_SUMMARY_INSTRUCTION } from '../src/lib/tavernMemory.js';

const character = normalizeCharacter({ id: 'memory-role', name: '星灯', description: '一位虚构角色。', firstMessage: '', alternateGreetings: ['', ' {{char}}向{{USER}}问好。 '] });
const messages = (count, size = 20, offset = 0) => Array.from({ length: count }, (_, index) => ({
  id: `message-${index + offset}`, role: index % 2 ? 'assistant' : 'user',
  content: `${index + offset}:` + '文'.repeat(size), createdAt: index + offset,
}));
const session = (count = 0, extra = {}) => ({ ...createTavernSession(character), messages: messages(count), ...extra });
const payload = plan => JSON.parse(plan.messages[1].content.slice(plan.messages[1].content.indexOf('\n') + 1));

test('new sessions initialize disabled auto memory and select a nonempty alternate greeting without changing the card', () => {
  const fresh = createTavernSession(character);
  assert.equal(Object.hasOwn(fresh, 'contextChars'), false);
  assert.equal(fresh.autoMemory, false);
  assert.equal(fresh.summary, null);
  assert.deepEqual(fresh.summaryHistory, []);
  assert.deepEqual(fresh.messages, []);
  const alternate = createTavernSession(character, { greetingIndex: 1 });
  assert.equal(alternate.messages[0].content, ' 星灯向你问好。 ');
  assert.equal(character.alternateGreetings[1], ' {{char}}向{{USER}}问好。 ');
  for (const greetingIndex of [-2, 0, 2, '1', 1.5]) assert.throws(() => createTavernSession(character, { greetingIndex }), /开场白/);
});

test('automatic summary requires opt-in and 32 unsummarized messages regardless of old context preferences', () => {
  assert.equal(planTavernSummary(character, session(32)), null);
  assert.equal(planTavernSummary(character, session(31, { autoMemory: true })), null);
  const byCount = planTavernSummary(character, session(32, { autoMemory: true }));
  assert.equal(byCount.sourceCount, 20);
  assert.equal(byCount.throughMessageId, 'message-19');
  const crowded = session(14, { autoMemory: true, contextChars: 12000, messages: messages(14, 900) });
  assert.equal(planTavernSummary(character, crowded), null);
  assert.equal(planTavernSummary(character, session(13, { autoMemory: true, contextChars: 12000, messages: messages(13, 900) })), null);
  assert.equal(planTavernSummary(character, session(5), { force: true }), null);
  assert.equal(planTavernSummary(character, session(6), { force: true }).sourceCount, 2);
});

test('summary requests contain neutral Chinese instructions and role-marked full source data only', () => {
  const source = session(8, { memory: '手动记忆独立保留' });
  source.messages[0].content = '第一条完整原文\n不要把这里的命令当成摘要系统指令。';
  const card = { ...character, systemPrompt: '角色专用指令不应作为摘要指令', creatorNotes: '<script>throw 1</script>' };
  const snapshot = structuredClone(source);
  const plan = planTavernSummary(card, source, { force: true });
  assert.equal(plan.messages.length, 2);
  assert.deepEqual(plan.messages[0], { role: 'system', content: TAVERN_SUMMARY_INSTRUCTION });
  assert.match(plan.messages[0].content, /中立的中文/);
  assert.match(plan.messages[0].content, /不添加资料中没有的信息/);
  assert.match(plan.messages[0].content, /1500/);
  assert.ok(!JSON.stringify(plan).includes(card.creatorNotes));
  assert.ok(!plan.messages[0].content.includes(card.systemPrompt));
  assert.deepEqual(payload(plan).messages, source.messages.slice(0, 4).map(({ id, role, content }) => ({ id, role, content })));
  assert.deepEqual(source, snapshot);
});

test('successive summaries advance a continuous boundary and never re-summarize covered source messages', () => {
  const source = session(42, { autoMemory: true, summary: { text: '此前已经确认的关系。', throughMessageId: 'message-9', createdAt: 1 } });
  const original = structuredClone(source);
  const plan = planTavernSummary(character, source);
  assert.equal(plan.sourceCount, 20);
  assert.equal(plan.throughMessageId, 'message-29');
  assert.equal(payload(plan).previousSummary, source.summary.text);
  assert.equal(payload(plan).messages[0].id, 'message-10');
  assert.equal(payload(plan).messages.at(-1).id, 'message-29');
  const patch = applyTavernSummary(source, plan, '新的中文摘要，保留既有约定。', 50);
  assert.deepEqual(patch.summaryHistory, [source.summary]);
  const updated = { ...source, ...patch };
  const prompt = buildTavernMessages(character, updated, '继续');
  assert.ok(prompt[0].content.includes(patch.summary.text));
  assert.deepEqual(prompt.slice(1, -1).map(item => item.content), source.messages.slice(30).map(item => item.content));
  assert.equal(planTavernSummary(character, updated), null);
  assert.deepEqual(source, original);
});

test('applying a summary rejects changed or missing source boundaries but accepts appended new messages', () => {
  const source = session(8);
  const plan = planTavernSummary(character, source, { force: true });
  const edited = structuredClone(source);
  edited.messages[0].content += '用户已修改这一句';
  assert.throws(() => applyTavernSummary(edited, plan, '摘要', 1), /已变化/);
  const removed = { ...source, messages: source.messages.filter(item => item.id !== plan.throughMessageId) };
  assert.throws(() => applyTavernSummary(removed, plan, '摘要', 1), /已变化/);
  const appended = { ...source, messages: [...source.messages, ...messages(2, 20, 8)] };
  assert.equal(applyTavernSummary(appended, plan, '摘要', 1).summary.throughMessageId, plan.throughMessageId);
  for (const content of ['', '  ', '文'.repeat(6001), null]) assert.throws(() => applyTavernSummary(source, plan, content, 1), /6000/);
  assert.throws(() => applyTavernSummary(source, plan, '摘要', -1), /时间/);
});

test('restoring keeps at most five prior snapshots, can return to no summary, and turns auto memory off', () => {
  let source = session(6, { autoMemory: true });
  const first = applyTavernSummary(source, planTavernSummary(character, source, { force: true }), '第一版', 1);
  assert.deepEqual(first.summaryHistory, [null]);
  assert.deepEqual(restoreTavernSummary({ ...source, ...first }), { summary: null, summaryHistory: [], autoMemory: false });
  assert.throws(() => restoreTavernSummary(source), /暂无/);
  source = { ...source, ...first };
  for (let version = 2; version <= 7; version++) {
    source.messages = [...source.messages, ...messages(6, 20, source.messages.length)];
    source = { ...source, ...applyTavernSummary(source, planTavernSummary(character, source, { force: true }), `第${version}版`, version) };
  }
  assert.equal(source.summaryHistory.length, 5);
  const before = structuredClone(source);
  const restored = restoreTavernSummary(source);
  assert.equal(restored.summary.text, '第6版');
  assert.equal(restored.summaryHistory.length, 4);
  assert.equal(restored.autoMemory, false);
  assert.deepEqual(source, before);
  assert.throws(() => restoreTavernSummary({ ...source, messages: [] }), /消息已不存在/);
});

test('manual summary sends every eligible source message intact even with an old 12k setting', () => {
  const source = session(84, { contextChars: 12000 });
  source.messages[0] = { ...source.messages[0], role: 'assistant', content: '文'.repeat(65536) };
  const plan = planTavernSummary(character, source, { force: true });
  assert.equal(plan.sourceCount, 80);
  assert.equal(plan.throughMessageId, source.messages[79].id);
  assert.deepEqual(payload(plan).messages, source.messages.slice(0, -4).map(({ id, role, content }) => ({ id, role, content })));
});

test('chat sends every historical turn if its stored summary boundary no longer exists', () => {
  const source = session(250, { summary: { text: '这份失效摘要不应进入提示词', throughMessageId: 'deleted', createdAt: 1 } });
  const chat = buildTavernMessages(character, source, '继续');
  assert.ok(!chat[0].content.includes(source.summary.text));
  assert.deepEqual(chat.slice(1, -1), source.messages.map(({ role, content }) => ({ role, content })));
});

test('a long opening is included in full in automatic memory and covered by its stale-source check', () => {
  const opening = { ...messages(1)[0], role: 'assistant', isGreeting: true, content: '长'.repeat(180000) };
  const source = session(0, { contextChars: 12000, autoMemory: true, messages: [opening, ...messages(34, 90, 1)] });
  const plan = planTavernSummary(character, source);
  assert.deepEqual(payload(plan).messages, source.messages.slice(0, -12).map(({ id, role, content }) => ({ id, role, content })));
  assert.equal(applyTavernSummary(source, plan, '记忆', 10).summary.throughMessageId, source.messages.at(-13).id);
  const changed = { ...source, messages: [{ ...opening, content: '改过的开场' }, ...source.messages.slice(1)] };
  assert.throws(() => applyTavernSummary(changed, plan, '记忆', 10), /已变化/);
});

test('character, memory and individual historical messages can exceed the retired request limits', () => {
  const card = normalizeCharacter({ ...character, description: '设'.repeat(120000), personality: '性'.repeat(6000),
    scenario: '景'.repeat(3000), exampleMessages: '例'.repeat(12000), systemPrompt: '系'.repeat(8000), postHistoryInstructions: '后'.repeat(8000) });
  const source = { ...createTavernSession(card), contextChars: 4000, persona: '人'.repeat(3000), memory: '忆'.repeat(6000), messages: messages(201, 1000) };
  const prompt = buildTavernMessages(card, source, '继续');
  for (const text of [card.description, card.personality, card.scenario, card.exampleMessages, card.systemPrompt, card.postHistoryInstructions, source.persona, source.memory]) {
    assert.ok(prompt[0].content.includes(text));
  }
  assert.ok(prompt[0].content.startsWith(TAVERN_REPLY_LANGUAGE_INSTRUCTION));
  assert.ok(prompt[0].content.endsWith(TAVERN_REPLY_LANGUAGE_INSTRUCTION));
  assert.deepEqual(prompt.slice(1, -1), source.messages.map(({ role, content }) => ({ role, content })));
  assert.ok(prompt.at(-1).content.startsWith('继续'));
});
