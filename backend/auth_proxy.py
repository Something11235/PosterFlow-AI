"""Narrow same-origin transport for the browser's public Supabase Auth API.

This module never uses the service key, authenticates as an administrator, or
logs request bodies. Auth still validates passwords, refresh tokens and JWTs.
"""
import base64
import json
import os
import re
import time
from urllib.parse import urlsplit

import requests
from flask import Blueprint, jsonify, make_response, request

PATH = "/api/auth/proxy"
BODY_LIMIT = 32 * 1024
RESPONSE_LIMIT = 1024 * 1024
METHODS = {"token": {"POST"}, "signup": {"POST"}, "recover": {"POST"},
           "verify": {"POST"}, "resend": {"POST"}, "user": {"GET", "PUT"}, "logout": {"POST"}}


def _claims(value):
    try:
        parts = value.split(".")
        if len(parts) != 3:
            return {}
        payload = parts[1]
        decoded = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return decoded if isinstance(decoded, dict) else {}
    except (ValueError, TypeError, UnicodeError, RecursionError):
        return {}


def _config():
    # These are the existing browser-safe key aliases; never fall back to an
    # administrator credential if a public key is missing or misconfigured.
    url = (os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL") or "").strip().rstrip("/")
    key = next((os.getenv(name, "").strip() for name in (
        "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY"
    ) if os.getenv(name, "").strip()), "")
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None, None
    valid_url = parsed.scheme == "https" and parsed.hostname and not (parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment)
    public_key = bool(re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]+", key) or _claims(key).get("role") == "anon")
    return (url, key) if valid_url and public_key else (None, None)


def _reply(code, message, status):
    response = make_response(jsonify(code=code, msg=message), status)
    response.headers["X-Supabase-Api-Version"] = "2024-01-01"
    return response


def create_auth_proxy_blueprint(server):
    bp = Blueprint("auth_proxy", __name__, url_prefix=PATH)

    @bp.after_request
    def private_response(response):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Pragma"] = "no-cache"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @bp.route("/<path:endpoint>", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"], provide_automatic_options=False)
    def proxy(endpoint):
        if request.method not in METHODS.get(endpoint, set()):
            return _reply("auth_proxy_route_blocked", "该登录操作不受支持。", 404)
        scheme = "https" if request.headers.get("X-Forwarded-Proto", "").split(",")[0].strip() == "https" else request.scheme
        own_origin = f"{scheme}://{request.host}"
        origin = request.headers.get("Origin")
        allowed_origins = {own_origin, *server.ALLOWED_ORIGINS}
        # GET fetches may omit Origin; the explicit marker forces a preflight
        # for cross-origin browser requests. No cookie is used for authorization.
        if (request.headers.get("X-Posterflow-Auth") != "1"
                or request.headers.get("Sec-Fetch-Site") == "cross-site"
                or (origin is not None and origin not in allowed_origins)
                or (request.method != "GET" and origin not in allowed_origins)):
            return _reply("auth_proxy_origin_blocked", "请在本站页面中登录。", 403)
        if request.content_length and request.content_length > BODY_LIMIT:
            return _reply("auth_proxy_body_too_large", "登录请求内容过长。", 413)
        raw = request.stream.read(BODY_LIMIT + 1)
        if len(raw) > BODY_LIMIT:
            return _reply("auth_proxy_body_too_large", "登录请求内容过长。", 413)
        body = None
        if request.method != "GET":
            if raw:
                if not request.is_json:
                    return _reply("auth_proxy_body_invalid", "登录请求格式无效。", 400)
                try:
                    body = json.loads(raw)
                except (ValueError, UnicodeError, RecursionError):
                    return _reply("auth_proxy_body_invalid", "登录请求格式无效。", 400)
                if not isinstance(body, dict):
                    return _reply("auth_proxy_body_invalid", "登录请求格式无效。", 400)
            elif endpoint != "logout":
                return _reply("auth_proxy_body_invalid", "登录请求格式无效。", 400)
        elif raw:
            return _reply("auth_proxy_body_invalid", "登录请求格式无效。", 400)
        allowed_query = {"grant_type"} if endpoint == "token" else {"scope"} if endpoint == "logout" else {"redirect_to"} if endpoint in {"signup", "recover", "verify", "resend", "user"} else set()
        if any(key not in allowed_query or len(request.args.getlist(key)) != 1 for key in request.args):
            return _reply("auth_proxy_query_invalid", "登录请求参数无效。", 400)
        if endpoint == "token" and request.args.get("grant_type") not in {"password", "refresh_token", "pkce"}:
            return _reply("auth_proxy_grant_blocked", "该登录方式不受支持。", 400)
        if endpoint == "logout" and request.args.get("scope", "global") not in {"local", "global", "others"}:
            return _reply("auth_proxy_query_invalid", "登录请求参数无效。", 400)
        redirect = request.args.get("redirect_to")
        if redirect:
            try:
                target = urlsplit(redirect)
            except ValueError:
                return _reply("auth_proxy_redirect_blocked", "验证邮件的返回地址无效。", 400)
            if (f"{target.scheme}://{target.netloc}" != (origin or own_origin) or target.username or target.password
                    or target.path not in {"", "/", "/api/auth/reset-password", "/api/auth/confirm"}):
                return _reply("auth_proxy_redirect_blocked", "验证邮件的返回地址无效。", 400)
        url, public_key = _config()
        if not url:
            return _reply("auth_proxy_not_configured", "登录服务暂未配置，请联系站主。", 503)
        headers = {"apikey": public_key, "Content-Type": "application/json", "Accept": "application/json"}
        if not public_key.startswith("sb_publishable_"):
            headers["Authorization"] = "Bearer " + public_key
        if endpoint in {"user", "logout"}:
            bearer = request.headers.get("Authorization", "")
            token = bearer[7:] if bearer.startswith("Bearer ") else ""
            claims = _claims(token) if len(token) <= 8192 else {}
            # This is only a privilege filter, not token verification. Auth
            # verifies the JWT signature/expiry and owns the authorization check.
            if claims.get("role") != "authenticated" or not claims.get("sub"):
                return _reply("bad_jwt", "登录状态已过期，请重新登录。", 401)
            headers["Authorization"] = bearer
        version = request.headers.get("X-Supabase-Api-Version", "")
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", version):
            headers["X-Supabase-Api-Version"] = version
        try:
            # In production the hosting edge supplies this address. It is used
            # only for the local throttle, never forwarded to Auth as a header.
            address = request.headers.get("X-Vercel-Forwarded-For", "").split(",")[0].strip() if os.getenv("VERCEL") else ""
            server.enforce_rate_limit("auth-proxy-" + endpoint, address or request.remote_addr or "unknown",
                                      60 if endpoint in {"token", "user", "logout"} else 10, 60)
        except server.ProviderError:
            response = _reply("over_request_rate_limit", "操作过于频繁，请稍后再试。", 429)
            response.headers["Retry-After"] = "60"
            return response
        try:
            started = time.monotonic()
            # A single bounded upstream request; no automatic POST retry or
            # redirect to an arbitrary host, and no browser cookies are relayed.
            with requests.request(request.method, url + "/auth/v1/" + endpoint,
                                  params=request.args.to_dict(), json=body, headers=headers,
                                  timeout=(5, 15), allow_redirects=False, stream=True) as upstream:
                if 300 <= upstream.status_code < 400:
                    return _reply("auth_proxy_bad_response", "登录服务响应异常，请稍后重试。", 502)
                chunks, size = [], 0
                for chunk in upstream.iter_content(16384):
                    size += len(chunk)
                    if size > RESPONSE_LIMIT or time.monotonic() - started > 25:
                        return _reply("auth_proxy_bad_response", "登录服务响应异常，请稍后重试。", 502)
                    chunks.append(chunk)
                content = b"".join(chunks)
                if upstream.status_code != 204:
                    if not isinstance(json.loads(content), (dict, list)):
                        raise ValueError("unexpected auth response")
                response = make_response(content if upstream.status_code != 204 else b"", upstream.status_code)
                response.headers["Content-Type"] = "application/json"
                for name in ("X-Supabase-Api-Version", "Retry-After"):
                    value = upstream.headers.get(name)
                    if value and re.fullmatch(r"[A-Za-z0-9 ,:-]{1,100}", value):
                        response.headers[name] = value
                return response
        except (requests.RequestException, ValueError, UnicodeError, RecursionError):
            return _reply("auth_network_unavailable", "登录服务连接暂时中断，请稍后重试。", 503)

    return bp
