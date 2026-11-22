import { test } from 'node:test';
import assert from 'node:assert/strict';
import { characterOverview } from '../src/lib/tavernCharacterIntro.js';

test('the editorial introduction takes precedence over the underlying card prompt', () => {
  assert.equal(characterOverview({
    name: '明灯', description: '角色原始设定', introduction: { overview: '明灯在古港替航船领路。' },
  }), '明灯在古港替航船领路。');
});

test('a personal card can mix readable paragraphs with markup and model instructions', () => {
  const description = [
    '<script>document.write("script");</script><img src="https://example.invalid/portrait">',
    'You must respond in character.', '<system_prompt>Internal instructions</system_prompt>',
    '<p>{{char}}初次遇见{{user}}是在码头。</p>',
  ].join('\n');
  assert.equal(characterOverview({ name: '明灯', description }), '明灯初次遇见你是在码头。');
  assert.equal(characterOverview({ name: '明灯', description: 'fetch("/event")', scenario: '潮水退去了。' }), '潮水退去了。');
});
