"""Public display metadata with administrator-only, revision-checked writes."""
from flask import Blueprint, jsonify, request
try:
    from backend.apimart_image_provider import MODELS
    from backend.supabase_service import SupabaseGateway, SupabaseError, is_supabase_configured
except ModuleNotFoundError:
    from apimart_image_provider import MODELS
    from supabase_service import SupabaseGateway, SupabaseError, is_supabase_configured

MODEL_IDS = ("gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", *(model for model in MODELS if not model.startswith("gpt-image-2.6-")))
DEFAULTS = {model: "hot" if model.startswith("gpt-image-2.6-") else "new" if model.startswith("seedream-") else "" for model in MODEL_IDS}


def validate_badges(data):
    if not isinstance(data, dict) or set(data) != {"revision", "badges"} or type(data["revision"]) is not int or not 1 <= data["revision"] < 2**53:
        raise ValueError()
    badges = data["badges"]
    if not isinstance(badges, dict) or set(badges) != set(MODEL_IDS) or any(type(value) is not str or value not in ("", "new", "hot") for value in badges.values()):
        raise ValueError()
    return badges


def create_model_badge_blueprint(server):
    bp = Blueprint("model_badges", __name__)

    @bp.errorhandler(SupabaseError)
    def unavailable(_error):
        return jsonify(success=False, code="MODEL_BADGES_UNAVAILABLE", error="模型角标配置暂时不可用，请稍后重新加载。"), 503

    @bp.errorhandler(Exception)
    def unexpected(error):
        if isinstance(error, server.ProviderError):
            return server.provider_error_response(error)
        return unavailable(error)

    @bp.after_request
    def headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "public, max-age=30" if request.path == "/api/model-badges" and response.status_code == 200 else "private, no-store"
        return response

    def read(gateway):
        result = gateway.rpc("get_model_badges", {})
        if not isinstance(result, dict) or not isinstance(result.get("badges"), dict) or type(result.get("revision")) is not int or not 1 <= result["revision"] < 2**53:
            raise ValueError()
        badges = {key: result["badges"].get(key, DEFAULTS[key]) for key in MODEL_IDS}
        validate_badges({"revision": result["revision"], "badges": badges})
        return {"success": True, "revision": result["revision"], "badges": badges}

    @bp.get("/api/model-badges")
    def public():
        if not is_supabase_configured():
            return jsonify(success=True, revision=0, badges=DEFAULTS)
        return jsonify(read(SupabaseGateway()))

    @bp.route("/api/admin/model-badges", methods=["GET", "POST"])
    def admin():
        user, gateway = server.require_admin_user()
        if request.method == "GET":
            return jsonify(read(gateway))
        origin = request.headers.get("Origin")
        if origin and origin.rstrip("/") not in {request.host_url.rstrip("/"), *server.ALLOWED_ORIGINS}:
            return jsonify(success=False, error="请求来源不受支持。", code="ORIGIN_FORBIDDEN"), 403
        server.enforce_rate_limit("model-badges-update", user.id, 10, 60)
        if request.content_length and request.content_length > 8192:
            return jsonify(success=False, error="角标配置过长。", code="MODEL_BADGES_INVALID"), 400
        data = request.get_json(silent=True)
        try:
            badges = validate_badges(data)
        except ValueError:
            return jsonify(success=False, error="请为每款模型选择无、新或热，并重新加载有效版本后保存。", code="MODEL_BADGES_INVALID"), 400
        result = gateway.rpc("update_model_badges", {"p_admin": user.id, "p_revision": data["revision"], "p_badges": badges})
        if not isinstance(result, dict) or not result.get("ok"):
            code = result.get("code") if isinstance(result, dict) else None
            if code == "MODEL_BADGES_CONFLICT":
                return jsonify(success=False, code=code, error="配置已被其他管理员更新，请重新加载后再保存。"), 409
            if code == "ADMIN_REQUIRED":
                return jsonify(success=False, code=code, error="当前账户不可执行此操作。"), 403
            return unavailable(None)
        validate_badges({"revision": result.get("revision"), "badges": result.get("badges")})
        return jsonify(success=True, revision=result["revision"], badges={key: result["badges"][key] for key in MODEL_IDS})

    return bp
