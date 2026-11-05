import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { deletePersonalStylePrompt, personalStylePrompts, savePersonalStylePrompt } from '../src/lib/personalStylePrompts.js';

const styles = JSON.parse(readFileSync(new URL('../src/lib/stylePromptsCatalog.json', import.meta.url), 'utf8'));

test('style prompt catalog has unique choices and complete public preview assets', () => {
  assert.equal(styles.length, 15);
  assert.equal(new Set(styles.map(style => style.id)).size, styles.length);
  assert.equal(new Set(styles.map(style => style.name)).size, styles.length);
  for (const style of styles) {
    assert.ok(style.name.trim());
    assert.ok(style.prompt.trim());
    assert.ok(style.prompt.length <= 6000);
    assert.equal(typeof style.requiresReference, 'boolean');
    assert.doesNotMatch(JSON.stringify(style), /!\[\[|[A-Z]:[\\/]|minote_type|created:/);
    assert.match(style.image.url, /^\/style-prompts\/style-\d{2}\.webp$/);
    const file = new URL(`../public${style.image.url}`, import.meta.url);
    assert.equal(statSync(file).size, style.image.bytes);
    const bytes = readFileSync(file);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
    assert.ok(style.image.width > 0 && style.image.width <= 1280);
    assert.ok(style.image.height > 0 && style.image.height <= 1280);
  }
});

test('prompts requiring uploaded reference images remain clearly identified', () => {
  assert.deepEqual(styles.filter(style => style.requiresReference).map(style => style.name), ['收藏版史诗叙事海报', '儿童蜡笔涂鸦']);
  assert.match(styles.find(style => style.name === '黑蓝红三色').prompt, /\[背景颜色/);
  assert.match(styles.find(style => style.name === '波普+水墨喷溅').prompt, /\[在此处替换/);
});

test('personal style writes reject built-in IDs, invalid input and missing identities before storage access', async () => {
  await assert.rejects(deletePersonalStylePrompt('user-a', 'style-01'), /内置风格不能删除/);
  await assert.rejects(savePersonalStylePrompt('user-a', { id: 'style-01', name: 'change builtin', prompt: 'text' }), /只能修改自己的风格/);
  await assert.rejects(savePersonalStylePrompt('user-a', { name: ' ', prompt: 'text' }), /风格名称/);
  await assert.rejects(savePersonalStylePrompt('user-a', { name: 'x'.repeat(81), prompt: 'text' }), /风格名称/);
  await assert.rejects(savePersonalStylePrompt('user-a', { name: 'style', prompt: ' ' }), /提示词/);
  await assert.rejects(savePersonalStylePrompt('user-a', { name: 'style', prompt: 'x'.repeat(6001) }), /提示词/);
  await assert.rejects(personalStylePrompts(''), /刷新页面/);
  await assert.rejects(savePersonalStylePrompt('', { name: 'style', prompt: 'text' }), /刷新页面/);
});
