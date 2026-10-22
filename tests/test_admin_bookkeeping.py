import unittest
from datetime import date
from unittest.mock import Mock, patch
from backend import server
from backend.supabase_service import SupabaseGateway


class AdminBookkeepingTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.user = Mock(id="admin-id")
        self.gateway = Mock()
        self.gateway.save_admin_bookkeeping.return_value = {"ok": True, "record": {"revision": 1, "recharge_text": "微信收款 50 元"}}
        self.payload = {"scope": "daily", "stat_date": "2026-10-19", "recharge_text": "微信收款 50 元", "cost_text": "12.50", "note": "人工记账", "revision": 0}

    def post(self, payload=None, **kwargs):
        with patch.object(server, "require_admin_user", return_value=(self.user, self.gateway)):
            return self.client.post("/api/admin/bookkeeping", json=self.payload if payload is None else payload, **kwargs)

    def test_manual_text_is_saved_and_actor_is_server_identity(self):
        result = self.post({**self.payload, "admin_user_id": "forged", "new_users": 999})
        self.assertEqual(result.status_code, 200)
        self.gateway.save_admin_bookkeeping.assert_called_once_with("admin-id", "daily", "2026-10-19", "微信收款 50 元", "12.50", "人工记账", 0)

    def test_overview_does_not_require_date(self):
        response = self.post({**self.payload, "scope": "overview", "stat_date": "invalid"})
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(self.gateway.save_admin_bookkeeping.call_args.args[2])

    def test_invalid_input_never_reaches_database(self):
        for change in ({"scope": "invalid"}, {"stat_date": "2099-01-01"}, {"stat_date": "2026-02-30"},
                       {"recharge_text": 25}, {"cost_text": "x" * 501}, {"note": "x" * 1001},
                       {"revision": True}, {"revision": -1}, {"revision": "0"}, {"cost_text": "a\x00b"}):
            self.assertEqual(self.post({**self.payload, **change}).status_code, 400, change)
        self.assertEqual(self.post([]).status_code, 400)
        self.gateway.save_admin_bookkeeping.assert_not_called()

    def test_optimistic_conflict_is_409(self):
        self.gateway.save_admin_bookkeeping.return_value = {"ok": False, "code": "BOOKKEEPING_CONFLICT"}
        response = self.post()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["code"], "BOOKKEEPING_CONFLICT")

    def test_daily_save_returns_authoritative_all_time_totals_without_an_extra_query(self):
        overview = {"source": "daily", "recharge_text": "0.30", "cost_text": "0.00", "recorded_days": 2}
        self.gateway.save_admin_bookkeeping.return_value["overview"] = overview
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["overview"], overview)
        self.gateway.admin_bookkeeping.assert_not_called()

    def test_non_admin_and_cross_origin_writes_rejected(self):
        for method in ("get", "post"):
            with patch.object(server, "require_admin_user", side_effect=server.ProviderError("ADMIN_REQUIRED", "没有管理员权限", 403)):
                self.assertEqual(getattr(self.client, method)("/api/admin/bookkeeping", json=self.payload).status_code, 403)
        self.assertEqual(self.post(headers={"Origin": "https://untrusted.example"}).status_code, 403)
        self.gateway.save_admin_bookkeeping.assert_not_called()

    def test_historical_read_is_bounded(self):
        self.gateway.admin_bookkeeping.return_value = {"days": []}
        with patch.object(server, "require_admin_user", return_value=(self.user, self.gateway)):
            self.assertEqual(self.client.get("/api/admin/bookkeeping?from=2026-10-01&to=2026-10-19").status_code, 200)
            for query in ("from=2026-01-01&to=2026-10-19", "from=2026-10-20&to=2026-10-01", "from=bad", "to=2099-01-01"):
                self.assertEqual(self.client.get("/api/admin/bookkeeping?" + query).status_code, 400)
        self.gateway.admin_bookkeeping.assert_called_once_with(date(2026, 10, 1), date(2026, 10, 19))

    def test_gateway_uses_restricted_rpcs(self):
        gateway = object.__new__(SupabaseGateway)
        with patch.object(gateway, "rpc", return_value={}) as rpc:
            gateway.save_admin_bookkeeping("admin-id", "daily", "2026-10-19", "10", "5", "", 3)
            self.assertEqual(rpc.call_args.args[0], "save_admin_bookkeeping")
            self.assertEqual(rpc.call_args.args[1]["p_revision"], 3)


if __name__ == "__main__":
    unittest.main()
