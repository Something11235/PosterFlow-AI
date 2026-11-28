"""Authenticated BuyToken presentation generation, editing, chat and recovery."""
import hashlib
import json
import logging
import os
import time
import uuid
from decimal import Decimal

from flask import Blueprint, jsonify, request

try:
    from backend.ppt_document import MAX_PAGES, InvalidDocument, compact, prepare, result_document
    from backend.ppt_preview import PptPreview
    from backend.supabase_service import SupabaseError, SupabaseGateway
    from backend.tavern_platform import DEFAULT_ENDPOINT
    from backend.tavern_routes import TavernError, normalize_usage, provider_reply, validate_endpoint
    from backend.tavern_stream import run_without_deltas, stream_response
except ModuleNotFoundError:
    from ppt_document import MAX_PAGES, InvalidDocument, compact, prepare, result_document
    from ppt_preview import PptPreview
    from supabase_service import SupabaseError, SupabaseGateway
    from tavern_platform import DEFAULT_ENDPOINT
    from tavern_routes import TavernError, normalize_usage, provider_reply, validate_endpoint
    from tavern_stream import run_without_deltas, stream_response


DEFAULT_MODEL = "gpt-6.2-astra"
PPT_DEADLINE_SECONDS = 120  # One absolute provider deadline, including any protocol negotiation.
PPT_EDIT_CHAT_SECONDS = 250
# Supplier RMB per million: ordinary input, output, cache read, and optional 5-minute write.
MODELS = {
    DEFAULT_MODEL: ("GPT 6.2 Astra", "3.2", "16", "0.16", "4"),
    "gpt-6.2-sol": ("GPT 6.2 Sol", "0.8", "4", "0.04", "1"),
    "deepseek-v4.1-flash": ("DeepSeek 4.1 Flash", "0.8", "3.2", "0.016"),
}
MESSAGES = {
    "INSUFFICIENT_CREDITS": (409, "积分不足，无法预留本次 PPT 任务费用。"),
    "ACCOUNT_FROZEN": (403, "当前账户不可用。"),
    "EMAIL_UNVERIFIED": (403, "请先完成邮箱验证。"),
    "PPT_NOT_FOUND": (404, "未找到本账户的这项 PPT 任务。"),
    "PPT_REQUEST_CONFLICT": (409, "这个编号已用于另一项 PPT 请求，请查看原任务。"),
    "PPT_INPUT_INVALID": (400, "请求参数无效，请检查模型、主题或选区。"),
    "PPT_PENDING_LIMIT": (429, "已有三项 PPT 任务处理中，请稍后查看结果。"),
    "PPT_MODEL_UNAVAILABLE": (503, "此 PPT 模型暂未配置，请联系站主开通。"),
    "PPT_DATABASE_UNAVAILABLE": (503, "暂时无法确认 PPT 任务状态，请保留当前任务并查询原编号。"),
    "PPT_RESULT_INVALID": (200, "模型未返回可用结果，预留积分已退回。"),
    "PPT_PROVIDER_REJECTED": (200, "模型服务商未接受本次请求，预留积分已退回。"),
    "PPT_PROVIDER_UNREACHABLE": (200, "暂时无法连接模型服务商，预留积分已退回。"),
    "PPT_PROVIDER_TIMEOUT": (200, "本次模型请求超时，本步预留积分已退回。"),
    "PPT_PROVIDER_UNAVAILABLE": (200, "模型服务商暂时无法提供该模型，本步预留积分已退回。"),
    "PPT_RESULT_UNAVAILABLE": (200, "未收到可交付的模型结果，预留积分已退回。"),
    "PPT_RESULT_EXPIRED": (200, "原任务超时，预留积分已退回。"),
    "PPT_USAGE_UNCONFIRMED": (200, "服务商用量未能核实，已释放本次预留积分。"),
}


class PptError(Exception):
    def __init__(self, code, message=None, status=None):
        default_status, default_message = MESSAGES[code]
        self.code = code
        self.status = status or default_status
        self.message = message or default_message
        super().__init__(self.message)


def model_settings(model):
    group_key = "PLATFORM_PPT_DEEPSEEK_API_KEY" if model == "deepseek-v4.1-flash" else "PLATFORM_PPT_GPT_API_KEY"
    key = os.getenv("PLATFORM_PPT_API_KEY", "").strip() or os.getenv(group_key, "").strip()
    endpoint = os.getenv("PLATFORM_PPT_API_ENDPOINT", "").strip() or DEFAULT_ENDPOINT
    if not key or len(key) > 4096 or not all(33 <= ord(c) <= 126 for c in key):
        raise PptError("PPT_MODEL_UNAVAILABLE")
    try:
        validate_endpoint(endpoint)
    except TavernError:
        raise PptError("PPT_MODEL_UNAVAILABLE") from None
    return endpoint, key


def catalog():
    models = []
    for model, (label, *rates) in MODELS.items():
        costs = dict(zip(("input", "output", "cache_read", "cache_write"), map(Decimal, rates)))
        models.append({"id": model, "label": label,
                       "cost_rmb_per_million": {k: float(v) for k, v in costs.items()},
                       "credits_per_million": {k: float(v*15) for k, v in costs.items()}})
    return {"default_model": DEFAULT_MODEL, "models": models, "max_pages": MAX_PAGES, "pricing_version": 1}


def request_id(value):
    try:
        if isinstance(value, str):
            return str(uuid.UUID(value))
    except ValueError:
        pass
    raise PptError("PPT_INPUT_INVALID", "任务编号无效。")


def rpc(name, params):
    try:
        result = SupabaseGateway().rpc(name, params)
    except SupabaseError:
        raise PptError("PPT_DATABASE_UNAVAILABLE") from None
    if not isinstance(result, dict) or result.get("ok") is not True or not isinstance(result.get("request"), dict):
        code = result.get("code") if isinstance(result, dict) else None
        raise PptError(code if isinstance(code, str) and code in MESSAGES else "PPT_DATABASE_UNAVAILABLE")
    return result


def public_record(record):
    payload = dict(record)
    code = payload.pop("error_code", None)
    if code in MESSAGES:
        field = "note" if payload.get("status") == "succeeded" else "error"
        payload[field] = {"code": code, "message": MESSAGES[code][1]}
    return payload


def public_result(record):
    return jsonify(public_record(record)), 202 if record.get("status") == "processing" else 200


def ppt_usage(raw):
    usage = normalize_usage(raw)
    details = raw.get("prompt_tokens_details") if isinstance(raw, dict) else None
    if not isinstance(details, dict) or details.get("cache_write_tokens") is None:
        return usage
    written = details["cache_write_tokens"]
    incoming, cached = usage["input_tokens"], usage["cache_read_tokens"]
    if type(written) is not int or incoming is None or written < 0 or written > incoming - (cached or 0):
        usage["status"] = "invalid"
    else:
        usage["cache_write_tokens"] = written
    return usage


def provider_events(endpoint, key, body, deadline, streaming, kind):
    def invoke(options):
        return provider_reply(endpoint, key, options, deadline, usage_reader=ppt_usage, model_fallback=True, structured=kind != "chat")

    if streaming:
        preview = None if kind == "motion_only" else PptPreview(kind)
        stream = invoke({**body, "stream": True, "stream_options": {"include_usage": True}})
        try:
            while True:
                try:
                    fragment = next(stream)
                except StopIteration as finished:
                    return finished.value
                if fragment is None:
                    yield {"type": "heartbeat"}
                elif preview is not None:
                    yield from preview.feed(fragment)
        except TavernError as error:
            # Some compatible routes explicitly reject the streaming parameter
            # before accepting a completion. Never replay an ambiguous POST.
            if error.code != "TAVERN_STREAM_UNSUPPORTED":
                raise
        finally:
            stream.close()
    return (yield from invoke(body))


def run_request(kind, user_id, payload, deadline, streaming=False):
    rid = request_id(payload.get("request_id"))
    model = payload.get("model", DEFAULT_MODEL)
    if not isinstance(model, str) or model not in MODELS:
        raise PptError("PPT_INPUT_INVALID", "请选择可用的 PPT 模型。")
    try:
        messages, output_bound, original, selected = prepare(kind, payload)
        # Hash the client operation, not deploy-specific prompts, so a retry across
        # releases still recovers the first recorded request.
        fingerprint = hashlib.sha256(compact(payload).encode("utf-8")).hexdigest()
    except (InvalidDocument, ValueError, RecursionError, UnicodeError) as error:
        raise PptError("PPT_INPUT_INVALID", str(error) if isinstance(error, InvalidDocument) else None) from None
    endpoint, key = model_settings(model)
    ids = {"p_user_id": str(user_id), "p_request_id": rid}
    input_bound = 1024 + sum(len(m["content"].encode()) + len(m["role"]) + 64 for m in messages)
    reply = rpc("begin_ppt_request", {**ids, "p_kind": kind, "p_model": model, "p_fingerprint": fingerprint,
                                       "p_input_bound": input_bound, "p_output_bound": output_bound})
    if reply.get("leader") is not True:
        return public_result(reply["request"])
    body = {"model": model, "messages": messages, "stream": False,
            "max_tokens" if model == "deepseek-v4.1-flash" else "max_completion_tokens": output_bound}
    if kind != "chat":
        body["response_format"] = {"type": "json_object"}
    work = finish_request(ids, kind, payload, original, selected, endpoint, key, body, deadline, streaming)
    if streaming:
        def stream_error(error):
            error = error if isinstance(error, PptError) else PptError("PPT_DATABASE_UNAVAILABLE")
            return {"error": {"code": error.code, "message": error.message}, "status": error.status}
        return stream_response(work, stream_error, finish_on_disconnect=True,
                               delta_packet=lambda event: event, result_packet=lambda record: {"type": "result", "data": record})
    return jsonify(run_without_deltas(work))


def finish_request(ids, kind, payload, original, selected, endpoint, key, body, deadline, streaming):
    if streaming:
        yield {"type": "start"}
    if deadline is None:
        # Generation gets its full provider budget after auth and reservation.
        deadline = time.monotonic() + PPT_DEADLINE_SECONDS
    usage, document, error_code = None, None, None
    diagnostic = None
    try:
        preview_kind = kind
        if kind == "page" and "motion_only" in payload:
            preview_kind = "motion_only"
        elif kind == "page" and "original_edit" in payload:
            preview_kind = "original_edit"
        answer = yield from provider_events(endpoint, key, body, deadline, streaming, preview_kind)
        usage = answer["usage"]
        if answer.get("finish_reason") == "content_filter":
            raise InvalidDocument("服务商明确拒绝输出本次内容，未能交付演示稿结果。")
        try:
            document = result_document(kind, answer["content"], payload.get("page_count", 6), original, selected)
        except (ValueError, TypeError, KeyError, RecursionError):
            if answer.get("finish_reason") == "length":
                raise InvalidDocument("模型达到输出 Token 上限，返回内容未通过演示稿校验。") from None
            raise
    except TavernError as error:
        usage = error.usage
        if error.code == "TAVERN_RESPONSE_INVALID":
            error_code = "PPT_RESULT_INVALID"
            diagnostic = "服务商响应未通过读取或有效文字校验。"
        elif error.code == "TAVERN_MODEL_TIMEOUT" or time.monotonic() >= deadline:
            error_code = "PPT_PROVIDER_TIMEOUT"
        elif error.code == "TAVERN_MODEL_UNAVAILABLE":
            error_code = "PPT_PROVIDER_UNAVAILABLE"
        elif error.code in ("TAVERN_DNS_BUSY", "TAVERN_DNS_UNAVAILABLE", "TAVERN_CONNECTION_FAILED"):
            error_code = "PPT_PROVIDER_UNREACHABLE"
        else:
            error_code = "PPT_RESULT_UNAVAILABLE" if error.uncertain else "PPT_PROVIDER_REJECTED"
    except InvalidDocument as error:
        error_code = "PPT_RESULT_INVALID"
        # The document validators construct these messages from rule labels and counts only.
        diagnostic = str(error)
    except json.JSONDecodeError as error:
        error_code = "PPT_RESULT_INVALID"
        diagnostic = f"JSON 解析失败，第 {error.lineno} 行、第 {error.colno} 列。"
    except (ValueError, RecursionError, TypeError, KeyError) as error:
        error_code = "PPT_RESULT_INVALID"
        diagnostic = f"处理模型结果时出现未分类的 {type(error).__name__}。"
    finish = {**ids, "p_result": document, "p_usage": usage, "p_error_code": error_code}
    if diagnostic:
        finish["p_diagnostic"] = diagnostic
        logging.getLogger(__name__).warning("PPT result invalid request=%s kind=%s detail=%s",
                                            ids["p_request_id"], kind, diagnostic)
    try:
        settled = rpc("finish_ppt_request", finish)
    except PptError as error:
        if error.code != "PPT_DATABASE_UNAVAILABLE":
            raise
        # A lost DB response is safe to retry, unlike the paid model request.
        settled = rpc("finish_ppt_request", finish)
    return public_record(settled["request"])


def create_ppt_blueprint(server):
    bp = Blueprint("ppt", __name__, url_prefix="/api/ppt")

    @bp.after_request
    def private_response(response):
        cache = "private, no-store"
        response.headers["Cache-Control"] = cache + ", no-transform" if response.mimetype == "application/x-ndjson" else cache
        return response

    @bp.errorhandler(PptError)
    @bp.errorhandler(server.ProviderError)
    def error_response(error):
        return jsonify(error={"code": error.code, "message": error.message},
                       code=error.code, message=error.message), error.status

    @bp.get("/config")
    def configure():
        return jsonify(catalog())

    @bp.get("/requests/<rid>")
    def recover(rid):
        user = server.require_authenticated_user()
        reply = rpc("read_ppt_request", {"p_user_id": str(user.id), "p_request_id": request_id(rid)})
        return public_result(reply["request"])

    def submit(kind):
        deadline = time.monotonic() + PPT_EDIT_CHAT_SECONDS if kind in ("chat", "edit") else None
        origin = request.headers.get("Origin")
        if (origin and origin.rstrip("/") not in {request.host_url.rstrip("/"), *server.ALLOWED_ORIGINS}
                or request.headers.get("Sec-Fetch-Site") == "cross-site"):
            raise PptError("PPT_INPUT_INVALID", "请求来源不受支持。", 403)
        user = server.require_authenticated_user()
        server.enforce_rate_limit("ppt-submit", str(user.id), 30, 60)
        if request.content_length and request.content_length > 512_000:
            raise PptError("PPT_INPUT_INVALID", "请求过大，请减少参考资料。", 413)
        try:
            data = request.get_json(silent=True)
        except (RecursionError, ValueError):
            data = None
        if not isinstance(data, dict):
            raise PptError("PPT_INPUT_INVALID")
        streaming = kind in ("outline", "page") and request.accept_mimetypes["application/x-ndjson"] > 0 and (
            "application/x-ndjson" in request.headers.get("Accept", "").lower())
        return run_request(kind, user.id, data, deadline, streaming=streaming)

    @bp.post("/outline")
    def outline():
        return submit("outline")

    @bp.post("/page")
    def page():
        return submit("page")

    @bp.post("/generate")
    def generate():
        return submit("generate")

    @bp.post("/edit")
    def edit():
        return submit("edit")

    @bp.post("/chat")
    def chat():
        return submit("chat")

    return bp
