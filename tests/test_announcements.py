import unittest
from unittest.mock import Mock, patch

from backend import server


class AnnouncementRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.user = Mock(id="admin-user-id")
        self.gateway = Mock()
        self.gateway.public_announcements.return_value = [{"id": "1", "title": "维护通知"}]
        self.gateway.admin_announcements.return_value = [{"id": "1", "title": "维护通知", "status": "draft"}]
        self.gateway.create_announcement.return_value = {"ok": True, "announcement": {"id": "1"}}
        self.gateway.update_announcement.return_value = {"ok": True, "announcement": {"id": "1"}}
        self.gateway.delete_announcement.return_value = {"ok": True}

    def test_public_announcements_are_available_without_login(self):
        with patch.object(server, "is_supabase_configured", return_value=True), patch.object(server, "SupabaseGateway", return_value=self.gateway):
            response = self.client.get("/api/announcements")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["announcements"][0]["title"], "维护通知")
        self.gateway.public_announcements.assert_called_once_with(5)

    def test_admin_can_create_announcement(self):
        with patch.object(server, "require_admin_user", return_value=(self.user, self.gateway)):
            response = self.client.post("/api/admin/announcements", json={"title": "维护通知", "content": "今晚维护", "status": "published", "is_pinned": True})
        self.assertEqual(response.status_code, 200)
        self.gateway.create_announcement.assert_called_once()
        args = self.gateway.create_announcement.call_args.args
        self.assertEqual(args[:5], ("admin-user-id", "维护通知", "今晚维护", "info", "published"))
        self.assertTrue(args[5])

    def test_invalid_announcement_is_rejected(self):
        with patch.object(server, "require_admin_user", return_value=(self.user, self.gateway)):
            response = self.client.post("/api/admin/announcements", json={"title": "", "content": "内容"})
        self.assertEqual(response.status_code, 400)
        self.gateway.create_announcement.assert_not_called()

    def test_non_admin_is_rejected(self):
        error = server.ProviderError("ADMIN_REQUIRED", "没有管理员权限", 403, "该操作仅对管理员开放。")
        with patch.object(server, "require_admin_user", side_effect=error):
            response = self.client.delete("/api/admin/announcements/00000000-0000-0000-0000-000000000001")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["code"], "ADMIN_REQUIRED")


if __name__ == "__main__":
    unittest.main()
