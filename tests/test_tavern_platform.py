"""Platform orchestration with synthetic env and mocked database/provider only."""
import os
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask

from backend import tavern_platform as platform
from backend import tavern_routes as tavern
from backend.supabase_service import SupabaseError
from backend.tavern_pricing import reserve_tavern_credits


OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
REQUEST = "11111111-1111-4111-8111-111111111111"
ACTOR = "22222222-2222-4222-8222-222222222222"
USAGE = {"status": "confirmed", "input_tokens": 1000, "output_tokens": 100,
         "total_tokens": 1100, "cache_read_tokens": 0, "cache_miss_tokens": 1000, "reasoning_tokens": None}


class ProviderError(Exception):
    def __init__(self, code="AUTH_REQUIRED", status=401):
        self.code, self.status = code, status


class TavernPlatformTests(unittest.TestCase):
    def setUp(self):
        self.stack = []
        def start(patcher):
            self.stack.append(patcher)
            return patcher.start()
        self.addCleanup(lambda: [patcher.stop() for patcher in reversed(self.stack)])
        start(patch.dict(os.environ, {"PLATFORM_TAVERN_ENABLED": "true", "PLATFORM_TAVERN_API_KEY": "synthetic-platform-secret"}, clear=True))
        start(patch.object(platform, "is_supabase_configured", return_value=True))
        self.store = Mock()
        start(patch.object(platform, "TavernStore", return_value=self.store))
        self.store.ready.return_value = True
        self.record = {"request_id": REQUEST, "user_id": OWNER, "model": tavern.DEFAULT_MODEL, "kind": "chat",
                       "status": "reserved", "billing_status": "held", "reserved_credits": "0.1000",
                       "charged_credits": None, "usage": None, "response_text": None,
                       "created_at": datetime.now(timezone.utc).isoformat(), "error_code": None}
        self.store.begin.return_value = {"ok": True, "leader": True, "request": self.record, "balance": "9.9000"}
        self.settled = {**self.record, "status": "completed", "billing_status": "settled", "charged_credits": "0.0084",
                        "usage": USAGE, "response_text": "合成回复"}
        self.store.apply.return_value = {"ok": True, "request": self.settled, "balance": "9.9916"}
        self.submit = start(patch.object(tavern, "submit_chat", return_value={"content": "合成回复", "usage": USAGE}))
        self.server = SimpleNamespace(ALLOWED_ORIGINS=["https://posterflow.example"], ProviderError=ProviderError,
                                      enforce_rate_limit=Mock(), require_authenticated_user=Mock(return_value=SimpleNamespace(id=OWNER)),
                                      require_admin_user=Mock(return_value=(SimpleNamespace(id=ACTOR), Mock())))
        app = Flask(__name__)
        app.register_blueprint(tavern.create_tavern_blueprint(self.server))
        self.client = app.test_client()
        self.body = {"billing_mode": "platform", "request_id": REQUEST, "kind": "chat", "model": tavern.DEFAULT_MODEL,
                     "messages": [{"role": "system", "content": "合成设定"}, {"role": "user", "content": "你好"}],
                     "max_tokens": 1024, "temperature": 0.8}
        self.headers = {"Origin": "https://posterflow.example"}

    def post(self, body=None, headers=None):
        return self.client.post("/api/tavern/chat", json=self.body if body is None else body,
                                headers=self.headers if headers is None else headers)

    def test_config_requires_explicit_enabled_valid_server_settings_and_database_ready(self):
        response = self.client.get("/api/tavern/config")
        self.assertTrue(response.json["platform_configured"])
        self.assertTrue(response.json["pricing"]["billing_enabled"])
        self.assertNotIn("synthetic-platform-secret", response.get_data(as_text=True))
        self.store.ready.return_value = False
        self.assertFalse(self.client.get("/api/tavern/config").json["platform_configured"])
        for changes in ({"PLATFORM_TAVERN_ENABLED": "false"}, {"PLATFORM_TAVERN_API_KEY": ""},
                        {"PLATFORM_TAVERN_MODEL": "unpriced"}, {"PLATFORM_TAVERN_API_ENDPOINT": "http://private.local"}):
            with patch.dict(os.environ, changes):
                self.assertFalse(self.client.get("/api/tavern/config").json["platform_configured"])
        self.submit.assert_not_called()

    def test_paid_call_uses_server_key_and_reserves_before_single_submission(self):
        sequence = Mock()
        sequence.attach_mock(self.store.begin, "begin")
        sequence.attach_mock(self.submit, "submit")
        sequence.attach_mock(self.store.apply, "apply")
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual([call[0] for call in sequence.mock_calls], ["begin", "submit", "apply"])
        self.assertEqual(self.submit.call_args.args[1], "synthetic-platform-secret")
        self.assertNotIn("request_id", self.submit.call_args.args[2])
        self.assertEqual(self.store.begin.call_args.args[:3], (OWNER, REQUEST, "chat"))
        self.assertEqual(self.store.apply.call_args.args[:3], (OWNER, REQUEST, "completed"))
        self.assertEqual(response.json["billing"], {"request_id": REQUEST, "status": "settled", "reserved_credits": "0.1000", "charged_credits": "0.0084"})
        self.assertEqual(response.json["credit_balance"], "9.9916")

    def test_assist_is_independent_billed_request_kind(self):
        response = self.post({**self.body, "kind": "assist"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.store.begin.call_args.args[:3], (OWNER, REQUEST, "assist"))
        self.submit.assert_called_once()
        self.assertNotIn("kind", self.submit.call_args.args[2])

    def test_admin_overview_validates_range_and_uses_authenticated_actor(self):
        self.store.rpc.return_value = {"ok": True, "days": 30, "stats": {"assist": 1}, "requests": []}
        response = self.client.get("/api/tavern/admin/overview?days=30")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["stats"]["assist"], 1)
        self.assertEqual(self.store.rpc.call_args.args, ("admin_tavern_overview", {"p_actor_id": ACTOR, "p_days": 30}))
        self.store.rpc.reset_mock()
        self.assertEqual(self.client.get("/api/tavern/admin/overview?days=999").status_code, 400)
        self.store.rpc.assert_not_called()

    def test_bad_parameters_client_credentials_and_auth_fail_before_reservation(self):
        for body in ({**self.body, "request_id": "bad"}, {**self.body, "kind": "image"},
                     {**self.body, "kind": {}},
                     {**self.body, "model": "unpriced"}, {**self.body, "messages": []},
                     {**self.body, "owner": OTHER}, {**self.body, "messages": [{"role": "user", "content": "\ud800"}]}):
            self.assertEqual(self.post(body).status_code, 400)
        self.assertEqual(self.post(headers={**self.headers, "X-Tavern-Api-Key": "client-key"}).status_code, 400)
        self.assertEqual(self.post(headers={**self.headers, "X-Tavern-Endpoint": tavern.DEFAULT_ENDPOINT}).status_code, 400)
        self.server.require_authenticated_user.side_effect = ProviderError()
        self.assertEqual(self.post().status_code, 401)
        self.store.begin.assert_not_called()
        self.submit.assert_not_called()

    def test_sql_rejection_or_rate_limit_never_submits(self):
        self.store.begin.side_effect = platform.TavernPlatformError("EMAIL_UNVERIFIED", "先验证邮箱", 403)
        self.assertEqual(self.post().status_code, 403)
        self.server.enforce_rate_limit.side_effect = ProviderError()
        self.assertEqual(self.post().status_code, 429)
        self.submit.assert_not_called()

    def test_duplicate_completed_reply_replays_and_held_never_retries(self):
        self.store.begin.return_value = {"ok": True, "leader": False, "request": self.settled, "balance": "9.9916"}
        self.assertTrue(self.post().json["idempotent"])
        self.store.begin.return_value = {"ok": True, "leader": False, "request": self.record}
        response = self.post()
        self.assertEqual(response.status_code, 409)
        self.assertTrue(response.json["submission_unknown"])
        self.assertIsNone(response.json["charged_credits"])
        self.submit.assert_not_called()
        self.store.apply.assert_not_called()

    def test_begin_timeout_or_malformed_leader_never_submits_or_refunds(self):
        self.store.begin.side_effect = SupabaseError("TIMEOUT", "private transport details")
        response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertTrue(response.json["submission_unknown"])
        self.assertEqual(response.json["request_id"], REQUEST)
        self.assertIsNone(response.json["charged_credits"])
        self.assertNotIn("private transport", response.get_data(as_text=True))
        self.store.begin.side_effect = None
        self.store.begin.return_value = {"ok": True, "leader": True, "request": {**self.record, "billing_status": "refunded"}}
        self.assertEqual(self.post().status_code, 503)
        self.submit.assert_not_called()
        self.store.apply.assert_not_called()

    def test_definite_rejection_refunds_but_unknown_holds_without_retry(self):
        for uncertain, code, expected in ((False, "TAVERN_REQUEST_REJECTED", "rejected"),
                                          (False, "TAVERN_CONNECTION_FAILED", "not_submitted"),
                                          (True, "TAVERN_RESULT_UNKNOWN", "unknown")):
            with self.subTest(uncertain=uncertain, code=code):
                self.submit.side_effect = tavern.TavernError(code, "合成错误", 502, uncertain)
                updated = {**self.record, "status": "unknown" if uncertain else "failed",
                           "billing_status": "held" if uncertain else "refunded", "charged_credits": None if uncertain else "0.0000"}
                self.store.apply.return_value = {"ok": True, "request": updated}
                response = self.post()
                self.assertEqual(response.status_code, 502)
                self.assertEqual(self.store.apply.call_args.args[2], expected)
                self.assertEqual(response.json["charged_credits"], None if uncertain else "0.0000")
        self.assertEqual(self.submit.call_count, 3)

    def test_missing_usage_and_settlement_failure_keep_successful_reply_but_no_fake_charge(self):
        missing = {"status": "missing", **{name: None for name in platform.USAGE_FIELDS}}
        self.submit.return_value = {"content": "已返回的正文", "usage": missing}
        self.store.apply.return_value = {"ok": True, "request": {**self.record, "status": "completed", "billing_status": "awaiting_review", "usage": missing}}
        response = self.post()
        self.assertTrue(response.json["success"])
        self.assertEqual(response.json["content"], "已返回的正文")
        self.assertEqual(response.json["billing"]["status"], "awaiting_review")
        self.assertIsNone(response.json["charged_credits"])
        self.store.apply.side_effect = SupabaseError("TIMEOUT", "secret")
        response = self.post()
        self.assertTrue(response.json["success"])
        self.assertEqual(response.json["content"], "已返回的正文")
        self.assertIsNone(response.json["charged_credits"])
        self.assertEqual(self.store.apply.call_count, 2)

    def test_failed_refund_is_unknown_and_does_not_claim_zero(self):
        self.submit.side_effect = tavern.TavernError("TAVERN_REQUEST_REJECTED", "已拒绝", 502, False)
        self.store.apply.side_effect = SupabaseError("TIMEOUT", "secret")
        response = self.post()
        self.assertTrue(response.json["submission_unknown"])
        self.assertIsNone(response.json["charged_credits"])

    def test_owner_queries_scope_by_auth_not_client_and_expire_response(self):
        expired = {**self.settled, "created_at": (datetime.now(timezone.utc) - timedelta(hours=13)).isoformat(), "api_key": "never-public"}
        self.store.get.return_value = {"ok": True, "requests": [expired]}
        response = self.client.get("/api/tavern/requests/" + REQUEST + "?user_id=" + OTHER)
        self.assertEqual(self.store.get.call_args.args, (OWNER, REQUEST))
        self.assertIsNone(response.json["request"]["content"])
        self.assertEqual(response.json["request"]["status"], "settled")
        self.assertEqual(response.json["request"]["request_status"], "completed")
        self.assertNotIn("user_id", response.json["request"])
        self.assertNotIn("never-public", response.get_data(as_text=True))

    def test_admin_identity_from_auth_and_usage_verified_not_body_actor(self):
        self.store.rpc.return_value = {"ok": True, "request": self.settled}
        body = {"user_id": OWNER, "action": "settle", "usage": {**USAGE, "api_key": "strip"}, "reason": "核对服务商账单"}
        route = "/api/tavern/admin/requests/" + REQUEST + "/resolve"
        self.assertEqual(self.client.post(route, json={**body, "actor_id": OWNER}).status_code, 400)
        self.assertEqual(self.client.post(route, json={**body, "usage": {**USAGE, "input_tokens": None}}).status_code, 400)
        response = self.client.post(route, json=body)
        self.assertEqual(response.status_code, 200)
        args = self.store.rpc.call_args.args[1]
        self.assertEqual(args["p_actor_id"], ACTOR)
        self.assertEqual(args["p_user_id"], OWNER)
        self.assertNotIn("api_key", args["p_usage"])
        self.assertIsNone(response.json["request"]["content"])
        self.server.require_admin_user.side_effect = ProviderError("ADMIN_REQUIRED", 403)
        self.assertEqual(self.client.get("/api/tavern/admin/requests").status_code, 403)

    def test_disabled_new_billing_still_allows_existing_owner_query_and_admin_review(self):
        self.store.get.return_value = {"ok": True, "requests": [self.settled]}
        self.store.rpc.return_value = {"ok": True, "requests": [self.settled], "request": self.settled}
        with patch.dict(os.environ, {"PLATFORM_TAVERN_ENABLED": "false", "PLATFORM_TAVERN_API_KEY": ""}):
            self.assertEqual(self.post().status_code, 503)
            response = self.client.get("/api/tavern/requests/" + REQUEST)
            self.assertEqual(response.json["request"]["content"], "合成回复")
            response = self.client.get("/api/tavern/admin/requests")
            self.assertIsNone(response.json["requests"][0]["content"])
            response = self.client.post("/api/tavern/admin/requests/" + REQUEST + "/resolve",
                                        json={"user_id": OWNER, "action": "refund", "reason": "已核对服务账单"})
            self.assertEqual(response.status_code, 200)
            self.assertIsNone(response.json["request"]["content"])
        self.submit.assert_not_called()

    def test_admin_nested_invalid_parameters_fail_before_rpc(self):
        body = {"user_id": OWNER, "action": "settle", "usage": USAGE, "reason": "核对服务商账单"}
        route = "/api/tavern/admin/requests/" + REQUEST + "/resolve"
        for changes in ({"action": {}}, {"reason": "短"}, {"reason": "字" * 501},
                        {"reason": "含有空字符\x00的核对原因"}, {"reason": "含有控制字符\x1f的核对原因"},
                        {"usage": {**USAGE, "status": {}}}, {"usage": {**USAGE, "input_tokens": True}}):
            with self.subTest(changes=changes):
                self.assertEqual(self.client.post(route, json={**body, **changes}).status_code, 400)
        self.store.rpc.assert_not_called()

    def test_summary_uses_same_reservation_without_sending_kind_to_provider(self):
        response = self.post({**self.body, "kind": "summary"})
        self.assertTrue(response.json["success"])
        self.assertEqual(self.store.begin.call_args.args[2], "summary")
        self.assertNotIn("kind", self.submit.call_args.args[2])


class TavernReservationTests(unittest.TestCase):
    def test_nul_reply_is_not_stored_but_real_usage_remains_settleable(self):
        with patch.object(platform, "SupabaseGateway") as gateway:
            gateway.return_value.rpc.return_value = {"ok": True}
            platform.TavernStore().apply(OWNER, REQUEST, "completed", USAGE, "真实\x00正文")
            name, payload = gateway.return_value.rpc.call_args.args
            self.assertEqual(name, "apply_tavern_request")
            self.assertIsNone(payload["p_response_text"])
            self.assertEqual(payload["p_usage"], USAGE)

    def test_reservation_accounts_for_utf8_and_max_output_and_is_not_actual_usage(self):
        body = tavern.build_chat_request({"messages": [{"role": "user", "content": "中"}], "max_tokens": 64})
        before = deepcopy(body)
        amount = reserve_tavern_credits(body)
        # 1024 framing + 3 UTF-8 bytes + 4 role bytes + 64 per-message;
        # uncached input 1095 * 6 + max output 64 * 24, ceil once.
        self.assertEqual(amount, "0.0082")
        self.assertEqual(body, before)
        body["max_tokens"] = 4096
        self.assertGreater(Decimal(reserve_tavern_credits(body)), Decimal(amount))

    def test_gateway_fingerprint_and_payload_never_store_prompt_or_key(self):
        with patch.object(platform, "SupabaseGateway") as gateway:
            gateway.return_value.rpc.return_value = {"ok": True}
            store = platform.TavernStore()
            body = tavern.build_chat_request({"messages": [{"role": "user", "content": "private prompt"}]})
            store.begin(OWNER, REQUEST, "chat", body, tavern.DEFAULT_ENDPOINT, "0.1000")
            name, payload = gateway.return_value.rpc.call_args.args
            self.assertEqual(name, "begin_tavern_request")
            self.assertEqual(len(payload["p_fingerprint"]), 64)
            self.assertNotIn("private prompt", str(payload))
            self.assertNotIn("endpoint", payload)
            first = payload["p_fingerprint"]
            store.begin(OWNER, REQUEST, "summary", body, tavern.DEFAULT_ENDPOINT, "0.1000")
            self.assertNotEqual(first, gateway.return_value.rpc.call_args.args[1]["p_fingerprint"])


if __name__ == "__main__":
    unittest.main()
