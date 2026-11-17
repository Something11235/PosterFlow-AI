import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask, jsonify
from backend import referrals


USER_ID = "11111111-1111-4111-8111-111111111111"
INVITE_CODE = "PF123456789ABC"


class ReferralRoutesTests(unittest.TestCase):
    def setUp(self):
        self.user = Mock(return_value=SimpleNamespace(id=USER_ID))
        self.rate_limit = Mock()
        self.gateway = Mock()
        app = Flask(__name__)
        app.register_blueprint(referrals.create_referral_blueprint(
            self.user, self.rate_limit,
            lambda exc: (jsonify(code=exc.code, error=exc.message), exc.status),
        ))
        self.client = app.test_client()
        mock = patch.object(referrals, "SupabaseGateway", return_value=self.gateway)
        mock.start()
        self.addCleanup(mock.stop)

    def snapshot(self):
        return {"ok": True, "code": INVITE_CODE, "rate": 0.1, "invited_count": 1,
                "total_rewards": 7, "has_more": False, "internal": "must-not-leak",
                "records": [{"id": "reward-id", "invitee_name": "朋友", "redeemed_credits": 70,
                             "reward_credits": 7, "created_at": "2026-11-17T01:00:00Z",
                             "email": "private@example.invalid", "code_hash": "private-proof"}]}

    def test_snapshot_uses_authenticated_identity_and_whitelists_response(self):
        self.gateway.rpc.return_value = self.snapshot()
        response = self.client.get("/api/referrals?limit=10&offset=20")
        self.assertEqual(response.status_code, 200)
        self.gateway.rpc.assert_called_once_with("referral_snapshot", {
            "p_user_id": USER_ID, "p_limit": 10, "p_offset": 20,
        })
        self.assertEqual(response.json["records"][0]["reward_credits"], 7)
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")
        self.assertEqual(response.headers["Vary"], "Authorization, Cookie")
        self.assertNotIn("private", response.get_data(as_text=True))
        self.assertNotIn("internal", response.json)

    def test_snapshot_rejects_spoofed_identity_and_invalid_pagination(self):
        for suffix in ("user_id=someone", "p_user_id=someone", "limit=0", "limit=51",
                       "offset=-1", "offset=1000001", "offset=1.5", "offset=1&offset=2",
                       "limit=20&limit=20", "path=another-route"):
            with self.subTest(suffix=suffix):
                self.assertEqual(self.client.get("/api/referrals?" + suffix).status_code, 400)
        self.gateway.rpc.assert_not_called()

    def test_vercel_rewrite_parameter_is_accepted_only_for_matching_route(self):
        self.gateway.rpc.return_value = self.snapshot()
        self.assertEqual(self.client.get("/api/referrals?path=referrals").status_code, 200)

    def test_no_auth_or_frozen_account_cannot_see_rewards(self):
        self.user.side_effect = referrals.ReferralError("AUTH_REQUIRED", "请先登录", 401)
        self.assertEqual(self.client.get("/api/referrals").status_code, 401)
        self.gateway.rpc.assert_not_called()
        self.user.side_effect = None
        self.gateway.rpc.return_value = {"ok": False, "code": "ACCOUNT_FROZEN"}
        self.assertEqual(self.client.get("/api/referrals").status_code, 403)

    def test_validation_is_public_normalized_and_discloses_only_validity(self):
        self.gateway.rpc.return_value = {"ok": True, "valid": True, "username": "private-user"}
        response = self.client.get("/api/referrals/validate?code=%20pf123456789abc%20")
        self.assertEqual(response.json, {"success": True, "valid": True})
        self.gateway.rpc.assert_called_once_with("validate_referral_code", {"p_code": INVITE_CODE})
        self.user.assert_not_called()
        self.rate_limit.assert_called_once()

    def test_malformed_codes_do_not_reach_database(self):
        for value in ("", "other", "PF123456789ABZ", "x" * 500):
            self.assertEqual(self.client.get("/api/referrals/validate", query_string={"code": value}).json,
                             {"success": True, "valid": False})
        self.gateway.rpc.assert_not_called()

    def test_validation_rejects_duplicate_query_and_honors_rate_limit(self):
        self.assertEqual(self.client.get("/api/referrals/validate?code=a&code=b").status_code, 400)
        self.rate_limit.side_effect = referrals.ReferralError("RATE_LIMITED", "操作过于频繁", 429)
        self.assertEqual(self.client.get("/api/referrals/validate?code=" + INVITE_CODE).status_code, 429)
        self.gateway.rpc.assert_not_called()

    def test_database_failure_never_leaks_details_or_fakes_zero_rewards(self):
        self.gateway.rpc.side_effect = RuntimeError("private-service-token-and-email")
        response = self.client.get("/api/referrals")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json["code"], "REFERRALS_UNAVAILABLE")
        self.assertNotIn("private-service", response.get_data(as_text=True))
        self.assertNotIn("total_rewards", response.json)

    def test_no_mutation_or_client_selected_reward_endpoint(self):
        self.assertEqual(self.client.post("/api/referrals", json={"reward": 9999}).status_code, 405)
        self.assertEqual(self.client.post("/api/referrals/validate", json={"code": INVITE_CODE}).status_code, 405)
        self.gateway.rpc.assert_not_called()
