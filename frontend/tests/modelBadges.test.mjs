import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DEFAULT_MODEL_BADGES, parseModelBadges, publishModelBadges, refreshModelBadges, useModelBadges} from '../src/lib/modelBadges.js';

function currentSnapshot() {
  let snapshot;
  function Probe() { snapshot = useModelBadges(); return null; }
  renderToStaticMarkup(React.createElement(Probe));
  return snapshot;
}

test('only the two GPT Image 2.6 variants are hot and the three Seedream models are new', () => {
  assert.deepEqual(Object.entries(DEFAULT_MODEL_BADGES).filter(([,v]) => v === 'hot').map(([id]) => id), ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']);
  assert.deepEqual(Object.entries(DEFAULT_MODEL_BADGES).filter(([,v]) => v === 'new').map(([id]) => id), ['seedream-5-0-pro', 'seedream-5-0-lite', 'seedream-5-0-flash']);
});
test('parser permits explicit removal, fills newly added models, and strips private fields', () => {
  const result = parseModelBadges({revision: 2, badges: {'seedream-5-0-pro': ''}, updated_by: 'private'});
  assert.equal(result.badges['seedream-5-0-pro'], '');
  assert.equal(result.badges['seedream-5-0-lite'], 'new');
  assert.deepEqual(Object.keys(result), ['revision', 'badges']);
});
test('only fixed badge values and valid revisions are accepted', () => {
  for (const data of [{revision: -1, badges: {}}, {revision: 1.2, badges: {}}, {revision: 1, badges: []}, {revision: 1, badges: 'bad'}, {revision: 1, badges: {'seedream-5-0-pro': '<script>'}}]) assert.throws(() => parseModelBadges(data));
  for (const value of [null, ['new'], true, 1]) assert.throws(() => parseModelBadges({revision: 1, badges: {'seedream-5-0-pro': value}}));
});
test('public refresh is credential free, single flight, and failure leaves the store intact', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async (url, options) => { calls++; assert.equal(url, '/api/model-badges'); assert.equal(options.credentials, 'omit'); return {ok: true, json: async () => ({revision: 3, badges: DEFAULT_MODEL_BADGES})}; };
  try {
    await Promise.all([refreshModelBadges(), refreshModelBadges()]);
    assert.equal(calls, 1);
    publishModelBadges({revision: 4, badges: {...DEFAULT_MODEL_BADGES, 'seedream-5-0-pro': ''}});
    publishModelBadges({revision: 3, badges: DEFAULT_MODEL_BADGES});
    assert.equal(currentSnapshot().revision, 4);
    assert.equal(currentSnapshot().badges['seedream-5-0-pro'], '');
    global.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(refreshModelBadges(), /offline/);
    assert.equal(currentSnapshot().badges['seedream-5-0-pro'], '');
  } finally { global.fetch = original; }
});
