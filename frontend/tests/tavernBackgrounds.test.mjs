import assert from 'node:assert/strict';
import test from 'node:test';
import { addTavernBackground, removeTavernBackground, normalizeTavernBackgrounds, tavernBackgroundStyle } from '../src/lib/tavernAppearance.js';
import { normalizeTavernState, saveTavernState, loadTavernState } from '../src/lib/tavernStorage.js';
import { buildTavernBackgroundPrompt } from '../src/lib/tavernBackgroundPrompt.js';
import { normalizeTavernUserAvatar } from '../src/lib/tavernUserAvatar.js';

const blank = () => ({ characters: [], sessions: [], favorites: [] });
const item = (id = 'one') => ({ id, name: '夜海', source: 'local', createdAt: 1, image: `data:image/jpeg;base64,${btoa(id)}` });

test('legacy single background migrates into the personal library with one image copy', () => {
  const original = { ...blank(), appearance: { preset: 'image', surface: 'glass', dim: 43, image: item().image } };
  const saved = normalizeTavernState(original);
  assert.equal(saved.backgrounds.length, 1);
  assert.equal(saved.backgrounds[0].image, original.appearance.image);
  assert.equal(saved.appearance.image, '');
  assert.equal(saved.appearance.backgroundId, saved.backgrounds[0].id);
  assert.equal(saved.appearance.surface, 'glass');
  assert.equal(JSON.stringify(saved).split(original.appearance.image).length, 2);
  assert.deepEqual(normalizeTavernState(saved), saved);
  assert.match(tavernBackgroundStyle(saved.appearance, saved.backgrounds).backgroundImage, /data:image\/jpeg/);
  assert.deepEqual(normalizeTavernState(blank()), blank());
});

test('library deduplicates source files and local image bytes without mutating the original archive', () => {
  const original = blank(), next = addTavernBackground(original, item());
  assert.deepEqual(original, blank());
  assert.equal(addTavernBackground(next.state, { ...item('two'), image: item().image }).background.id, 'one');
  const generated = { ...item('gen'), source: 'generated', sourceFilename: 'generated.png' };
  const state = addTavernBackground(next.state, generated).state;
  assert.equal(addTavernBackground(state, { ...item('replayed'), source: 'generated', sourceFilename: 'generated.png' }).background.id, 'gen');
  const full = { ...blank(), backgrounds: Array.from({ length: 20 }, (_, i) => item(`bg-${i}`)) };
  assert.throws(() => addTavernBackground(full, item('overflow')), /20/);
  assert.equal(addTavernBackground(full, item('bg-0')).background.id, 'bg-0');
});

test('deleting an active background safely resets only the scene and retains glass and dim settings', () => {
  const state = { ...blank(), backgrounds: [item(), item('two')], appearance: { preset: 'library', backgroundId: 'one', image: '', surface: 'glass', dim: 51 } };
  assert.equal(removeTavernBackground(state, 'two').appearance.backgroundId, 'one');
  const removed = normalizeTavernState(removeTavernBackground(state, 'one'));
  assert.deepEqual(removed.appearance, { preset: 'none', surface: 'glass', dim: 51, image: '' });
  assert.equal(removed.backgrounds[0].id, 'two');
  assert.equal(state.backgrounds.length, 2);
  assert.throws(() => normalizeTavernState({ ...blank(), appearance: state.appearance }), /不存在/);
});

test('library rejects unsafe or oversized data, shares the archive quota, and strips extra credentials', () => {
  for (const patch of [{ image: 'https://remote.invalid/image.png' }, { image: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { name: 'bad\0name' }, { id: '../id' }, { sourceFilename: '../secret.png' }, { createdAt: -1 }, { image: `data:image/jpeg;base64,${'A'.repeat(2*1024*1024)}` }]) {
    assert.throws(() => normalizeTavernBackgrounds([{ ...item(), ...patch }]));
  }
  const [saved] = normalizeTavernBackgrounds([{ ...item(), apiKey: 'must-not-save', remoteUrl: 'https://private.invalid', prompt: 'private scene' }]);
  assert.deepEqual(saved, item());
  const large = { ...blank(), backgrounds: Array.from({ length: 11 }, (_, i) => ({ ...item(`large-${i}`), image: `data:image/jpeg;base64,${'A'.repeat(2*1024*1024-100)}` })) };
  assert.throws(() => normalizeTavernState(large), /20 MB/);
});

test('background prompt uses bounded scene and recent story excerpts without a paid helper call or personality instructions', t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('No model call'); });
  const session = { scenario: '海边黄昏', memory: '旧摘要', summary: { text: '此刻在灯塔' },
    messages: [{ content: 'OLD_MESSAGE_EXCLUDED' }, ...Array.from({ length: 4 }, () => ({ content: '海风\0'.repeat(1000) }))], apiKey: 'never-reference',
    loreEntries:[{ id:'world',name:'世界',keys:[],content:'夜海中的蓝色灯塔',constant:true,enabled:true }] };
  const snapshot = structuredClone(session);
  const prompt = buildTavernBackgroundPrompt({ scenario: '原场景', personality: 'PRIVATE_PERSONALITY' }, session);
  assert.match(prompt, /海边黄昏/); assert.match(prompt, /此刻在灯塔/);
  assert.match(prompt, /夜海中的蓝色灯塔/);
  assert.match(prompt, /无人物、无文字、无水印/);
  for (const secret of ['OLD_MESSAGE_EXCLUDED','PRIVATE_PERSONALITY','never-reference','旧摘要','\0']) assert.ok(!prompt.includes(secret));
  assert.ok(prompt.length < 6000); assert.deepEqual(session, snapshot); assert.equal(fetch.mock.callCount(), 0);
  const escaped=buildTavernBackgroundPrompt({}, { scenario:'\\'.repeat(3000), memory:'\\'.repeat(6000), messages:Array.from({length:4},()=>({content:'\\'.repeat(1000)})) });
  assert.ok(escaped.length<=6000);
});

test('saved background libraries remain isolated by owner and survive reload', async t => {
  const rows = new Map();
  const db = { close() {}, transaction() {
    const tx = { objectStore: () => ({ get: owner => run(() => structuredClone(rows.get(owner))), put: (value,owner) => run(() => rows.set(owner,structuredClone(value))) }) };
    function run(action) { const q = {}; queueMicrotask(() => { q.result=action(); q.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); }); return q; }
    return tx;
  } };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
  Object.defineProperty(globalThis,'indexedDB',{ configurable:true,value:{ open() { const q={}; queueMicrotask(() => { q.result=db; q.onsuccess?.(); }); return q; } } });
  t.after(() => { if(descriptor) Object.defineProperty(globalThis,'indexedDB',descriptor); else delete globalThis.indexedDB; });
  const state = { ...addTavernBackground(blank(),item()).state, userAvatar:item().image, imageTemplates:{portrait:'我的专属肖像模板 {{char}}'} };
  await saveTavernState('owner-one',state);
  assert.deepEqual(await loadTavernState('owner-one'),state);
  assert.deepEqual(await loadTavernState('owner-two'),blank());
  assert.deepEqual(await loadTavernState('guest'),blank());
});

test('user avatars persist only bounded local image data and can be removed independently of the role avatar', () => {
  for(const avatar of ['https://remote.invalid/avatar.png','data:image/svg+xml;base64,AA==',`data:image/jpeg;base64,${'A'.repeat(512*1024)}`,null,{}]) assert.throws(() => normalizeTavernUserAvatar(avatar));
  const state=normalizeTavernState({ ...blank(),userAvatar:item().image });
  assert.equal(state.userAvatar,item().image);
  assert.equal(normalizeTavernState({ ...state,userAvatar:'' }).userAvatar,'');
  assert.deepEqual(state.characters,[]);
});
