"""Server-owned tavern credit orchestration. No provider retries or prompt storage."""
import hashlib
import json
import os
import uuid
from datetime import datetime, timedelta, timezone

from flask import jsonify, request

try:
    from backend.credits import credit_amount
    from backend.supabase_service import SupabaseError, SupabaseGateway, is_supabase_configured
    from backend.tavern_pricing import PRICING_MODEL, PRICING_VERSION, quote_tavern_credits, reserve_tavern_credits
except ModuleNotFoundError:
    from credits import credit_amount
    from supabase_service import SupabaseError, SupabaseGateway, is_supabase_configured
    from tavern_pricing import PRICING_MODEL, PRICING_VERSION, quote_tavern_credits, reserve_tavern_credits


DEFAULT_ENDPOINT = "https://api.buytoken.work/v1/chat/completions"
BILLING_STATUSES = {"held", "settled", "refunded", "awaiting_review"}
USAGE_FIELDS = ("input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_miss_tokens", "reasoning_tokens")


class TavernPlatformError(Exception):
    def __init__(self, code, message, status=503, uncertain=False, billing=None):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status
        self.uncertain, self.billing = uncertain, billing


def normalize_request_id(value):
    try:
        if not isinstance(value, str):
            raise ValueError()
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise TavernPlatformError("TAVERN_INVALID_REQUEST_ID", "请提供有效的对话请求编号。", 400) from None


def platform_settings(validate_endpoint):
    """Fail closed; public config never returns credentials or endpoint."""
    if os.getenv("PLATFORM_TAVERN_ENABLED", "").strip().lower() != "true":
        return None
    key = os.getenv("PLATFORM_TAVERN_API_KEY", "").strip()
    model = os.getenv("PLATFORM_TAVERN_MODEL", PRICING_MODEL).strip()
    endpoint = os.getenv("PLATFORM_TAVERN_API_ENDPOINT", DEFAULT_ENDPOINT).strip()
    if (not key or len(key) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in key)
            or model != PRICING_MODEL or not is_supabase_configured()):
        return None
    try:
        validate_endpoint(endpoint)
    except Exception:
        return None
    return {"key": key, "model": model, "endpoint": endpoint}


def clean_usage(value):
    """Whitelist already-normalized usage without inventing missing counts."""
    if not isinstance(value, dict):
        return None
    status = value.get("status")
    if not isinstance(status, str) or status not in {"confirmed", "partial", "missing", "invalid"}:
        return None
    result = {"status": status}
    bad = False
    for field in USAGE_FIELDS:
        count = value.get(field)
        valid = type(count) is int and 0 <= count <= 2 ** 53 - 1
        result[field] = count if valid else None
        bad = bad or (count is not None and not valid)
    if bad:
        result["status"] = "partial" if any(result[key] is not None for key in USAGE_FIELDS) else "invalid"
    return result


def _credit(value):
    try:
        return format(credit_amount(value), ".4f") if value is not None else None
    except (ValueError, TypeError):
        return None


def billing_fields(record):
    status = record.get("billing_status")
    if status not in BILLING_STATUSES:
        status = "awaiting_review"
    return {"request_id": record.get("request_id"), "status": status,
            "reserved_credits": _credit(record.get("reserved_credits")),
            "charged_credits": _credit(record.get("charged_credits")) if status in {"settled", "refunded"} else None}


def public_request(record, admin=False):
    billing = billing_fields(record)
    result = {**billing, "billing": billing, "request_status": record.get("status"),
              "model": record.get("model"), "kind": record.get("kind"),
              "usage": clean_usage(record.get("usage")), "created_at": record.get("created_at"),
              "error_code": record.get("error_code"), "content": None}
    # Defense in depth: SQL also expires the response. Never expose chat inputs.
    try:
        created = datetime.fromisoformat(str(record.get("created_at", "")).replace("Z", "+00:00"))
        expires_raw = record.get("response_expires_at")
        expires = datetime.fromisoformat(str(expires_raw).replace("Z", "+00:00")) if expires_raw else created + timedelta(hours=12)
        now = datetime.now(timezone.utc)
        if not admin and created.tzinfo and expires.tzinfo and created <= now < expires <= now + timedelta(hours=12):
            content = record.get("response_text")
            if isinstance(content, str) and content.strip() and len(content) <= 65536:
                result["content"] = content
    except (ValueError, TypeError, OverflowError):
        pass
    if admin:
        result["user_id"] = record.get("user_id")
    return result


class TavernStore:
    def __init__(self):
        self.gateway = SupabaseGateway()

    def rpc(self, name, body):
        result = self.gateway.rpc(name, body)
        if not isinstance(result, dict) or result.get("ok") is not True:
            code = result.get("code") if isinstance(result, dict) else None
            messages = {
                "INSUFFICIENT_CREDITS": "积分不足，暂时无法预留本次对话费用。",
                "EMAIL_UNVERIFIED": "请先完成邮箱验证。", "ACCOUNT_FROZEN": "当前账户不可用。",
                "TAVERN_REQUEST_CONFLICT": "该请求编号对应的参数不同，请查询原请求，不要重复提交。",
                "TAVERN_NOT_FOUND": "未找到本人的对话请求。", "ADMIN_REQUIRED": "没有管理员权限。",
                "TAVERN_INVALID_USAGE": "真实用量不完整或不一致，无法结算。",
                "TAVERN_ALREADY_RESOLVED": "该请求已经处理，请刷新账单。",
                "TAVERN_REVIEW_REQUIRED": "存在待核对的对话账单，请先完成核对后再使用平台积分。",
                "TAVERN_PENDING_LIMIT": "已有三笔待确认请求，请先查询账单，不要重复发送。",
                "TAVERN_USAGE_UNSETTLEABLE": "实际用量不可信或超过预留范围，请先核实账单。",
                "TAVERN_REQUEST_AMBIGUOUS": "请求编号对应多个账户，请明确选择目标账户。",
                "TAVERN_REVIEW_NOT_READY": "该请求可能仍在生成，请稍后查询后再核对。",
                "TAVERN_INPUT_INVALID": "账务请求参数无效。",
                "TAVERN_EVENT_INVALID": "账务请求状态无效，请保留原请求编号。",
                "TAVERN_REVIEW_INVALID": "管理员核对参数无效。",
            }
            known = code in messages
            status = 404 if code == "TAVERN_NOT_FOUND" else 403 if code in {"EMAIL_UNVERIFIED", "ACCOUNT_FROZEN", "ADMIN_REQUIRED"} else 409 if known else 503
            raise TavernPlatformError(code if known else "TAVERN_DATABASE_UNAVAILABLE",
                                      messages.get(code, "对话账务服务暂不可用，请保留请求编号后查询。"), status)
        return result

    def ready(self):
        try:
            value = self.gateway.rpc("tavern_billing_ready", {})
            return (isinstance(value, dict) and value.get("ok") is True and value.get("ready") is True
                    and value.get("version") == 1 and value.get("pricing_version") == PRICING_VERSION
                    and value.get("precision") == "0.0001")
        except Exception:
            return False

    def begin(self, user_id, request_id, kind, body, endpoint, reserved):
        fingerprint = hashlib.sha256(json.dumps({"body": body, "kind": kind, "endpoint": endpoint,
                                                "pricing_version": PRICING_VERSION}, sort_keys=True,
                                               ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        return self.rpc("begin_tavern_request", {"p_user_id": user_id, "p_request_id": request_id,
                        "p_fingerprint": fingerprint, "p_model": body["model"], "p_kind": kind,
                        "p_reserved_credits": reserved})

    def apply(self, user_id, request_id, outcome, usage=None, content=None, error_code=None):
        # PostgreSQL text cannot represent NUL. Preserve real usage for billing
        # even when this one reply cannot be retained for later recovery.
        stored_content = None if isinstance(content, str) and "\x00" in content else content
        return self.rpc("apply_tavern_request", {"p_user_id": user_id, "p_request_id": request_id,
                        "p_outcome": outcome, "p_usage": clean_usage(usage), "p_response_text": stored_content,
                        "p_error_code": error_code})

    def get(self, user_id, request_id=None):
        return self.rpc("get_tavern_requests", {"p_user_id": user_id, "p_request_id": request_id})


def platform_available(validate_endpoint):
    settings = platform_settings(validate_endpoint)
    if not settings:
        return False
    try:
        return TavernStore().ready()
    except Exception:
        return False


def _authenticated(server, admin=False):
    try:
        value = server.require_admin_user() if admin else server.require_authenticated_user()
        return value[0] if admin else value
    except Exception as error:
        code = getattr(error, "code", "AUTH_REQUIRED")
        status = getattr(error, "status", 401)
        if code not in {"AUTH_REQUIRED", "AUTH_SESSION_EXPIRED", "AUTH_TOKEN_INVALID", "AUTH_VERIFY_UNAVAILABLE", "ADMIN_REQUIRED"}:
            code, status = "AUTH_VERIFY_UNAVAILABLE", 503
        raise TavernPlatformError(code, "没有管理员权限。" if code == "ADMIN_REQUIRED" else "请先登录，或刷新后重试身份验证。", status) from None


def _rate(server, scope, identity, count=12):
    try:
        server.enforce_rate_limit(scope, identity, count, 60)
    except server.ProviderError:
        raise TavernPlatformError("TAVERN_RATE_LIMITED", "操作过于频繁，请稍后再试。", 429) from None


def _unknown(request_id, reserved=None, status="awaiting_review"):
    return {"request_id": request_id, "status": status, "reserved_credits": reserved, "charged_credits": None}


def platform_chat(data, server, submit_chat, build_chat_request, validate_endpoint):
    settings = platform_settings(validate_endpoint)
    if not settings:
        raise TavernPlatformError("TAVERN_PLATFORM_UNAVAILABLE", "平台对话服务尚未启用，请使用自带 API Key 模式。", 503)
    if request.headers.get("X-Tavern-Api-Key") or request.headers.get("X-Tavern-Endpoint"):
        raise TavernPlatformError("TAVERN_PLATFORM_OVERRIDE", "平台模式不能覆盖服务 Key 或接口。", 400)
    if data.get("model", settings["model"]) != settings["model"]:
        raise TavernPlatformError("TAVERN_INVALID_MODEL", "平台模式只支持当前已定价的模型。", 400)
    request_id = normalize_request_id(data.get("request_id"))
    kind = data.get("kind", "chat")
    if not isinstance(kind, str) or kind not in {"chat", "summary", "assist"}:
        raise TavernPlatformError("TAVERN_INVALID_INPUT", "对话请求类型无效。", 400)
    body = build_chat_request({key: value for key, value in data.items() if key not in {"request_id", "kind"}})
    body["model"] = settings["model"]
    user = _authenticated(server)
    _rate(server, "tavern-platform-ip", request.remote_addr or "unknown", 20)
    _rate(server, "tavern-platform-user", user.id)
    reserved = reserve_tavern_credits(body)
    if reserved is None:
        raise TavernPlatformError("TAVERN_CONTEXT_LIMIT", "上下文超出平台预留费用上限。", 400)
    try:
        store = TavernStore()
    except SupabaseError:
        raise TavernPlatformError("TAVERN_PLATFORM_UNAVAILABLE", "平台对话账务服务尚未就绪。", 503) from None
    if not store.ready():
        raise TavernPlatformError("TAVERN_PLATFORM_UNAVAILABLE", "平台对话账务服务尚未就绪。", 503)
    try:
        begun = store.begin(user.id, request_id, kind, body, settings["endpoint"], reserved)
    except TavernPlatformError as error:
        if error.status < 500:
            raise
        raise TavernPlatformError("TAVERN_DATABASE_UNKNOWN", "预留结果暂未确认；本次不会继续提交模型，请保留请求编号查询。", 503, True,
                                  _unknown(request_id, reserved)) from None
    except Exception:
        # A transaction may have committed despite a lost HTTP response.
        raise TavernPlatformError("TAVERN_DATABASE_UNKNOWN", "预留结果暂未确认；本次不会继续提交模型，请保留请求编号查询。", 503, True,
                                  _unknown(request_id, reserved)) from None
    record = begun.get("request")
    if not isinstance(record, dict) or record.get("request_id") != request_id:
        raise TavernPlatformError("TAVERN_DATABASE_UNKNOWN", "账务响应无效，请保留请求编号查询。", 503, True, _unknown(request_id, reserved))
    if begun.get("leader") is not True:
        saved = public_request(record)
        if saved["content"] is not None and saved["request_status"] == "completed":
            return {"success": True, "content": saved["content"], "usage": saved["usage"], "billing": saved["billing"],
                    "request_id": request_id, "billing_mode": "platform", "streaming": False,
                    "charged_credits": saved["charged_credits"], "credit_balance": begun.get("balance"), "idempotent": True}
        uncertain = saved["status"] in {"held", "awaiting_review"}
        raise TavernPlatformError("TAVERN_REQUEST_PENDING" if uncertain else "TAVERN_REQUEST_FINISHED",
                                  "该请求已存在，请查询账单；原请求不会再次提交模型。", 409, uncertain, saved["billing"])
    if record.get("billing_status") != "held" or record.get("status") != "reserved":
        raise TavernPlatformError("TAVERN_DATABASE_UNKNOWN", "账务状态无效，请保留请求编号查询。", 503, True, billing_fields(record))
    try:
        result = submit_chat(settings["endpoint"], settings["key"], body)
    except Exception as error:
        # Only the provider's explicit not-submitted/rejected errors may refund.
        explicit = hasattr(error, "uncertain") and hasattr(error, "code")
        uncertain = not explicit or error.uncertain
        code = error.code if explicit else "TAVERN_RESULT_UNKNOWN"
        event = "unknown" if uncertain else "rejected" if code == "TAVERN_REQUEST_REJECTED" else "not_submitted"
        try:
            applied = store.apply(user.id, request_id, event, error_code=code)
            billing = billing_fields(applied["request"])
        except Exception:
            raise TavernPlatformError("TAVERN_DATABASE_UNKNOWN", "请求或退款结果暂未确认，请保留请求编号查询，不要重复发送。", 503, True,
                                      _unknown(request_id, reserved)) from None
        raise TavernPlatformError(code, getattr(error, "message", "对话结果暂未确认，请查询请求记录。"),
                                  getattr(error, "status", 502), uncertain, billing) from None
    try:
        applied = store.apply(user.id, request_id, "completed", result["usage"], result["content"])
        billing = billing_fields(applied["request"])
        balance = applied.get("balance")
    except Exception:
        # Keep the already received reply; a failed settlement is never a refund.
        billing, balance = _unknown(request_id, reserved), None
    return {"success": True, "content": result["content"], "usage": clean_usage(result["usage"]),
            "billing": billing, "request_id": request_id, "billing_mode": "platform", "streaming": False,
            "charged_credits": billing["charged_credits"], "credit_balance": balance}


def register_platform_routes(bp, server):
    def check_origin():
        origin = request.headers.get("Origin")
        if (origin and origin.rstrip("/") not in {request.host_url.rstrip("/"), *server.ALLOWED_ORIGINS}
                or request.headers.get("Sec-Fetch-Site") == "cross-site"):
            raise TavernPlatformError("TAVERN_ORIGIN_FORBIDDEN", "请求来源不受支持。", 403)

    @bp.get("/requests")
    @bp.get("/requests/<request_id>")
    def requests_list(request_id=None):
        check_origin()
        user = _authenticated(server)
        _rate(server, "tavern-request-query", user.id, 60)
        value = TavernStore().get(user.id, normalize_request_id(request_id) if request_id else None)
        records = [public_request(row) for row in value.get("requests", [])[:50]]
        if request_id and not records:
            raise TavernPlatformError("TAVERN_NOT_FOUND", "未找到本人的对话请求。", 404)
        return jsonify(success=True, requests=records, request=records[0] if request_id else None,
                       credit_balance=value.get("balance"))

    @bp.get("/admin/overview")
    def admin_overview():
        check_origin()
        actor = _authenticated(server, admin=True)
        if request.args.get("scope") == "all":
            if any(key != "scope" for key in request.args):
                raise TavernPlatformError("TAVERN_INVALID_INPUT", "累计统计不接受日期或用户筛选。", 400)
            _rate(server, "tavern-admin-overview", actor.id, 30)
            value = TavernStore().rpc("admin_tavern_totals", {"p_actor_id": actor.id})
            stats = value.get("stats", {})
            fields = ("requests", "users", "chat", "summary", "assist", "credits_spent")
            return jsonify(success=True, scope="all", stats={key: stats.get(key) for key in fields})
        days = request.args.get("days", "30")
        if days not in {"7", "30", "90"}:
            raise TavernPlatformError("TAVERN_INVALID_INPUT", "请选择近7、30或90天。", 400)
        _rate(server, "tavern-admin-overview", actor.id, 30)
        value = TavernStore().rpc("admin_tavern_overview", {"p_actor_id": actor.id, "p_days": int(days)})
        return jsonify(success=True, days=value.get("days"), since=value.get("since"), stats=value.get("stats", {}),
                       requests=[public_request(row, admin=True) for row in value.get("requests", [])[:50]])

    @bp.get("/admin/requests")
    def admin_requests():
        check_origin()
        actor = _authenticated(server, admin=True)
        _rate(server, "tavern-admin-query", actor.id, 60)
        value = TavernStore().rpc("list_tavern_billing_reviews", {"p_actor_id": actor.id})
        return jsonify(success=True, requests=[public_request(row, admin=True) for row in value.get("requests", [])[:50]])

    @bp.post("/admin/requests/<request_id>/resolve")
    def admin_resolve(request_id):
        check_origin()
        actor = _authenticated(server, admin=True)
        _rate(server, "tavern-admin-resolve", actor.id, 20)
        if request.content_length and request.content_length > 8192:
            raise TavernPlatformError("TAVERN_INVALID_INPUT", "核对数据过大。", 413)
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or set(data) - {"user_id", "action", "usage", "reason"}:
            raise TavernPlatformError("TAVERN_INVALID_INPUT", "核对参数无效。", 400)
        reason = data.get("reason")
        action = data.get("action")
        if (not isinstance(reason, str) or not 5 <= len(reason.strip()) <= 500
                or any(ord(char) < 32 and char not in "\n\r\t" or ord(char) == 127 for char in reason)
                or not isinstance(action, str) or action not in {"refund", "settle"}):
            raise TavernPlatformError("TAVERN_INVALID_INPUT", "请填写5–500字的核对原因，并选择退款或结算。", 400)
        usage = clean_usage(data.get("usage")) if action == "settle" else None
        if action == "settle" and quote_tavern_credits(PRICING_MODEL, usage) is None:
            raise TavernPlatformError("TAVERN_INVALID_USAGE", "请填写可信且完整一致的实际输入、输出、总计和缓存用量。", 400)
        value = TavernStore().rpc("resolve_tavern_request", {
            "p_actor_id": actor.id, "p_user_id": normalize_request_id(data.get("user_id")),
            "p_request_id": normalize_request_id(request_id), "p_action": action,
            "p_usage": usage, "p_reason": reason.strip(),
        })
        return jsonify(success=True, request=public_request(value["request"], admin=True), credit_balance=value.get("balance"))
