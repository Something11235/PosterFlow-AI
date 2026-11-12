"""Short image submit/query requests; task state survives browser/function exit."""
import hashlib
import hmac
import json
import os
import re
import uuid
from datetime import datetime

from flask import Blueprint, jsonify, request

try:
    from backend import apimart_image_provider as provider
    from backend import grok_region
    from backend import image_reference_delivery as delivery
    from backend import image_tier_pricing as tiers
    from backend.supabase_service import SupabaseGateway, SupabaseError, is_supabase_configured
except ModuleNotFoundError:
    import apimart_image_provider as provider
    import grok_region
    import image_reference_delivery as delivery
    import image_tier_pricing as tiers
    from supabase_service import SupabaseGateway, SupabaseError, is_supabase_configured

PUBLIC_FIELDS = ("request_id", "model", "billing_mode", "status", "requested_count", "image_keys", "error_code", "created_at", "reference_count", "unit_credit_cost", "pricing_resolution")


def public_job(job):
    result = {name: job.get(name) for name in PUBLIC_FIELDS}
    # BuyToken uses processing both while sending and after receiving URLs.
    # Expose only this fact so clients can resume saving confirmed results,
    # without disclosing temporary upstream URLs or claiming an unknown POST
    # has already returned images.
    result["result_available"] = bool(job.get("provider_result_urls"))
    if job.get('status') == 'failed':
        result['failure_reason'] = provider.image_failure_reason(job.get('error_code'))
        if job.get('error_code') == 'IMAGE_PROVIDER_TIMEOUT':
            result['recovery'] = provider.IMAGE_TIMEOUT_RECOVERY
    return result


class ImageStore:
    def __init__(self):
        self.gateway = SupabaseGateway()

    def rpc(self, name, values):
        result = self.gateway.rpc(name, values)
        if not isinstance(result, dict) or not result.get("ok"):
            code = result.get("code", "IMAGE_DATABASE_UNAVAILABLE") if isinstance(result, dict) else "IMAGE_DATABASE_UNAVAILABLE"
            messages = {"IMAGE_TASK_NOT_FOUND": "未找到本人的图片任务。", "IMAGE_REQUEST_CONFLICT": "请求编号对应的参数不同，请查询原任务。", "EMAIL_UNVERIFIED": "请先完成邮箱验证。", "CREDITS_INSUFFICIENT": "积分不足，请减少生成数量或充值后重试。", "ACCOUNT_FROZEN": "当前账户不可用。"}
            raise provider.ImageTaskError(code, messages.get(code, "图片任务暂时无法处理，请保留请求编号。"), 404 if code == "IMAGE_TASK_NOT_FOUND" else 409)
        return result

    def begin(self, owner, user, request_id, mode, model, body, prompt):
        fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        resolution = body.get("resolution", "").upper() or None
        if model == "seedream-5-5" and body.get("size") in ("1K", "1.5K", "2K"):
            resolution = body["size"]
        if model == 'grok-imagine-image-2.0':
            resolution = None  # Legacy RPC; v3 tier store handles its resolution.
        rpc_name = "begin_seedream55_image_job" if model == "seedream-5-5" else "begin_gpt26_image_job_v2" if model.startswith("gpt-image-2.6-") else "begin_seedream_image_job" if model.startswith("seedream-") else "begin_apimart_image_job_v3"
        return self.rpc(rpc_name, {"p_owner": owner, "p_user": user, "p_request": request_id, "p_mode": mode, "p_model": model, "p_count": body["n"], "p_fingerprint": fingerprint, "p_prompt": prompt, "p_reference_count": len(body.get("image_urls") or []), "p_resolution": resolution})

    def apply(self, owner, request_id, event, **kwargs):
        return self.rpc("apply_image_job_v3", {"p_owner": owner, "p_request": request_id, "p_event": event, **kwargs})

    def jobs(self, owner, request_id=None):
        # The table also holds BuyToken jobs. Returning those here would relabel
        # them as APIMart on the client, whose query cannot save BuyToken URLs.
        params = {"owner_scope": "eq." + owner, "submission_provider": "eq.apimart", "select": "*", "order": "created_at.desc", "limit": "50"}
        if request_id:
            params["request_id"] = "eq." + request_id
        return self.gateway._request("GET", "/rest/v1/apimart_image_jobs", params=params) or []


class ImageTierStore(ImageStore):
    def begin(self, owner, user, request_id, mode, model, body, prompt):
        fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        data = dict(body)
        if model == 'seedream-5-5' and body.get('size') in tiers.TIERS[model]:
            data['resolution'] = body['size']
        if model in ('seedream-5-0-pro', 'seedream-5-5') and 'x' in body.get('size', ''):
            width, height = body['size'].split('x')
            data.update(size='custom', custom_width=width, custom_height=height)
        resolution = tiers.resolution(model, data)
        return self.rpc('begin_image_tier_job', {'p_owner': owner, 'p_user': user, 'p_request': request_id,
            'p_mode': mode, 'p_model': model, 'p_count': body['n'], 'p_fingerprint': fingerprint,
            'p_prompt': prompt, 'p_reference_count': len(body.get('image_urls') or []), 'p_resolution': resolution})

    def apply(self, owner, request_id, event, **kwargs):
        return self.rpc('apply_image_tier_job', {'p_owner': owner, 'p_request': request_id, 'p_event': event, **kwargs})


class Seedream55ImageStore(ImageStore):
    def apply(self, owner, request_id, event, **kwargs):
        return self.rpc("apply_seedream55_image_job", {"p_owner": owner, "p_request": request_id, "p_event": event, **kwargs})


def create_image_blueprint(server):
    bp = Blueprint("apimart_images", __name__, url_prefix="/api/apimart-images")

    @bp.after_request
    def private_response(response):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @bp.errorhandler(provider.ImageTaskError)
    def image_error(error):
        if error.code in {"REFERENCE_UPLOAD_QUOTA_EXCEEDED", "REFERENCE_UPLOAD_RATE_LIMITED", "REFERENCE_LINK_UNAVAILABLE"}:
            payload = dict(error=error.message, code=error.code, detail=provider.image_failure_reason(error.code),
                           submission_unknown=False, generation_submitted=False, phase="reference_upload",
                           recovery=["稍后再试；持续失败请联系站主"])
            # A shared platform provider account's quota is operational metadata.
            # Only an own-key caller may receive their own bounded quota fields.
            if getattr(server.g, "apimart_image_billing_mode", None) == "own_key" and getattr(error, "quota", None):
                payload["upload_quota"] = error.quota
            return jsonify(payload), error.status
        if error.code == "IMAGE_PROVIDER_CHANGED":
            return jsonify(error=error.message, code=error.code, detail=error.message, submission_unknown=False, generation_submitted=False, phase="validation", recovery=["刷新页面后再提交"]), error.status
        if error.code == "IMAGE_PRICING_CHANGED":
            return jsonify(error=error.message, code=error.code, detail=error.message, submission_unknown=False, generation_submitted=False, phase="validation", recovery=["刷新页面，核对当前积分后再生成"]), error.status
        if error.code == "IMAGE_MASK_INVALID":
            return jsonify(error=error.message, code=error.code, detail=error.message + " 蒙版校验未通过，尚未提交生图任务。", submission_unknown=False, generation_submitted=False, phase="validation", recovery=["重新选择原图与编辑区域", "确认蒙版尺寸与原图一致"]), error.status
        if error.code in ("REFERENCE_UPLOAD_FAILED", "REFERENCE_IMAGE_INVALID"):
            return jsonify(error=error.message, code=error.code, detail="参考图未完成上传，尚未提交生图任务。请稍后重试上传；若持续失败，请联系站主。", submission_unknown=False, generation_submitted=False, phase="reference_upload", recovery=["稍后重试上传", "持续失败请联系站主"]), error.status
        return jsonify(error=error.message, code=error.code, detail=error.message, submission_unknown=error.uncertain, recovery=["查询原任务", "请勿重复生成"]), error.status

    @bp.errorhandler(SupabaseError)
    def database_error(_error):
        return jsonify(error="图片任务数据库尚未就绪，请检查配置和迁移。", code="IMAGE_DATABASE_UNAVAILABLE"), 503

    @bp.errorhandler(Exception)
    def other_error(error):
        if isinstance(error, server.ProviderError):
            return server.provider_error_response(error)
        # Never log raw provider errors, URLs, request bodies or credentials.
        return jsonify(error="图片任务暂未完成，请保留任务记录后查询。", code="IMAGE_TASK_UNAVAILABLE"), 503

    def context():
        mode = server.parse_billing_mode({})
        if mode == "platform":
            if any(request.headers.get(name, "").strip() for name in ("X-Provider-Api-Key", "X-Provider-Endpoint", "X-Provider-Model", "X-Provider-Auth-Type")):
                raise provider.ImageTaskError("PLATFORM_PROVIDER_OVERRIDE_BLOCKED", "平台模式不能混用个人服务配置。")
            user = server.require_authenticated_user()
            key = os.getenv("APIMART_IMAGE_API_KEY", "").strip()
            if not key:
                raise provider.ImageTaskError("APIMART_IMAGE_NOT_CONFIGURED", "平台图片服务尚未配置，可使用原有模型。", 503)
            return mode, key, "user-" + user.id, user.id
        key = request.headers.get("X-Provider-Api-Key", "").strip()
        endpoint = request.headers.get("X-Provider-Endpoint", "").strip().rstrip("/")
        if endpoint != provider.BASE + "/images/generations" or request.headers.get("X-Provider-Auth-Type", "bearer") != "bearer":
            raise provider.ImageTaskError("APIMART_ENDPOINT_INVALID", "新增模型需要填写完整的图片生成地址，并使用 Bearer 鉴权。")
        if not key or len(key) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in key):
            raise provider.ImageTaskError("PROVIDER_KEY_MISSING", "请填写有效的图片服务 API Key。")
        user = server.set_optional_storage_scope()
        identity = "user-" + user.id if user else "guest-" + server.current_client_id()
        owner = identity + "-" + hashlib.sha256(key.encode()).hexdigest()
        return mode, key, owner, user.id if user else None

    def normalize_id(value):
        try:
            return str(uuid.UUID(str(value)))
        except (TypeError, ValueError, AttributeError):
            raise provider.ImageTaskError("INVALID_IMAGE_TASK", "图片任务编号无效。") from None

    def result(job, balance=None, **extra):
        return {"success": True, "job": public_job(job), "images": [{"filename": name, "index": i + 1} for i, name in enumerate(job.get("image_keys") or [])], "credit_balance": balance, **extra}

    def reconcile(store, owner, key, job):
        if job.get('pricing_policy_version', 1) == tiers.VERSION:
            store = ImageTierStore()
        elif job.get("model") == "seedream-5-5":
            store = Seedream55ImageStore()
        request_id = job["request_id"]
        if job["status"] in ("completed", "failed") or not job.get("provider_task_id"):
            return result(job)
        remote = provider.query(key, job["provider_task_id"])
        if remote["status"] in ("failed", "cancelled"):
            applied = store.apply(owner, request_id, "failed", p_error=remote.get('error_code') or "APIMART_TASK_FAILED")
            return result(applied["job"], applied.get("balance"))
        if remote["status"] != "completed":
            applied = store.apply(owner, request_id, "unknown" if remote["status"] == "unknown" else "processing")
            return result(applied["job"], applied.get("balance"))
        urls = remote["urls"]
        if not urls or len(urls) > job["requested_count"]:
            raise provider.ImageTaskError("APIMART_RESULT_UNCERTAIN", "上游已完成，结果数量暂未确认；请查询原任务。", 503)
        token = str(uuid.uuid4())
        claim = store.apply(owner, request_id, "claim", p_token=token)
        if not claim.get("claimed"):
            return result(claim["job"], claim.get("balance"))
        names = []
        try:
            prefix = datetime.fromisoformat(job["created_at"].replace("Z", "+00:00")).strftime("%Y%m%d_%H%M%S")
            for i, url in enumerate(urls):
                data = provider.download_image(url)
                extension = "gif" if data[:6] in (b"GIF87a", b"GIF89a") else "png"
                name = f"{prefix}_{job['id'].replace('-', '')[:12]}_{i + 1}.{extension}"
                server.store_generated_image(name, data)
                names.append(name)
            applied = store.apply(owner, request_id, "completed", p_images=names, p_token=token)
            return result(applied["job"], applied.get("balance"))
        except Exception:
            # Deterministic private filenames make a retry safe; no re-generation.
            # Do not refund an accepted task due to a transient download/save error.
            try:
                store.apply(owner, request_id, "retry", p_token=token, p_error="IMAGE_SAVE_PENDING")
            except (provider.ImageTaskError, SupabaseError):
                pass
            raise

    @bp.get("/config")
    def config():
        return jsonify(success=True, platform_configured=bool(os.getenv("APIMART_IMAGE_API_KEY", "").strip()) and is_supabase_configured(), database_configured=is_supabase_configured(), models=[{"model": name, "credit_cost": 1, **spec} for name, spec in provider.MODELS.items()])

    @bp.post("/generations")
    def generate():
        origin = request.headers.get("Origin")
        if origin and origin.rstrip("/") not in {request.host_url.rstrip("/"), *server.ALLOWED_ORIGINS}:
            raise provider.ImageTaskError("ORIGIN_FORBIDDEN", "请求来源不受支持。", 403)
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise provider.ImageTaskError("INVALID_IMAGE_TASK", "图片请求格式无效。")
        mode, key, owner, user_id = context()
        server.g.apimart_image_billing_mode = mode
        model = data.get("platform_model") if mode == "platform" else request.headers.get("X-Provider-Model", "").strip()
        if mode == "platform" and isinstance(model, str) and model.startswith("gpt-image-2.6-"):
            raise provider.ImageTaskError("IMAGE_PROVIDER_CHANGED", "图片服务线路已更新，请刷新页面后再提交；本次尚未提交生图。", 409)
        request_id = normalize_id(data.get("request_id"))
        if model in tiers.TIERS:
            try:
                tiers.resolution(model, data)
            except ValueError as error:
                raise provider.ImageTaskError('IMAGE_RESOLUTION_INVALID', str(error)) from None
            if mode == 'platform' and data.get('pricing_version') != tiers.VERSION:
                tier = tiers.resolution(model, data)
                refs = bool(data.get('reference_storage_paths') or data.get('reference_images_b64') or data.get('reference_b64') or data.get('previous_image'))
                old = provider.MODELS[model].get('reference_credit_cost', provider.MODELS[model].get('credit_cost', 1)) if refs else provider.MODELS[model].get('credit_cost', 1)
                old = provider.MODELS[model].get('resolution_credit_costs', {}).get(tier, old)
                if tiers.unit_cost(model, tier, int(refs)) != old:
                    raise provider.ImageTaskError('IMAGE_PRICING_CHANGED', '分辨率计费已更新，请刷新页面后提交。', 409)
        server.enforce_rate_limit("apimart-image-submit", owner, 8, 60)
        paths = server.validate_reference_storage_paths(data.get("reference_storage_paths"))
        temporary_paths = list(paths)
        try:
            mask_path = server.validate_reference_storage_path(data.get("mask_storage_path"))
            if mask_path:
                if mask_path not in temporary_paths:
                    temporary_paths.append(mask_path)
                if mask_path in paths or data.get("mask_b64"):
                    raise provider.ImageTaskError("IMAGE_MASK_INVALID", "原图与蒙版须分别上传，请重新选择编辑区域。")
            references = [server.stored_reference_to_base64(path) for path in paths] if paths else server.validate_reference_images_b64(data.get("reference_images_b64"))
            if not references:
                single = server.validate_reference_image_b64(data.get("reference_b64"))
                if single:
                    references = [single]
            if not references and data.get("previous_image"):
                previous = server.stored_image_to_base64(os.path.basename(str(data["previous_image"])))
                if not previous:
                    raise provider.ImageTaskError("PREVIOUS_IMAGE_MISSING", "原图已过期或暂时无法读取，请更换参考图。")
                references = [server.validate_reference_image_b64(previous)]
            references = provider.normalize_model_references(model, references)
            if model.startswith("gpt-image-2.6-") and mode == "platform" and references and (type(data.get("pricing_version")) is not int or data["pricing_version"] != 2):
                raise provider.ImageTaskError("IMAGE_PRICING_CHANGED", "图片编辑价格已更新为每张1.5积分，纯文字生图仍为1积分。请刷新页面核对后再提交；本次尚未预留积分或提交生图。", 409)
            region_edit = model == grok_region.MODEL and data.get("operation") == "region_edit"
            if data.get("operation") and not region_edit:
                raise provider.ImageTaskError("IMAGE_REGION_INVALID", "当前模型不支持此编辑方式。")
            if region_edit and (references or data.get("mask_b64") or data.get("mask_storage_path")):
                raise provider.ImageTaskError("IMAGE_REGION_INVALID", "选区编辑须先完成原图准备，请重新选择原图。")
            mask = None
            if model.startswith("gpt-image-2.6-") and (mask_path or data.get("mask_b64")):
                mask = server.stored_reference_to_base64(mask_path) if mask_path else server.validate_reference_image_b64(data.get("mask_b64"))
                try:
                    server.validate_edit_mask(mask, references[0] if references else None)
                except ValueError as error:
                    raise provider.ImageTaskError("IMAGE_MASK_INVALID", str(error)) from None
            body = grok_region.build_request(data, key, owner) if region_edit else provider.build_request(model, data, references, **({"mask": mask} if mask else {}))
            store = ImageTierStore() if model in tiers.TIERS and data.get('pricing_version') == tiers.VERSION else Seedream55ImageStore() if model == "seedream-5-5" else ImageStore()
            begun = store.begin(owner, user_id, request_id, mode, model, body, str(data.get("prompt", "")).strip())
            if begun.get("existing"):
                return jsonify(result(begun["job"], begun.get("balance"), idempotent=True)), 200
            copy_paths = []
            try:
                if references:
                    if model in delivery.INLINE_MODELS or model in delivery.LINK_MODELS:
                        body["image_urls"], copy_paths = delivery.prepare_references(server, model, references, owner)
                    else:
                        # Retain the original protocol for historical own-key GPT2.6.
                        body["image_urls"] = [provider.upload_reference(key, ref, request_id=request_id, reference_index=index) for index,ref in enumerate(references,1)]
            except provider.ImageTaskError as error:
                store.apply(owner, request_id, "failed", p_error=error.code)
                raise
            try:
                task = provider.submit(key, body, begun["job"]["id"])
            except provider.ImageTaskError as error:
                if not error.uncertain:
                    delivery.cleanup_copies(server, copy_paths)
                store.apply(owner, request_id, "submission_unknown" if error.uncertain else "failed", p_error=error.code)
                raise
            applied = store.apply(owner, request_id, "submitted", p_task=task)
            return jsonify(result(applied["job"], applied.get("balance"))), 202
        finally:
            server.cleanup_reference_storage_paths(temporary_paths)

    @bp.post("/segments")
    @bp.post("/segments/status")
    def segment():
        origin = request.headers.get("Origin")
        if origin and origin.rstrip("/") not in {request.host_url.rstrip("/"), *server.ALLOWED_ORIGINS}:
            raise provider.ImageTaskError("ORIGIN_FORBIDDEN", "请求来源不受支持。", 403)
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise provider.ImageTaskError("IMAGE_REGION_INVALID", "原图准备请求无效。")
        mode, key, owner, _user = context()
        server.g.apimart_image_billing_mode = mode
        model = data.get("platform_model") if mode == "platform" else request.headers.get("X-Provider-Model", "").strip()
        if model != grok_region.MODEL:
            raise provider.ImageTaskError("IMAGE_REGION_INVALID", "当前模型不支持此编辑方式。")
        server.enforce_rate_limit("image-segment-status" if request.path.endswith("/status") else "image-segment-submit", owner, 60 if request.path.endswith("/status") else 8, 60)
        if request.path.endswith("/status"):
            task = grok_region.read_proof(key, owner, "task", data.get("receipt"))
        else:
            grok_region.selection_regions(data.get("selection_regions"))
            paths = server.validate_reference_storage_paths(data.get("reference_storage_paths"))
            if len(paths) != 1:
                raise provider.ImageTaskError("IMAGE_REGION_INVALID", "选区编辑需要且只支持一张本人上传的原图。")
            request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, owner + normalize_id(data.get("request_id")) + ":segment"))
            copy_paths = []
            try:
                reference = server.stored_reference_to_base64(paths[0])
                urls, copy_paths = delivery.prepare_references(server, model, [reference], owner)
                task = provider.submit(key, {"model": grok_region.MODEL, "operation": "segment", "image_urls": urls, "cache_only": True, "include_mask_rle": False}, request_id)
            except provider.ImageTaskError as error:
                if not error.uncertain:
                    delivery.cleanup_copies(server, copy_paths)
                raise
            finally:
                server.cleanup_reference_storage_paths(paths)
            return jsonify(success=True, status="pending", receipt=grok_region.proof(key, owner, "task", task))
        remote = provider.api_request("GET", "/tasks/" + task, key)
        payload = remote.get("data", {}) if isinstance(remote, dict) else {}
        if not isinstance(payload, dict):
            raise provider.ImageTaskError("IMAGE_REGION_PENDING", "原图准备结果暂未确认，请稍后重试。", 503)
        status = payload.get("status")
        if status in ("failed", "cancelled"):
            raise provider.ImageTaskError("IMAGE_REGION_FAILED", "原图准备未成功，尚未提交收费编辑。")
        if status != "completed":
            return jsonify(success=True, status="pending", receipt=data["receipt"])
        asset = payload.get("result", {}).get("image_id")
        if not isinstance(asset, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", asset):
            raise provider.ImageTaskError("IMAGE_REGION_FAILED", "原图准备缺少有效图片资产，尚未提交收费编辑。", 502)
        return jsonify(success=True, status="completed", segment_receipt=grok_region.proof(key, owner, "asset", asset))

    @bp.get("/tasks")
    def tasks():
        _mode, _key, owner, _user = context()
        return jsonify(success=True, jobs=[public_job(job) for job in ImageStore().jobs(owner) if job.get("submission_provider", "apimart") == "apimart"])

    @bp.get("/tasks/<request_id>")
    def task(request_id):
        _mode, key, owner, _user = context()
        server.enforce_rate_limit("apimart-image-query", owner, 120, 60)
        rows = ImageStore().jobs(owner, normalize_id(request_id))
        if not rows or rows[0].get("submission_provider", "apimart") != "apimart":
            raise provider.ImageTaskError("IMAGE_TASK_NOT_FOUND", "未找到本人的图片任务。", 404)
        return jsonify(reconcile(ImageStore(), owner, key, rows[0]))

    @bp.post("/reconcile")
    def scheduled_reconcile():
        secret = os.getenv("APIMART_IMAGE_RECONCILE_SECRET", "")
        if not secret or not hmac.compare_digest(request.headers.get("Authorization", ""), "Bearer " + secret):
            raise provider.ImageTaskError("AUTH_REQUIRED", "需要图片对账凭证。", 401)
        key = os.getenv("APIMART_IMAGE_API_KEY", "").strip()
        if not key:
            raise provider.ImageTaskError("APIMART_IMAGE_NOT_CONFIGURED", "平台图片服务未配置。", 503)
        store = ImageStore()
        jobs = store.gateway._request("GET", "/rest/v1/apimart_image_jobs", params={"billing_mode": "eq.platform", "status": "not.in.(completed,failed)", "provider_task_id": "not.is.null", "select": "*", "order": "updated_at.asc", "limit": "4"}) or []
        checked = 0
        for job in jobs:
            # Only a server-secret holder can read/save other owners' tasks.
            server.g.posterflow_storage_scope = "user-" + job["user_id"]
            try:
                reconcile(store, job["owner_scope"], key, job)
                checked += 1
            except Exception:
                pass
        return jsonify(success=True, checked=checked)

    return bp
