"""Supabase authentication and server-only database access helpers.

The browser only receives the anon key. This module is intentionally used by
Flask/Vercel Functions so platform credits and service keys never reach React.
"""

from __future__ import annotations

import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from typing import Any

import jwt
import requests
from jwt import PyJWKClient


SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = (
    os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip() or os.getenv("SUPABASE_SECRET_KEY", "").strip()
)
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "").strip()
SUPABASE_JWT_AUDIENCE = os.getenv("SUPABASE_JWT_AUDIENCE", "authenticated").strip() or "authenticated"
REQUEST_TIMEOUT_SECONDS = 12


class SupabaseError(Exception):
    def __init__(self, code: str, message: str, status: int = 503, detail: str = ""):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.detail = detail


@dataclass(frozen=True)
class AuthenticatedUser:
    id: str
    email: str
    claims: dict[str, Any]


def is_supabase_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def _require_supabase_config() -> None:
    if not is_supabase_configured():
        raise SupabaseError(
            "SUPABASE_NOT_CONFIGURED",
            "平台账户服务尚未配置",
            503,
            "请在服务端配置 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY 后再启用平台积分模式。",
        )


def _auth_issuer() -> str:
    return f"{SUPABASE_URL}/auth/v1"


@lru_cache(maxsize=1)
def _jwks_client() -> PyJWKClient:
    _require_supabase_config()
    return PyJWKClient(f"{_auth_issuer()}/.well-known/jwks.json", cache_keys=True, lifespan=300)


def _decode_access_token(token: str) -> dict[str, Any]:
    _require_supabase_config()
    if not token:
        raise SupabaseError("AUTH_REQUIRED", "请先登录后再使用平台积分", 401)
    try:
        header = jwt.get_unverified_header(token)
        algorithm = str(header.get("alg", ""))
        options = {"require": ["exp", "sub", "aud", "iss"]}
        if algorithm.startswith("HS") and SUPABASE_JWT_SECRET:
            return jwt.decode(
                token,
                SUPABASE_JWT_SECRET,
                algorithms=[algorithm],
                audience=SUPABASE_JWT_AUDIENCE,
                issuer=_auth_issuer(),
                options=options,
            )
        signing_key = _jwks_client().get_signing_key_from_jwt(token).key
        return jwt.decode(
            token,
            signing_key,
            algorithms=[algorithm],
            audience=SUPABASE_JWT_AUDIENCE,
            issuer=_auth_issuer(),
            options=options,
        )
    except SupabaseError:
        raise
    except jwt.ExpiredSignatureError as exc:
        raise SupabaseError("AUTH_SESSION_EXPIRED", "登录状态已过期，请重新登录", 401) from exc
    except jwt.PyJWTError as exc:
        raise SupabaseError("AUTH_TOKEN_INVALID", "登录凭证无效，请重新登录", 401) from exc
    except requests.RequestException as exc:
        raise SupabaseError("AUTH_VERIFY_UNAVAILABLE", "暂时无法验证登录状态", 503) from exc


def authenticate_access_token(token: str) -> AuthenticatedUser:
    claims = _decode_access_token(token)
    user_id = str(claims.get("sub", ""))
    try:
        uuid.UUID(user_id)
    except ValueError as exc:
        raise SupabaseError("AUTH_TOKEN_INVALID", "登录凭证无效，请重新登录", 401) from exc
    return AuthenticatedUser(id=user_id, email=str(claims.get("email", "")), claims=claims)


class SupabaseGateway:
    """Small PostgREST wrapper using the server-only service key."""

    def __init__(self) -> None:
        _require_supabase_config()
        self.base_url = SUPABASE_URL
        self._headers = {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Content-Type": "application/json",
        }
        # New sb_secret_* keys are opaque API keys, not JWTs. Sending one as
        # Authorization: Bearer makes Supabase reject it as "Invalid JWT".
        # Legacy service_role JWT keys still need the bearer header.
        if not SUPABASE_SERVICE_ROLE_KEY.startswith("sb_secret_"):
            self._headers["Authorization"] = f"Bearer {SUPABASE_SERVICE_ROLE_KEY}"

    def _request(self, method: str, path: str, *, params=None, body=None, headers=None) -> Any:
        try:
            response = requests.request(
                method,
                f"{self.base_url}{path}",
                params=params,
                json=body,
                headers={**self._headers, **(headers or {})},
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except requests.RequestException as exc:
            raise SupabaseError("SUPABASE_UNAVAILABLE", "账户服务暂时不可用，请稍后重试", 503) from exc
        if response.status_code >= 400:
            try:
                response_data = response.json()
            except ValueError:
                response_data = {}
            code = str(response_data.get("code") or "SUPABASE_REQUEST_FAILED")
            raise SupabaseError(code, "账户数据处理失败，请稍后重试", 503)
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise SupabaseError("SUPABASE_BAD_RESPONSE", "账户服务返回了无效数据", 503) from exc

    def rpc(self, name: str, payload: dict[str, Any]) -> Any:
        return self._request("POST", f"/rest/v1/rpc/{name}", body=payload)

    def ensure_signup_bonus(self, user_id: str) -> dict[str, Any]:
        return self.rpc("ensure_signup_bonus", {"p_user_id": user_id})

    def reserve_credits(
        self,
        user_id: str,
        request_id: str,
        count: int,
        provider: str,
        model: str,
        prompt: str,
        user_daily_limit: int | None,
        platform_daily_limit: int | None,
    ) -> dict[str, Any]:
        return self.rpc(
            "reserve_platform_credits",
            {
                "p_user_id": user_id,
                "p_request_id": request_id,
                "p_count": count,
                "p_provider": provider,
                "p_model": model,
                "p_prompt": prompt,
                "p_user_daily_limit": user_daily_limit,
                "p_platform_daily_limit": platform_daily_limit,
            },
        )

    def settle_generation(self, job_id: str, generated_count: int, duration_ms: int, image_keys: list[str]) -> dict[str, Any]:
        return self.rpc(
            "settle_generation",
            {
                "p_job_id": job_id,
                "p_generated_count": generated_count,
                "p_duration_ms": duration_ms,
                "p_image_keys": image_keys,
            },
        )

    def refund_generation(self, job_id: str, reason: str) -> dict[str, Any]:
        return self.rpc("refund_generation", {"p_job_id": job_id, "p_reason": reason[:120]})

    def record_own_key_generation(
        self,
        user_id: str,
        request_id: str,
        provider: str,
        model: str,
        prompt: str,
        requested_count: int,
        generated_count: int,
        duration_ms: int,
        image_keys: list[str],
        error_code: str | None = None,
    ) -> dict[str, Any]:
        return self.rpc(
            "record_own_key_generation",
            {
                "p_user_id": user_id,
                "p_request_id": request_id,
                "p_provider": provider,
                "p_model": model,
                "p_prompt": prompt,
                "p_requested_count": requested_count,
                "p_generated_count": generated_count,
                "p_duration_ms": duration_ms,
                "p_image_keys": image_keys,
                "p_error_code": error_code,
            },
        )

    def account_snapshot(self, user_id: str) -> dict[str, Any]:
        try:
            return self.rpc("get_account_snapshot", {"p_user_id": user_id})
        except SupabaseError as error:
            # Keep local development usable until the newest migration has been
            # applied. Once installed, the single RPC is the normal fast path.
            if error.code not in {"PGRST202", "42883"}:
                raise

        # The bonus RPC must finish first because it may create the account and
        # transaction. The independent reads then run concurrently; otherwise
        # four sequential Supabase round trips make a fresh login look stalled.
        signup_bonus = self.ensure_signup_bonus(user_id)

        def read_auth_user():
            return self._request("GET", f"/auth/v1/admin/users/{user_id}") or {}

        def read_profile():
            return self._request(
                "GET",
                "/rest/v1/profiles",
                params={"id": f"eq.{user_id}", "select": "id,username,role,status,created_at,last_login_at"},
            )

        def read_account():
            return self._request(
                "GET",
                "/rest/v1/credit_accounts",
                params={"user_id": f"eq.{user_id}", "select": "balance,total_granted,total_spent,total_refunded,updated_at"},
            )

        def read_transactions():
            return self._request(
                "GET",
                "/rest/v1/credit_transactions",
                params={
                    "user_id": f"eq.{user_id}",
                    "select": "id,type,delta,metadata,created_at",
                    "order": "created_at.desc",
                    "limit": "30",
                },
            )

        def read_jobs():
            return self._request(
                "GET",
                "/rest/v1/generation_jobs",
                params={
                    "user_id": f"eq.{user_id}",
                    "select": "id,request_id,billing_mode,provider,model,status,requested_count,generated_count,charged_credits,image_keys,error_code,duration_ms,created_at,settled_at",
                    "order": "created_at.desc",
                    "limit": "50",
                },
            )

        with ThreadPoolExecutor(max_workers=5) as pool:
            auth_user, profile, account, transactions, jobs = pool.map(
                lambda reader: reader(),
                (read_auth_user, read_profile, read_account, read_transactions, read_jobs),
            )

        email_confirmed_at = auth_user.get("email_confirmed_at")
        return {
            "profile": profile[0] if profile else None,
            "email": auth_user.get("email"),
            "email_verified": bool(email_confirmed_at),
            "email_confirmed_at": email_confirmed_at,
            "signup_bonus": signup_bonus,
            "credits": account[0] if account else {"balance": 0, "total_granted": 0, "total_spent": 0, "total_refunded": 0},
            "transactions": transactions or [],
            "jobs": jobs or [],
        }

    def list_jobs(self, user_id: str, offset: int, limit: int) -> list[dict[str, Any]]:
        return self._request(
            "GET",
            "/rest/v1/generation_jobs",
            params={
                "user_id": f"eq.{user_id}",
                "status": "in.(succeeded,refunded)",
                "select": "id,prompt,size:metadata->>size,quality:metadata->>quality,strength:metadata->>strength,requested_count,generated_count,image_keys,provider,model,billing_mode,created_at",
                "order": "created_at.desc",
                "offset": str(offset),
                "limit": str(limit),
            },
        )

    def delete_user(self, user_id: str) -> None:
        self._request("DELETE", f"/auth/v1/admin/users/{user_id}")

    def admin_metrics(self, from_date: date, to_date: date) -> dict[str, Any]:
        return self.rpc("get_admin_metrics", {"p_from": from_date.isoformat(), "p_to": to_date.isoformat()})

    def admin_console_snapshot(self, from_date: date, to_date: date, search: str = "", limit: int = 50) -> dict[str, Any]:
        return self.rpc(
            "get_admin_console_snapshot",
            {
                "p_from": from_date.isoformat(),
                "p_to": to_date.isoformat(),
                "p_search": search[:80],
                "p_limit": max(1, min(limit, 100)),
            },
        )

    def admin_adjust_credits(self, admin_user_id: str, user_id: str, delta: int, reason: str, idempotency_key: str) -> dict[str, Any]:
        return self.rpc(
            "admin_adjust_credits",
            {
                "p_admin_user_id": admin_user_id,
                "p_user_id": user_id,
                "p_delta": delta,
                "p_reason": reason[:240],
                "p_idempotency_key": idempotency_key,
            },
        )

    def create_credit_order(
        self,
        user_id: str,
        channel: str,
        amount_fen: int,
        credits: int,
        out_trade_no: str,
        expires_at: str,
    ) -> dict[str, Any]:
        rows = self._request(
            "POST",
            "/rest/v1/credit_orders",
            params={"on_conflict": "out_trade_no"},
            body={
                "user_id": user_id,
                "channel": channel,
                "amount_fen": amount_fen,
                "credits": credits,
                "out_trade_no": out_trade_no,
                "status": "pending",
                "expires_at": expires_at,
            },
            headers={"Prefer": "return=representation,resolution=ignore-duplicates"},
        )
        return rows[0] if isinstance(rows, list) and rows else {}

    def update_credit_order_payment(self, order_id: str, **fields: Any) -> dict[str, Any]:
        rows = self._request(
            "PATCH",
            "/rest/v1/credit_orders",
            params={"id": f"eq.{order_id}"},
            body=fields,
            headers={"Prefer": "return=representation"},
        )
        return rows[0] if isinstance(rows, list) and rows else {}

    def get_credit_order(self, user_id: str, order_id: str) -> dict[str, Any] | None:
        rows = self._request(
            "GET",
            "/rest/v1/credit_orders",
            params={
                "id": f"eq.{order_id}",
                "user_id": f"eq.{user_id}",
                "select": "id,channel,amount_fen,credits,out_trade_no,status,code_url,payment_url,expires_at,paid_at,created_at",
                "limit": "1",
            },
        )
        return rows[0] if isinstance(rows, list) and rows else None

    def complete_credit_order(
        self, out_trade_no: str, provider_trade_no: str, paid_amount_fen: int, metadata: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return self.rpc(
            "complete_credit_order",
            {
                "p_out_trade_no": out_trade_no,
                "p_provider_trade_no": provider_trade_no,
                "p_paid_amount_fen": paid_amount_fen,
                "p_metadata": metadata or {},
            },
        )


def utc_milliseconds_since(start_time: float) -> int:
    return max(0, round((time.monotonic() - start_time) * 1000))
