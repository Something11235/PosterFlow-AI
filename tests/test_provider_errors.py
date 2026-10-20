import json
import unittest
from dataclasses import replace
from unittest.mock import Mock, patch

from backend import server
from backend.provider_errors import PLATFORM_FAILURE_DETAIL, describe_provider_rejection


class ProviderRejectionTests(unittest.TestCase):
    def setUp(self):
        self.provider = server.ProviderConfig("synthetic-private-key-123456", "https://relay.example/v1/images/generations", "synthetic-model", "bearer", "platform")

    def test_platform_reasons_are_fixed_regardless_of_upstream_code_or_message(self):
        for code, message, status in (("moderation_blocked", "Content policy violation", 400),
                                      ("insufficient_quota", "Key 独立额度不足", 403),
                                      ("rate_limit_exceeded", "Too many requests", 429),
                                      ("invalid_api_key", "Unauthorized", 401),
                                      ("unknown_error", "Forbidden", 403)):
            with self.subTest(code=code):
                result = describe_provider_rejection({"error": {"code": code, "message": message}}, status, self.provider, {"x-request-id": "synthetic-request"})
                self.assertEqual(result["code"], "PROVIDER_REJECTED")
                self.assertEqual(result["detail"], PLATFORM_FAILURE_DETAIL)
                self.assertEqual(result["upstream_error"]["message"], message)
                self.assertEqual(result["upstream_error"]["code"], code)
                self.assertEqual(result["upstream_error"]["http_status"], status)
                self.assertEqual(result["upstream_error"]["request_id"], "synthetic-request")
                self.assertNotIn("Key", " / ".join(result["recovery"]))

    def test_nested_error_json_keeps_the_specific_message_without_inferring_a_category(self):
        payload = {"error": {"message": json.dumps({"error": {"code": "content_policy_violation", "message": "Rejected by the safety system."}})}}
        result = describe_provider_rejection(payload, 400, self.provider)
        self.assertEqual(result["code"], "PROVIDER_REJECTED")
        self.assertEqual(result["upstream_error"]["message"], "Rejected by the safety system.")
        self.assertEqual(result["upstream_error"]["code"], "content_policy_violation")

    def test_only_selected_error_fields_are_exposed_and_secrets_urls_and_prompt_are_redacted(self):
        prompt = "synthetic full private prompt for a regression check"
        other_key = "sk-" + "syntheticOtherSecret12345"
        message = f"Error: {self.provider.api_key}, {other_key}; https://relay.example/private?token=secret; relay.example; Bearer syntheticBearer; {prompt}"
        result = describe_provider_rejection({"error": {"message": message, "request_body": {"api_key": self.provider.api_key}}, "headers": {"secret": "not-for-client"}}, 400, self.provider, {}, prompt)
        exposed = json.dumps(result)
        for private in (self.provider.api_key, other_key, "relay.example", "syntheticBearer", prompt, "not-for-client", "request_body"):
            self.assertNotIn(private, exposed)

    def test_reason_is_bounded_and_html_remains_a_string(self):
        result = describe_provider_rejection({"error": "<script>synthetic</script>" + "x" * 5000}, 400, self.provider)
        self.assertLessEqual(len(result["upstream_error"]["message"]), 1601)
        self.assertIn("<script>", result["upstream_error"]["message"])

    def test_platform_request_path_returns_diagnostics_while_own_key_keeps_old_behavior(self):
        response = Mock(status_code=400, headers={"x-request-id": "synthetic-request"})
        response.json.return_value = {"error": {"code": "moderation_blocked", "message": "synthetic original rejection"}}
        for source in ("platform", "browser"):
            with patch.object(server.requests, "post", return_value=response):
                with self.assertRaises(server.ProviderError) as caught:
                    server.generate_images(replace(self.provider, source=source), "synthetic prompt")
            with server.app.test_request_context():
                data, status = server.provider_error_response(caught.exception)
            data = data.get_json()
            self.assertEqual(status, 400)
            self.assertEqual(data["code"], "PROVIDER_REJECTED")
            if source == "platform":
                self.assertEqual(data["detail"], PLATFORM_FAILURE_DETAIL)
                self.assertEqual(data["upstream_error"]["message"], "synthetic original rejection")
            else:
                self.assertEqual(data["detail"], "synthetic original rejection")
                self.assertEqual(data["recovery"], ["检查 API Key、余额与模型权限", "参考图编辑需确认模型支持 input_references 或标准图片编辑接口", "核对接口地址和模型标识"])
                self.assertNotIn("upstream_error", data)

    def test_plaintext_platform_error_is_preserved_and_bad_success_payload_does_not_crash(self):
        response = Mock(status_code=403, headers={}, text="synthetic plain text rejection")
        response.json.side_effect = ValueError("not json")
        with patch.object(server.requests, "post", return_value=response):
            with self.assertRaises(server.ProviderError) as caught:
                server.generate_images(self.provider, "synthetic prompt")
        self.assertEqual(caught.exception.code, "PROVIDER_REJECTED")
        self.assertEqual(caught.exception.upstream_error["message"], "synthetic plain text rejection")
        response = Mock(status_code=200)
        response.json.return_value = []
        with patch.object(server.requests, "post", return_value=response):
            with self.assertRaises(server.ProviderError) as caught:
                server.generate_images(self.provider, "synthetic prompt")
        self.assertEqual(caught.exception.code, "PROVIDER_BAD_RESPONSE")


if __name__ == "__main__":
    unittest.main()
