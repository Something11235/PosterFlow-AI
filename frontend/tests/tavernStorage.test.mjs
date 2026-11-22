import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_CHARACTERS, DEFAULT_TAVERN_PERSONA, DEFAULT_TAVERN_MEMORY, DEFAULT_TAVERN_LORE_ENTRIES,
  createTavernSession, tavernStateBytes, TAVERN_MAX_REPLY_CHARS, parseCharacterFile, exportCharacter,
  normalizeCharacter, buildTavernMessages } from '../src/lib/tavern.js';
import { loadTavernState, normalizeTavernState, saveTavernState } from '../src/lib/tavernStorage.js';
import { createReplyVariant } from '../src/lib/tavernConversation.js';
import legacyOpenings from '../src/lib/tavernCards/legacyEnglishOpenings.json' with { type: 'json' };

const QUOTA = 20 * 1024 * 1024;

test('only the untouched English preset text is localized, once, without changing messages or accounting', async t => {
  const sessions = [];
  const expectations = [];
  const fill = (template, name) => template.replace(/\{\{(char|user)\}\}/gi, (_, macro) => macro.toLowerCase() === 'char' ? name : '你');
  for (const card of BUILTIN_CHARACTERS.filter(c => Object.hasOwn(legacyOpenings, c.id))) {
    const old = legacyOpenings[card.id];
    old.greetings.forEach((greeting, index) => {
      const session = createTavernSession(card, { greetingIndex: index - 1 });
      const expectedOpening = session.messages[0].content;
      delete session.builtinTextVersion;
      session.title = `与${old.name}的对话`;
      session.scenario = old.scenario;
      session.messages[0].content = fill(greeting, old.name);
      session.messages.push({ id: 'actual-user', role: 'user', content: 'My own words', createdAt: 1 },
        { id: 'actual-reply', role: 'assistant', content: fill(greeting, old.name), createdAt: 2 });
      const requestId = 'c5de1fe1-8e6b-4bbc-959a-4e869da2e93a';
      session.usageRecords = [{ id: requestId, messageId: 'actual-reply', createdAt: 2, model: 'a-model',
        billingMode: 'platform', outcome: 'completed', kind: 'chat',
        usage: { status: 'confirmed', input_tokens: 10, output_tokens: 2, total_tokens: 12, cache_read_tokens: 0, cache_miss_tokens: 10, reasoning_tokens: 0 },
        billing: { request_id: requestId, status: 'settled', reserved_credits: '0.1000', charged_credits: '0.0022' } }];
      sessions.push(session);
      expectations.push({ scenario: card.scenario, title: `与${card.name}的对话`, opening: expectedOpening });
      const edited = structuredClone(session);
      edited.id += '-fork';
      edited.sourceSessionId = session.id;
      edited.titleEdited = true;
      edited.scenario += '\nA custom sentence.';
      edited.messages[0].content += '\nMy branch opening.';
      sessions.push(edited);
      expectations.push({ scenario: edited.scenario, title: edited.title, opening: edited.messages[0].content });
      const fork = structuredClone(session);
      fork.id += '-default-fork';
      fork.sourceSessionId = session.id;
      fork.title += ' · 分支';
      sessions.push(fork);
      expectations.push({ scenario: card.scenario, title: `与${card.name}的对话 · 分支`, opening: expectedOpening });
      if (session.title.length <= 24) {
        const namedByFirstMessage = structuredClone(session);
        namedByFirstMessage.id += '-user-title';
        namedByFirstMessage.messages[1].content = namedByFirstMessage.title;
        sessions.push(namedByFirstMessage);
        expectations.push({ scenario: card.scenario, title: namedByFirstMessage.title, opening: expectedOpening });
      }
    });
  }
  const original = { characters: [], sessions, favorites: [] };
  const store = mockStore(t, new Map([['localized-owner', structuredClone(original)]]));
  const upgraded = await loadTavernState('localized-owner');
  upgraded.sessions.forEach((session, index) => {
    const old = sessions[index], expected = expectations[index];
    assert.equal(session.id, old.id);
    assert.equal(session.builtinTextVersion, 1);
    assert.equal(session.title, expected.title);
    assert.equal(session.scenario, expected.scenario);
    assert.deepEqual(session.messages[0], { ...old.messages[0], content: expected.opening });
    assert.deepEqual(session.messages.slice(1), old.messages.slice(1));
    assert.deepEqual(session.usageRecords, old.usageRecords);
  });
  await saveTavernState('localized-owner', upgraded);
  assert.deepEqual(store.rows.get('localized-owner'), upgraded);
  assert.deepEqual(await loadTavernState('localized-owner'), upgraded);
  const editedLater = structuredClone(upgraded);
  editedLater.sessions[0].scenario = sessions[0].scenario;
  assert.deepEqual(normalizeTavernState(editedLater), editedLater);
});

function mockStore(t, rows = new Map()) {
  let writes = 0;
  const database = {
    close() {},
    transaction() {
      const transaction = { objectStore: () => ({
        get(owner) { return run(() => structuredClone(rows.get(owner))); },
        put(value, owner) { return run(() => { writes++; rows.set(owner, structuredClone(value)); return owner; }); },
      }) };
      function run(operation) {
        const request = {};
        queueMicrotask(() => { request.result = operation(); request.onsuccess?.(); queueMicrotask(() => transaction.oncomplete?.()); });
        return request;
      }
      return transaction;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() {
    const request = {};
    queueMicrotask(() => { request.result = database; request.onsuccess?.(); });
    return request;
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'indexedDB', previous); else delete globalThis.indexedDB; });
  return { rows, get writes() { return writes; } };
}

test('card metadata survives normalize save load export without executing HTML or dropping whitespace and empty openings', async t => {
  const store = mockStore(t);
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('No remote card assets may load'); });
  const data = {
    id: 'synthetic-standard-card', name: 'Synthetic', description: ` \n${'D'.repeat(6610)} FULL_DESCRIPTION_END \t`,
    personality: ' \nPersonality\t ', scenario: ' \nScene\t ', first_mes: ' \nHello {{USER}} from {{CHAR}}\t ',
    mes_example: ' \nExample text\t ', creator_notes: ' \n<img src="https://public.invalid/never-load.png"><script>globalThis.syntheticAuthorExecuted = true</script>\t ',
    creator: ' Author \t', character_version: ' v2 \n', system_prompt: ' \nSystem text\t ', post_history_instructions: ' \nTail text\t ',
    alternate_greetings: ['', '  Second opening {{user}}\n', '', ' \t '], tags: ['duplicate', '', 'duplicate', ...Array.from({ length: 14 }, (_, index) => `tag-${index}`)],
    extensions: { depth_prompt: { depth: 4, prompt: ' \nINERT_DEPTH_METADATA\t ', role: 'assistant' }, unsupported_script: 'never execute' },
    apiKey: 'synthetic-key-must-not-persist',
  };
  const snapshot = structuredClone(data);
  const card = await parseCharacterFile(new Blob([JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data })], { type: 'application/json' }));
  const session = createTavernSession(card);
  const original = { characters: [card], sessions: [session], favorites: [card.id] };
  const normalized = normalizeTavernState(original);
  await saveTavernState('card-owner', normalized);
  const restored = await loadTavernState('card-owner');
  const exported = exportCharacter(restored.characters[0]);
  for (const field of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes',
    'creator', 'character_version', 'system_prompt', 'post_history_instructions', 'alternate_greetings', 'tags']) {
    assert.deepEqual(exported.data[field], data[field], `verbatim persisted field: ${field}`);
  }
  assert.deepEqual(exported.data.extensions.depth_prompt, data.extensions.depth_prompt);
  assert.deepEqual(data, snapshot);
  assert.deepEqual(restored, normalized);
  assert.equal(store.writes, 1);
  const serialized = JSON.stringify(store.rows.get('card-owner'));
  assert.ok(!serialized.includes('synthetic-key-must-not-persist'));
  assert.ok(!serialized.includes('unsupported_script'));
  assert.equal(globalThis.syntheticAuthorExecuted, undefined);
  assert.equal(fetch.mock.callCount(), 0);
  const prompt = buildTavernMessages(restored.characters[0], restored.sessions[0], 'Continue');
  assert.ok(prompt[0].content.includes(data.description));
  assert.ok(!prompt[0].content.includes('syntheticAuthorExecuted'));
  assert.ok(!prompt[0].content.includes('INERT_DEPTH_METADATA'));
  assert.ok(restored.sessions[0].messages[0].content.includes('Hello 你 from Synthetic'));
});

test('new character metadata migration can recover old near-quota archives without bypassing write limits', async t => {
  const character = normalizeCharacter({ id: 'legacy-personal-card', name: 'Synthetic', description: 'Old character' });
  for (const field of ['creatorNotes', 'creator', 'characterVersion', 'systemPrompt', 'postHistoryInstructions', 'alternateGreetings', 'depthPrompt']) delete character[field];
  const session = { ...createTavernSession(character), persona: '', memory: '', loreEntries: [] };
  session.messages = Array.from({ length: 107 }, (_, index) => ({ id: `character-legacy-${index}`, role: 'assistant',
    content: index < 106 ? '文'.repeat(TAVERN_MAX_REPLY_CHARS) : '', createdAt: index }));
  const original = { characters: [character], sessions: [session], favorites: [] };
  const remaining = QUOTA - 64 - tavernStateBytes(original);
  assert.ok(remaining > 0 && remaining <= TAVERN_MAX_REPLY_CHARS * 3);
  session.messages.at(-1).content = '文'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
  assert.equal(tavernStateBytes(original), QUOTA - 64);
  const store = mockStore(t, new Map([['legacy-card-owner', original]]));
  const loaded = await loadTavernState('legacy-card-owner');
  assert.ok(tavernStateBytes(loaded) > QUOTA);
  assert.equal(loaded.characters[0].creatorNotes, '');
  assert.deepEqual(loaded.characters[0].alternateGreetings, []);
  assert.equal(loaded.characters[0].depthPrompt, null);
  assert.equal(store.writes, 0);
  assert.deepEqual(loaded.sessions[0].messages, original.sessions[0].messages);
  await assert.rejects(saveTavernState('legacy-card-owner', loaded), /20 MB/);
  assert.equal(store.writes, 0);
  const oversized = structuredClone(original);
  oversized.sessions[0].messages.at(-1).content += 'x'.repeat(128);
  store.rows.set('already-oversized', oversized);
  await assert.rejects(loadTavernState('already-oversized'), /20 MB/);
  loaded.sessions[0].messages.pop();
  await saveTavernState('legacy-card-owner', loaded);
  assert.equal(store.writes, 1);
  const again = await loadTavernState('legacy-card-owner');
  assert.equal(again.characters[0].creatorNotes, '');
  assert.ok(tavernStateBytes(again) <= QUOTA);
});

test('conversation context, summary snapshots and reply variants save and reload using strict whitelists', async t => {
  const store = mockStore(t);
  const session = createTavernSession(BUILTIN_CHARACTERS[0]);
  session.contextChars = 96000;
  session.autoMemory = true;
  session.sourceSessionId = 'original-session';
  session.summary = { text: ' \nAutomatic memory\t ', throughMessageId: 'old-nonactive-boundary', createdAt: 2, apiKey: 'summary-secret' };
  session.summaryHistory = [null, { text: 'Previous memory', throughMessageId: 'also-old-boundary', createdAt: 1, endpoint: 'history-secret' }];
  const previous = { id: 'old-reply', role: 'assistant', content: ' Old reply ', createdAt: 1 };
  const current = createReplyVariant(previous, { id: 'new-reply', role: 'assistant', content: ' New reply ', createdAt: 2 });
  current.alternatives[0].apiKey = 'variant-secret';
  current.apiKey = 'message-secret';
  session.messages.push(current);
  session.usageRecords = [{ id: 'summary-request', messageId: null, createdAt: 2, model: 'test-model', billingMode: 'own_key', outcome: 'completed', kind: 'summary', usage: null }];
  await saveTavernState('conversation-owner', { characters: [], sessions: [session], favorites: [] });
  const restored = (await loadTavernState('conversation-owner')).sessions[0];
  assert.equal(Object.hasOwn(restored, 'contextChars'), false);
  assert.equal(restored.autoMemory, true);
  assert.equal(restored.sourceSessionId, session.sourceSessionId);
  assert.equal(restored.summary.text, session.summary.text);
  assert.equal(restored.summary.throughMessageId, 'old-nonactive-boundary');
  assert.equal(restored.summaryHistory.length, 2);
  assert.equal(restored.summaryHistory[0], null);
  assert.equal(restored.messages.at(-1).alternatives.length, 2);
  assert.equal(restored.messages.at(-1).alternatives[0].content, ' Old reply ');
  assert.equal(restored.usageRecords[0].kind, 'summary');
  assert.ok(!JSON.stringify(store.rows.get('conversation-owner')).includes('secret'));
  const old = structuredClone(restored);
  for (const field of ['contextChars', 'autoMemory', 'summary', 'summaryHistory']) delete old[field];
  delete old.usageRecords[0].kind;
  const migrated = normalizeTavernState({ characters: [], sessions: [old], favorites: [] }).sessions[0];
  assert.equal(Object.hasOwn(migrated, 'contextChars'), false);
  assert.equal(migrated.autoMemory, false);
  assert.equal(migrated.summary, null);
  assert.deepEqual(migrated.summaryHistory, []);
  assert.equal(migrated.usageRecords[0].kind, 'chat');
});

test('summary and context schema rejects malformed boundaries, oversized history and unsupported modes', () => {
  const base = createTavernSession(BUILTIN_CHARACTERS[0]);
  const normalize = patch => normalizeTavernState({ characters: [], sessions: [{ ...base, ...patch }], favorites: [] });
  for (const contextChars of [null, '24000', 4000, 48000, 120000, 120001]) {
    assert.equal(Object.hasOwn(normalize({ contextChars }).sessions[0], 'contextChars'), false);
  }
  for (const autoMemory of [null, 0, 1, 'true']) assert.throws(() => normalize({ autoMemory }), /开关/);
  const valid = { text: 'x', throughMessageId: 'safe-boundary', createdAt: 1 };
  for (const summary of [[], '', { ...valid, text: '' }, { ...valid, text: ' \n ' }, { ...valid, text: 'x'.repeat(6001) },
    { ...valid, throughMessageId: '../escape' }, { ...valid, throughMessageId: 3 }, { ...valid, createdAt: -1 }, { ...valid, createdAt: true }]) {
    assert.throws(() => normalize({ summary }));
  }
  assert.equal(normalize({ summary: { ...valid, text: 'x'.repeat(6000) } }).sessions[0].summary.text.length, 6000);
  for (const summaryHistory of [null, {}, Array(6).fill(null), [undefined], [false], [{ ...valid, text: '' }]]) assert.throws(() => normalize({ summaryHistory }));
  assert.equal(normalize({ summaryHistory: Array(5).fill(valid) }).sessions[0].summaryHistory.length, 5);
  for (const sourceSessionId of [null, '', 1, '../escape']) assert.throws(() => normalize({ sourceSessionId }));
});

test('reply variant storage enforces active-body consistency, unique ids and assistant-only nesting', () => {
  const base = createTavernSession(BUILTIN_CHARACTERS[0]);
  const first = { id: 'a-1', role: 'assistant', content: 'First', createdAt: 1 };
  const second = { id: 'a-2', role: 'assistant', content: 'Second', createdAt: 2 };
  const current = createReplyVariant(first, second);
  const normalize = messages => normalizeTavernState({ characters: [], sessions: [{ ...base, messages }], favorites: [] });
  for (const message of [
    { ...current, content: 'Different active body' }, { ...current, createdAt: 3 },
    { ...current, alternatives: [...current.alternatives, current.alternatives[0]] },
    { ...current, alternatives: Array.from({ length: 11 }, (_, index) => ({ id: `v-${index}`, content: 'x', createdAt: index })) },
    { ...current, alternatives: null }, { ...current, role: 'user' },
    { ...current, alternatives: [{ id: 'a-2', content: 'x'.repeat(65537), createdAt: 2 }] },
    { ...current, alternatives: [{ id: 'a-2', content: 'Second', createdAt: true }] },
  ]) assert.throws(() => normalize([message]));
  assert.throws(() => normalize([{ id: 'a-1', role: 'user', content: 'Collision with inactive variant', createdAt: 1 }, current]), /重复/);
  const stored = normalize([current]).sessions[0].messages[0];
  assert.deepEqual(stored, current);
  assert.notEqual(stored.alternatives, current.alternatives);
});

test('new conversation defaults and legacy usage kinds can grow a compliant archive only during loading', async t => {
  const state = nearQuotaLegacyState();
  const current = state.sessions[0];
  current.personaPresetVersion = 1;
  current.contextPresetVersion = 1;
  current.scenario = '';
  for (const field of ['contextChars', 'autoMemory', 'summary', 'summaryHistory']) delete current[field];
  current.usageRecords = [{ id: 'old-request', messageId: null, createdAt: 1, model: 'test-model', billingMode: 'own_key', outcome: 'unknown', usage: null }];
  current.messages.at(-1).content = '';
  const remaining = QUOTA - 64 - tavernStateBytes(state);
  current.messages.at(-1).content = '文'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
  assert.equal(tavernStateBytes(state), QUOTA - 64);
  const store = mockStore(t, new Map([['legacy-conversation-owner', state]]));
  const loaded = await loadTavernState('legacy-conversation-owner');
  assert.ok(tavernStateBytes(loaded) > QUOTA);
  assert.equal(Object.hasOwn(loaded.sessions[0], 'contextChars'), false);
  assert.equal(loaded.sessions[0].autoMemory, false);
  assert.equal(loaded.sessions[0].summary, null);
  assert.equal(loaded.sessions[0].usageRecords[0].kind, 'chat');
  assert.equal(store.writes, 0);
  await assert.rejects(saveTavernState('legacy-conversation-owner', loaded), /20 MB/);
  loaded.sessions[0].messages.pop();
  await saveTavernState('legacy-conversation-owner', loaded);
  assert.equal(store.writes, 1);
});

function nearQuotaLegacyState() {
  const session = { ...createTavernSession(BUILTIN_CHARACTERS[0]), persona: '', memory: '', loreEntries: [] };
  for (const field of ['personaPresetVersion', 'contextPresetVersion', 'scenario']) delete session[field];
  session.messages = Array.from({ length: 107 }, (_, index) => ({ id: `legacy-${index}`, role: 'assistant',
    content: index < 106 ? '文'.repeat(TAVERN_MAX_REPLY_CHARS) : '', createdAt: index }));
  const state = { characters: [], sessions: [session], favorites: [] };
  const remaining = QUOTA - 64 - tavernStateBytes(state);
  assert.ok(remaining > 0 && remaining <= TAVERN_MAX_REPLY_CHARS * 3);
  session.messages.at(-1).content = '文'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
  assert.equal(tavernStateBytes(state), QUOTA - 64);
  return state;
}

test('loading may recover compliant legacy data expanded by migration, while writes stay within the quota', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const original = nearQuotaLegacyState();
  const rows = new Map([['legacy-owner', original]]);
  let writes = 0;
  const database = {
    close() {},
    transaction() {
      const transaction = { objectStore: () => ({
        get(owner) { return run(() => structuredClone(rows.get(owner))); },
        put(value, owner) { return run(() => { writes++; rows.set(owner, structuredClone(value)); return owner; }); },
      }) };
      function run(operation) {
        const request = {};
        queueMicrotask(() => { request.result = operation(); request.onsuccess?.(); queueMicrotask(() => transaction.oncomplete?.()); });
        return request;
      }
      return transaction;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() {
    const request = {};
    queueMicrotask(() => { request.result = database; request.onsuccess?.(); });
    return request;
  } } });
  try {
    const migrated = await loadTavernState('legacy-owner');
    assert.ok(tavernStateBytes(migrated) > QUOTA);
    assert.equal(migrated.sessions[0].persona, DEFAULT_TAVERN_PERSONA);
    assert.equal(migrated.sessions[0].memory, DEFAULT_TAVERN_MEMORY);
    assert.deepEqual(migrated.sessions[0].loreEntries, DEFAULT_TAVERN_LORE_ENTRIES);
    assert.deepEqual(migrated.sessions[0].messages, original.sessions[0].messages);
    assert.equal(writes, 0);
    assert.equal(rows.get('legacy-owner'), original);
    assert.throws(() => normalizeTavernState(original), /20 MB/);
    assert.throws(() => normalizeTavernState(migrated), /20 MB/);
    await assert.rejects(saveTavernState('legacy-owner', migrated), /20 MB/);
    assert.equal(writes, 0);

    // An already oversized stored document cannot use the migration exception.
    const oversizedLegacy = structuredClone(original);
    oversizedLegacy.sessions[0].messages.at(-1).content += 'x'.repeat(128);
    rows.set('oversized-owner', oversizedLegacy);
    await assert.rejects(loadTavernState('oversized-owner'), /20 MB/);
    rows.set('already-migrated-owner', migrated);
    await assert.rejects(loadTavernState('already-migrated-owner'), /20 MB/);

    // The recovered state is editable: removing data allows an ordinary save.
    migrated.sessions[0].messages.pop();
    assert.ok(tavernStateBytes(migrated) < QUOTA);
    await saveTavernState('legacy-owner', migrated);
    assert.equal(writes, 1);
    const restored = await loadTavernState('legacy-owner');
    assert.equal(restored.sessions[0].messages.length, 106);
    assert.equal(restored.sessions[0].contextPresetVersion, 1);
    assert.equal(restored.sessions[0].personaPresetVersion, 1);
    assert.equal(restored.sessions[0].scenario, BUILTIN_CHARACTERS[0].scenario);
    assert.ok(tavernStateBytes(restored) <= QUOTA);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous); else delete globalThis.indexedDB;
  }
});


test('renamed and pinned stories survive reload without changing messages or other owners', async t => {
  mockStore(t);
  const character = BUILTIN_CHARACTERS[0];
  const first = { ...createTavernSession(character), title: '海边的长故事', titleEdited: true, pinned: true, contextChars: 24000 };
  const second = createTavernSession(character);
  await saveTavernState('story-owner', { characters: [], sessions: [first, second], favorites: [] });
  const saved = await loadTavernState('story-owner');
  assert.equal(saved.sessions[0].title, first.title);
  assert.equal(saved.sessions[0].titleEdited, true);
  assert.equal(saved.sessions[0].pinned, true);
  assert.equal(Object.hasOwn(saved.sessions[0], 'contextChars'), false);
  assert.equal(Object.hasOwn(saved.sessions[1], 'contextChars'), false);
  assert.deepEqual(saved.sessions[0].messages, first.messages);
  assert.equal((await loadTavernState('another-owner')).sessions.length, 0);
});
