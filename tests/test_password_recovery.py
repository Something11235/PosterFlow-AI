import unittest
from unittest.mock import Mock, patch

from backend import password_recovery as recovery, server, supabase_service


HASH = "a" * 56
ACCESS = "synthetic-user-session-" + "a" * 64
ORIGIN = "https://posterflow.example"
HEADERS = {"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"}
PASSWORD = "Synthetic.special!密码9"


class PasswordRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.key = patch.object(recovery, "SUPABASE_SERVICE_ROLE_KEY", "synthetic-signing-key-only-for-tests")
        self.key.start()
        self.addCleanup(self.key.stop)
        self.gateway = Mock()
        self.gateway.verify_password_recovery.return_value = ACCESS
        self.gateway_patch = patch.object(recovery, "SupabaseGateway", return_value=self.gateway)
        self.gateway_patch.start()
        self.addCleanup(self.gateway_patch.stop)

    def post(self, body, headers=None):
        return self.client.post(recovery.PATH, base_url=ORIGIN, json=body, headers=HEADERS if headers is None else headers)

    def verify(self):
        return self.post({"action": "verify", "type": "recovery", "token_hash": HASH})

    def update(self, password=PASSWORD, confirmation=PASSWORD):
        return self.post({"action": "update", "password": password, "password_confirmation": confirmation})

    def test_get_head_and_prefetch_never_consume_email_proof(self):
        for method in ("get", "head"):
            response = getattr(self.client, method)(recovery.PATH, base_url=ORIGIN)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(response.headers["Referrer-Policy"], "no-referrer")
            self.assertIn("connect-src 'self'", response.headers["Content-Security-Policy"])
            self.assertNotIn("Set-Cookie", response.headers)
        self.gateway_patch.target.SupabaseGateway.assert_not_called()

    def test_success_requires_recovery_session_and_user_update_then_clears_cookie(self):
        self.assertEqual(self.update().status_code, 401)
        self.gateway.update_recovered_password.assert_not_called()
        verified = self.verify()
        self.assertEqual(verified.status_code, 200)
        cookie = verified.headers["Set-Cookie"]
        for flag in ("Secure", "HttpOnly", "SameSite=Strict", "Max-Age=600", "Path=" + recovery.PATH):
            self.assertIn(flag, cookie)
        self.assertNotIn(ACCESS, verified.get_data(as_text=True))
        response = self.update()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["title"], "密码修改成功")
        self.gateway.verify_password_recovery.assert_called_once_with(HASH)
        self.gateway.update_recovered_password.assert_called_once_with(ACCESS, PASSWORD)
        self.assertIn("Max-Age=0", response.headers["Set-Cookie"])
        self.assertEqual(self.update().status_code, 401)

    def test_cross_origin_and_non_json_posts_rejected_even_with_cookie(self):
        self.verify()
        for headers in ({}, {"Origin": "https://untrusted.example"}, {**HEADERS, "Sec-Fetch-Site": "cross-site"}):
            response = self.post({"action": "update", "password": PASSWORD, "password_confirmation": PASSWORD}, headers)
            self.assertEqual(response.status_code, 403)
        response = self.client.post(recovery.PATH, base_url=ORIGIN, data="action=update", headers=HEADERS)
        self.assertEqual(response.status_code, 403)
        self.gateway.update_recovered_password.assert_not_called()

    def test_bad_input_never_reaches_auth(self):
        for body in ([], {}, {"action": "verify", "type": "email", "token_hash": HASH},
                     {"action": "verify", "type": "recovery", "token_hash": "bad"},
                     {"action": "verify", "type": "recovery", "token_hash": "a" * 257}):
            self.assertEqual(self.post(body).status_code, 400)
        self.gateway.verify_password_recovery.assert_not_called()
        self.gateway.validate_recovery_access_token.assert_not_called()

    def test_https_origin_works_behind_tls_terminating_proxy(self):
        response = self.client.post(
            recovery.PATH, base_url="http://posterflow.example",
            json={"action": "verify", "type": "recovery", "token_hash": HASH},
            headers={**HEADERS, "X-Forwarded-Proto": "https"},
        )
        self.assertEqual(response.status_code, 200)
        self.gateway.verify_password_recovery.assert_called_once_with(HASH)

    def test_failed_password_validation_preserves_session_for_retry(self):
        self.verify()
        for password, confirmation in (("short", "short"), ("x" * 129, "x" * 129), (PASSWORD, "different")):
            self.assertEqual(self.update(password, confirmation).status_code, 400)
        self.gateway.update_recovered_password.assert_not_called()
        self.assertEqual(self.update().status_code, 200)

    def test_weak_or_same_password_and_network_errors_do_not_report_success(self):
        self.verify()
        for code, status in (("weak_password", 400), ("same_password", 400), ("SUPABASE_UNAVAILABLE", 503)):
            self.gateway.update_recovered_password.side_effect = supabase_service.SupabaseError(code, "private detail")
            response = self.update()
            self.assertEqual(response.status_code, status)
            self.assertFalse(response.get_json()["ok"])
            self.assertNotIn("private detail", response.get_data(as_text=True))
            self.assertNotIn("Set-Cookie", response.headers)
        self.gateway.update_recovered_password.side_effect = None
        self.assertEqual(self.update().status_code, 200)

    def test_expired_link_does_not_create_session(self):
        self.gateway.verify_password_recovery.side_effect = supabase_service.SupabaseError("otp_expired", "private")
        response = self.verify()
        self.assertEqual(response.status_code, 400)
        self.assertTrue(response.get_json()["restart"])
        self.assertFalse(response.get_json()["ok"])
        self.assertEqual(self.update().status_code, 401)

    def test_verify_retry_is_idempotent_only_for_same_emailed_proof(self):
        self.verify()
        self.assertEqual(self.verify().status_code, 200)
        self.gateway.verify_password_recovery.assert_called_once_with(HASH)
        self.post({"action": "verify", "type": "recovery", "token_hash": "b" * 56})
        self.assertEqual(self.gateway.verify_password_recovery.call_count, 2)

    def test_old_email_access_token_is_validated_by_auth_before_cookie_creation(self):
        response = self.post({"action": "verify", "type": "recovery", "access_token": ACCESS})
        self.assertEqual(response.status_code, 200)
        self.gateway.validate_recovery_access_token.assert_called_once_with(ACCESS)
        self.gateway.verify_password_recovery.assert_not_called()
        self.assertEqual(self.update().status_code, 200)

    def test_cookie_tampering_and_server_expiry_are_rejected(self):
        self.client.set_cookie(recovery.COOKIE, "tampered", domain="posterflow.example", path=recovery.PATH)
        self.assertEqual(self.update().status_code, 401)
        with patch("time.time", return_value=2000000000):
            self.verify()
        with patch("time.time", return_value=2000000601):
            self.assertEqual(self.update().status_code, 401)
        self.gateway.update_recovered_password.assert_not_called()

    def test_cookie_from_other_purpose_does_not_authorize_reset(self):
        from itsdangerous import URLSafeTimedSerializer
        value = URLSafeTimedSerializer("synthetic-signing-key-only-for-tests", salt="another-purpose").dumps({"access_token": ACCESS})
        self.client.set_cookie(recovery.COOKIE, value, domain="posterflow.example", path=recovery.PATH)
        self.assertEqual(self.update().status_code, 401)


class RecoveryGatewayTests(unittest.TestCase):
    def setUp(self):
        self.gateway = object.__new__(supabase_service.SupabaseGateway)
        self.gateway._request = Mock()

    def test_verify_uses_recovery_type_and_requires_auth_session(self):
        self.gateway._request.return_value = {"user": {"id": "synthetic"}, "access_token": ACCESS, "refresh_token": "discard"}
        self.assertEqual(self.gateway.verify_password_recovery(HASH), ACCESS)
        self.gateway._request.assert_called_once_with("POST", "/auth/v1/verify", body={"token_hash": HASH, "type": "recovery"})
        for result in ({}, {"user": {}}, {"user": {"id": "synthetic"}}, {"access_token": ACCESS}):
            self.gateway._request.return_value = result
            with self.assertRaises(supabase_service.SupabaseError):
                self.gateway.verify_password_recovery(HASH)

    def test_update_uses_user_authorization_and_never_admin_endpoint(self):
        self.gateway._request.return_value = {"id": "synthetic"}
        self.assertIsNone(self.gateway.update_recovered_password(ACCESS, PASSWORD))
        self.gateway._request.assert_called_once_with("PUT", "/auth/v1/user", body={"password": PASSWORD}, headers={"Authorization": "Bearer " + ACCESS})
        for result in (None, {}, []):
            self.gateway._request.return_value = result
            with self.assertRaises(supabase_service.SupabaseError):
                self.gateway.update_recovered_password(ACCESS, PASSWORD)

    def test_legacy_session_validation_requires_auth_user(self):
        self.gateway._request.return_value = {"id": "synthetic"}
        self.gateway.validate_recovery_access_token(ACCESS)
        self.gateway._request.assert_called_once_with("GET", "/auth/v1/user", headers={"Authorization": "Bearer " + ACCESS})
        self.gateway._request.return_value = {}
        with self.assertRaises(supabase_service.SupabaseError):
            self.gateway.validate_recovery_access_token(ACCESS)


if __name__ == "__main__":
    unittest.main()
