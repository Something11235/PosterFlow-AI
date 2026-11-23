import unittest
from unittest.mock import Mock, patch
from backend import server


class AdminMusicTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.gateway = Mock()
        self.gateway.admin_console_snapshot.return_value = {"metrics": {"daily_active_users": 1}, "usage": []}
        self.gateway.admin_music_overview.return_value = {"activity": {"daily_active_users": 2}, "metrics": {"credits": 2}, "jobs": []}
        self.gateway.admin_ppt_overview.return_value = {"metrics": {"credits": "0.0106"}, "models": [], "jobs": []}

    def test_console_keeps_legacy_data_and_includes_music_with_same_filters(self):
        with patch.object(server, "require_admin_user", return_value=(Mock(id="admin"), self.gateway)):
            response = self.client.get("/api/admin/console?from=2026-10-11&to=2026-10-23&search=someone")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["music"]["metrics"]["credits"], 2)
        self.assertEqual(self.gateway.admin_console_snapshot.call_args, self.gateway.admin_music_overview.call_args)
        self.assertEqual(response.json["ppt"]["metrics"]["credits"], "0.0106")
        self.assertEqual(self.gateway.admin_console_snapshot.call_args, self.gateway.admin_ppt_overview.call_args)

    def test_non_admin_cannot_read_any_music_or_usage_data(self):
        with patch.object(server, "require_admin_user", side_effect=server.ProviderError("ADMIN_REQUIRED", "没有管理员权限", 403)):
            response = self.client.get("/api/admin/console")
        self.assertEqual(response.status_code, 403)
        self.gateway.admin_music_overview.assert_not_called()
        self.gateway.admin_ppt_overview.assert_not_called()

    def test_ppt_failure_is_local_to_ppt_overview(self):
        self.gateway.admin_ppt_overview.side_effect = server.SupabaseError("UNAVAILABLE", "internal secret", 503)
        with patch.object(server, "require_admin_user", return_value=(Mock(id="admin"), self.gateway)):
            response = self.client.get("/api/admin/console")
        self.assertEqual(response.status_code, 200)
        self.assertIn("ppt_error", response.json)
        self.assertNotIn("ppt", response.json)
        self.assertIn("music", response.json)
        self.assertNotIn("internal secret", response.get_data(as_text=True))

    def test_music_failure_is_reported_without_hiding_old_admin_controls(self):
        self.gateway.admin_music_overview.side_effect = server.SupabaseError("UNAVAILABLE", "internal secret", 503)
        with patch.object(server, "require_admin_user", return_value=(Mock(id="admin"), self.gateway)):
            response = self.client.get("/api/admin/console?from=2026-10-11&to=2026-10-23")
        self.assertEqual(response.status_code, 200)
        self.assertIn("music_error", response.json)
        self.assertIn("metrics", response.json)
        self.assertNotIn("internal secret", response.get_data(as_text=True))
