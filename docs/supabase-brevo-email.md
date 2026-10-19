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

## 注册邮件显示明确验证结果

网站提供 `GET /api/auth/confirm` 验证页面。新邮件链接指向本站，页面通过同源 POST 请求让后端调用 Supabase Auth 验证一次性 token hash，只有 Auth 返回已验证的用户时才显示“邮箱验证成功”和“验证已完成，可以关闭此页面。”。成功页不提供跳转按钮，不会自动登录或替换浏览器中已有的账号；临时失败时保留“重新验证”按钮。

链接使用片段：`https://www.posterflow-ai.xyz/api/auth/confirm#token_hash=<一次性哈希>&type=email`。浏览器读取后立即清除片段，通过 POST 请求体提交；服务器响应不返回 Auth 会话、用户邮箱或原始错误。打开页面或邮件扫描器只发起 GET/HEAD 请求时不会消费验证链接。不要向日志或聊天复制真实验证链接。

### 使用 Brevo SMTP 时

1. 先部署网站代码，确认 `/api/auth/confirm` 可以打开。无 token 时应提示“验证链接不完整”，不能显示成功。
2. 在 Supabase Authentication → URL Configuration 中确认 Site URL 为 `https://www.posterflow-ai.xyz`，末尾不加 `/`。
3. 在 Authentication → Email Templates → Confirm signup 中，将正文替换为 [`templates/confirm-signup.html`](templates/confirm-signup.html)。只修改注册确认模板，不修改重置密码、邀请或邮箱变更模板。
4. 关闭 Brevo 对认证邮件的点击跟踪／链接重写，避免验证链接片段丢失。
5. 用测试邮箱新注册，检查成功、重复点击、链接过期及手机显示。若发送全新验证邮件，可使用 Supabase 官方 resend 流程；旧邮件不会自动换成新入口。

### 使用 Send Email Hook 时

保留现有发信方式。先部署网站，再部署本仓库的 Hook，并设置 Edge Function secret `EMAIL_CONFIRM_URL=https://www.posterflow-ai.xyz/api/auth/confirm`。只有配置该变量后，Hook 的注册邮件才使用新入口；未配置时保留旧链接，找回密码和邮箱变更等流程继续使用原有验证地址。不要为了启用结果页同时开启 SMTP 和 Hook。

### 验证与范围

- 本地测试使用模拟 Auth 响应，不消费真实用户的验证链接、不发送真实邮件、不修改积分。
- 新入口减少邮箱验证这一步对浏览器直连 Supabase 的依赖；网站本身仍需可访问，登录等其他请求仍按原有方式连接 Supabase。
- 本地代码或模板文件更新不等于线上配置已生效。发布时需要分别核对网站部署和实际启用的发信模板／Hook。

参考：[Supabase 邮件模板与服务端验证](https://supabase.com/docs/guides/auth/auth-email-templates#redirecting-the-user-to-a-server-side-endpoint)。
