import unittest
from unittest.mock import Mock, patch

from backend import server, supabase_service


TOKEN_HASH = "a" * 56


class EmailConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()

    def test_opening_or_prefetching_page_does_not_verify_or_consume_token(self):
        with patch.object(server, "SupabaseGateway") as gateway:
            for method in ("get", "head"):
                response = getattr(self.client, method)("/api/auth/confirm")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertEqual(response.headers["Referrer-Policy"], "no-referrer")
                self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
            gateway.assert_not_called()
        page = self.client.get("/api/auth/confirm").get_data(as_text=True)
        self.assertIn("正在验证邮箱", page)
        self.assertIn('history.replaceState(null, "", window.location.pathname)', page)
        self.assertNotIn("https://", page)

    def test_verified_result_contains_no_user_data_or_session(self):
        gateway = Mock()
        with patch.object(server, "SupabaseGateway", return_value=gateway):
            response = self.client.post("/api/auth/confirm", json={"token_hash": TOKEN_HASH, "type": "email"})
        gateway.confirm_signup_email.assert_called_once_with(TOKEN_HASH)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["verified"])
        self.assertEqual(response.get_json()["title"], "邮箱验证成功")
        self.assertNotIn(TOKEN_HASH, response.get_data(as_text=True))
        self.assertNotIn("Set-Cookie", response.headers)

    def test_invalid_missing_and_other_action_tokens_are_rejected_before_auth(self):
        with patch.object(server, "SupabaseGateway") as gateway:
            for body in ({}, [], {"token_hash": TOKEN_HASH, "type": "recovery"},
                         {"token_hash": "<script>alert(1)</script>", "type": "email"},
                         {"token_hash": "short", "type": "email"},
                         {"token_hash": "a" * 257, "type": "email"}):
                with self.subTest(body_type=type(body).__name__):
                    response = self.client.post("/api/auth/confirm", json=body)
                    self.assertEqual(response.status_code, 400)
                    self.assertFalse(response.get_json()["verified"])
            gateway.assert_not_called()

    def test_expired_token_never_reports_success_or_exposes_auth_error(self):
        gateway = Mock()
        gateway.confirm_signup_email.side_effect = supabase_service.SupabaseError(
            "otp_expired", "private upstream detail", 503
        )
        with patch.object(server, "SupabaseGateway", return_value=gateway):
            response = self.client.post("/api/auth/confirm", json={"token_hash": TOKEN_HASH, "type": "email"})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()["verified"])
        self.assertFalse(response.get_json()["retryable"])
        self.assertEqual(response.get_json()["title"], "验证链接已失效")
        self.assertNotIn("private upstream detail", response.get_data(as_text=True))

    def test_unavailable_auth_offers_retry_without_claiming_success(self):
        gateway = Mock()
        gateway.confirm_signup_email.side_effect = supabase_service.SupabaseError("SUPABASE_UNAVAILABLE", "offline")
        with patch.object(server, "SupabaseGateway", return_value=gateway):
            response = self.client.post("/api/auth/confirm", json={"token_hash": TOKEN_HASH, "type": "email"})
        self.assertEqual(response.status_code, 503)
        self.assertFalse(response.get_json()["verified"])
        self.assertTrue(response.get_json()["retryable"])

    def test_gateway_verifies_emailed_proof_and_discards_session(self):
        gateway = object.__new__(supabase_service.SupabaseGateway)
        gateway._request = Mock(return_value={
            "user": {"email_confirmed_at": "2026-10-19T00:00:00Z"},
            "access_token": "synthetic-session", "refresh_token": "synthetic-refresh",
        })
        self.assertIsNone(gateway.confirm_signup_email(TOKEN_HASH))
        gateway._request.assert_called_once_with(
            "POST", "/auth/v1/verify", body={"token_hash": TOKEN_HASH, "type": "email"}
        )

    def test_gateway_requires_confirmed_user_even_after_success_http_response(self):
        gateway = object.__new__(supabase_service.SupabaseGateway)
        for payload in (None, [], {}, {"user": {}}, {"user": {"email_confirmed_at": None}}):
            gateway._request = Mock(return_value=payload)
            with self.subTest(payload=payload), self.assertRaises(supabase_service.SupabaseError):
                gateway.confirm_signup_email(TOKEN_HASH)


if __name__ == "__main__":
    unittest.main()
