import base64
import json
import os
import unittest
from contextlib import contextmanager
from unittest import mock

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from backend import payment_service


def _key_pair():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public_pem = private.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private, private_pem, public_pem


def _sign(private, content):
    return base64.b64encode(private.sign(content, padding.PKCS1v15(), hashes.SHA256())).decode()


@contextmanager
def _environment(**values):
    original = {key: os.environ.get(key) for key in values}
    try:
        for key, value in values.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        yield
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


class PaymentAdapterTests(unittest.TestCase):
    def test_disabled_provider_exposes_no_channels(self):
        with _environment(
            PAYMENT_PROVIDER="disabled",
            WECHAT_APP_ID="wx-app",
            WECHAT_MCH_ID="mch",
            WECHAT_SERIAL_NO="serial",
            WECHAT_MCH_PRIVATE_KEY="private",
            WECHAT_PLATFORM_PUBLIC_KEY="public",
            WECHAT_API_V3_KEY="12345678901234567890123456789012",
            ALIPAY_APP_ID="ali-app",
            ALIPAY_PRIVATE_KEY="private",
            ALIPAY_PUBLIC_KEY="public",
        ):
            self.assertEqual(payment_service.configured_payment_channels(), [])

    def test_invalid_public_url_does_not_expose_channels(self):
        with _environment(
            PAYMENT_PROVIDER="enabled",
            PUBLIC_BASE_URL="https://",
            ALIPAY_APP_ID="ali-app",
            ALIPAY_PRIVATE_KEY="private",
            ALIPAY_PUBLIC_KEY="public",
        ):
            self.assertEqual(payment_service.configured_payment_channels(), [])

    def test_active_channel_list_only_exposes_alipay(self):
        with _environment(
            PAYMENT_PROVIDER="enabled",
            PUBLIC_BASE_URL="https://posterflow.example.com",
            WECHAT_APP_ID="wx-app",
            WECHAT_MCH_ID="mch",
            WECHAT_SERIAL_NO="serial",
            WECHAT_MCH_PRIVATE_KEY="private",
            WECHAT_PLATFORM_PUBLIC_KEY="public",
            WECHAT_PLATFORM_PUBLIC_KEY_ID="platform-key-id",
            WECHAT_API_V3_KEY="12345678901234567890123456789012",
            ALIPAY_APP_ID="ali-app",
            ALIPAY_PRIVATE_KEY="private",
            ALIPAY_PUBLIC_KEY="public",
        ):
            self.assertEqual(payment_service.configured_payment_channels(), ["alipay"])

    def test_wechat_checkout_is_safely_disabled(self):
        with self.assertRaises(payment_service.PaymentError) as context:
            payment_service.create_checkout("wechat", out_trade_no="PF123", amount_fen=1000, expires_at="2026-09-14T00:00:00+00:00")
        self.assertEqual(context.exception.code, "PAYMENT_CHANNEL_DISABLED")

    def test_alipay_callback_is_verified_and_normalized(self):
        private, _private_pem, public_pem = _key_pair()
        form = {
            "app_id": "ali-app",
            "out_trade_no": "PF123",
            "trade_no": "ALI123",
            "trade_status": "TRADE_SUCCESS",
            "total_amount": "10.00",
            "seller_id": "seller",
            "sign_type": "RSA2",
        }
        canonical = payment_service._alipay_canonical(form, exclude_sign_type=True).encode()
        form["sign"] = _sign(private, canonical)
        with _environment(ALIPAY_APP_ID="ali-app", ALIPAY_PUBLIC_KEY=public_pem, ALIPAY_SELLER_ID="seller"):
            result = payment_service.parse_alipay_callback(form)
        self.assertEqual(result.out_trade_no, "PF123")
        self.assertEqual(result.provider_trade_no, "ALI123")
        self.assertEqual(result.paid_amount_fen, 1000)

    def test_wechat_callback_decrypts_and_uses_total_amount(self):
        private, _private_pem, public_pem = _key_pair()
        api_v3_key = b"12345678901234567890123456789012"
        timestamp = "1789320000"
        nonce = "notification-nonce"
        associated_data = "transaction"
        transaction = {
            "appid": "wx-app",
            "mchid": "mch",
            "out_trade_no": "PF456",
            "transaction_id": "WX456",
            "trade_state": "SUCCESS",
            "amount": {"total": 2000, "payer_total": 1},
        }
        ciphertext = AESGCM(api_v3_key).encrypt(
            nonce.encode(),
            json.dumps(transaction, separators=(",", ":")).encode(),
            associated_data.encode(),
        )
        body = json.dumps(
            {
                "event_type": "TRANSACTION.SUCCESS",
                "resource": {
                    "nonce": nonce,
                    "associated_data": associated_data,
                    "ciphertext": base64.b64encode(ciphertext).decode(),
                },
            },
            separators=(",", ":"),
        ).encode()
        headers = {
            "Wechatpay-Timestamp": timestamp,
            "Wechatpay-Nonce": "header-nonce",
            "Wechatpay-Serial": "platform-key-id",
        }
        headers["Wechatpay-Signature"] = _sign(
            private,
            f"{timestamp}\nheader-nonce\n".encode() + body + b"\n",
        )
        with _environment(
            WECHAT_APP_ID="wx-app",
            WECHAT_MCH_ID="mch",
            WECHAT_PLATFORM_PUBLIC_KEY=public_pem,
            WECHAT_PLATFORM_PUBLIC_KEY_ID="platform-key-id",
            WECHAT_API_V3_KEY=api_v3_key.decode(),
        ):
            with mock.patch("backend.payment_service.time.time", return_value=1789320000):
                result = payment_service.parse_wechat_callback(headers, body)
        self.assertEqual(result.out_trade_no, "PF456")
        self.assertEqual(result.provider_trade_no, "WX456")
        self.assertEqual(result.paid_amount_fen, 2000)

    def test_callback_requires_order_and_trade_numbers(self):
        private, _private_pem, public_pem = _key_pair()
        form = {
            "app_id": "ali-app",
            "out_trade_no": "",
            "trade_no": "",
            "trade_status": "TRADE_SUCCESS",
            "total_amount": "10.00",
            "sign_type": "RSA2",
        }
        form["sign"] = _sign(private, payment_service._alipay_canonical(form, exclude_sign_type=True).encode())
        with _environment(ALIPAY_APP_ID="ali-app", ALIPAY_PUBLIC_KEY=public_pem):
            with self.assertRaises(payment_service.PaymentError) as context:
                payment_service.parse_alipay_callback(form)
        self.assertEqual(context.exception.code, "PAYMENT_CALLBACK_INVALID")


if __name__ == "__main__":
    unittest.main()
