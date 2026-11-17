import React, { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, Mail, X } from "lucide-react";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { authErrorMessage } from "../lib/authTransport";
import { validateInvitationCode } from "../lib/referrals";

const MODES = { signIn: "登录", signUp: "注册", forgot: "找回密码", recovery: "设置新密码" };

export default function AuthModal({ open, initialMode = "signIn", initialInvitationCode = "", onRegistered, onClose, onNotice }) {
  const [mode, setMode] = useState(initialMode);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invitationCode, setInvitationCode] = useState(initialInvitationCode);
  const scope = useRef(0);
  const validation = useRef(null);

  useEffect(() => { setInvitationCode(initialInvitationCode); }, [initialInvitationCode]);

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setError("");
    setPassword("");
    setBusy(false);
    scope.current += 1;
    return () => { scope.current += 1; validation.current?.abort(); };
  }, [initialMode, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!supabaseConfigured || !supabase) {
      setError("登录服务尚未配置，请联系管理员");
      return;
    }
    if (!email.trim()) return setError("请输入邮箱");
    if (mode !== "forgot" && password.length < 8) return setError("密码至少需要 8 位");
    setBusy(true);
    setError("");
    const version = scope.current;
    const live = () => version === scope.current;
    try {
      if (mode === "signIn") {
        const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (!live()) return;
        if (authError) throw authError;
        onNotice?.("登录成功");
        onClose();
      } else if (mode === "signUp") {
        const controller = new AbortController(); validation.current = controller;
        let referralCode;
        try { referralCode = await validateInvitationCode(invitationCode, { signal: controller.signal }); }
        catch (reason) { if (live()) setError(reason.message); return; }
        if (!live()) return;
        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { username: username.trim() || email.trim().split("@")[0], ...(referralCode ? { referral_code: referralCode } : {}) } },
        });
        if (!live()) return;
        if (authError) throw authError;
        if (!data.session) onNotice?.("注册成功，请打开验证邮件，完成邮箱验证后再登录。");
        else onNotice?.("注册成功");
        setInvitationCode("");
        onRegistered?.();
        onClose();
      } else if (mode === "forgot") {
        const { error: authError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/api/auth/reset-password`,
        });
        if (!live()) return;
        if (authError) throw authError;
        onNotice?.("如果该邮箱已注册，你将收到重置密码邮件。请检查收件箱和垃圾邮件。");
        onClose();
      } else {
        const { error: authError } = await supabase.auth.updateUser({ password });
        if (!live()) return;
        if (authError) throw authError;
        onNotice?.("密码已更新，请使用新密码登录");
        onClose();
      }
    } catch (authError) {
      if (live()) setError(authErrorMessage(authError));
    } finally {
      if (live()) setBusy(false);
    }
  };

  const title = MODES[mode];
  const isPasswordMode = mode !== "forgot";

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
      <div className="flex max-h-[100dvh] w-full max-w-md flex-col overflow-hidden rounded-t-lg border border-border-default bg-bg-secondary shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:rounded-lg">
        <div className="flex shrink-0 items-start justify-between border-b border-border-subtle px-5 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">PosterFlow Account</p>
            <h2 id="auth-modal-title" className="mt-1 text-lg font-semibold text-text-primary">{title}</h2>
            <p className="mt-1 text-sm leading-6 text-text-muted">登录后可使用平台积分生图，完成邮箱验证后可获得注册赠送积分。</p>
          </div>
          <button type="button" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary" aria-label="关闭登录窗口">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={submit} className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-5 py-5">
          {mode === "signIn" && (
            <div className="rounded-lg border border-gold/30 bg-gold/10 px-3 py-3 text-sm leading-6 text-gold" role="note">
              如果刚刚注册，请打开验证邮件，完成邮箱验证后再登录。
            </div>
          )}
          {mode === "signUp" && (
            <>
              <div className="rounded-lg border border-accent/20 bg-accent/8 px-3 py-2 text-xs leading-5 text-text-secondary">
                注册完成后，请打开邮箱并点击验证链接；验证通过后，系统会自动发放注册赠送积分。
              </div>
              <div>
                <label htmlFor="auth-username" className="text-sm font-medium text-text-secondary">用户名</label>
                <input id="auth-username" value={username} onChange={(event) => setUsername(event.target.value)} className="mt-2 min-h-12 w-full rounded-lg border border-border-default bg-bg-primary px-3 text-base text-text-primary" placeholder="用于显示的昵称" autoComplete="username" />
              </div>
            </>
          )}
          <div>
            <label htmlFor="auth-email" className="text-sm font-medium text-text-secondary">邮箱</label>
            <div className="relative mt-2"><Mail size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" /><input id="auth-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="min-h-12 w-full rounded-lg border border-border-default bg-bg-primary pl-10 pr-3 text-base text-text-primary" placeholder="name@example.com" autoComplete="email" /></div>
          </div>
          {isPasswordMode && (
            <div>
              <label htmlFor="auth-password" className="text-sm font-medium text-text-secondary">{mode === "recovery" ? "新密码" : "密码"}</label>
              <div className="relative mt-2"><KeyRound size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" /><input id="auth-password" type={visible ? "text" : "password"} required value={password} onChange={(event) => setPassword(event.target.value)} className="min-h-12 w-full rounded-lg border border-border-default bg-bg-primary px-10 text-base text-text-primary" placeholder="至少 8 位" autoComplete={mode === "signIn" ? "current-password" : "new-password"} /><button type="button" onClick={() => setVisible((value) => !value)} className="absolute right-1 top-1 flex min-h-10 min-w-10 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary" aria-label={visible ? "隐藏密码" : "显示密码"}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
            </div>
          )}
          {mode === "signUp" && <div><label htmlFor="auth-invitation-code" className="text-sm font-medium text-text-secondary">邀请码<span className="ml-2 text-xs font-normal text-text-muted">选填</span></label><input id="auth-invitation-code" value={invitationCode} onChange={event => setInvitationCode(event.target.value)} disabled={busy} maxLength={32} autoComplete="off" autoCapitalize="characters" spellCheck={false} className="mt-2 min-h-12 w-full rounded-lg border border-border-default bg-bg-primary px-3 font-mono text-base text-text-primary disabled:opacity-60" placeholder="填写好友的邀请码" /><p className="mt-2 text-xs leading-5 text-text-muted">注册时绑定邀请人，之后每次兑换积分，邀请人额外获得 10% 奖励；你的到账积分不受影响。</p></div>}
          {error && <p className="rounded-lg border border-error/35 bg-error/10 px-3 py-2 text-sm leading-6 text-error" role="alert">{error}</p>}
          <button type="submit" disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">{busy && <Loader2 size={16} className="animate-spin-soft" />}{busy ? "处理中" : title}</button>
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm text-text-muted">
            {mode !== "signIn" && <button type="button" disabled={busy} onClick={() => setMode("signIn")} className="text-accent hover:underline disabled:opacity-50">返回登录</button>}
            {mode === "signIn" && <><button type="button" disabled={busy} onClick={() => setMode("signUp")} className="text-accent hover:underline disabled:opacity-50">注册账号</button><button type="button" disabled={busy} onClick={() => setMode("forgot")} className="text-accent hover:underline disabled:opacity-50">忘记密码</button></>}
          </div>
        </form>
      </div>
    </div>
  );
}
