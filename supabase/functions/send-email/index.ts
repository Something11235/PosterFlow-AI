import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Webhook } from "npm:standardwebhooks@^1";

type HookPayload = {
  user?: { email?: string | null; new_email?: string | null };
  email_data?: {
    token?: string;
    email_action_type?: string;
    token_hash?: string;
    token_new?: string;
    token_hash_new?: string;
    redirect_to?: string;
    site_url?: string;
  };
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function actionLabel(action: string): string {
  switch (action) {
    case "signup":
      return "验证邮箱";
    case "recovery":
      return "重置密码";
    case "email_change":
      return "确认邮箱变更";
    case "invite":
      return "接受邀请";
    case "magiclink":
      return "登录账户";
    case "reauthentication":
      return "确认身份";
    default:
      return "继续操作";
  }
}

function buildVerifyUrl(data: NonNullable<HookPayload["email_data"]>, tokenHash: string): string {
  const siteUrl = (Deno.env.get("SUPABASE_URL") || "").trim();
  const action = data.email_action_type?.trim() || "signup";
  if (!siteUrl || !tokenHash) throw new Error("Missing site_url or token_hash");

  const url = new URL("/auth/v1/verify", siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`);
  url.searchParams.set("token", tokenHash);
  url.searchParams.set("type", action);
  if (data.redirect_to) url.searchParams.set("redirect_to", data.redirect_to);
  return url.toString();
}

function createMessages(payload: HookPayload) {
  const email = payload.user?.email?.trim();
  const data = payload.email_data;
  if (!email || !data) throw new Error("Invalid Send Email Hook payload");

  const label = actionLabel(data.email_action_type || "");
  const subject = `PosterFlow AI：${label}`;
  const targets = [{ email, tokenHash: data.token_hash?.trim() }];

  // Secure email change can require one message to the old address and one to the new address.
  if (data.email_action_type === "email_change" && data.token_hash_new?.trim()) {
    targets[0].tokenHash = data.token_hash_new.trim();
    if (payload.user?.new_email?.trim() && data.token_hash?.trim()) {
      targets.push({ email: payload.user.new_email.trim(), tokenHash: data.token_hash.trim() });
    }
  }

  return targets.map(({ email: targetEmail, tokenHash }) => {
    if (!tokenHash) throw new Error("Missing token_hash");
    const verifyUrl = buildVerifyUrl(data, tokenHash);
    const safeUrl = escapeHtml(verifyUrl);
    const text = `${label}\n\n请打开以下链接：\n${verifyUrl}\n\n如果这不是你的操作，可以忽略此邮件。`;
    const html = `<!doctype html><html lang="zh-CN"><body style="font-family:Arial,sans-serif;line-height:1.7;color:#1f2937"><h2>${escapeHtml(subject)}</h2><p>请点击下面的按钮继续：</p><p><a href="${safeUrl}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(label)}</a></p><p>如果按钮无法打开，请复制此链接到浏览器：</p><p style="word-break:break-all">${safeUrl}</p><p>如果这不是你的操作，可以忽略此邮件。</p></body></html>`;
    return { email: targetEmail, subject, text, html };
  });
}

function senderDetails() {
  const [email, name = "PosterFlow AI"] = required("EMAIL_FROM").split("|");
  return { email: email.trim(), name: name.trim() };
}

async function sendBrevo(message: ReturnType<typeof createMessages>[number]) {
  const sender = senderDetails();
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": required("BREVO_API_KEY"),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender,
      to: [{ email: message.email }],
      subject: message.subject,
      htmlContent: message.html,
      textContent: message.text,
    }),
  });
  const body = await response.text();
  return { response, body };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const rawPayload = await request.text();
    const headers = Object.fromEntries(request.headers.entries());
    const hookSecret = required("SEND_EMAIL_HOOK_SECRET").replace("v1,whsec_", "");
    const payload = new Webhook(hookSecret).verify(rawPayload, headers) as HookPayload;
    const messages = createMessages(payload);

    for (const message of messages) {
      const result = await sendBrevo(message);
      if (!result.response.ok) {
        console.error("Brevo rejected email", { status: result.response.status });
        return json({ error: "Email delivery failed" }, 502);
      }
    }
    return json({});
  } catch (error) {
    console.error("Send Email Hook failed", error instanceof Error ? error.message : "unknown error");
    return json({ error: "Email hook failed" }, 401);
  }
});
