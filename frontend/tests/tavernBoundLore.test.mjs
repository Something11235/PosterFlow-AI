import assert from 'node:assert/strict';
import test from 'node:test';
import { activeLoreEntries, buildTavernMessages, createTavernSession, exportCharacter, normalizeCharacter } from '../src/lib/tavern.js';
import { buildTavernAssistMessages } from '../src/lib/tavernAssist.js';
import { buildTavernBackgroundPrompt } from '../src/lib/tavernBackgroundPrompt.js';
import { characterForExport } from '../src/lib/tavernExport.js';
import { buildTavernImagePrompt } from '../src/lib/tavernImageTemplates.js';

const role = normalizeCharacter({ id: 'book-reader', name: 'Reader', firstMessage: '', loreEntries: [
  { id: 'same-id', name: 'Local', content: 'SESSION_ONLY', constant: true },
] });
const entry = (content, flags = {}) => ({ id: 'same-id', name: 'Setting', content, keys: [], enabled: true, constant: true, ...flags });
const book = (id, entries, characterIds = [role.id]) => ({ id, name: id, entries, characterIds });

test('bound books take effect in existing chats and pictures and stay separate from the saved session and card', () => {
  const session = createTavernSession(role);
  session.messages = [{ role: 'user', content: 'Look at the beacon' }];
  const original = structuredClone(session);
  const character = { ...role, boundLorebooks: [
    book('coast', [entry('BOUND_COAST', { constant: false, keys: ['beacon'] })]),
    book('winter', [entry('BOUND_SNOW'), entry('DISABLED', { enabled: false }), entry('NO_MATCH', { constant: false, keys: ['unused'] })]),
    book('other', [entry('ANOTHER_CHARACTER')], ['other-character']),
  ] };
  const chat = buildTavernMessages(character, session, 'Continue');
  const assist = buildTavernAssistMessages(character, session, 'Continue');
  for (const text of [chat[0].content, assist[1].content, buildTavernImagePrompt('scene', character, session), buildTavernBackgroundPrompt(character, session)]) {
    for (const needle of ['SESSION_ONLY', 'BOUND_COAST', 'BOUND_SNOW']) assert.ok(text.includes(needle), needle);
    for (const needle of ['DISABLED', 'NO_MATCH', 'ANOTHER_CHARACTER']) assert.ok(!text.includes(needle), needle);
  }
  assert.ok(!buildTavernMessages(role, session, 'Continue')[0].content.includes('BOUND_COAST'));
  assert.deepEqual(session, original);
  assert.deepEqual(createTavernSession(character).loreEntries, role.loreEntries);
  assert.deepEqual(exportCharacter(character), exportCharacter(role));
  assert.deepEqual(exportCharacter(characterForExport(character, session)), exportCharacter(role));
});

test('entry count and IDs are scoped to individual books and every matched entry is sent intact to both chat and assist', () => {
  const books = ['A','B'].map(prefix => book(prefix, Array.from({ length: 25 }, (_, n) => ({
    ...entry(prefix + n), id: 'same-' + n,
  }))));
  const character = { ...role, boundLorebooks: books };
  const session = createTavernSession(role);
  assert.equal(activeLoreEntries(session.loreEntries, [], '', character).length, 51);
  books[0].entries[0].content = 'left' + 'a'.repeat(30000);
  books[1].entries[0].content = 'right' + 'b'.repeat(30000);
  const included = activeLoreEntries(session.loreEntries, [], '', character);
  assert.equal(included.length, 51);
  const chat = buildTavernMessages(character, session, 'go');
  const assist = buildTavernAssistMessages(character, session, 'go');
  const reference = JSON.parse(assist[1].content.slice(assist[1].content.indexOf('\n') + 1));
  for (const item of books.flatMap(book => book.entries)) {
    assert.ok(included.some(entry => entry.content === item.content));
    assert.ok(chat[0].content.includes(item.content));
    assert.ok(reference.includes(item.content));
  }
});
