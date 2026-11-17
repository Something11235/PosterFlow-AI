import test from 'node:test';
import assert from 'node:assert/strict';
import { copyInvitationText, invitationFromSearch, invitationLink, normalizeInvitationCode, referralApi, validateInvitationCode } from '../src/lib/referrals.js';
import { authErrorMessage } from '../src/lib/authTransport.js';

const CODE = 'PF012345ABCDEF';

test('optional invitation code is normalized without accepting arbitrary signup metadata', () => {
  assert.equal(normalizeInvitationCode(' ' + CODE.toLowerCase() + ' '), CODE);
  assert.equal(normalizeInvitationCode(''), '');
  for (const value of ['PF' + 'A'.repeat(26), 'PF012345ABCDEG', 'PF012345ABCDE', { inviter_id: 'fixture' }, '<script>', 'PF01 2345ABCDEF']) {
    assert.throws(() => normalizeInvitationCode(value), /邀请码格式/);
  }
});

test('public invitation link contains only the code and opens the site root', () => {
  assert.equal(invitationLink(CODE, 'https://www.posterflow-ai.xyz'), 'https://www.posterflow-ai.xyz/?invite=' + CODE);
  assert.equal(invitationLink(CODE, 'https://fixture.invalid/private?access_token=never-share#secret'), 'https://fixture.invalid/?invite=' + CODE);
  assert.equal(invitationFromSearch('?area=tavern&invite=' + CODE.toLowerCase()), CODE);
  assert.equal(invitationFromSearch('?invite=bad'), '');
  assert.equal(invitationFromSearch('?access_token=fixture'), '');
  assert.equal(invitationLink('', 'https://fixture.invalid'), '');
  assert.throws(() => invitationLink(CODE, 'javascript:alert(1)'));
});

test('invitation snapshot uses same-origin authenticated uncached GET with pagination', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ success: true, code: CODE, records: [], has_more: false }) }; };
  try {
    const result = await referralApi('?limit=20&offset=20', { authHeaders: { Authorization: 'Bearer synthetic-fixture' } });
    assert.equal(result.code, CODE);
    assert.equal(calls[0].url, '/api/referrals?limit=20&offset=20');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-fixture');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[0].options.credentials, 'include');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal(calls[0].options.body, undefined);
  } finally { globalThis.fetch = original; }
});

test('signup without an invitation does not depend on referral service availability', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('should not be called'); };
  try {
    assert.equal(await validateInvitationCode(''), '');
    await assert.rejects(validateInvitationCode('bad'), /格式/);
  } finally { globalThis.fetch = original; }
});

test('invitation is server-validated before registration and invalid/malformed responses fail closed', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ success: true, valid: true }) }; };
  try {
    assert.equal(await validateInvitationCode(CODE.toLowerCase()), CODE);
    assert.equal(calls[0].url, '/api/referrals/validate?code=' + CODE);
    assert.deepEqual(calls[0].options.headers, {});
    for (const valid of [false, undefined, 'true']) {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, valid }) });
      await assert.rejects(validateInvitationCode(CODE), /邀请码无效/);
    }
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ success: false, error: '请求过于频繁' }) });
    await assert.rejects(validateInvitationCode(CODE), /请求过于频繁/);
    globalThis.fetch = async () => ({ ok: true, json: async () => { throw new Error('html response'); } });
    await assert.rejects(validateInvitationCode(CODE), /刷新重试/);
  } finally { globalThis.fetch = original; }
});

test('closing an invitation view aborts its request and network timeout has clear retry text', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const controller = new AbortController();
    const pending = referralApi('', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(referralApi('', { timeoutMs: 5 }), /无法连接邀请服务/);
  } finally { globalThis.fetch = original; }
});

test('copying an invitation succeeds through the clipboard and reports failure without pretending success', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let copied;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { copied = value; } } } });
  try {
    assert.equal(await copyInvitationText(CODE), true);
    assert.equal(copied, CODE);
    globalThis.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    assert.equal(await copyInvitationText(CODE), false);
    assert.equal(await copyInvitationText(''), false);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator; }
});

test('copy fallback removes its temporary field and restores keyboard focus', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let appended = false, selected = false, removed = false, restored = false;
  const field = { style: {}, select: () => { selected = true; }, remove: () => { removed = true; } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    activeElement: { focus: () => { restored = true; } },
    createElement: () => field,
    body: { appendChild: () => { appended = true; } },
    execCommand: command => command === 'copy',
  } });
  try {
    assert.equal(await copyInvitationText(CODE), true);
    assert.equal(field.value, CODE);
    assert.ok(appended && selected && removed && restored);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document; }
});

test('referral validation errors do not become a password error', () => {
  assert.match(authErrorMessage({ code: 'REFERRAL_CODE_INVALID' }), /邀请码无效/);
  assert.match(authErrorMessage({ message: 'REFERRAL_CODE_INVALID' }), /邀请码无效/);
});
