import unittest
from unittest.mock import Mock, patch

from backend import server


class GenerationCreditSettlementTests(unittest.TestCase):
    def setUp(self):
        self.provider = server.ProviderConfig(
            api_key="test-key",
            endpoint="https://provider.example/v1/images/generations",
            model="test-model",
            auth_type="bearer",
            source="server",
        )
        self.gateway = Mock()
        self.gateway.reserve_credits.return_value = {
            "ok": True,
            "existing": False,
            "job_id": "job-1",
            "status": "running",
        }
        self.gateway.refund_generation.return_value = {"ok": True, "status": "refunded"}

    def test_provider_failure_refunds_reserved_credits(self):
        with (
            patch.object(server, "platform_provider_configured", return_value=True),
            patch.object(server, "require_authenticated_user", return_value=Mock(id="user-1")),
            patch.object(server, "SupabaseGateway", return_value=self.gateway),
            patch.object(server, "resolve_provider_config", return_value=self.provider),
            patch.object(server, "enforce_rate_limit"),
        ):
            with self.assertRaises(server.ProviderError):
                server.execute_generation(
                    {"billing_mode": "platform", "request_id": "11111111-1111-4111-8111-111111111111"},
                    requested_count=1,
                    prompt="test",
                    generate_callback=Mock(side_effect=server.ProviderError("PROVIDER_REJECTED", "rejected", 502)),
                )

        self.gateway.refund_generation.assert_called_once_with("job-1", "PROVIDER_REJECTED")

    def test_platform_model_is_forwarded_to_provider_and_reservation(self):
        provider = server.ProviderConfig(
            api_key="test-key", endpoint="https://provider.example/v1/images/generations",
            model="gpt-image-2.5-sunburst", auth_type="bearer", source="platform"
        )
        self.gateway.reserve_credits.return_value = {"ok": True, "existing": False, "job_id": "job-2", "status": "running"}
        self.gateway.settle_generation.return_value = {"ok": True, "balance": 8}
        with (
            patch.object(server, "platform_provider_configured", return_value=True),
            patch.object(server, "require_authenticated_user", return_value=Mock(id="user-1")),
            patch.object(server, "SupabaseGateway", return_value=self.gateway),
            patch.object(server, "resolve_provider_config", return_value=provider) as resolve_provider,
            patch.object(server, "enforce_rate_limit"),
        ):
            result = server.execute_generation({"billing_mode": "platform", "platform_model": "gpt-image-2.5-sunburst", "request_id": "33333333-3333-4333-8333-333333333333"}, requested_count=1, prompt="test", generate_callback=lambda _provider: [{"filename": "image.png"}])
        resolve_provider.assert_called_once_with("platform", platform_model="gpt-image-2.5-sunburst")
        self.gateway.reserve_credits.assert_called_once_with("user-1", "33333333-3333-4333-8333-333333333333", 1, "provider.example", "gpt-image-2.5-sunburst", "test", server.USER_DAILY_IMAGE_LIMIT or None, server.PLATFORM_DAILY_IMAGE_LIMIT or None)
        self.gateway.settle_generation.assert_called_once_with("job-2", 1, unittest.mock.ANY, ["image.png"])
        self.assertEqual(result["images"], [{"filename": "image.png"}])

    def test_empty_success_response_is_refunded_and_not_returned_as_success(self):
        with (
            patch.object(server, "platform_provider_configured", return_value=True),
            patch.object(server, "require_authenticated_user", return_value=Mock(id="user-1")),
            patch.object(server, "SupabaseGateway", return_value=self.gateway),
            patch.object(server, "resolve_provider_config", return_value=self.provider),
            patch.object(server, "enforce_rate_limit"),
        ):
            with self.assertRaises(server.ProviderError) as context:
                server.execute_generation(
                    {"billing_mode": "platform", "request_id": "22222222-2222-4222-8222-222222222222"},
                    requested_count=1,
                    prompt="test",
                    generate_callback=lambda _provider: [],
                )

        self.assertEqual(context.exception.code, "PROVIDER_EMPTY_RESULT")
        self.gateway.refund_generation.assert_called_once_with("job-1", "PROVIDER_EMPTY_RESULT")
        self.gateway.settle_generation.assert_not_called()

    def test_legacy_quality_value_is_normalized_to_auto(self):
        prompt, size, custom_size, quality, count, strength = server.parse_generation_request(
            {"prompt": "一张测试图", "quality": "high"}
        )

        self.assertEqual(prompt, "一张测试图")
        self.assertEqual(size, "")
        self.assertIsNone(custom_size)
        self.assertEqual(quality, "auto")
        self.assertEqual(count, 1)
        self.assertEqual(strength, 0.65)


if __name__ == "__main__":
    unittest.main()
