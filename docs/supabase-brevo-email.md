# Supabase Auth 邮件使用 Brevo

项目中的 `supabase/functions/send-email/index.ts` 仅通过 Brevo Transactional Email API 发送邮件，不调用 Resend，也不做供应商故障切换。它可用于 Supabase Auth 的 Send Email Hook，负责注册验证、找回密码、邮箱变更等邮件。

## 配置

在 Supabase Dashboard 的 Edge Functions 中部署 `send-email`，设置以下 Secrets。不要把真实值写入 Git：

```text
BREVO_API_KEY=你的 Brevo API Key（不是 SMTP Key）
EMAIL_FROM=noreply@posterflow-ai.xyz|PosterFlow AI
SEND_EMAIL_HOOK_SECRET=随机生成的一段长字符串
```

在 Brevo 中验证发件人域名，并将 `EMAIL_FROM` 设置为 `邮箱|名称`。随后在 Authentication → Hooks → Send Email Hook 中选择 `send-email`，配置相同的 Hook Secret。

启用 Hook 后，相关 Auth 邮件由 Edge Function 发送。不要同时配置另一个会为相同 Auth 事件发送邮件的 Hook，以免重复发送。

## 部署与验证

安装并登录 Supabase CLI 后执行：

```powershell
supabase functions deploy send-email --no-verify-jwt
supabase secrets set BREVO_API_KEY=... EMAIL_FROM="noreply@posterflow-ai.xyz|PosterFlow AI" SEND_EMAIL_HOOK_SECRET=...
```

不要在聊天、日志、提交记录或前端环境变量中粘贴 API Key。部署并启用 Hook 后，分别测试注册验证、找回密码和重新发送验证邮件，并在 Supabase Auth Logs 与 Brevo Transactional Logs 中确认投递结果。

如果不使用 Supabase Send Email Hook，则不要部署或启用该函数；直接在 Supabase Auth 的 SMTP 设置中配置 Brevo SMTP 即可。两种接入方式任选其一，避免重复发送。
