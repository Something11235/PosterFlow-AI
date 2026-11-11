import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCharacter, createTavernSession, buildTavernMessages, getTavernContextStatus,
  TAVERN_CONTEXT_OPTIONS, TAVERN_REPLY_LANGUAGE_INSTRUCTION } from '../src/lib/tavern.js';
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
  assert.equal(fresh.contextChars, 24000);
  assert.equal(fresh.autoMemory, false);
  assert.equal(fresh.summary, null);
  assert.deepEqual(fresh.summaryHistory, []);
  assert.deepEqual(TAVERN_CONTEXT_OPTIONS, [12000, 24000, 48000, 96000]);
  assert.deepEqual(fresh.messages, []);
  const alternate = createTavernSession(character, { greetingIndex: 1 });
  assert.equal(alternate.messages[0].content, ' 星灯向你问好。 ');
  assert.equal(character.alternateGreetings[1], ' {{char}}向{{USER}}问好。 ');
  for (const greetingIndex of [-2, 0, 2, '1', 1.5]) assert.throws(() => createTavernSession(character, { greetingIndex }), /开场白/);
});

test('automatic summary requires opt-in and its message-count or 80 percent capacity threshold', () => {
  assert.equal(planTavernSummary(character, session(32)), null);
  assert.equal(planTavernSummary(character, session(31, { autoMemory: true })), null);
  const byCount = planTavernSummary(character, session(32, { autoMemory: true }));
  assert.equal(byCount.sourceCount, 20);
  assert.equal(byCount.throughMessageId, 'message-19');
  const crowded = session(14, { autoMemory: true, contextChars: 12000, messages: messages(14, 900) });
  const status = getTavernContextStatus(character, crowded);
  assert.ok(status.usedChars >= status.budgetChars * 0.8);
  assert.equal(planTavernSummary(character, crowded).sourceCount, 2);
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
  const status = getTavernContextStatus(character, updated, '继续');
  assert.equal(status.historyCount, 42);
  assert.equal(status.summarizedCount, 30);
  assert.equal(status.includedHistoryCount, 12);
  assert.equal(status.omittedHistoryCount, 0);
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

test('summary plans fit whole consecutive messages and fail instead of skipping or splitting oversized source', () => {
  const source = session(14, { contextChars: 12000 });
  for (let index = 0; index < 3; index++) source.messages[index].content = `完整原文${index}` + '文'.repeat(3990);
  const plan = planTavernSummary(character, source, { force: true });
  assert.equal(plan.sourceCount, 2);
  assert.equal(plan.throughMessageId, source.messages[1].id);
  assert.equal(payload(plan).messages[1].content, source.messages[1].content);
  assert.ok(plan.messages.reduce((total, item) => total + item.content.length, 0) <= 12000);
  assert.ok(plan.messages[1].content.length <= 65536);
  source.contextChars = 96000;
  source.messages[0] = { ...source.messages[0], role: 'assistant', content: '文'.repeat(65536) };
  assert.throws(() => planTavernSummary(character, source, { force: true }), /不会跳过消息或截取半条/);
});

test('context status counts actual empty input, included/omitted history, and ignores stale summary boundaries', () => {
  const source = session(50);
  const status = getTavernContextStatus(character, source);
  assert.equal(status.error, null);
  assert.equal(status.historyCount, 50);
  assert.equal(status.includedHistoryCount, 40);
  assert.equal(status.omittedHistoryCount, 10);
  assert.equal(status.summarizedCount, 0);
  assert.equal(getTavernContextStatus(character, source, '问').usedChars, status.usedChars + 1);
  const stale = { ...source, summary: { text: '这份失效摘要不应进入提示词', throughMessageId: 'deleted', createdAt: 1 } };
  assert.equal(getTavernContextStatus(character, stale).summarizedCount, 0);
  assert.ok(!buildTavernMessages(character, stale, '继续')[0].content.includes(stale.summary.text));
  assert.match(getTavernContextStatus(character, { ...source, contextChars: 1000 }).error, /容量/);
});

test('96000 character context accommodates full longer settings but enforces the 60000 system cap', () => {
  const longCharacter = normalizeCharacter({ ...character, description: '设'.repeat(16000), personality: '性'.repeat(6000),
    scenario: '景'.repeat(3000), exampleMessages: '例'.repeat(12000), systemPrompt: '系'.repeat(8000), postHistoryInstructions: '后'.repeat(8000) });
  const source = { ...createTavernSession(longCharacter), contextChars: 96000, messages: messages(30, 1000) };
  const prompt = buildTavernMessages(longCharacter, source, '继续');
  assert.ok(prompt[0].content.includes(longCharacter.description));
  assert.ok(prompt[0].content.startsWith(TAVERN_REPLY_LANGUAGE_INSTRUCTION));
  assert.ok(prompt[0].content.endsWith(TAVERN_REPLY_LANGUAGE_INSTRUCTION));
  const status = getTavernContextStatus(longCharacter, source, '继续');
  assert.ok(status.usedChars > 48000 && status.usedChars <= 96000);
  assert.equal(status.includedHistoryCount, 30);
  assert.throws(() => buildTavernMessages(longCharacter, { ...source, contextChars: 24000 }, '继续'), /24000/);
  const huge = { ...source, persona: '人'.repeat(3000), memory: '忆'.repeat(6000) };
  assert.throws(() => buildTavernMessages(longCharacter, huge, '继续'), /60000/);
  assert.match(getTavernContextStatus(longCharacter, huge, '继续').error, /60000/);
});
