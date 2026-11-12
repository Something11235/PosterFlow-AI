import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminTavernTotalsStore } from '../src/lib/adminTavernTotals.js';

test('overview preloads once and reuses totals through tab switches', async () => {
  let finish, calls = 0;
  const store = createAdminTavernTotalsStore(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = store.load();
  const simultaneous = store.load();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(first, simultaneous);
  const result = { stats: { requests: 19, users: 3, credits_spent: '0.1054' } };
  finish(result); await first;
  const saved = store.getSnapshot().data;
  await store.load(); await store.load();
  assert.equal(store.getSnapshot().data, saved);
  assert.equal(calls, 1);
});

test('refresh keeps previous totals visible, failure is explicit and retry recovers', async () => {
  let fail = false, result;
  const old = { stats: { requests: 1 } }, fresh = { stats: { requests: 2 } };
  const store = createAdminTavernTotalsStore(() => fail ? Promise.reject(new Error('temporary outage')) : result || old);
  await store.load(); fail = true;
  const refresh = store.load({ force: true });
  assert.equal(store.getSnapshot().busy, true);
  assert.equal(store.getSnapshot().data, old);
  await refresh;
  assert.equal(store.getSnapshot().data, old);
  assert.equal(store.getSnapshot().error, 'temporary outage');
  assert.equal(store.getSnapshot().busy, false);
  fail = false; result = fresh;
  await store.load({ force: true });
  assert.equal(store.getSnapshot().data, fresh);
  assert.equal(store.getSnapshot().error, '');
});

test('a different account store cannot inherit cached totals or a late response', async () => {
  let finish;
  const old = createAdminTavernTotalsStore(() => new Promise(resolve => { finish = resolve; }));
  const current = createAdminTavernTotalsStore(async () => ({ stats: { requests: 0 } }));
  const pending = old.load(); await Promise.resolve(); await current.load();
  finish({ stats: { requests: 999 } }); await pending;
  assert.equal(current.getSnapshot().data.stats.requests, 0);
});
