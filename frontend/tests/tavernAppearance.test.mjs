import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TAVERN_APPEARANCE, normalizeTavernAppearance, tavernBackgroundStyle } from '../src/lib/tavernAppearance.js';
import { normalizeTavernState } from '../src/lib/tavernStorage.js';

test('appearance persists only allowed local settings and does not inflate old archives', () => {
  const original = { characters: [], sessions: [], favorites: [] };
  assert.deepEqual(normalizeTavernState(original), original);
  const appearance = { ...DEFAULT_TAVERN_APPEARANCE, preset: 'ocean', surface: 'glass', dim: 42 };
  const saved = normalizeTavernState({ ...original, appearance: { ...appearance, apiKey: 'discard', url: 'https://untrusted.invalid' } });
  assert.deepEqual(saved.appearance, appearance);
  assert.match(tavernBackgroundStyle(appearance).backgroundImage, /0.42/);
  assert.ok(!tavernBackgroundStyle(appearance).backgroundImage.includes('untrusted'));
});

test('appearance rejects remote backgrounds, executable data and invalid controls', () => {
  for (const patch of [{ preset: 'unknown' }, { surface: 'unknown' }, { dim: -1 }, { dim: 81 }, { dim: '35' },
    { preset: 'image', image: '' }, { preset: 'image', image: 'https://remote.invalid/image.png' },
    { preset: 'image', image: 'data:image/svg+xml;base64,PHN2Zz4=' }, { preset: 'image', image: 'data:image/png;base64,a'.repeat(100000) }]) {
    assert.throws(() => normalizeTavernAppearance({ ...DEFAULT_TAVERN_APPEARANCE, ...patch }));
  }
  for (const surface of ['solid', 'glass', 'none']) assert.equal(normalizeTavernAppearance({ surface }).surface, surface);
});
