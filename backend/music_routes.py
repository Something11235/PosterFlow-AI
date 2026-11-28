"""Durable, owner-scoped music requests, separate from the image ledger."""
import hashlib
import hmac
import json
import os
import uuid
import time
from decimal import Decimal

from flask import Blueprint, jsonify, request

try:
    from backend.music_provider import MusicError, build_music_request, custom_endpoints, query_music, submit_music, failure_reason
    from backend.supabase_service import SupabaseError, SupabaseGateway, is_supabase_configured
    from backend.prompt_history import music_prompt_snapshot
    from backend.music_operations import OPERATIONS, operation_request, operation_fingerprint, submit_operation
    from backend.flow_audio import flow_cover_request, submit_flow, reconcile_flow_import
except ModuleNotFoundError:
    from music_provider import MusicError, build_music_request, custom_endpoints, query_music, submit_music, failure_reason
    from supabase_service import SupabaseError, SupabaseGateway, is_supabase_configured
    from prompt_history import music_prompt_snapshot
    from music_operations import OPERATIONS, operation_request, operation_fingerprint, submit_operation
    from flow_audio import flow_cover_request, submit_flow, reconcile_flow_import

REQUEST_CREDITS = 2
PUBLIC_JOB_FIELDS = ("request_id", "billing_mode", "billing_unit", "credits_per_request", "credits_per_song", "model", "version", "status", "billing_status", "provider_task_id", "generated_count", "reserved_credits", "charged_credits", "error_code", "created_at", "operation", "reference_count", "flow_stage")


def stage_failure(code, importing):
    # Flow has only received audio_url at this stage. No lyrics or cover instruction have been sent.
    return "MUSIC_AUDIO_POLICY_REJECTED" if importing and code == "MUSIC_CONTENT_REJECTED" else code


def public_job(job):
    result = {key: job.get(key) for key in PUBLIC_JOB_FIELDS}
    if job.get("status") == "failed":
        result["error_code"] = stage_failure(job.get("error_code"), job.get("flow_stage") == "importing")
        result["failure_reason"] = failure_reason(result["error_code"])
    return result


class MusicStore:
    def __init__(self):
        self.gateway = SupabaseGateway()

    def rpc(self, name, body):
        result = self.gateway.rpc(name, body)
        if not isinstance(result, dict) or not result.get("ok"):
            code = result.get("code", "MUSIC_DATABASE_UNAVAILABLE") if isinstance(result, dict) else "MUSIC_DATABASE_UNAVAILABLE"
            messages = {"INSUFFICIENT_CREDITS": "积分不足，每次音乐生成需要 2 积分。", "EMAIL_UNVERIFIED": "请先完成邮箱验证。", "ACCOUNT_FROZEN": "账户当前不可用。", "MUSIC_REQUEST_CONFLICT": "该请求编号对应的参数不同，请保留原任务。", "MUSIC_NOT_FOUND": "未找到本人的音乐任务。"}
            raise MusicError(code, messages.get(code, "音乐任务处理暂时不可用。"), 404 if code == "MUSIC_NOT_FOUND" else 409)
        return result

    def begin(self, owner, user_id, request_id, mode, body, version, parameter_format=None):
        fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        snapshot = music_prompt_snapshot({**body, **({"parameter_format": parameter_format} if parameter_format in {"suno", "flowmusic"} else {})})
        return self.rpc("begin_music_job_with_history", {"p_owner": owner, "p_user_id": user_id, "p_request_id": request_id, "p_mode": mode, "p_model": body["model"], "p_version": version, "p_fingerprint": fingerprint, "p_prompt": snapshot["prompt"], "p_parameters": snapshot["parameters"]})

    def apply(self, owner, request_id, event, task_id=None, count=0, error_code=None):
        return self.rpc("apply_music_job", {"p_owner": owner, "p_request_id": request_id, "p_event": event, "p_task_id": task_id, "p_count": count, "p_error_code": error_code})

    def jobs(self, owner):
        return self.gateway._request("GET", "/rest/v1/music_jobs", params={"owner_scope": f"eq.{owner}", "select": ",".join(PUBLIC_JOB_FIELDS), "order": "created_at.desc,request_id.desc", "limit": "50"}) or []

    def get(self, owner, request_id):
        rows = self.gateway._request("GET", "/rest/v1/music_jobs", params={"owner_scope": f"eq.{owner}", "request_id": f"eq.{request_id}", "select": ",".join(PUBLIC_JOB_FIELDS), "limit": "1"})
        if not rows:
            raise MusicError("MUSIC_NOT_FOUND", "未找到本人的音乐任务。", 404)
        return rows[0]


def create_music_blueprint(require_user, optional_user, rate_limit, allowed_origins, reference_service=None):
    bp = Blueprint("music", __name__, url_prefix="/api/music")

    @bp.after_request
    def private_response(response):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @bp.errorhandler(MusicError)
    def music_error(error):
        diagnostic = {"provider_status": error.provider_status, "provider_code": error.provider_code} if error.provider_status is not None else {}
        if error.reason_code:
            diagnostic["reason_code"] = error.reason_code
        return jsonify(error=error.message, code=error.code, submission_unknown=error.uncertain, **diagnostic), error.status

    @bp.errorhandler(SupabaseError)
    def database_error(_error):
        return jsonify(error="音乐任务数据库尚未就绪，请检查开发配置和音乐迁移。", code="MUSIC_DATABASE_UNAVAILABLE"), 503

    @bp.errorhandler(Exception)
    def other_error(error):
        if hasattr(error, "code") and hasattr(error, "status") and hasattr(error, "message"):
            return jsonify(error=error.message, code=error.code), error.status
        return jsonify(error="音乐请求暂未完成，请保留原请求编号后查询。", code="MUSIC_SERVICE_UNAVAILABLE"), 503

    def context():
        mode = request.headers.get("X-Billing-Mode", "platform")
        if mode not in {"platform", "own_key"}:
            raise MusicError("INVALID_BILLING_MODE", "请选择平台积分或自带 Key。")
        if mode == "platform":
            user = require_user()
            key = os.getenv("APIMART_MUSIC_API_KEY", "").strip()
            if not key:
                raise MusicError("MUSIC_NOT_CONFIGURED", "平台音乐服务尚未配置，可选择自定义 API Key。", 503)
            return mode, key, f"user-{user.id}", user.id, None, None, "bearer"
        key = request.headers.get("X-Music-Api-Key", "").strip()
        if not key or len(key) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in key):
            raise MusicError("MUSIC_KEY_REQUIRED", "请填写有效的 API Key。")
        endpoint, query_template = custom_endpoints(request.headers.get("X-Music-Endpoint", "").strip(), request.headers.get("X-Music-Query-Template", "").strip())
        auth_type = request.headers.get("X-Music-Auth-Type", "bearer")
        if auth_type not in {"bearer", "x-api-key"}:
            raise MusicError("MUSIC_AUTH_TYPE_INVALID", "请选择有效的鉴权方式。")
        user = optional_user()
        identity = f"user-{user.id}" if user else "guest"
        owner = identity + "-" + hashlib.sha256(json.dumps([key, endpoint, query_template, auth_type]).encode()).hexdigest()
        return mode, key, owner, user.id if user else None, endpoint, query_template, auth_type

    def normalize_id(value):
        try:
            return str(uuid.UUID(value))
        except (ValueError, TypeError, AttributeError) as exc:
            raise MusicError("INVALID_MUSIC_REQUEST", "音乐请求编号无效。") from exc

    def check_origin():
        origin = request.headers.get("Origin")
        if origin and origin.rstrip("/") not in {request.host_url.rstrip("/"), *allowed_origins}:
            raise MusicError("MUSIC_ORIGIN_FORBIDDEN", "请求来源不受支持。", 403)

    def audio_context():
        mode, key, owner, user_id, endpoint, query_template, auth_type = context()
        if not reference_service:
            raise MusicError("MUSIC_REFERENCE_UNAVAILABLE", "音频创作服务尚未配置。", 503)
        if not user_id:
            raise MusicError("AUTH_REQUIRED", "请先登录后添加音频素材。", 401)
        if endpoint and endpoint.rstrip("/") != "https://api.apimart.ai/v1/music/generations":
            raise MusicError("MUSIC_OPERATION_UNSUPPORTED", "当前音乐服务未配置音频创作功能。")
        account = SupabaseGateway().rpc("get_account_snapshot", {"p_user_id": user_id})
        if not account.get("email_verified"):
            raise MusicError("EMAIL_UNVERIFIED", "请先完成邮箱验证后使用音频素材。", 403)
        if (account.get("profile") or {}).get("status") != "active":
            raise MusicError("ACCOUNT_FROZEN", "当前账户不可用。", 403)
        return mode, key, owner, user_id, endpoint, query_template, auth_type

    def reconcile(store, owner, job, key, query_template=None, auth_type="bearer"):
        if job.get("operation") == "flow_cover" and job.get("flow_stage") == "cover_submitting" and job.get("status") != "failed":
            return {"success": True, "job": public_job(job), "tracks": [], "warning": "改编提交结果待确认，请保留原任务编号，勿重复生成。"}
        if not job.get("provider_task_id"):
            return {"success": True, "job": public_job(job), "tracks": []}
        result = query_music(key, job["provider_task_id"], query_template, auth_type)
        if result["status"] == "failed":
            result["error_code"] = stage_failure(result.get("error_code"), job.get("flow_stage") == "importing")
        if job.get("operation") == "flow_cover" and job.get("flow_stage") == "importing" and job.get("status") != "failed":
            data = reconcile_flow_import(store, owner, job, result, key, auth_type)
            return {"success": True, **data, "job": public_job(data["job"])}
        if job.get("operation") == "flow_cover":
            result["progress"] = 30 + round(result["progress"] * .7)
        status = result["status"]
        if status == "completed" and not result["tracks"]:
            # Do not turn missing/expired files into a refund or a new paid job.
            return {"success": True, "job": public_job(job), "tracks": [], "warning": "任务已完成，但暂未取得可播放结果，请保留任务编号后刷新。"}
        event = status if status in {"completed", "failed", "unknown"} else "processing"
        applied = store.apply(owner, job["request_id"], event, count=len(result["tracks"]), error_code=result["error_code"])
        updated = applied["job"]
        tracks = result["tracks"] if status == "completed" and updated["billing_status"] in {"settled", "not_applicable"} else []
        visible_job = public_job(updated)
        if status == "failed":
            # An old already-refunded row can retain its original generic code;
            # show the newly queried reason without rewriting historical money.
            reason = result["error_code"]
            if reason and (reason not in {"MUSIC_TASK_FAILED", "MUSIC_PROVIDER_JOB_FAILED"} or
                           updated.get("error_code") in {None, "MUSIC_TASK_FAILED"}):
                visible_job.update(error_code=reason, failure_reason=failure_reason(reason))
        return {"success": True, "job": visible_job, "tracks": tracks, "progress": result["progress"], "credit_balance": applied.get("balance")}

    @bp.get("/config")
    def config():
        return jsonify(success=True, platform_configured=bool(os.getenv("APIMART_MUSIC_API_KEY", "").strip()) and is_supabase_configured(), database_configured=is_supabase_configured(), billing_unit="request", credits_per_request=REQUEST_CREDITS,
                       audio_operations=[*OPERATIONS, "flow_cover"] if reference_service and reference_service.available and is_supabase_configured() else [], reference_max_bytes=20*1024*1024, reference_max_seconds=480, reference_retention_hours=12)

    @bp.post("/references/uploads")
    def reference_upload():
        check_origin()
        _mode, _key, owner, user_id, _endpoint, _query, _auth = audio_context()
        rate_limit("music-audio-upload", user_id, 8, 60)
        raw = request.get_json(silent=True)
        if not isinstance(raw, dict) or set(raw) != {"filename", "size", "content_type"}:
            raise MusicError("MUSIC_REFERENCE_INVALID", "音频上传参数无效。")
        return jsonify(success=True, **reference_service.issue(owner, raw["filename"], raw["size"], raw["content_type"]))

    @bp.post("/references/complete")
    def reference_complete():
        check_origin()
        _mode, _key, owner, user_id, _endpoint, _query, _auth = audio_context()
        rate_limit("music-audio-verify", user_id, 8, 60)
        raw = request.get_json(silent=True)
        if not isinstance(raw, dict) or set(raw) != {"upload_ticket"}:
            raise MusicError("MUSIC_REFERENCE_INVALID", "音频校验参数无效。")
        return jsonify(success=True, reference=reference_service.complete(owner, raw["upload_ticket"]))

    @bp.post("/operations/<operation>")
    def generate_audio(operation):
        check_origin()
        mode, key, owner, user_id, endpoint, _query, auth_type = audio_context()
        rate_limit("music-submit", owner, 8, 60)
        raw = request.get_json(silent=True)
        if not isinstance(raw, dict) or set(raw) != {"request_id", "parameters", "references"}:
            raise MusicError("INVALID_MUSIC_INPUT", "音频创作请求无效。")
        request_id = normalize_id(raw["request_id"])
        receipts = raw["references"]
        if not isinstance(receipts, list) or not 1 <= len(receipts) <= 4:
            raise MusicError("MUSIC_REFERENCE_COUNT", "请添加 1–4 段参考音频。")
        flow = operation == "flow_cover"
        body = flow_cover_request(raw["parameters"], len(receipts)) if flow else operation_request(operation, raw["parameters"], len(receipts))
        values = [reference_service.verify(receipt, owner, allow_expired=True) for receipt in receipts]
        if len({item["id"] for item in values}) != len(values):
            raise MusicError("MUSIC_REFERENCE_INVALID", "同一段音频不能重复添加。")
        fingerprint = operation_fingerprint(operation, body, values)
        store = MusicStore()
        existing = store.gateway._request("GET", "/rest/v1/music_jobs", params={"owner_scope": "eq." + owner, "request_id": "eq." + request_id, "select": "*", "limit": "1"}) or []
        if existing:
            if existing[0].get("request_fingerprint") != fingerprint or existing[0].get("operation") != operation:
                raise MusicError("MUSIC_REQUEST_CONFLICT", "该请求编号对应的参数不同，请查询原任务。", 409)
            return jsonify(success=True, job=public_job(existing[0]), tracks=[], idempotent=True)
        if any(value["expires"] <= time.time()+900 for value in values):
            raise MusicError("MUSIC_REFERENCE_EXPIRED", "音频素材已过期或临近清理，请重新添加。")
        urls = reference_service.urls(values)
        history = {**raw["parameters"], "model": "flowmusic" if flow else "suno", "operation": operation}
        if flow:
            history = {"model": "flowmusic", "version": raw["parameters"].get("version", "lyria-3-pro"), "operation": operation,
                       "prompt": body["instruction"], "strength": format(Decimal(str(body["strength"])), "f"),
                       **({"title": body["title"]} if "title" in body else {})}
        snapshot = music_prompt_snapshot(history)
        reservation_args = {"p_owner": owner, "p_user_id": user_id, "p_request_id": request_id, "p_mode": mode, "p_version": raw["parameters"].get("version", "lyria-3-pro" if flow else "v6"), "p_fingerprint": fingerprint, "p_prompt": snapshot["prompt"], "p_parameters": snapshot["parameters"]}
        if not flow:
            reservation_args.update(p_operation=operation, p_reference_count=len(values))
        reserved = store.rpc("begin_flow_cover_job" if flow else "begin_music_audio_job", reservation_args)
        if reserved.get("existing"):
            return jsonify(success=True, job=public_job(reserved["job"]), tracks=[], idempotent=True)
        try:
            task_id = submit_flow(key, "uploadAudioFlowMusic", {"model": "flowmusic", "audio_url": urls[0]}, auth_type) if flow else submit_operation(key, operation, body, urls, endpoint, auth_type)
        except MusicError as error:
            if flow and error.reason_code == "MUSIC_CONTENT_REJECTED":
                error.reason_code = stage_failure(error.reason_code, True)
                error.message = failure_reason(error.reason_code)
            store.apply(owner, request_id, "submission_unknown" if error.uncertain else "rejected", error_code=error.reason_code or error.code)
            raise
        applied = store.apply(owner, request_id, "submitted", task_id=task_id)
        return jsonify(success=True, job=public_job(applied["job"]), tracks=[], credit_balance=applied.get("balance")), 202

    @bp.get("/tasks")
    def tasks():
        _mode, _key, owner, _user_id, _endpoint, _query, _auth = context()
        return jsonify(success=True, jobs=[public_job(job) for job in MusicStore().jobs(owner)])

    @bp.post("/generations")
    def generate():
        check_origin()
        raw = request.get_json(silent=True)
        if not isinstance(raw, dict) or set(raw) - {"request_id", "parameters"}:
            raise MusicError("INVALID_MUSIC_INPUT", "音乐请求格式无效。")
        request_id = normalize_id(raw.get("request_id"))
        mode, key, owner, user_id, endpoint, query_template, auth_type = context()
        body = build_music_request(raw.get("parameters"), allow_custom=mode == "own_key")
        rate_limit("music-submit", owner, 8, 60)
        store = MusicStore()
        version = raw["parameters"].get("version", "v6" if body["model"] == "suno" else "lyria-3-pro" if body["model"] == "flowmusic" else "")
        reservation = store.begin(owner, user_id, request_id, mode, body, version, parameter_format=raw["parameters"].get("parameter_format"))
        if reservation.get("existing"):
            return jsonify(success=True, job=public_job(reservation["job"]), tracks=[], credit_balance=reservation.get("balance"), idempotent=True)
        try:
            task_id = submit_music(key, body, endpoint, auth_type) if mode == "own_key" else submit_music(key, body)
        except MusicError as error:
            store.apply(owner, request_id, "submission_unknown" if error.uncertain else "rejected", error_code=error.reason_code or error.code)
            raise
        # Save failure is deliberately not caught/refunded: APIMart accepted it.
        applied = store.apply(owner, request_id, "submitted", task_id=task_id)
        return jsonify(success=True, job=public_job(applied["job"]), tracks=[], credit_balance=applied.get("balance")), 202

    @bp.get("/tasks/<request_id>")
    def task(request_id):
        _mode, key, owner, _user_id, _endpoint, query_template, auth_type = context()
        rate_limit("music-query", owner, 120, 60)
        store = MusicStore()
        return jsonify(reconcile(store, owner, store.get(owner, normalize_id(request_id)), key, query_template, auth_type))

    @bp.post("/reconcile")
    def scheduled_reconcile():
        secret = os.getenv("MUSIC_RECONCILE_SECRET", "")
        if not secret or not hmac.compare_digest(request.headers.get("Authorization", ""), "Bearer " + secret):
            raise MusicError("AUTH_REQUIRED", "需要对账服务凭证。", 401)
        key = os.getenv("APIMART_MUSIC_API_KEY", "").strip()
        if not key:
            raise MusicError("MUSIC_NOT_CONFIGURED", "平台音乐服务尚未配置。", 503)
        store = MusicStore()
        jobs = store.gateway._request("GET", "/rest/v1/music_jobs", params={"billing_mode": "eq.platform", "billing_status": "in.(reserved,awaiting_balance)", "provider_task_id": "not.is.null", "select": "owner_scope," + ",".join(PUBLIC_JOB_FIELDS), "order": "last_checked_at.asc.nullsfirst", "limit": "20"}) or []
        processed = 0
        for job in jobs:
            try:
                reconcile(store, job["owner_scope"], job, key)
                processed += 1
            except (MusicError, SupabaseError):
                continue
        return jsonify(success=True, checked=processed)

    return bp
