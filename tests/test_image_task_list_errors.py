import unittest
import hashlib
from unittest.mock import Mock, patch

import jwt

from backend import apimart_image_routes, buytoken_image_routes, server, supabase_service


class ImageTaskListErrorsTests(unittest.TestCase):
    routes = (
        ("apimart", apimart_image_routes, "ImageStore"),
        ("buytoken", buytoken_image_routes, "BuyTokenStore"),
    )
    headers = {"X-Billing-Mode": "platform", "Authorization": "Bearer test-token"}

    def setUp(self):
        self.client = server.app.test_client()

    def test_list_preserves_auth_failure_without_reading_the_database(self):
        for name, module, store_type in self.routes:
            for code, status in (("AUTH_SESSION_EXPIRED", 401), ("AUTH_TOKEN_INVALID", 401),
                                 ("AUTH_VERIFY_UNAVAILABLE", 503)):
                with (self.subTest(name=name, code=code), patch.object(module, store_type) as store,
                      patch.object(server, "authenticate_access_token",
                                   side_effect=supabase_service.SupabaseError(code, "private", status)),
                      self.assertLogs(apimart_image_routes.__name__) as logs):
                    response = self.client.get(f"/api/{name}-images/tasks", headers=self.headers)
                    self.assertEqual((response.status_code, response.json["code"]), (status, code))
                    message = response.json["error"]
                    self.assertIn("刷新页面", message)
                    if status == 401:
                        self.assertLess(message.index("刷新页面"), message.index("重新登录"))
                    else:
                        self.assertNotIn("重新登录", message)
                    self.assertIn(f"provider={name} stage=identity reason={code} status={status}", logs.output[0])
                    self.assertNotIn("test-token", logs.output[0])
                    store.assert_not_called()

    def test_list_differentiates_database_and_unexpected_errors(self):
        for name, module, store_type in self.routes:
            with (self.subTest(name=name), patch.object(module, store_type) as store,
                  patch.object(server, "require_authenticated_user", return_value=Mock(id="example-user"))):
                store.return_value.jobs.side_effect = supabase_service.SupabaseError("sensitive-value", "sensitive-value")
                with self.assertLogs(apimart_image_routes.__name__) as logs:
                    response = self.client.get(f"/api/{name}-images/tasks", headers=self.headers)
                self.assertEqual((response.status_code, response.json["code"]), (503, "IMAGE_TASK_LIST_READ_FAILED"))
                self.assertIn("stage=database reason=SUPABASE_ERROR", logs.output[0])
                self.assertNotIn("sensitive-value", logs.output[0] + response.get_data(as_text=True))

                store.return_value.jobs.side_effect = None
                store.return_value.jobs.return_value = [None]
                with self.assertLogs(apimart_image_routes.__name__) as logs:
                    response = self.client.get(f"/api/{name}-images/tasks", headers=self.headers)
                self.assertEqual((response.status_code, response.json["code"]), (500, "IMAGE_TASK_LIST_UNAVAILABLE"))
                self.assertIn("stage=format", logs.output[0])

    def test_platform_list_works_without_generation_credentials(self):
        with (patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": ""}),
              patch.object(server, "require_authenticated_user", return_value=Mock(id="example-user")),
              patch.object(apimart_image_routes, "ImageStore") as store):
            store.return_value.jobs.return_value = []
            response = self.client.get("/api/apimart-images/tasks", headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json, {"jobs": [], "success": True})
            store.return_value.jobs.assert_called_once_with("user-example-user")

    def test_cookie_only_platform_list_preserves_verification_outage(self):
        self.client.set_cookie(server.AUTH_COOKIE_NAME, "test-cookie")
        for name, module, store_type in self.routes:
            with (self.subTest(name=name), patch.object(module, store_type) as store,
                  patch.object(server, "authenticate_access_token",
                               side_effect=supabase_service.SupabaseError("AUTH_VERIFY_UNAVAILABLE", "test")),
                  self.assertLogs(apimart_image_routes.__name__)):
                response = self.client.get(f"/api/{name}-images/tasks", headers={"X-Billing-Mode": "platform"})
                self.assertEqual((response.status_code, response.json["code"]), (503, "AUTH_VERIFY_UNAVAILABLE"))
                store.assert_not_called()

    def test_auth_stops_new_submission_but_does_not_close_existing_task_on_query(self):
        task_id = "11111111-1111-4111-8111-111111111111"
        for name, module, store_type in self.routes:
            for code, status in (("AUTH_SESSION_EXPIRED", 401), ("AUTH_TOKEN_INVALID", 401),
                                 ("AUTH_VERIFY_UNAVAILABLE", 503)):
                with (self.subTest(name=name, code=code), patch.object(module, store_type) as store,
                      patch.object(module.provider, "submit") as submit,
                      patch.object(server, "authenticate_access_token",
                                   side_effect=supabase_service.SupabaseError(code, "private details", status))):
                    base = f"/api/{name}-images"
                    create = self.client.post(base + "/generations", json={"request_id": task_id}, headers=self.headers)
                    self.assertEqual((create.status_code, create.json["code"], create.json["phase"]),
                                     (status, code, "authentication"))
                    self.assertIs(create.json["generation_submitted"], False)
                    self.assertIs(create.json["submission_unknown"], False)
                    self.assertIn("刷新页面", create.json["recovery"][0])
                    self.assertNotIn("重新登录", create.json["recovery"][0])
                    self.assertNotIn("private details", create.get_data(as_text=True))

                    query = self.client.get(base + "/tasks/" + task_id, headers=self.headers)
                    self.assertEqual((query.status_code, query.json["code"], query.json["phase"]),
                                     (status, code, "query"))
                    self.assertIs(query.json["submission_unknown"], True)
                    self.assertIn("查询原任务", query.json["detail"])
                    self.assertIn("刷新页面", query.json["recovery"][0])
                    self.assertNotIn("generation_submitted", query.json)
                    self.assertNotIn("refunded", query.json)
                    store.assert_not_called()
                    submit.assert_not_called()

    def test_task_store_error_after_verification_is_not_relabelled_as_client_auth(self):
        task_id = "11111111-1111-4111-8111-111111111111"
        for name, module, store_type in self.routes:
            with (self.subTest(name=name), patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "test-key"}),
                  patch.object(server, "require_authenticated_user", return_value=Mock(id=task_id)),
                  patch.object(module, store_type) as store):
                store.return_value.jobs.side_effect = supabase_service.SupabaseError("AUTH_TOKEN_INVALID", "private")
                response = self.client.get(f"/api/{name}-images/tasks/{task_id}", headers=self.headers)
                self.assertEqual((response.status_code, response.json["code"]), (503, "IMAGE_DATABASE_UNAVAILABLE"))

    def test_own_key_list_keeps_the_caller_and_key_scoped_owner(self):
        owner_hash = hashlib.sha256(b"test-key").hexdigest()
        for name, module, store_type in self.routes:
            endpoint = ("https://api.buytoken.work/v1/images/generations" if name == "buytoken"
                        else apimart_image_routes.provider.BASE + "/images/generations")
            headers = {"X-Billing-Mode": "own_key", "X-Provider-Model": "gpt-image-2.6-flare",
                       "X-Provider-Api-Key": "test-key", "X-Provider-Endpoint": endpoint,
                       "X-Provider-Auth-Type": "bearer", "X-Client-Id": "test-browser-id"}
            with (self.subTest(name=name), patch.object(module, store_type) as store,
                  patch.object(server, "validate_provider_endpoint")):
                store.return_value.jobs.return_value = []
                response = self.client.get(f"/api/{name}-images/tasks", headers=headers)
                self.assertEqual(response.status_code, 200)
                store.return_value.jobs.assert_called_once_with(f"guest-test-browser-id-{owner_hash}")

    def test_jwt_connection_failure_and_invalid_signature_are_distinct(self):
        with (patch.object(supabase_service, "_require_supabase_config"),
              patch.object(jwt, "get_unverified_header", return_value={"alg": "ES256"}),
              patch.object(supabase_service, "_jwks_client") as client, patch.object(jwt, "decode") as decode):
            get_key = client.return_value.get_signing_key_from_jwt
            get_key.side_effect = jwt.PyJWKClientConnectionError("test connect error")
            with self.assertRaises(supabase_service.SupabaseError) as error:
                supabase_service.authenticate_access_token("test-token")
            self.assertEqual((error.exception.status, error.exception.code), (503, "AUTH_VERIFY_UNAVAILABLE"))
            decode.assert_not_called()

            get_key.side_effect = None
            decode.side_effect = jwt.InvalidSignatureError("test invalid signature")
            with self.assertRaises(supabase_service.SupabaseError) as error:
                supabase_service.authenticate_access_token("test-token")
            self.assertEqual((error.exception.status, error.exception.code), (401, "AUTH_TOKEN_INVALID"))
