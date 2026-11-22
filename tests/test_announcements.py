import unittest
from unittest.mock import Mock, patch

from backend import server

ANNOUNCEMENT_ID = "00000000-0000-0000-0000-000000000001"


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
        self.gateway.pending_popup_announcements.return_value = [{"id": ANNOUNCEMENT_ID, "is_popup": True}]
        self.gateway.acknowledge_popup_announcement.return_value = {"ok": True}

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
        self.assertIs(args[-1], False)

    def test_admin_can_publish_popup_and_edit_without_resetting_popup_flag(self):
        form = {"title": "新版本", "content": "更新内容", "status": "published", "is_popup": True}
        with patch.object(server, "require_admin_user", return_value=(self.user, self.gateway)):
            self.assertEqual(self.client.post("/api/admin/announcements", json=form).status_code, 200)
            self.assertIs(self.gateway.create_announcement.call_args.args[-1], True)
            del form["is_popup"]
            url = f"/api/admin/announcements/{ANNOUNCEMENT_ID}"
            self.assertEqual(self.client.patch(url, json=form).status_code, 200)
            self.assertIsNone(self.gateway.update_announcement.call_args.args[-1])
            form["is_popup"] = False
            self.assertEqual(self.client.patch(url, json=form).status_code, 200)
            self.assertIs(self.gateway.update_announcement.call_args.args[-1], False)
            for invalid in (None, "false", 1):
                with self.subTest(invalid=invalid):
                    self.assertEqual(self.client.patch(url, json={**form, "is_popup": invalid}).status_code, 400)

    def test_guest_loads_popups_without_private_caching_or_writing_receipt(self):
        with patch.object(server, "is_supabase_configured", return_value=True), patch.object(server, "SupabaseGateway", return_value=self.gateway):
            response = self.client.get("/api/announcements/popups?user_id=untrusted")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["announcements"], self.gateway.pending_popup_announcements.return_value)
            self.gateway.pending_popup_announcements.assert_called_once_with(None)
            self.assertTrue(response.cache_control.no_store)
            self.assertTrue(response.cache_control.private)
            self.assertIn("Authorization", response.vary)
            self.assertIn("Cookie", response.vary)
            response = self.client.post(f"/api/announcements/{ANNOUNCEMENT_ID}/acknowledge", json={"user_id": "untrusted"})
            self.assertEqual(response.status_code, 401)
            self.gateway.acknowledge_popup_announcement.assert_not_called()

    def test_account_reads_and_acknowledges_only_for_authenticated_identity(self):
        headers = {"Authorization": "Bearer access-token"}
        url = f"/api/announcements/{ANNOUNCEMENT_ID}/acknowledge"
        with patch.object(server, "authenticate_access_token", return_value=self.user), patch.object(server, "is_supabase_configured", return_value=True), patch.object(server, "SupabaseGateway", return_value=self.gateway):
            self.assertEqual(self.client.get("/api/announcements/popups?user_id=untrusted", headers=headers).status_code, 200)
            self.gateway.pending_popup_announcements.assert_called_once_with(self.user.id)
            for _ in range(2):
                response = self.client.post(url, headers=headers, json={"user_id": "untrusted"})
                self.assertEqual(response.get_json(), {"success": True, "ok": True})
                self.gateway.acknowledge_popup_announcement.assert_called_with(self.user.id, ANNOUNCEMENT_ID)
            self.gateway.acknowledge_popup_announcement.return_value = {"ok": False, "code": "ANNOUNCEMENT_NOT_FOUND"}
            self.assertEqual(self.client.post(url, headers=headers).status_code, 404)

    def test_invalid_credentials_do_not_fall_back_to_guest_list(self):
        error = server.SupabaseError("AUTH_TOKEN_INVALID", "登录凭证无效", 401)
        with patch.object(server, "authenticate_access_token", side_effect=error), patch.object(server, "SupabaseGateway", return_value=self.gateway):
            for authorization in ("Bearer expired", "Basic malformed", "Bearer"):
                with self.subTest(authorization=authorization):
                    response = self.client.get("/api/announcements/popups", headers={"Authorization": authorization})
                    self.assertEqual(response.status_code, 401)
                    self.assertTrue(response.cache_control.no_store)
            self.gateway.pending_popup_announcements.assert_not_called()

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
