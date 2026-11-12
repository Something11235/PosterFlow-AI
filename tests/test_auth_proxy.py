import base64
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests
from flask import Flask
from backend import auth_proxy


ORIGIN = "https://posterflow.example"
HEADERS = {"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin", "X-Posterflow-Auth": "1"}


def jwt(role="authenticated"):
    part = base64.urlsafe_b64encode(json.dumps({"role": role, "sub": "synthetic-user"}).encode()).decode().rstrip("=")
    return "synthetic." + part + ".signature"


class Upstream:
    def __init__(self, body=None, status=200, headers=None, raw=None):
        self.status_code = status
        self.headers = headers or {}
        self.content = raw if raw is not None else json.dumps(body or {}).encode()
        self.closed = False

    def iter_content(self, size):
        for offset in range(0, len(self.content), size):
            yield self.content[offset:offset + size]

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.closed = True


class AuthProxyTests(unittest.TestCase):
    def test_vercel_rewrite_capture_is_not_an_auth_parameter(self):
        response = self.call("token?grant_type=password&path=auth%2Fproxy%2Ftoken", body={"email": "fixture@example.invalid", "password": "synthetic-only"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.upstream.call_args.kwargs["params"], {"grant_type": "password"})
        for query in ("path=other", "path=auth/proxy/token&path=auth/proxy/token", "path=auth/proxy/token&admin=1"):
            self.upstream.reset_mock()
            response = self.call("token?grant_type=password&" + query, body={"password": "synthetic-only"})
            self.assertEqual(response.status_code, 400)
            self.upstream.assert_not_called()

    def setUp(self):
        env = patch.dict(os.environ, {"SUPABASE_URL": "https://project.supabase.co", "VITE_SUPABASE_ANON_KEY": "sb_publishable_fixture"}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.server = SimpleNamespace(ALLOWED_ORIGINS=["http://localhost:3001"], enforce_rate_limit=Mock(), ProviderError=type("Limit", (Exception,), {}))
        app = Flask(__name__)
        app.register_blueprint(auth_proxy.create_auth_proxy_blueprint(self.server))
        self.client = app.test_client()
        upstream = patch.object(auth_proxy.requests, "request", return_value=Upstream({"access_token": "synthetic-session", "user": {"id": "synthetic-user"}}))
        self.upstream = upstream.start()
        self.addCleanup(upstream.stop)

    def call(self, path="token?grant_type=password", *, method="POST", headers=None, body=None):
        return self.client.open(auth_proxy.PATH + "/" + path, base_url=ORIGIN, method=method,
                                headers=HEADERS if headers is None else headers, json=body if body is not None else {"email": "fixture@example.invalid", "password": "synthetic-only"} if method == "POST" else None)

    def test_password_forwarding_uses_fixed_upstream_public_key_and_never_cookies_or_browser_api_key(self):
        self.client.set_cookie("posterflow_session", "private-cookie", domain="posterflow.example")
        response = self.call(headers={**HEADERS, "apikey": "sb_secret_forbidden", "Authorization": "Bearer " + jwt("service_role"), "X-Supabase-Api-Version": "2024-01-01"})
        self.assertEqual(response.status_code, 200)
        args, options = self.upstream.call_args
        self.assertEqual(args, ("POST", "https://project.supabase.co/auth/v1/token"))
        self.assertEqual(options["params"], {"grant_type": "password"})
        self.assertEqual(options["headers"], {"apikey": "sb_publishable_fixture", "Content-Type": "application/json", "Accept": "application/json", "X-Supabase-Api-Version": "2024-01-01"})
        self.assertEqual(options["timeout"], (5, 15))
        self.assertFalse(options["allow_redirects"])
        self.assertTrue(options["stream"])
        self.assertNotIn("Set-Cookie", response.headers)
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")

    def test_all_public_sdk_flows_and_user_authorization_are_supported(self):
        for path, method, body in (
            ("token?grant_type=refresh_token", "POST", {"refresh_token": "synthetic-refresh"}),
            ("token?grant_type=pkce", "POST", {"auth_code": "synthetic", "code_verifier": "synthetic"}),
            ("signup", "POST", {"email": "fixture@example.invalid", "password": "synthetic-only"}),
            ("recover?redirect_to=" + ORIGIN + "/api/auth/reset-password", "POST", {"email": "fixture@example.invalid"}),
            ("verify", "POST", {"type": "email", "token_hash": "synthetic"}),
            ("resend", "POST", {"type": "signup", "email": "fixture@example.invalid"}),
            ("user", "GET", None), ("user", "PUT", {"password": "synthetic-new"}),
            ("logout?scope=local", "POST", {}),
        ):
            with self.subTest(path=path):
                self.upstream.reset_mock()
                response = self.call(path, method=method, body=body, headers={**HEADERS, "Authorization": "Bearer " + jwt()})
                self.assertEqual(response.status_code, 200)
                self.upstream.assert_called_once()
                if path.split("?")[0] in {"user", "logout"}:
                    self.assertEqual(self.upstream.call_args.kwargs["headers"]["Authorization"], "Bearer " + jwt())

    def test_forbidden_routes_queries_origins_and_user_privileges_never_contact_upstream(self):
        for path in ("admin/users", "../admin/users", "token?grant_type=client_credentials", "token?grant_type=password&url=https://evil.invalid", "token?grant_type=password&grant_type=refresh_token", "recover?redirect_to=https://evil.invalid/", "recover?redirect_to=https://[bad/"):
            with self.subTest(path=path):
                self.assertIn(self.call(path).status_code, {400, 404})
        for headers in ({}, {**HEADERS, "Origin": "https://evil.invalid"}, {**HEADERS, "Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.call(headers=headers).status_code, 403)
        for token in ("", jwt("service_role"), "sb_secret_forbidden", jwt("anon")):
            self.assertEqual(self.call("user", method="GET", headers={**HEADERS, "Authorization": "Bearer " + token}).status_code, 401)
        self.assertEqual(self.call("verify", method="GET").status_code, 404)
        self.assertEqual(self.call("user", method="HEAD").status_code, 404)
        self.upstream.assert_not_called()

    def test_forwarded_https_and_configured_dev_origin_work_without_arbitrary_origins(self):
        response = self.client.post(auth_proxy.PATH + "/token?grant_type=password", base_url="http://posterflow.example", headers={**HEADERS, "X-Forwarded-Proto": "https"}, json={})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.call(headers={**HEADERS, "Origin": "http://localhost:3001"}).status_code, 200)

    def test_response_status_auth_code_api_version_and_retry_after_are_preserved_without_cookies(self):
        self.upstream.return_value = Upstream({"code": "invalid_credentials", "msg": "Invalid login credentials"}, 400, {"X-Supabase-Api-Version": "2024-01-01", "Set-Cookie": "should-not-forward"})
        response = self.call()
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "invalid_credentials")
        self.assertEqual(response.headers["X-Supabase-Api-Version"], "2024-01-01")
        self.assertNotIn("Set-Cookie", response.headers)
        self.upstream.return_value = Upstream({"code": "over_request_rate_limit"}, 429, {"Retry-After": "60"})
        self.assertEqual(self.call().headers["Retry-After"], "60")
        self.upstream.return_value = Upstream(status=204)
        self.assertEqual(self.call("logout", headers={**HEADERS, "Authorization": "Bearer " + jwt()}).data, b"")

    def test_body_size_depth_and_invalid_public_key_fail_before_upstream(self):
        self.assertEqual(self.call(body={"padding": "x" * auth_proxy.BODY_LIMIT}).status_code, 413)
        nested = '[' * 1200 + '0' + ']' * 1200
        self.assertEqual(self.client.post(auth_proxy.PATH + "/token?grant_type=password", base_url=ORIGIN, headers={**HEADERS, "Content-Type": "application/json"}, data=nested).status_code, 400)
        for key in ("sb_secret_forbidden", jwt("service_role"), ""):
            with patch.dict(os.environ, {"VITE_SUPABASE_ANON_KEY": key}):
                self.assertEqual(self.call().status_code, 503)
        self.upstream.assert_not_called()

    def test_transport_or_response_failure_never_retries_or_echoes_sensitive_details(self):
        self.upstream.side_effect = requests.Timeout("private request password")
        response = self.call()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["code"], "auth_network_unavailable")
        self.assertNotIn("private request", response.get_data(as_text=True))
        self.upstream.assert_called_once()
        self.upstream.side_effect = None
        for upstream in (Upstream(status=302), Upstream(raw=b"x" * (auth_proxy.RESPONSE_LIMIT + 1)), Upstream(raw=b"<html>error</html>")):
            self.upstream.reset_mock()
            self.upstream.return_value = upstream
            self.assertIn(self.call().status_code, {502, 503})
            self.upstream.assert_called_once()
            self.assertTrue(upstream.closed)

    def test_local_throttle_does_not_send_an_upstream_request(self):
        self.server.enforce_rate_limit.side_effect = self.server.ProviderError()
        response = self.call()
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["Retry-After"], "60")
        self.upstream.assert_not_called()


if __name__ == "__main__":
    unittest.main()
