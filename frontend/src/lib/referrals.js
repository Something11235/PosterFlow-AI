const INVITATION_CODE = /^PF[A-F0-9]{12}$/;

export function normalizeInvitationCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!code) return '';
  if (!INVITATION_CODE.test(code)) throw new Error('邀请码格式不正确，请核对后重试，或留空继续注册。');
  return code;
}

export function invitationFromSearch(search = '') {
  try { return normalizeInvitationCode(new URLSearchParams(search).get('invite')); }
  catch { return ''; }
}

export function invitationLink(code, origin = globalThis.location?.origin) {
  const clean = normalizeInvitationCode(code);
  if (!clean) return '';
  const url = new URL('/', origin);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('邀请链接暂不可用。');
  url.searchParams.set('invite', clean);
  return url.href;
}

export async function referralApi(path = '', { authHeaders = {}, signal, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch('/api/referrals' + path, {
      headers: authHeaders, credentials: 'include', cache: 'no-store', signal: controller.signal,
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error('邀请奖励信息暂未加载，请稍后刷新重试。'); }
    if (!response.ok || !data?.success) throw new Error(data?.error || '邀请奖励信息暂不可用，请稍后刷新重试。');
    return data;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error?.name === 'AbortError' || error?.name === 'TypeError') throw new Error('暂时无法连接邀请服务，请稍后刷新重试。');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function validateInvitationCode(value, options) {
  const code = normalizeInvitationCode(value);
  if (!code) return '';
  const data = await referralApi('/validate?code=' + encodeURIComponent(code), options);
  if (data.valid !== true) throw new Error('邀请码无效或暂不可用，请核对后重试，或留空继续注册。');
  return code;
}

export async function copyInvitationText(text) {
  if (!text) return false;
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Fall back for browsers that block the Clipboard API. */ }
  if (!globalThis.document?.body) return false;
  const previous = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.position = 'fixed';
  field.style.left = '-9999px';
  document.body.appendChild(field);
  let copied = false;
  try { field.select(); copied = Boolean(document.execCommand?.('copy')); }
  catch { copied = false; }
  finally { field.remove(); previous?.focus?.({ preventScroll: true }); }
  return copied;
}
