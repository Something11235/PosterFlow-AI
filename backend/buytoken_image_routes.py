"""Durable single-submit BuyToken jobs; legacy APIMart tasks stay on their routes."""
import hashlib
import json
import os
import uuid
from datetime import datetime

from flask import Blueprint, jsonify, request

try:
    from backend import buytoken_image_provider as provider
    from backend.apimart_image_provider import ImageTaskError
    from backend.apimart_image_routes import ImageStore, public_job
    from backend.supabase_service import SupabaseError, is_supabase_configured
except ModuleNotFoundError:
    import buytoken_image_provider as provider
    from apimart_image_provider import ImageTaskError
    from apimart_image_routes import ImageStore, public_job
    from supabase_service import SupabaseError, is_supabase_configured


class BuyTokenStore(ImageStore):
    def begin(self, owner, user, request_id, mode, model, body, prompt):
        fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        return self.rpc("begin_buytoken_gpt26_image_job", {"p_owner": owner, "p_user": user, "p_request": request_id,
            "p_mode": mode, "p_model": model, "p_count": body["payload"]["n"], "p_fingerprint": fingerprint,
            "p_prompt": prompt, "p_reference_count": len(body["references"]), "p_resolution": "1K"})

    def apply(self, owner, request_id, event, **kwargs):
        return self.rpc("apply_buytoken_gpt26_image_job", {"p_owner": owner, "p_request": request_id, "p_event": event, **kwargs})

    def jobs(self, owner, request_id=None):
        params = {"owner_scope": "eq." + owner, "submission_provider": "eq.buytoken", "select": "*", "order": "created_at.desc", "limit": "50"}
        if request_id:
            params["request_id"] = "eq." + request_id
        return self.gateway._request("GET", "/rest/v1/apimart_image_jobs", params=params) or []


def create_buytoken_image_blueprint(server):
    bp = Blueprint("buytoken_images", __name__, url_prefix="/api/buytoken-images")

    @bp.after_request
    def private_response(response):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @bp.errorhandler(ImageTaskError)
    def image_error(error):
        return jsonify(error=error.message, code=error.code, detail=error.message, submission_unknown=error.uncertain,
            generation_submitted=error.uncertain, phase="submission" if error.uncertain else "validation",
            recovery=["查询原任务，请勿重复生成"] if error.uncertain else ["按提示修改后重试"]), error.status

    @bp.errorhandler(SupabaseError)
    def database_error(_error):
        uncertain = bool(server.g.get("buytoken_submission_started"))
        return jsonify(error="图片任务数据库暂时不可用，请保留请求编号并联系管理员。", code="IMAGE_DATABASE_UNAVAILABLE",
            submission_unknown=uncertain, generation_submitted=uncertain,
            recovery=["查询原任务，请勿重复生成"] if uncertain else ["联系管理员检查图片服务配置"]), 503

    @bp.errorhandler(Exception)
    def other_error(error):
        if isinstance(error, server.ProviderError):
            return server.provider_error_response(error)
        return jsonify(error="图片任务尚未确认，请保留请求编号，勿重复生成。", code="IMAGE_TASK_UNAVAILABLE", submission_unknown=True), 503

    def context():
        mode = server.parse_billing_mode({})
        if mode == "platform":
            if any(request.headers.get(name, "").strip() for name in ("X-Provider-Api-Key", "X-Provider-Endpoint", "X-Provider-Model", "X-Provider-Auth-Type")):
                raise ImageTaskError("PLATFORM_PROVIDER_OVERRIDE_BLOCKED", "平台模式不能混用个人服务配置。")
            user = server.require_authenticated_user()
            return mode, "user-" + user.id, user.id
        model = request.headers.get("X-Provider-Model", "").strip()
        config = provider.resolve_config(server, mode, model)
        user = server.set_optional_storage_scope()
        identity = "user-" + user.id if user else "guest-" + server.current_client_id()
        return mode, identity + "-" + hashlib.sha256(config.api_key.encode()).hexdigest(), user.id if user else None

    def request_id(value):
        try:
            return str(uuid.UUID(str(value)))
        except (ValueError, TypeError, AttributeError):
            raise ImageTaskError("INVALID_IMAGE_TASK", "图片任务编号无效。") from None

    def result(job, balance=None, **extra):
        visible = public_job(job)
        if job.get("error_code") == "BUYTOKEN_REQUEST_REJECTED":
            visible["failure_reason"] = "图片服务未接受本次请求，预留积分已退回。"
        return {"success": True, "job": visible, "images": [{"filename": name, "index": i + 1} for i, name in enumerate(job.get("image_keys") or [])], "credit_balance": balance, **extra}

    def reconcile(store, owner, job):
        if job["status"] in ("completed", "failed") or not job.get("provider_result_urls"):
            # Synchronous providers have no remote query task. In particular,
            # a GET must never turn a timeout into another paid generation.
            return result(job)
        token = str(uuid.uuid4())
        claim = store.apply(owner, job["request_id"], "claim", p_token=token)
        if not claim.get("claimed"):
            return result(claim["job"], claim.get("balance"))
        try:
            prefix = datetime.fromisoformat(job["created_at"].replace("Z", "+00:00")).strftime("%Y%m%d_%H%M%S")
            names = []
            for index, url in enumerate(job["provider_result_urls"], 1):
                content = provider.download(server, url)
                extension = "gif" if content[:6] in (b"GIF87a", b"GIF89a") else "png"
                name = f"{prefix}_{job['id'].replace('-', '')[:12]}_{index}.{extension}"
                server.store_generated_image(name, content)
                names.append(name)
            saved = store.apply(owner, job["request_id"], "completed", p_token=token, p_images=names)
            return result(saved["job"], saved.get("balance"))
        except Exception:
            try:
                store.apply(owner, job["request_id"], "retry", p_token=token, p_error="IMAGE_SAVE_PENDING")
            except (ImageTaskError, SupabaseError):
                pass
            raise ImageTaskError("IMAGE_SAVE_PENDING", "图片结果已返回，保存暂未完成；请查询原任务，不要重新生成。", 503, True) from None

    @bp.get("/config")
    def config():
        return jsonify(success=True, platform_configured=provider.configured(server) and is_supabase_configured())

    @bp.post("/generations")
    def generate():
        origin = request.headers.get("Origin")
        if origin and origin.rstrip("/") not in {request.host_url.rstrip("/"), *server.ALLOWED_ORIGINS}:
            raise ImageTaskError("ORIGIN_FORBIDDEN", "请求来源不受支持。", 403)
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ImageTaskError("INVALID_IMAGE_TASK", "图片请求格式无效。")
        mode, owner, user_id = context()
        model = data.get("platform_model") if mode == "platform" else request.headers.get("X-Provider-Model", "").strip()
        rid = request_id(data.get("request_id"))
        server.enforce_rate_limit("buytoken-image-submit", owner, 8, 60)
        paths = server.validate_reference_storage_paths(data.get("reference_storage_paths"))
        temporary_paths = list(paths)
        try:
            mask_path = server.validate_reference_storage_path(data.get("mask_storage_path"))
            if mask_path:
                if mask_path not in temporary_paths:
                    temporary_paths.append(mask_path)
                if mask_path in paths or data.get("mask_b64"):
                    raise ImageTaskError("IMAGE_MASK_INVALID", "原图与蒙版须分别上传。")
            references = [server.stored_reference_to_base64(path) for path in paths] if paths else server.validate_reference_images_b64(data.get("reference_images_b64"))
            if not references:
                single = server.validate_reference_image_b64(data.get("reference_b64"))
                references = [single] if single else []
            if not references and data.get("previous_image"):
                previous = server.stored_image_to_base64(os.path.basename(str(data["previous_image"])))
                if not previous:
                    raise ImageTaskError("PREVIOUS_IMAGE_MISSING", "原图已过期或暂时无法读取，请重新选择。")
                references = [server.validate_reference_image_b64(previous)]
            if mode == "platform" and references and (type(data.get("pricing_version")) is not int or data["pricing_version"] != 2):
                raise ImageTaskError("IMAGE_PRICING_CHANGED", "带图编辑每张1.5积分，请刷新页面核对后提交。", 409)
            mask = server.stored_reference_to_base64(mask_path) if mask_path else server.validate_reference_image_b64(data.get("mask_b64"))
            if mask:
                try:
                    server.validate_edit_mask(mask, references[0] if references else None)
                except ValueError as error:
                    raise ImageTaskError("IMAGE_MASK_INVALID", str(error)) from None
            body = provider.build_request(server, model, data, references, mask)
            selected = provider.resolve_config(server, mode, model)
            store = BuyTokenStore()
            begun = store.begin(owner, user_id, rid, mode, model, body, body["payload"]["prompt"])
            if begun.get("existing"):
                return jsonify(reconcile(store, owner, begun["job"])), 200
            sending = store.apply(owner, rid, "sending")
            if not sending.get("send"):
                return jsonify(result(sending["job"], sending.get("balance"))), 200
            server.g.buytoken_submission_started = True
            try:
                urls = provider.submit(server, selected, body, rid)
            except ImageTaskError as error:
                store.apply(owner, rid, "unknown" if error.uncertain else "failed", p_error=error.code)
                raise
            received = store.apply(owner, rid, "received", p_urls=urls)
            # Start downloads on a fresh GET budget. A synchronous generation
            # may already have used most of the function's 300-second limit.
            return jsonify(result(received["job"], received.get("balance"))), 202
        finally:
            server.cleanup_reference_storage_paths(temporary_paths)

    @bp.get("/tasks/<rid>")
    def task(rid):
        _mode, owner, _user = context()
        server.enforce_rate_limit("buytoken-image-query", owner, 120, 60)
        store = BuyTokenStore()
        rows = store.jobs(owner, request_id(rid))
        if not rows:
            raise ImageTaskError("IMAGE_TASK_NOT_FOUND", "未找到本人的图片任务。", 404)
        return jsonify(reconcile(store, owner, rows[0]))

    return bp
