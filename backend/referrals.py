"""Account-scoped invitation summaries; credit rewards are minted only in SQL redemption."""
import os
import re

from flask import Blueprint, jsonify, request

try:
    from backend.routing_query import application_query
    from backend.supabase_service import SupabaseError, SupabaseGateway
except ModuleNotFoundError:
    from routing_query import application_query
    from supabase_service import SupabaseError, SupabaseGateway


INVITE_CODE = re.compile(r"PF[0-9A-F]{12}")


class ReferralError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def create_referral_blueprint(require_user, rate_limit, error_response):
    bp = Blueprint("referrals", __name__, url_prefix="/api/referrals")

    @bp.after_request
    def private(response):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Vary"] = "Authorization, Cookie"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @bp.errorhandler(ReferralError)
    def error(exc):
        return jsonify(code=exc.code, error=exc.message), exc.status

    @bp.errorhandler(SupabaseError)
    def database_error(_exc):
        return jsonify(code="REFERRALS_UNAVAILABLE", error="邀请奖励服务暂不可用，请稍后刷新重试。"), 503

    @bp.errorhandler(Exception)
    def unexpected(exc):
        if hasattr(exc, "code") and hasattr(exc, "status"):
            return error_response(exc)
        return database_error(exc)

    def query(allowed):
        values = application_query()
        if any(key not in allowed or len(values.getlist(key)) != 1 for key in values):
            raise ReferralError("REFERRAL_INPUT_INVALID", "邀请奖励查询参数无效。")
        return values

    def rpc(name, args):
        value = SupabaseGateway().rpc(name, args)
        if not isinstance(value, dict) or value.get("ok") is not True:
            if isinstance(value, dict) and value.get("code") == "ACCOUNT_FROZEN":
                raise ReferralError("ACCOUNT_FROZEN", "当前账户不可用。", 403)
            raise ReferralError("REFERRALS_UNAVAILABLE", "邀请奖励服务暂不可用，请稍后刷新重试。", 503)
        return value

    @bp.get("")
    def snapshot():
        user = require_user()
        rate_limit("referral-snapshot", user.id, 60, 60)
        values = query({"limit", "offset"})
        limit_text, offset_text = values.get("limit", "20"), values.get("offset", "0")
        if (not re.fullmatch(r"[0-9]{1,2}", limit_text)
                or not re.fullmatch(r"[0-9]{1,7}", offset_text)):
            raise ReferralError("REFERRAL_INPUT_INVALID", "奖励记录页码无效。")
        limit, offset = int(limit_text), int(offset_text)
        if not 1 <= limit <= 50 or not 0 <= offset <= 1000000:
            raise ReferralError("REFERRAL_INPUT_INVALID", "奖励记录页码无效。")
        value = rpc("referral_snapshot", {"p_user_id": user.id, "p_limit": limit, "p_offset": offset})
        # Never spread the RPC result: new database fields must be explicitly
        # reviewed before becoming part of the public account response.
        records = [{key: row.get(key) for key in (
            "id", "invitee_name", "redeemed_credits", "reward_credits", "created_at"
        )} for row in value["records"]]
        return jsonify(success=True, code=value["code"], rate=value["rate"],
                       invited_count=value["invited_count"], total_rewards=value["total_rewards"],
                       records=records, has_more=value["has_more"])

    @bp.get("/validate")
    def validate():
        # This public endpoint deliberately returns no inviter identity or
        # account details. The random 48-bit code is a sharing identifier.
        address = request.headers.get("X-Vercel-Forwarded-For", "").split(",")[0].strip() if os.getenv("VERCEL") else ""
        rate_limit("referral-validate", address or request.remote_addr or "unknown", 30, 60)
        values = query({"code"})
        raw = values.get("code", "")
        if len(raw) > 64:
            return jsonify(success=True, valid=False)
        code = raw.strip().upper()
        if not INVITE_CODE.fullmatch(code):
            return jsonify(success=True, valid=False)
        value = rpc("validate_referral_code", {"p_code": code})
        return jsonify(success=True, valid=value.get("valid") is True)

    return bp
