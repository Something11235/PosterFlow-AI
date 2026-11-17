import test from 'node:test';
import assert from 'node:assert/strict';
import { adminReferralPath, createAdminReferralStore, referralBeijingTime, referralMember, referralRecordStatus } from '../src/lib/adminReferrals.js';

const response = (id = 'fixture') => ({ success: true, totals: { inviter_count: 2, invitee_count: 5, redemption_count: 3, redeemed_credits: '210', reward_credits: '21' }, records: [{ id }], total_count: 25, has_more: true });

test('admin referral query encodes both-party search and bounds pagination without date filters', () => {
  const url = new URL(adminReferralPath({ view: 'rewards', search: '  姓名+tag@example.invalid & 123  ', page: 2 }), 'https://fixture.invalid');
  assert.equal(url.pathname, '/admin');
  assert.equal(url.searchParams.get('view'), 'rewards');
  assert.equal(url.searchParams.get('search'), '姓名+tag@example.invalid & 123');
  assert.equal(url.searchParams.get('limit'), '20');
  assert.equal(url.searchParams.get('offset'), '40');
  assert.equal(url.searchParams.has('from'), false);
  for (const query of [{ view: 'users' }, { page: -1 }, { page: 1.5 }, { page: 50001 }, { search: 'a'.repeat(121) }]) assert.throws(() => adminReferralPath(query));
});

test('editing search is local; Query commits search and pagination resets while totals remain global', async () => {
  const calls = [], headers = { Authorization: 'Bearer synthetic-admin' };
  const store = createAdminReferralStore(headers, async (path, options) => { calls.push({ path, options }); return response(); });
  await store.start(); assert.equal(calls.length, 1);
  store.setDraft('  用户昵称  '); assert.equal(calls.length, 1); assert.equal(store.getSnapshot().search, '');
  await store.setPage(1); assert.equal(new URL(calls.at(-1).path, 'https://fixture.invalid').searchParams.get('search'), '');
  await store.query(); assert.equal(store.getSnapshot().page, 0); assert.equal(store.getSnapshot().search, '用户昵称');
  assert.equal(new URL(calls.at(-1).path, 'https://fixture.invalid').searchParams.get('offset'), '0');
  assert.equal(new URL(calls.at(-1).path, 'https://fixture.invalid').searchParams.get('search'), '用户昵称');
  assert.equal(store.getSnapshot().data.totals.reward_credits, '21'); assert.equal(calls[0].options.authHeaders, headers);
  store.dispose();
});

test('tabs and refresh keep applied search rather than silently applying a draft', async () => {
  const calls = [];
  const store = createAdminReferralStore({}, async path => { calls.push(new URL(path, 'https://fixture.invalid')); return response(); });
  await store.start(); store.setDraft('已查询用户'); await store.query(); await store.setPage(1);
  store.setDraft('未查询草稿'); await store.setView('rewards');
  assert.equal(store.getSnapshot().page, 0); assert.equal(calls.at(-1).searchParams.get('view'), 'rewards'); assert.equal(calls.at(-1).searchParams.get('search'), '已查询用户');
  await store.refresh(); assert.equal(calls.at(-1).searchParams.get('search'), '已查询用户');
  store.dispose();
});

test('obsolete tab responses cannot overwrite current records, even if transport ignores abort', async () => {
  const calls = [];
  const store = createAdminReferralStore({}, (path, options) => new Promise(resolve => calls.push({ path, options, resolve })));
  const first = store.start(), second = store.setView('rewards');
  assert.equal(calls[0].options.signal.aborted, true);
  calls[1].resolve(response('current-reward')); await second;
  calls[0].resolve(response('old-relation')); await first;
  assert.equal(store.getSnapshot().view, 'rewards'); assert.equal(store.getSnapshot().data.records[0].id, 'current-reward');
  assert.equal(store.getSnapshot().loading, false); store.dispose();
});

test('disposing one credential scope prevents stale data from reaching a new account', async () => {
  let resolveOld, oldSignal;
  const first = createAdminReferralStore({ Authorization: 'Bearer old-fixture' }, (_path, options) => { oldSignal = options.signal; return new Promise(resolve => { resolveOld = resolve; }); });
  const pending = first.start(); first.setDraft('私有搜索'); first.dispose();
  const second = createAdminReferralStore({ Authorization: 'Bearer new-fixture' }, async () => response('new-account'));
  assert.equal(second.getSnapshot().draftSearch, ''); assert.equal(second.getSnapshot().data, null); assert.equal(second.getSnapshot().page, 0);
  await second.start(); resolveOld(response('old-account')); await pending;
  assert.equal(oldSignal.aborted, true); assert.equal(first.getSnapshot().data, null); assert.equal(second.getSnapshot().data.records[0].id, 'new-account'); second.dispose();
});

test('failed loads show an error, preserve the last totals and recover with refresh', async () => {
  let failure = false;
  const store = createAdminReferralStore({}, async () => { if (failure) throw new Error('服务暂不可用'); return response(); });
  await store.start(); failure = true; await store.refresh();
  assert.equal(store.getSnapshot().error, '服务暂不可用'); assert.equal(store.getSnapshot().loading, false); assert.equal(store.getSnapshot().data.totals.reward_credits, '21');
  failure = false; await store.refresh(); assert.equal(store.getSnapshot().error, ''); store.dispose();
});

test('deleted identities retain their audit identifier and unpaid rows are never labeled paid', () => {
  assert.deepEqual(referralMember({ inviter_id: 'old-id', inviter_name: '已注销用户', inviter_email: null }, 'inviter'), { id: 'old-id', name: '已注销用户', email: '' });
  assert.equal(referralMember({ inviter_id: 'live-no-email', inviter_name: '无邮箱用户', inviter_email: null }, 'inviter').name, '无邮箱用户');
  assert.deepEqual(referralMember({ invitee_id: 'live-id', invitee_name: '好友', invitee_email: 'fixture@example.invalid' }, 'invitee'), { id: 'live-id', name: '好友', email: 'fixture@example.invalid' });
  assert.equal(referralRecordStatus('rewarded'), '已发放'); assert.equal(referralRecordStatus('not_issued'), '未发放'); assert.equal(referralRecordStatus(null), '待确认');
  assert.match(referralBeijingTime('2026-11-16T16:00:00Z'), /2026\/11\/17 00:00:00/); assert.equal(referralBeijingTime(null), '—');
});
