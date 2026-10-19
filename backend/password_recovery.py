"""Same-origin recovery page; emailed proof never enters HTTP query strings."""

import hashlib
import re
import secrets

from flask import Blueprint, jsonify, make_response, render_template, request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

try:
    from backend.supabase_service import SUPABASE_SERVICE_ROLE_KEY, SupabaseError, SupabaseGateway
except ModuleNotFoundError:
    from supabase_service import SUPABASE_SERVICE_ROLE_KEY, SupabaseError, SupabaseGateway


password_recovery = Blueprint("password_recovery", __name__)
PATH = "/api/auth/reset-password"
COOKIE = "posterflow_password_recovery"
LIFETIME = 600
INVALID_LINK = {"otp_expired", "token_expired", "validation_failed", "bad_code_verifier",
                "bad_jwt", "session_not_found", "session_expired", "user_not_found", "invalid_token"}


def _signer():
    if not SUPABASE_SERVICE_ROLE_KEY:
        raise SupabaseError("SUPABASE_NOT_CONFIGURED", "账户服务尚未配置")
    return URLSafeTimedSerializer(SUPABASE_SERVICE_ROLE_KEY, salt="posterflow-password-recovery-v1")


def _read_session(proof=None):
    value = request.cookies.get(COOKIE)
    if not value:
        return None
    try:
        data = _signer().loads(value, max_age=LIFETIME)
        token = data.get("access_token") if isinstance(data, dict) else None
        if proof is not None and (not isinstance(data, dict) or data.get("proof") != _proof_digest(proof)):
            return None
        return token if isinstance(token, str) and token else None
    except (BadSignature, SignatureExpired):
        return None


def _reply(ok, title, message, status=200, **extra):
    return make_response(jsonify(ok=ok, title=title, message=message, **extra), status)


def _same_origin():
    # Vercel can terminate HTTPS before forwarding to WSGI over HTTP.
    scheme = "https" if request.headers.get("X-Forwarded-Proto", "").split(",")[0].strip() == "https" else request.scheme
    return request.headers.get("Origin") == f"{scheme}://{request.host}"


@password_recovery.route(PATH, methods=["GET", "POST"])
def reset_password():
    nonce = secrets.token_urlsafe(24)
    try:
        if request.method in {"GET", "HEAD"}:
            # Email scanners may GET/HEAD this page. Verify only on form submission.
            response = make_response(render_template(
                "password_recovery.html", nonce=nonce, recovery_ready=bool(_read_session())
            ))
        elif (not request.is_json or not _same_origin()
              or request.headers.get("Sec-Fetch-Site") == "cross-site"):
            response = _reply(False, "请求未通过验证", "请在邮件打开的页面中提交新密码。", 403)
        else:
            data = request.get_json(silent=True)
            if not isinstance(data, dict):
                response = _reply(False, "请求格式有误", "请重新打开邮件中的重置链接。", 400)
            elif data.get("action") == "verify":
                token_hash = data.get("token_hash")
                access_token = data.get("access_token")
                if data.get("type") != "recovery":
                    response = _reply(False, "重置链接不完整", "请重新打开密码重置邮件中的完整链接。", 400)
                elif isinstance(token_hash, str) and re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token_hash):
                    if _read_session(token_hash):
                        response = _reply(True, "链接验证通过", "请提交新密码。")
                    else:
                        access_token = SupabaseGateway().verify_password_recovery(token_hash)
                        response = _recovery_cookie(access_token, token_hash)
                elif isinstance(access_token, str) and re.fullmatch(r"[A-Za-z0-9_.-]{32,3072}", access_token):
                    if _read_session(access_token):
                        response = _reply(True, "链接验证通过", "请提交新密码。")
                    else:
                        SupabaseGateway().validate_recovery_access_token(access_token)
                        response = _recovery_cookie(access_token, access_token)
                else:
                    response = _reply(False, "重置链接不完整", "请重新打开密码重置邮件中的完整链接。", 400)
            elif data.get("action") == "update":
                password = data.get("password")
                confirmation = data.get("password_confirmation")
                token = _read_session()
                if not token:
                    response = _reply(False, "重置链接已失效", "请返回网站，重新申请密码重置邮件。", 401, restart=True)
                elif not isinstance(password, str) or not 8 <= len(password) <= 128:
                    response = _reply(False, "请检查新密码", "密码需要 8–128 位，支持特殊字符。", 400)
                elif confirmation != password:
                    response = _reply(False, "两次密码不一致", "请确认两次输入的新密码完全一致。", 400)
                else:
                    SupabaseGateway().update_recovered_password(token, password)
                    response = _reply(True, "密码修改成功", "请返回网站，使用新密码登录。")
                    response.delete_cookie(COOKIE, path=PATH, secure=True, httponly=True, samesite="Strict")
            else:
                response = _reply(False, "请求格式有误", "请重新打开邮件中的重置链接。", 400)
    except SupabaseError as error:
        if error.code in INVALID_LINK:
            response = _reply(False, "重置链接已失效", "链接已过期或已使用，请返回网站重新申请重置邮件。", 400, restart=True)
            response.delete_cookie(COOKIE, path=PATH, secure=True, httponly=True, samesite="Strict")
        elif error.code in {"weak_password", "same_password", "reauthentication_needed", "reauthentication_not_valid"}:
            messages = {
                "weak_password": "新密码未满足安全要求，请换一个更长、包含字母、数字和符号的密码。",
                "same_password": "新密码不能与原密码相同，请换一个密码。",
                "reauthentication_needed": "账户需要再次验证，请重新申请密码重置邮件。",
                "reauthentication_not_valid": "账户验证已失效，请重新申请密码重置邮件。",
            }
            response = _reply(False, "密码尚未修改", messages[error.code], 400)
        elif error.code in {"over_request_rate_limit", "over_email_send_rate_limit"}:
            response = _reply(False, "操作过于频繁", "请稍后再试。", 429)
        else:
            response = _reply(False, "暂时无法完成修改", "服务暂时没有响应，请稍后重试。密码尚未确认修改成功。", 503)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = (
        f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; "
        "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    )
    return response


def _proof_digest(proof):
    return hashlib.sha256(proof.encode("utf-8")).hexdigest()


def _recovery_cookie(access_token, proof):
    value = _signer().dumps({"access_token": access_token, "proof": _proof_digest(proof)})
    if len(value) > 3800:
        raise SupabaseError("SUPABASE_BAD_RESPONSE", "重置凭证格式有误")
    response = _reply(True, "链接验证通过", "请提交新密码。")
    response.set_cookie(COOKIE, value, max_age=LIFETIME, path=PATH,
                        secure=True, httponly=True, samesite="Strict")
    return response
