import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTavernStatusBlocks, visibleTavernMessage } from '../src/lib/tavernStatusBlocks.js';
import { BUILTIN_CHARACTERS, buildTavernMessages, createTavernSession, exportCharacter } from '../src/lib/tavern.js';

test('only complete comments are hidden in the display; surrounding text, literal HTML and incomplete comments survive', () => {
  assert.equal(visibleTavernMessage('前<!-- a -->中<!-- \n\n b -->后<img src=x><!--未关闭'),
    '前中后<img src=x><!--未关闭');
  assert.equal(visibleTavernMessage('<!-- only -->'), '');
});

test('the RPG opening keeps its author note in the card, session and model payload while displaying all 15 statistics', () => {
  const character = BUILTIN_CHARACTERS.find(role => role.id === 'tavern-isekai-rpg');
  const session = createTavernSession(character), opening = session.messages[0].content;
  const comment = opening.match(/<!--[\s\S]+?-->/)?.[0];
  assert.ok(comment);
  const visible = visibleTavernMessage(opening);
  assert.equal(visible, opening.replace(comment, ''));
  assert.equal(splitTavernStatusBlocks(visible).find(section => section.fields).fields.length, 15);
  assert.ok(buildTavernMessages(character, session, '继续').some(message => message.content.includes(comment)));
  assert.ok(exportCharacter(character).data.first_mes.includes('<!--'));
});

test('fenced RPG status rows render between the original narrative and the next action', () => {
  const content = ['A new day.', '<stats>', '```', 'HP: 20/30 | MP: 6/8', '任务：打开箱子', 'Time: 07:30', '```', '</stats>', 'Choose a path.'].join('\r\n');
  assert.deepEqual(splitTavernStatusBlocks(content), [
    { text: 'A new day.\r\n' },
    { fields: [{ label: 'HP', value: '20/30' }, { label: 'MP', value: '6/8' }, { label: '任务', value: '打开箱子' }, { label: 'Time', value: '07:30' }] },
    { text: '\nChoose a path.' },
  ]);
});

test('arbitrary HTML and malformed or oversized status markup stays plain text', () => {
  for (const value of [
    '<stats><img src=x></stats>', '<stats onclick="bad()">\nHP: 3\n</stats>', '<stats>\nHP: 3',
    '<stats>\nhas no fields\n</stats>', '<stats>\n```javascript\nalert(1)\n```\n</stats>',
    '<stats>\nHP: ' + 'x'.repeat(9000) + '\n</stats>',
  ]) assert.equal(splitTavernStatusBlocks(value), null);
  const literal = '<img src=x onerror="bad()">';
  assert.deepEqual(splitTavernStatusBlocks(`<stats>\nName: ${literal}\n</stats>`), [{ fields: [{ label: 'Name', value: literal }] }]);
});
