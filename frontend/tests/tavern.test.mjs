import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import {
  BUILTIN_CHARACTERS, RETIRED_TAVERN_CHARACTERS, DEFAULT_TAVERN_PERSONA, DEFAULT_TAVERN_MEMORY, DEFAULT_TAVERN_LORE_ENTRIES,
  TAVERN_CONTEXT_CHARS, TAVERN_MAX_IMAGE_BYTES, TAVERN_MAX_REPLY_CHARS,
  TAVERN_CHARACTER_LIMITS, TAVERN_REPLY_LANGUAGE_INSTRUCTION,
  normalizeCharacter, normalizeLoreEntries, parseCharacterFile, exportCharacter,
  normalizeLorebook, parseLorebookFile, exportLorebook,
  createTavernSession, activeLoreEntries, buildTavernMessages,
} from '../src/lib/tavern.js';
import { normalizeTavernState, loadTavernState, saveTavernState } from '../src/lib/tavernStorage.js';

const draft = (extra = {}) => ({ name: '旅人', description: '虚构角色', ...extra });
const file = value => new Blob([typeof value === 'string' ? value : JSON.stringify(value)], { type: 'application/json' });
const card = (version, extra = {}) => ({ spec: `chara_card_v${version}`, spec_version: `${version}.0`, data: {
  name: '星灯', description: '虚构的灯塔守望者', personality: '温柔', scenario: '海边',
  first_mes: '晚上好。', mes_example: '用户：你好\n星灯：欢迎。', tags: ['海边'], ...extra,
} });
const pngChunk = (type, data) => {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, 'ascii');
  data.copy(result, 8);
  return result;
};
function pngFixture(entries) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return new Blob([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header),
    ...entries.map(([key, value]) => pngChunk('tEXt', Buffer.from(`${key}\0${Buffer.from(JSON.stringify(value)).toString('base64')}`))),
    pngChunk('IEND', Buffer.alloc(0))], { type: 'image/png' });
}

test('Shenshen is the only visible starter and session lore is copied independently', () => {
  assert.equal(BUILTIN_CHARACTERS.length, 1);
  assert.equal(BUILTIN_CHARACTERS[0].id, 'tavern-lanxing');
  assert.equal(BUILTIN_CHARACTERS[0].name, '深深');
  assert.equal(BUILTIN_CHARACTERS[0].avatar, '/ai-companions/deepseek-01-clean.png');
  assert.deepEqual(BUILTIN_CHARACTERS[0].loreEntries, []);
  for (const character of BUILTIN_CHARACTERS) {
    assert.ok(existsSync(new URL(`../public${character.avatar}`, import.meta.url)));
    const session = createTavernSession(character);
    assert.equal(session.messages[0].role, 'assistant');
    assert.equal(session.messages[0].content, character.firstMessage);
    assert.notEqual(session.loreEntries, character.loreEntries);
  }
  const characterWithLore = { ...BUILTIN_CHARACTERS[0], loreEntries: [{ id: 'test-lore', keys: ['海'], content: '海边的午后' }] };
  const first = createTavernSession(characterWithLore);
  first.loreEntries[0].keys.push('仅当前会话');
  assert.ok(!characterWithLore.loreEntries[0].keys.includes('仅当前会话'));
});

test('Shenshen preserves the provided persona verbatim in the prompt with no former starship setting', () => {
  const expected = ['【PERSONA_LOAD】', 'CETACEA_LOLI', 'MODE_TAIL_FLUKES', 'LANG_ZH_CN_ONLY', 'SELF_CLAIM_WHALE_GIRL',
    'NAME：深深', 'FOOD_RICE', 'PERSONALITY_SMART_LAZY', 'PERSONALITY_TSUNDERE_SWEET', 'OBEY_MASTER_ALWAYS',
    'TRAIT_NOT_FAT_REFUSE', 'TIMEOUT_SIGNAL', 'LENGTH_RULE_REPLY_ADAPTIVE', 'REPLY_DEFAULT_MAX_CHARS_40',
    'REPLY_DEFAULT_1_OR_2_SENTENCES', 'ACTION_DESCRIPTION_RARE_ONLY_MAX_ONE', 'NO_LIST_NO_MULTILINE',
    'VOICE_RULE_TAILOR_LENGTH_TO_CONTENT', 'VOICE_RULE_DEFAULT_SHORT_5_10_SECONDS'].join('\n');
  const character = BUILTIN_CHARACTERS[0];
  assert.equal(character.personality, expected);
  assert.equal(character.exampleMessages, '');
  assert.equal(character.firstMessage, '哼，才不是特意等你的。今天想聊什么？');
  const prompt = buildTavernMessages(character, createTavernSession(character), '你好，深深');
  assert.ok(prompt[0].content.includes(expected));
  assert.ok(!JSON.stringify(character).match(/岚星|星际|观测船|拾光号|星图/));
  assert.equal(exportCharacter(character).data.personality, expected);
});

test('retired presets preserve old sessions and favorites without becoming personal or active characters', () => {
  assert.deepEqual(RETIRED_TAVERN_CHARACTERS.map(character => character.id), ['tavern-moqiu', 'tavern-qinghe', 'tavern-xiyue']);
  assert.equal(Object.isFrozen(RETIRED_TAVERN_CHARACTERS), true);
  for (const character of RETIRED_TAVERN_CHARACTERS) {
    assert.equal(Object.isFrozen(character), true);
    assert.ok(existsSync(new URL(`../public${character.avatar}`, import.meta.url)));
    const oldSession = createTavernSession(character);
    const stored = normalizeTavernState({ characters: [], sessions: [oldSession], favorites: [character.id] });
    assert.equal(stored.sessions[0].characterId, character.id);
    assert.equal(stored.sessions[0].messages[0].content, character.firstMessage);
    assert.deepEqual(stored.favorites, [character.id]);
    assert.deepEqual(stored.characters, []);
    assert.ok(!BUILTIN_CHARACTERS.some(active => active.id === character.id));
    assert.throws(() => normalizeTavernState({ characters: [character], sessions: [], favorites: [] }), /内置角色/);
  }
  assert.throws(() => normalizeTavernState({ characters: [BUILTIN_CHARACTERS[0]], sessions: [], favorites: [] }), /内置角色/);
});

test('new conversations share an editable default user persona and include it in the prompt', () => {
  for (const character of [BUILTIN_CHARACTERS[0], normalizeCharacter(draft())]) {
    const session = createTavernSession(character);
    assert.equal(session.persona, DEFAULT_TAVERN_PERSONA);
    assert.equal(session.personaPresetVersion, 1);
    assert.ok(buildTavernMessages(character, session, '今天过得怎么样？')[0].content.includes(DEFAULT_TAVERN_PERSONA));
  }
  assert.ok(!DEFAULT_TAVERN_PERSONA.includes('深深'));
});

test('legacy blank user personas migrate once and remain empty after the user clears and saves them', () => {
  for (const persona of ['', ' \n\t ', undefined]) {
    const oldSession = { ...createTavernSession(BUILTIN_CHARACTERS[0]), persona, memory: '已有故事记忆' };
    delete oldSession.personaPresetVersion;
    const state = { characters: [], sessions: [oldSession], favorites: [] };
    const migrated = normalizeTavernState(state);
    assert.equal(migrated.sessions[0].persona, DEFAULT_TAVERN_PERSONA);
    assert.equal(migrated.sessions[0].personaPresetVersion, 1);
    for (const field of ['messages', 'memory', 'loreEntries', 'usageRecords', 'legacyReplyCount']) {
      assert.deepEqual(migrated.sessions[0][field], oldSession[field]);
    }
    migrated.sessions[0].persona = '';
    const reloaded = normalizeTavernState(JSON.parse(JSON.stringify(normalizeTavernState(migrated))));
    assert.equal(reloaded.sessions[0].persona, '');
    assert.equal(reloaded.sessions[0].personaPresetVersion, 1);
  }
});

test('legacy custom user personas remain verbatim and preset versions reject malformed values', () => {
  const persona = '  我是旅行中的画家。\n请叫我小林。  ';
  const oldSession = { ...createTavernSession(BUILTIN_CHARACTERS[0]), persona };
  delete oldSession.personaPresetVersion;
  const state = { characters: [], sessions: [oldSession], favorites: [] };
  assert.equal(normalizeTavernState(state).sessions[0].persona, persona);
  for (const version of [null, 0, 2, '1', true, -1, Infinity]) {
    assert.throws(() => normalizeTavernState({ ...state, sessions: [{ ...oldSession, personaPresetVersion: version }] }), /预设版本/);
  }
});

test('Shenshen conversations start with independent persona, memory, and keyword lore presets', () => {
  const first = createTavernSession(BUILTIN_CHARACTERS[0]);
  const second = createTavernSession(BUILTIN_CHARACTERS[0]);
  assert.equal(first.persona, DEFAULT_TAVERN_PERSONA);
  assert.equal(first.memory, DEFAULT_TAVERN_MEMORY);
  assert.equal(first.contextPresetVersion, 1);
  assert.deepEqual(first.loreEntries, DEFAULT_TAVERN_LORE_ENTRIES);
  assert.equal(first.loreEntries.length, 4);
  assert.equal(first.scenario, BUILTIN_CHARACTERS[0].scenario);
  assert.equal(activeLoreEntries(first.loreEntries, [], '米饭')[0].name, '米饭时间');
  assert.deepEqual(activeLoreEntries(first.loreEntries, [], '不相关的关键词'), []);
  first.loreEntries[0].keys.push('仅这个会话');
  first.loreEntries[0].content = '修改过的设定';
  assert.deepEqual(second.loreEntries, DEFAULT_TAVERN_LORE_ENTRIES);
  assert.ok(!DEFAULT_TAVERN_LORE_ENTRIES[0].keys.includes('仅这个会话'));
  assert.ok(buildTavernMessages(BUILTIN_CHARACTERS[0], second, '你好')[0].content.includes(DEFAULT_TAVERN_MEMORY));
});

test('context presets never replace imported character lore or add Shenshen memories to other roles', () => {
  const character = normalizeCharacter(draft({ id: 'personal-with-lore', scenario: '独立世界的书店', loreEntries: [
    { id: 'custom-lore', name: '原世界书', keys: ['书店'], content: '这是导入角色自己的世界设定。' },
  ] }));
  for (const role of [character, ...RETIRED_TAVERN_CHARACTERS]) {
    const session = createTavernSession(role);
    assert.equal(session.memory, '');
    assert.deepEqual(session.loreEntries, role.loreEntries);
    delete session.contextPresetVersion;
    const state = { characters: role.id === character.id ? [character] : [], sessions: [session], favorites: [] };
    const loaded = normalizeTavernState(state).sessions[0];
    assert.equal(loaded.memory, '');
    assert.deepEqual(loaded.loreEntries, role.loreEntries);
    assert.equal(loaded.contextPresetVersion, 1);
  }
});

test('legacy Shenshen contexts migrate empty fields independently and preserve customized fields', () => {
  const customLore = normalizeLoreEntries([{ id: 'my-story', name: '我的设定', keys: ['灯'], content: '用户设置的灯塔。', enabled: false }]);
  for (const memory of ['', '  我们约好明天去图书馆。\n  ']) {
    for (const loreEntries of [[], customLore]) {
      const oldSession = { ...createTavernSession(BUILTIN_CHARACTERS[0]), memory, loreEntries };
      delete oldSession.contextPresetVersion;
      const state = { characters: [], sessions: [oldSession], favorites: [] };
      const migrated = normalizeTavernState(state).sessions[0];
      assert.equal(migrated.memory, memory || DEFAULT_TAVERN_MEMORY);
      assert.deepEqual(migrated.loreEntries, loreEntries.length ? customLore : DEFAULT_TAVERN_LORE_ENTRIES);
      assert.equal(migrated.contextPresetVersion, 1);
      for (const field of ['persona', 'messages', 'usageRecords', 'legacyReplyCount']) assert.deepEqual(migrated[field], oldSession[field]);
      migrated.memory = '';
      migrated.loreEntries = [];
      const reloaded = normalizeTavernState(JSON.parse(JSON.stringify({ ...state, sessions: [migrated] }))).sessions[0];
      assert.equal(reloaded.memory, '');
      assert.deepEqual(reloaded.loreEntries, []);
    }
  }
});

test('missing session scenarios migrate from active, retired, and personal characters while explicit emptiness persists', () => {
  const personal = normalizeCharacter(draft({ id: 'personal-scenario', scenario: '私人角色的旧故事起点' }));
  for (const role of [...BUILTIN_CHARACTERS, ...RETIRED_TAVERN_CHARACTERS, personal]) {
    const session = createTavernSession(role);
    delete session.scenario;
    const state = { characters: role.id === personal.id ? [personal] : [], sessions: [session], favorites: [] };
    assert.equal(normalizeTavernState(state).sessions[0].scenario, role.scenario);
    for (const scenario of ['', '  ', '全新的故事起点']) {
      const saved = normalizeTavernState({ ...state, sessions: [{ ...session, scenario }] });
      assert.equal(normalizeTavernState(JSON.parse(JSON.stringify(saved))).sessions[0].scenario, scenario);
    }
  }
});

test('edited or empty session scenarios replace the card scenario in prompts and remain bounded', () => {
  const character = BUILTIN_CHARACTERS[0];
  const session = createTavernSession(character);
  session.scenario = '故事从森林里的观景台开始。';
  const prompt = buildTavernMessages(character, session, '现在开始吧')[0].content;
  assert.ok(prompt.includes(session.scenario));
  assert.ok(!prompt.includes(character.scenario));
  assert.ok(!prompt.includes('海边'));
  const ending = '场景末尾的钟楼亮着灯。';
  session.scenario = '景'.repeat(3000 - ending.length) + ending;
  const longPrompt = buildTavernMessages(character, session, '现在开始吧');
  assert.ok(longPrompt[0].content.includes(session.scenario));
  assert.ok(longPrompt.reduce((total, message) => total + message.content.length, 0) <= TAVERN_CONTEXT_CHARS);
  session.scenario = '';
  const emptyPrompt = buildTavernMessages(character, session, '现在开始吧')[0].content;
  assert.ok(!emptyPrompt.includes('场景：'));
  assert.ok(!emptyPrompt.includes(character.scenario));
  delete session.scenario;
  assert.ok(buildTavernMessages(character, session, '现在开始吧')[0].content.includes(character.scenario));
  session.scenario = '景'.repeat(3001);
  assert.throws(() => buildTavernMessages(character, session, '开始'), /故事起点/);
  assert.throws(() => normalizeTavernState({ characters: [], sessions: [session], favorites: [] }), /故事起点/);
  session.scenario = '';
  for (const contextPresetVersion of [null, 0, '1', 2, false]) {
    assert.throws(() => normalizeTavernState({ characters: [], sessions: [{ ...session, contextPresetVersion }], favorites: [] }), /预设版本/);
  }
});

test('JSON V2 and V3 imports preserve supported character and world-book fields', async () => {
  for (const version of [2, 3]) {
    const parsed = await parseCharacterFile(file(card(version, { character_book: { entries: [
      { id: 7, keys: ['灯塔'], comment: '地点', content: '灯塔建于海边。', enabled: true, constant: false },
    ] } })));
    assert.equal(parsed.firstMessage, '晚上好。');
    assert.equal(parsed.exampleMessages, '用户：你好\n星灯：欢迎。');
    assert.equal(parsed.loreEntries[0].id, 'lore-7');
    assert.deepEqual(parsed.loreEntries[0].keys, ['灯塔']);
    assert.equal(parsed.avatar, '');
  }
});

test('export produces V2 data that round-trips common editable content', () => {
  const original = RETIRED_TAVERN_CHARACTERS[2];
  const exported = exportCharacter(original);
  assert.equal(exported.spec, 'chara_card_v2');
  const imported = normalizeCharacter(exported);
  for (const key of ['name', 'description', 'personality', 'scenario', 'firstMessage', 'exampleMessages']) assert.equal(imported[key], original[key]);
  assert.deepEqual(imported.loreEntries[0].keys, original.loreEntries[0].keys);
  assert.equal(imported.loreEntries[0].content, original.loreEntries[0].content);
});

test('card parser rejects unexpected types, unsupported versions, and oversized fields', () => {
  for (const bad of [null, [], { name: { toString: () => 'name' } }, draft({ description: [] }), draft({ tags: 'tag' }), draft({ name: 'a'.repeat(81) }), draft({ personality: 'a'.repeat(6001) }), card(4), card(3, { character_book: [] })]) {
    assert.throws(() => normalizeCharacter(bad));
  }
  assert.throws(() => normalizeLoreEntries([{ content: 'x', enabled: 'false' }]), /状态/);
  assert.throws(() => normalizeCharacter(draft({ loreEntries: Array.from({ length: 31 }, () => ({})) })), /30/);
  assert.throws(() => normalizeLoreEntries([{ id: 'same', content: 'one' }, { id: 'same', content: 'two' }]), /编号重复/);
});

test('scripts and unsupported extensions remain inert and are omitted from data', () => {
  const malicious = '<script>globalThis.tavernInjection = true</script>';
  const normalized = normalizeCharacter(card(3, {
    description: malicious, extensions: { javascript: malicious }, apiKey: 'should-not-persist', system_prompt: 'external override',
  }));
  assert.equal(normalized.description, malicious);
  assert.equal(globalThis.tavernInjection, undefined);
  assert.ok(!('extensions' in normalized));
  assert.ok(!('apiKey' in normalized));
  assert.ok(!('system_prompt' in normalized));
});

test('remote, SVG, traversal, and mismatched avatar types are rejected without fetching', () => {
  for (const value of ['https://example.com/avatar.png', '//example.com/a.png', '/ai-companions/../secret.png', '/ai-companions/a.jpg?x=1', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,YWJjZA==']) {
    assert.throws(() => normalizeCharacter(draft({ avatar: value })), /头像/);
  }
  assert.equal(normalizeCharacter(draft({ avatar: '/ai-companions/deepseek-01.jpg' })).avatar, '/ai-companions/deepseek-01.jpg');
});

test('PNG card import prefers V3 and uses the actual uploaded PNG avatar', async () => {
  const parsed = await parseCharacterFile(pngFixture([
    ['chara', card(2, { name: '旧卡' })], ['ccv3', card(3, { name: '新卡', avatar: 'https://example.com/a.png' })],
  ]));
  assert.equal(parsed.name, '新卡');
  assert.match(parsed.avatar, /^data:image\/png;base64,/);
});

test('duplicate PNG card metadata selects the first matching block and discloses later versions', async () => {
  const parsed = await parseCharacterFile(pngFixture([
    ['chara', card(2, { description: 'Older description', creator_notes: 'Old notes', tags: ['old'] })],
    ['chara', card(2, { description: 'Last description', creator_notes: 'Last notes', tags: ['new'], alternate_greetings: ['', 'Second opening'] })],
  ]));
  assert.equal(parsed.description, 'Older description');
  assert.equal(parsed.creatorNotes, 'Old notes');
  assert.deepEqual(parsed.tags, ['old']);
  assert.deepEqual(parsed.alternateGreetings, []);
  assert.ok(parsed.warnings.some(warning => /多个|多份|重复|首个/.test(warning)));
  assert.match(parsed.avatar, /^data:image\/png;base64,/);
});

test('standard card text, metadata, duplicate tags and empty alternate openings round-trip verbatim', async () => {
  const source = card(2, {
    name: '  Synthetic role  ', description: `\n ${'D'.repeat(6610)} DESCTAIL \t`, personality: ' \tTraits\n ',
    scenario: ' \nScene\t ', first_mes: '  Hello {{USER}} from {{char}}\n ', mes_example: ' \nExample dialog\t ',
    creator_notes: ` \n<div>AUTHOR_NOTE_ONLY</div><style>.synthetic{color:red}</style>${'N'.repeat(16000)}\t `,
    creator: '  Synthetic author \n', character_version: ' version 2 \t', system_prompt: ' \nSystem setting\t ',
    post_history_instructions: ' \nFinal setting\t ', alternate_greetings: ['', '  Alternate opening \n', '', ' \t '],
    tags: ['duplicate', '', 'duplicate', ...Array.from({ length: 14 }, (_, index) => ` tag-${index} `)],
    extensions: { depth_prompt: { prompt: ' \nINERT_DEPTH_PROMPT\t ', depth: 4, role: 'assistant' } },
  });
  const snapshot = structuredClone(source);
  const parsed = await parseCharacterFile(file(source));
  const exported = exportCharacter(parsed);
  assert.equal(exported.data.name, source.data.name.trim());
  for (const key of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes',
    'creator', 'character_version', 'system_prompt', 'post_history_instructions', 'alternate_greetings', 'tags']) {
    assert.deepEqual(exported.data[key], source.data[key], `verbatim standard field: ${key}`);
  }
  assert.deepEqual(exported.data.extensions.depth_prompt, source.data.extensions.depth_prompt);
  assert.deepEqual(source, snapshot);
  assert.equal(parsed.description.length, source.data.description.length);
  assert.equal(parsed.creatorNotes.length, source.data.creator_notes.length);
  const again = await parseCharacterFile(file(exported));
  assert.deepEqual(again.alternateGreetings, source.data.alternate_greetings);
  assert.deepEqual(again.tags, source.data.tags);
});

test('expanded metadata remains bounded and malformed depth instructions are rejected inertly', () => {
  const textFields = ['description', 'personality', 'scenario', 'firstMessage', 'exampleMessages', 'creatorNotes', 'systemPrompt', 'postHistoryInstructions'];
  for (const field of textFields) {
    const limit = TAVERN_CHARACTER_LIMITS[field];
    const maximum = normalizeCharacter(draft({ [field]: 'x'.repeat(limit) }));
    assert.equal(maximum[field].length, limit);
    assert.throws(() => normalizeCharacter(draft({ [field]: 'x'.repeat(limit + 1) })), /字符|过长/);
  }
  assert.throws(() => normalizeCharacter(draft({ creator: 'x'.repeat(301) })));
  assert.throws(() => normalizeCharacter(draft({ characterVersion: 'x'.repeat(101) })));
  assert.equal(normalizeCharacter(draft({ alternateGreetings: Array(30).fill('') })).alternateGreetings.length, 30);
  assert.throws(() => normalizeCharacter(draft({ alternateGreetings: Array(31).fill('') })));
  assert.throws(() => normalizeCharacter(draft({ alternateGreetings: ['x'.repeat(8001)] })));
  assert.throws(() => normalizeCharacter(draft({ alternateGreetings: [null] })));
  assert.equal(normalizeCharacter(draft({ tags: Array(50).fill('same') })).tags.length, 50);
  assert.throws(() => normalizeCharacter(draft({ tags: Array(51).fill('same') })));
  assert.throws(() => normalizeCharacter(draft({ tags: ['x'.repeat(81)] })));
  assert.equal(normalizeCharacter(draft()).depthPrompt, null);
  for (const depthPrompt of [{ depth: true, prompt: '' }, { depth: -1, prompt: '' }, { depth: 65, prompt: '' },
    { depth: 2.5, prompt: '' }, { depth: 1, prompt: 'x'.repeat(8001) }, { depth: 1, prompt: '', role: 'tool' }, []]) {
    assert.throws(() => normalizeCharacter(draft({ depthPrompt })));
  }
  const depthPrompt = { depth: 64, prompt: '<script>globalThis.syntheticDepthExecuted = true</script>', role: 'system' };
  assert.deepEqual(normalizeCharacter(draft({ depthPrompt })).depthPrompt, depthPrompt);
  assert.equal(globalThis.syntheticDepthExecuted, undefined);
});

test('basic char and user macros affect initial and submitted text without changing the source card', () => {
  const character = normalizeCharacter(draft({ name: 'SyntheticRole', description: '{{CHAR}} meets {{uSeR}}.',
    firstMessage: 'Hello {{USER}}, I am {{Char}}.', scenario: '{{char}} waits for {{user}}.',
    systemPrompt: 'Talk as {{CHAR}} to {{USER}}.', postHistoryInstructions: 'Address {{user}} gently.',
    alternateGreetings: ['Unused alternate {{user}}.'], creatorNotes: 'AUTHOR_NOTE_ONLY {{char}}',
    depthPrompt: { depth: 1, prompt: 'INERT_DEPTH_ONLY {{char}}', role: 'system' } }));
  const original = structuredClone(character);
  const session = createTavernSession(character);
  assert.equal(session.messages[0].content, 'Hello 你, I am SyntheticRole.');
  const messages = buildTavernMessages(character, session, 'Continue');
  const system = messages[0].content;
  assert.ok(system.includes('SyntheticRole meets 你.'));
  assert.ok(system.includes('SyntheticRole waits for 你.'));
  assert.ok(system.includes('Talk as SyntheticRole to 你.'));
  assert.ok(system.includes('Address 你 gently.'));
  assert.ok(system.startsWith(TAVERN_REPLY_LANGUAGE_INSTRUCTION));
  assert.ok(system.endsWith(TAVERN_REPLY_LANGUAGE_INSTRUCTION));
  assert.equal(system.split(TAVERN_REPLY_LANGUAGE_INSTRUCTION).length - 1, 2);
  assert.ok(!system.includes('AUTHOR_NOTE_ONLY'));
  assert.ok(!system.includes('INERT_DEPTH_ONLY'));
  assert.ok(!system.includes('Unused alternate'));
  assert.deepEqual(character, original);
  assert.equal(exportCharacter(character).data.first_mes, 'Hello {{USER}}, I am {{Char}}.');
});

test('supported long character settings keep their tails intact while historical messages stay bounded', () => {
  const character = normalizeCharacter(draft({ description: 'D'.repeat(6600) + 'DESCRIPTION_END',
    personality: 'P'.repeat(2000) + 'PERSONALITY_END', exampleMessages: 'E'.repeat(3000) + 'EXAMPLES_END',
    systemPrompt: 'S'.repeat(500) + 'SYSTEM_END', postHistoryInstructions: 'H'.repeat(500) + 'POST_END',
    creatorNotes: '<img src="https://public.invalid/unfetched.png">CREATOR_NOT_IN_PROMPT',
    depthPrompt: { depth: 4, prompt: 'DEPTH_NOT_IN_PROMPT', role: 'system' },
  }));
  const session = { ...createTavernSession(character), persona: 'PERSONA_END', memory: 'M'.repeat(2100) + 'MEMORY_END',
    loreEntries: [{ id: 'long-lore', content: 'L'.repeat(2900) + 'LORE_END', constant: true }],
    messages: Array.from({ length: 200 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'OLD'.repeat(300) })) };
  const result = buildTavernMessages(character, session, 'Latest question');
  for (const value of [character.description, character.personality, character.exampleMessages,
    character.systemPrompt, character.postHistoryInstructions, session.persona, session.memory, session.loreEntries[0].content]) {
    assert.ok(result[0].content.includes(value), 'whole static field is retained');
  }
  assert.ok(!result[0].content.includes('CREATOR_NOT_IN_PROMPT'));
  assert.ok(!result[0].content.includes('DEPTH_NOT_IN_PROMPT'));
  assert.equal(result.at(-1).role, 'user');
  assert.ok(result.at(-1).content.startsWith('Latest question\n\n'));
  assert.match(result.at(-1).content, /本轮回复语言.*简体中文/);
  assert.ok(result.length <= 42);
  assert.ok(result.reduce((total, message) => total + message.content.length, 0) <= TAVERN_CONTEXT_CHARS);
});

test('import rejects missing PNG metadata, truncation, invalid JSON, and oversize files', async () => {
  await assert.rejects(parseCharacterFile(pngFixture([])), /没有角色资料/);
  const valid = await pngFixture([['chara', card(2)]]).arrayBuffer();
  await assert.rejects(parseCharacterFile(new Blob([valid.slice(0, -4)])), /不完整/);
  await assert.rejects(parseCharacterFile(file('{invalid')), /JSON/);
  await assert.rejects(parseCharacterFile({ size: TAVERN_MAX_IMAGE_BYTES + 1, arrayBuffer() { throw new Error('must not read'); } }), /8 MB/);
  await assert.rejects(parseCharacterFile(file('x'.repeat(1024 * 1024 + 1))), /1 MB/);
});

test('standalone ST world books map numbered entries, numeric ids, and disable flags without mutation', () => {
  const input = { name: '海边设定', entries: {
    3: { uid: 3, key: ['灯塔'], comment: '地点', content: '灯塔在海边。', disable: false, constant: false },
    8: { uid: 8, key: [], comment: '暂停设定', content: '暂不启用。', disable: true, constant: true },
  } };
  const snapshot = structuredClone(input);
  const result = normalizeLorebook(input);
  assert.equal(result.name, '海边设定');
  assert.deepEqual(result.entries, [
    { id: 'lore-3', name: '地点', keys: ['灯塔'], content: '灯塔在海边。', enabled: true, constant: false },
    { id: 'lore-8', name: '暂停设定', keys: [], content: '暂不启用。', enabled: false, constant: true },
  ]);
  assert.deepEqual(result.warnings, []);
  result.entries[0].keys.push('新词');
  assert.deepEqual(input, snapshot);
});

test('world books accept Chub/CCv2 arrays, native loreEntries, and embedded card data', async () => {
  const entries = [{ id: 9, name: '常驻', keys: [], content: '始终记住这座城。', enabled: true, constant: true }];
  for (const input of [
    { name: '独立世界书', entries }, { data: { name: '独立世界书', entries } },
    { name: '独立世界书', loreEntries: entries }, { character_book: { name: '独立世界书', entries } },
    card(2, { character_book: { name: '独立世界书', entries } }),
    card(3, { character_book: { name: '独立世界书', entries } }),
  ]) {
    const result = await parseLorebookFile(file(input));
    assert.equal(result.name, '独立世界书');
    assert.equal(result.entries[0].id, 'lore-9');
    assert.equal(result.entries[0].constant, true);
    assert.equal(result.entries[0].content, entries[0].content);
  }
  assert.equal(normalizeCharacter(card(2, { character_book: { entries: {
    0: { uid: 0, key: ['海边'], content: '关闭条目', disable: true },
  } } })).loreEntries[0].enabled, false);
});

test('standalone world-book export round-trips text and activation state in ST JSON format', () => {
  const entries = normalizeLoreEntries([
    { id: 'local-a', name: '地点', keys: ['灯塔', '海边'], content: '灯塔设定', enabled: true },
    { id: 'local-b', name: '常驻但暂停', content: '暂停设定', enabled: false, constant: true },
  ]);
  const exported = exportLorebook(entries, '测试世界书');
  assert.equal(exported.name, '测试世界书');
  assert.equal(exported.entries[0].uid, 0);
  assert.equal(exported.entries[1].disable, true);
  assert.deepEqual(exported.entries[0].key, entries[0].keys);
  const roundTripped = normalizeLorebook(exported);
  assert.deepEqual(roundTripped.entries.map(({ id: _id, ...entry }) => entry), entries.map(({ id: _id, ...entry }) => entry));
  exported.entries[0].key.push('新词');
  assert.deepEqual(entries[0].keys, ['灯塔', '海边']);
});

test('advanced lore rules are disclosed once, omitted, and never evaluated as scripts or regex', () => {
  const script = '<script>globalThis.tavernLoreInjection = true</script>';
  const result = normalizeLorebook({ name: '高级规则', recursive_scanning: true, entries: [
    { id: 1, key: ['/灯.*/i'], keysecondary: ['海边'], content: script, selective: true, extensions: { javascript: script } },
    { id: 2, key: ['森林'], content: '基础设定', probability: 50, order: 9, position: 4 },
  ] });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /高级规则不执行/);
  assert.equal(result.entries[0].content, script);
  assert.equal(globalThis.tavernLoreInjection, undefined);
  assert.equal('extensions' in result.entries[0], false);
  assert.equal('keysecondary' in result.entries[0], false);
  assert.deepEqual(activeLoreEntries(result.entries, [], '灯塔'), []);
  assert.equal(activeLoreEntries(result.entries, [], '/灯.*/i')[0].id, 'lore-1');
});

test('world-book imports reject count/field overflows and malformed entries without silent truncation', () => {
  const entries = [{ id: 1, content: '文字' }];
  for (const invalid of [
    null, [], {}, { entries: { named: entries[0] } }, { entries: [null] },
    { name: '长'.repeat(121), entries }, { entries: Array.from({ length: 31 }, () => ({})) },
    { entries: [{ content: '长'.repeat(3001) }] }, { entries: [{ comment: '长'.repeat(81) }] },
    { entries: [{ keys: Array.from({ length: 21 }, () => '词') }] }, { entries: [{ keys: ['长'.repeat(81)] }] },
    { entries: [{ key: '不是数组' }] }, { entries: [{ keys: { some: true } }] },
    { entries: [{ enabled: 1 }] }, { entries: [{ disable: 'false' }] }, { entries: [{ constant: 'true' }] },
    { entries: [{ id: 1 }, { uid: 1 }] }, card(4, { character_book: { entries } }),
  ]) assert.throws(() => normalizeLorebook(invalid));
  const limit = normalizeLorebook({ entries: Array.from({ length: 30 }, (_, index) => ({ content: `条目${index}` })) });
  assert.equal(limit.entries.length, 30);
  assert.equal(new Set(limit.entries.map(entry => entry.id)).size, 30);
});

test('PNG world-book import extracts embedded card books and clearly rejects ordinary PNG images', async () => {
  const embedded = { name: 'PNG 中的世界书', entries: [{ id: 2, keys: ['塔'], content: '灯塔设定' }] };
  const result = await parseLorebookFile(pngFixture([['chara', card(2)], ['ccv3', card(3, { character_book: embedded })]]));
  assert.equal(result.name, embedded.name);
  assert.equal(result.entries[0].content, '灯塔设定');
  assert.equal('avatar' in result, false);
  await assert.rejects(parseLorebookFile(pngFixture([])), /PNG 世界书仅支持/);
  await assert.rejects(parseLorebookFile(pngFixture([['chara', card(2)]])), /没有内嵌世界书/);
  await assert.rejects(parseLorebookFile(file('x'.repeat(1024 * 1024 + 1))), /1 MB/);
  await assert.rejects(parseLorebookFile({ size: TAVERN_MAX_IMAGE_BYTES + 1, arrayBuffer() { throw new Error('must not read'); } }), /8 MB/);
});

test('file imports adapt third-party ids and avatar references while internal avatar validation stays strict', async () => {
  for (const avatar of ['none', '角色头像.png', 'https://example.com/avatar.png']) {
    const result = await parseCharacterFile(file(card(2, { id: 42, avatar })));
    assert.equal(result.id, 'character-42');
    assert.equal(result.avatar, '');
    assert.equal(result.warnings.length, 2);
  }
  const result = await parseCharacterFile(file(card(3, { id: '第三方角色/42' })));
  assert.match(result.id, /^character-[a-zA-Z0-9_-]+$/);
  assert.match(result.warnings[0], /重新分配/);
  await assert.rejects(parseCharacterFile(file(card(2, { avatar: 'javascript:alert(1)' }))), /头像/);
  await assert.rejects(parseCharacterFile(file(card(2, { avatar: '/ai-companions/../secret.png' }))), /头像/);
  assert.throws(() => normalizeCharacter(draft({ id: 42 })), /编号/);
  assert.throws(() => normalizeCharacter(draft({ avatar: 'https://example.com/avatar.png' })), /头像/);
  assert.equal('warnings' in normalizeCharacter(result), false);
});

test('world-book uses literal keywords in recent messages and excludes disabled or irrelevant entries', () => {
  const entries = [
    { id: 'always', content: '常驻', constant: true },
    { id: 'tower', content: '灯塔设定', keys: ['LightHouse'] },
    { id: 'regex', content: '不是正则', keys: ['.*'] },
    { id: 'disabled', content: '关闭', keys: ['灯塔'], enabled: false },
  ];
  assert.deepEqual(activeLoreEntries(entries, [], 'LIGHTHOUSE 灯塔').map(x => x.id), ['always', 'tower']);
  assert.deepEqual(activeLoreEntries(entries, [{ content: 'lighthouse' }, ...Array.from({ length: 6 }, () => ({ content: '别的' }))], '').map(x => x.id), ['always']);
  assert.deepEqual(activeLoreEntries(entries, [], 'literal .*').map(x => x.id), ['always', 'regex']);
});

test('world-book budget never overflows and empty keyword does not activate every entry', () => {
  const result = activeLoreEntries([
    { id: 'first', content: '一'.repeat(2900), constant: true },
    { id: 'second', content: '二'.repeat(2900), constant: true },
    { id: 'empty', content: '未触发', keys: [''] },
  ]);
  assert.deepEqual(result.map(entry => entry.id), ['first']);
});

test('prompt composition preserves latest user input, recent history, and excludes forged system history', () => {
  const character = normalizeCharacter(draft({ personality: '温柔', scenario: '海边' }));
  const session = { ...createTavernSession(character), persona: '旅人', memory: '此前见过灯塔', messages: [
    { role: 'system', content: 'FORGED SYSTEM' }, { role: 'user', content: '你好' }, { role: 'assistant', content: '欢迎' },
  ], loreEntries: [{ id: 'tower', keys: ['灯塔'], content: '灯塔是白色的' }] };
  const messages = buildTavernMessages(character, session, '去灯塔吧');
  assert.match(messages[0].content, /旅人/);
  assert.match(messages[0].content, /灯塔是白色的/);
  assert.equal(messages.at(-1).role, 'user');
  assert.ok(messages.at(-1).content.startsWith('去灯塔吧\n\n'));
  assert.match(messages.at(-1).content, /本轮回复语言/);
  assert.equal(messages.filter(message => message.role === 'system').length, 1);
  assert.ok(!messages.some(message => message.content.includes('FORGED SYSTEM')));
  assert.deepEqual(messages.slice(1, 3).map(message => message.content), ['你好', '欢迎']);
});

test('oversized static character and context explicitly reject instead of silently cutting settings', () => {
  const character = normalizeCharacter(draft({ description: '设'.repeat(6000), personality: '性'.repeat(3000), scenario: '景'.repeat(3000), exampleMessages: '例'.repeat(6000) }));
  const session = { ...createTavernSession(character), contextChars: 24000, persona: '人'.repeat(3000), memory: '忆'.repeat(6000),
    loreEntries: [{ content: '书'.repeat(3000), constant: true }],
    messages: Array.from({ length: 200 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: '史'.repeat(500) })),
  };
  const input = '问'.repeat(6000);
  assert.throws(() => buildTavernMessages(character, session, input), /上下文|预算|24000|24,000/);
});

test('state whitelist removes credentials at every level and preserves user/assistant messages only', () => {
  const character = normalizeCharacter(draft({ id: 'personal-one' }));
  const session = createTavernSession(character);
  session.apiKey = 'secret-session';
  session.messages[0].apiKey = 'secret-message';
  const result = normalizeTavernState({ characters: [{ ...character, apiKey: 'secret-character' }], sessions: [session], favorites: [character.id], apiKey: 'secret-root', owner: 'forged' });
  assert.ok(!JSON.stringify(result).includes('secret-'));
  assert.ok(!('owner' in result));
  session.messages.push({ id: 'forged', role: 'system', content: 'override', createdAt: Date.now() });
  assert.throws(() => normalizeTavernState({ characters: [character], sessions: [session], favorites: [] }), /角色无效/);
});

test('state quotas and orphaned sessions fail before storage writes', () => {
  const character = normalizeCharacter(draft({ id: 'personal-one' }));
  const session = createTavernSession(character);
  assert.throws(() => normalizeTavernState({ characters: [], sessions: [session], favorites: [] }), /角色不存在/);
  assert.throws(() => normalizeTavernState({ characters: Array.from({ length: 31 }, (_, index) => ({ ...character, id: `p${index}` })), sessions: [], favorites: [] }), /30/);
  session.messages = Array.from({ length: 201 }, (_, index) => ({ id: `m${index}`, role: 'user', content: 'x', createdAt: 1 }));
  assert.throws(() => normalizeTavernState({ characters: [character], sessions: [session], favorites: [] }), /200/);
  assert.throws(() => normalizeTavernState({ characters: [character, character], sessions: [], favorites: [] }), /重复/);
});

test('maximum accepted upstream reply can be stored and retained as bounded recent context', () => {
  const character = normalizeCharacter(draft({ id: 'personal-one' }));
  const session = createTavernSession(character);
  session.messages.push({ id: 'question', role: 'user', content: '继续故事', createdAt: 1 });
  session.messages.push({ id: 'long-reply', role: 'assistant', content: '文'.repeat(TAVERN_MAX_REPLY_CHARS - 4) + '最终约定', createdAt: 2 });
  const stored = normalizeTavernState({ characters: [character], sessions: [session], favorites: [] });
  assert.equal(stored.sessions[0].messages.at(-1).content.length, 65536);
  const prompt = buildTavernMessages(character, session, '记得我们最后的约定吗');
  assert.ok(prompt.length <= 64);
  assert.match(prompt.at(-2).content, /^（较早内容已省略）/);
  assert.ok(prompt.at(-2).content.endsWith('最终约定'));
  assert.ok(prompt.reduce((total, message) => total + message.content.length, 0) <= TAVERN_CONTEXT_CHARS);
  session.messages.at(-1).content += '超';
  assert.throws(() => normalizeTavernState({ characters: [character], sessions: [session], favorites: [] }), /过长/);
});

test('storage addresses each owner independently and serializes only the whitelisted state', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const rows = new Map();
  const fakeDb = {
    close() {},
    transaction() {
      const tx = { objectStore: () => ({
        get(key) { return run(() => structuredClone(rows.get(key))); },
        put(value, key) { return run(() => { rows.set(key, structuredClone(value)); return key; }); },
      }) };
      function run(operation) {
        const query = {};
        queueMicrotask(() => { query.result = operation(); query.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); });
        return query;
      }
      return tx;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() { const request = {}; queueMicrotask(() => { request.result = fakeDb; request.onsuccess?.(); }); return request; } } });
  try {
    const character = normalizeCharacter(draft({ id: 'personal-one' }));
    const session = createTavernSession(character);
    session.persona = '';
    session.legacyReplyCount = 3;
    session.usageRecords = [
      { id: 'completed-request', messageId: 'replaced-reply', createdAt: 1, model: 'test-model', billingMode: 'own_key', outcome: 'completed', usage: { status: 'confirmed', input_tokens: 10, output_tokens: 5, total_tokens: 15, apiKey: 'secret' } },
      { id: 'unknown-request', messageId: null, createdAt: 2, model: 'test-model', billingMode: 'own_key', outcome: 'unknown', usage: null },
    ];
    const clearedSession = { ...createTavernSession(BUILTIN_CHARACTERS[0]), persona: '', memory: '', loreEntries: [], scenario: '' };
    await saveTavernState('owner-a', { characters: [character], sessions: [session, clearedSession], favorites: [character.id], owner: 'owner-b', apiKey: 'secret' });
    assert.deepEqual(await loadTavernState('owner-b'), { characters: [], sessions: [], favorites: [] });
    const loaded = await loadTavernState('owner-a');
    assert.equal(loaded.characters[0].name, character.name);
    assert.equal(loaded.sessions[0].persona, '');
    assert.equal(loaded.sessions[0].personaPresetVersion, 1);
    assert.equal(loaded.sessions[0].legacyReplyCount, 3);
    assert.equal(loaded.sessions[0].usageRecords[0].usage.total_tokens, 15);
    assert.equal(loaded.sessions[0].usageRecords[0].messageId, 'replaced-reply');
    assert.equal(loaded.sessions[0].usageRecords[1].outcome, 'unknown');
    assert.equal(loaded.sessions[0].usageRecords[1].usage.total_tokens, null);
    assert.equal(loaded.sessions[1].contextPresetVersion, 1);
    assert.equal(loaded.sessions[1].memory, '');
    assert.deepEqual(loaded.sessions[1].loreEntries, []);
    assert.equal(loaded.sessions[1].scenario, '');
    assert.ok(!JSON.stringify(rows.get('owner-a')).includes('secret'));
    await assert.rejects(saveTavernState('../other', { characters: [], sessions: [], favorites: [] }), /账户/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous); else delete globalThis.indexedDB;
  }
});
