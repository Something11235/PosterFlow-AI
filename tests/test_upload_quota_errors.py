"""Offline quota diagnostics: no server import, credentials or upstream access."""
import base64
import io
import json
import unittest
from unittest.mock import Mock, patch

from PIL import Image

from backend import apimart_image_provider as provider
from backend.admin_multimedia import enrich_overview
from backend.generation_failures import image_failure_reason


REQUEST_ID = "22222222-2222-4222-8222-222222222222"


def response(payload, status=200):
    result = Mock(status_code=status)
    result.iter_content.return_value = [json.dumps(payload).encode()]
    return result


class UploadQuotaTests(unittest.TestCase):
    def setUp(self):
        image = io.BytesIO()
        Image.new("RGB", (16, 16), "blue").save(image, format="PNG")
        self.encoded = base64.b64encode(image.getvalue()).decode("ascii")

    def upload_error(self, payload, status=429):
        with patch.object(provider.requests, "request", return_value=response(payload, status)) as call:
            with self.assertRaises(provider.ImageTaskError) as caught:
                provider.upload_reference("synthetic-fixture-key", self.encoded, request_id=REQUEST_ID, reference_index=1)
            call.assert_called_once()
        return caught.exception

    def test_confirmed_upload_quota_is_distinct_from_transient_rate_limit(self):
        quota = {"limit": 2000, "used": 2000, "remaining": 0, "window_hours": 72, "reset_at": 1794063600}
        error = self.upload_error({"error": {"type": "rate_limit_exceeded"}, "quota": quota})
        self.assertEqual(error.code, "REFERENCE_UPLOAD_QUOTA_EXCEEDED")
        self.assertEqual(error.status, 429)
        self.assertEqual(error.upstream_status, 429)
        self.assertFalse(error.uncertain)
        self.assertEqual(error.quota, quota)
        self.assertIn("上传额度已用尽", str(error))

    def test_429_without_confirmed_exhausted_quota_does_not_invent_reset_or_limit(self):
        for quota in (None, {}, {"remaining": 0}, {"limit": 2000, "remaining": 12},
                      {"limit": 2000, "remaining": False}, {"limit": "2000", "remaining": 0}):
            with self.subTest(quota=quota):
                error = self.upload_error({"error": {"type": "rate_limit_exceeded"}, "quota": quota})
                self.assertEqual(error.code, "REFERENCE_UPLOAD_RATE_LIMITED")
                self.assertEqual(error.status, 429)
                self.assertFalse(error.uncertain)
                self.assertNotIn("reset_at", error.quota)
                self.assertNotIn("2000", str(error))

    def test_quota_allows_only_bounded_integer_fields(self):
        quota = {"limit": 2000, "used": -1, "remaining": False, "window_hours": 72.0,
                 "reset_at": "1794063600", "message": "private", "token": "private"}
        error = provider.ImageTaskError("fixture", "fixture", quota=quota)
        self.assertEqual(error.quota, {"limit": 2000})
        for value in (True, None, 1.5, "1", -1, 10**30):
            with self.subTest(value=value):
                error = provider.ImageTaskError("fixture", "fixture", quota={name: value for name in quota})
                self.assertEqual(error.quota, {})
        for value in ([], "private", 7, None):
            self.assertEqual(provider.ImageTaskError("fixture", "fixture", quota=value).quota, {})

    def test_quota_diagnostics_do_not_log_raw_response_key_or_image(self):
        quota = {"limit": 2000, "used": 2000, "remaining": 0, "window_hours": 72,
                 "reset_at": 1794063600, "private\nforged": "private-content"}
        payload = {"error": {"type": "rate_limit_exceeded", "message": "private-response-content"},
                   "quota": quota, "url": "https://private.invalid/?token=private"}
        with self.assertLogs(provider.__name__, level="WARNING") as logs:
            error = self.upload_error(payload)
        text = "\n".join(logs.output)
        for value in ("upstream_status=429", "limit=2000", "used=2000", "remaining=0", "reset_at=1794063600", "window_hours=72"):
            self.assertIn(value, text)
        for value in ("private", "forged", "synthetic-fixture-key", self.encoded):
            self.assertNotIn(value, text)
            self.assertNotIn(value, str(error))

    def test_successful_upload_records_only_sanitized_quota(self):
        payload = {"url": "https://getapib.org/image/reference.png", "quota": {"limit": 2000, "remaining": 1900, "message": "private"}}
        with patch.object(provider.requests, "request", return_value=response(payload)), self.assertLogs(provider.__name__, level="INFO") as logs:
            self.assertEqual(provider.upload_reference("synthetic-fixture-key", self.encoded), payload["url"])
        text = "\n".join(logs.output)
        self.assertIn("remaining=1900", text)
        self.assertNotIn("private", text)
        self.assertNotIn("getapib.org", text)

    def test_generation_429_does_not_become_upload_error(self):
        payload = {"error": {"type": "rate_limit_exceeded"}, "quota": {"limit": 2000, "remaining": 0}}
        with patch.object(provider.requests, "request", return_value=response(payload, 429)):
            with self.assertRaises(provider.ImageTaskError) as caught:
                provider.submit("synthetic-fixture-key", {"model": "gemini-nano-banana-2.1", "prompt": "fixture"}, REQUEST_ID)
        self.assertEqual(caught.exception.code, "APIMART_REQUEST_REJECTED")

    def test_other_upload_failures_keep_generic_code_and_never_claim_paid_submission(self):
        for status in (400, 401, 402, 413, 500, 504):
            with self.subTest(status=status):
                error = self.upload_error({"error": {"type": "invalid_request_error"}}, status)
                self.assertEqual(error.code, "REFERENCE_UPLOAD_FAILED")
                self.assertFalse(error.uncertain)

    def test_admin_and_recovered_task_explanations_are_precise(self):
        cases = {"REFERENCE_UPLOAD_QUOTA_EXCEEDED": "参考素材上传额度已用尽",
                 "REFERENCE_UPLOAD_RATE_LIMITED": "参考图上传被限流",
                 "REFERENCE_LINK_UNAVAILABLE": "参考图临时链接不可用"}
        result = enrich_overview({"image_jobs": [{"status": "refunded", "error_code": code} for code in cases]})
        for row in result["image_jobs"]:
            code = row["error_code"]
            self.assertEqual(row["failure_label"], cases[code])
            self.assertEqual(row["failure_reason"], image_failure_reason(code))
            self.assertIn("尚未提交生图", row["failure_reason"])
            for unsuitable in ("提示词", "余额不足", "网络", "违规", "修改参考图"):
                self.assertNotIn(unsuitable, row["failure_reason"])


if __name__ == "__main__":
    unittest.main()
