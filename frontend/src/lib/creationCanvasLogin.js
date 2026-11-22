const KEY = "posterflow.creation-canvas.login";
export const CANVAS_LOGIN_READY = "posterflow:canvas-login-ready";

export function rememberGuestCanvasForLogin(projectId) {
  if (!projectId) return;
  const intent = { projectId, token: crypto.randomUUID(), owner: null, expires: Date.now() + 30 * 60_000 };
  sessionStorage.setItem(KEY, JSON.stringify(intent));
}

export function readGuestCanvasLogin() {
  try {
    const intent = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (intent?.token && intent.projectId && intent.expires > Date.now()) return intent;
  } catch { /* Login works even when no pending canvas can be read. */ }
  return null;
}

export function forgetGuestCanvasLogin(token) {
  try {
    if (!token || readGuestCanvasLogin()?.token === token) sessionStorage.removeItem(KEY);
  } catch { /* Optional resume state must not block closing the login form. */ }
}

// Only called after a sign-in has actually succeeded in this tab. Auth changes
// broadcast from other tabs never authorize a copy into their user's account.
export function confirmGuestCanvasLogin(owner) {
  const intent = readGuestCanvasLogin();
  if (!intent || !owner || owner === "guest" || (intent.owner && intent.owner !== owner)) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...intent, owner }));
    window.dispatchEvent(new Event(CANVAS_LOGIN_READY));
  } catch { /* Canvas resume is optional to authentication. */ }
}
