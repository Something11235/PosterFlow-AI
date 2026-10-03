import unittest
from unittest.mock import Mock, patch

from backend import server


class CreditSettingsRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.user = Mock(id="admin-user-id")
        self.gateway = Mock()
        self.gateway.get_credit_settings.return_value = {
            "signup_bonus_credits": 10,
            "updated_by": None,
            "updated_at": None,
            "updated_reason": "初始默认值",
        }
        self.gateway.update_signup_bonus_credits.return_value = {
            "ok": True,
            "settings": {
                "signup_bonus_credits": 25,
                "updated_by": "admin-user-id",
                "updated_at": "2026-10-03T00:00:00+00:00",
                "updated_reason": "活动期间",
            },
        }

    def test_admin_can_read_signup_bonus_setting(self):
        with patch.object(server, "require_admin_user", return_value=(self.user, self.gateway)):
            response = self.client.get("/api/admin/settings/credits")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["settings"]["signup_bonus_credits"], 10)
        self.gateway.get_credit_settings.assert_called_once_with()

    def test_admin_can_update_signup_bonus_setting(self):
        with patch.object(server, "require_admin_user", return_value=(self.user, self.gateway)):
            response = self.client.post(
                "/api/admin/settings/credits",
                json={"signup_bonus_credits": 25, "reason": "活动期间"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["settings"]["signup_bonus_credits"], 25)
        self.gateway.update_signup_bonus_credits.assert_called_once_with(
            "admin-user-id", 25, "活动期间"
        )

    def test_update_rejects_fractional_and_out_of_range_values(self):
        with patch.object(server, "require_admin_user", return_value=(self.user, self.gateway)):
            for value in (1.5, -1, 10001, "10.5", True):
                response = self.client.post(
                    "/api/admin/settings/credits",
                    json={"signup_bonus_credits": value},
                )
                self.assertEqual(response.status_code, 400, value)

        self.gateway.update_signup_bonus_credits.assert_not_called()

    def test_non_admin_is_rejected(self):
        error = server.ProviderError("ADMIN_REQUIRED", "没有管理员权限", 403, "该操作仅对管理员开放。")
        with patch.object(server, "require_admin_user", side_effect=error):
            response = self.client.post(
                "/api/admin/settings/credits",
                json={"signup_bonus_credits": 25},
            )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["code"], "ADMIN_REQUIRED")


if __name__ == "__main__":
    unittest.main()
