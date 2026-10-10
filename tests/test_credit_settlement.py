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


if __name__ == "__main__":
    unittest.main()
