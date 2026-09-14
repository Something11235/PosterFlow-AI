"""Server-only Alipay checkout helpers.

The former WeChat Native Pay implementation remains below for historical
reference, but WeChat is intentionally disabled and is never advertised or
accepted by the active checkout channel list. Merchant credentials are read
from environment variables; the browser only receives a checkout QR payload.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import time
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import quote, urlsplit
from zoneinfo import ZoneInfo

import requests
from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PAYMENT_REQUEST_TIMEOUT = 20


class PaymentError(Exception):
    def __init__(self, code: str, message: str, status: int = 502, detail: str = ""):
        super().__init__(message)
        self.code, self.message, self.status, self.detail = code, message, status, detail


@dataclass(frozen=True)
class CheckoutResult:
    code_url: str
    payment_url: str = ""


@dataclass(frozen=True)
class PaidOrder:
    out_trade_no: str
    provider_trade_no: str
    paid_amount_fen: int
    metadata: dict[str, Any]


def _env(name: str) -> str:
    return os.getenv(name, "").strip()


def _pem(name: str) -> bytes:
    value = _env(name).replace("\\n", "\n")
    if not value:
        raise PaymentError("PAYMENT_NOT_CONFIGURED", "在线支付尚未配置", 503, f"服务端缺少 {name}。")
    return value.encode("utf-8")


def _private_key(name: str):
    try:
        return serialization.load_pem_private_key(_pem(name), password=None)
    except (TypeError, ValueError) as exc:
        raise PaymentError("PAYMENT_KEY_INVALID", "支付商户私钥无效", 503, f"请检查环境变量 {name}。") from exc


def _public_key(name: str):
    try:
        return serialization.load_pem_public_key(_pem(name))
    except (TypeError, ValueError) as exc:
        raise PaymentError("PAYMENT_KEY_INVALID", "支付平台公钥无效", 503, f"请检查环境变量 {name}。") from exc


def _rsa_sign(key_name: str, content: bytes) -> str:
    return base64.b64encode(_private_key(key_name).sign(content, padding.PKCS1v15(), hashes.SHA256())).decode("ascii")


def _rsa_verify(key_name: str, content: bytes, signature: str) -> None:
    try:
        _public_key(key_name).verify(base64.b64decode(signature, validate=True), content, padding.PKCS1v15(), hashes.SHA256())
    except (InvalidSignature, ValueError) as exc:
        raise PaymentError("PAYMENT_SIGNATURE_INVALID", "支付签名校验失败", 401, "拒绝处理无法确认来源的支付消息。") from exc


def public_base_url() -> str:
    value = _env("PUBLIC_BASE_URL").rstrip("/")
    try:
        parsed = urlsplit(value)
        is_local_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        is_public_https = parsed.scheme == "https" and bool(parsed.hostname)
        has_credentials = bool(parsed.username or parsed.password)
    except ValueError:
        is_local_http = is_public_https = has_credentials = False
    if not value or not (is_public_https or is_local_http) or has_credentials:
        raise PaymentError("PAYMENT_NOT_CONFIGURED", "在线支付回调地址尚未配置", 503, "生产环境必须设置公网 HTTPS 的 PUBLIC_BASE_URL。")
    return value


def payment_enabled() -> bool:
    """Return whether the operator explicitly enabled online checkout."""
    return _env("PAYMENT_PROVIDER").lower() in {"enabled", "alipay"}


def configured_payment_channels() -> list[str]:
    if not payment_enabled():
        return []
    # A gateway can accept a checkout request while still being unable to send
    # its official callback if the public URL is missing or not HTTPS. Treat
    # that as not configured so the UI never advertises a channel that cannot
    # safely settle orders.
    try:
        public_base_url()
    except PaymentError:
        return []
    # WeChat Native Pay is deliberately disabled for this product. Keep the
    # legacy adapter in this module for audit/history, but do not expose its
    # credentials, QR flow, or callback as an active channel.
    if all(_env(name) for name in ("ALIPAY_APP_ID", "ALIPAY_PRIVATE_KEY", "ALIPAY_PUBLIC_KEY")):
        return ["alipay"]
    return []


def create_checkout(channel: str, *, out_trade_no: str, amount_fen: int, expires_at: str) -> CheckoutResult:
    if channel == "wechat":
        raise PaymentError("PAYMENT_CHANNEL_DISABLED", "微信支付已停用", 410, "当前仅支持支付宝当面付。")
    if channel == "alipay":
        return _create_alipay_precreate(out_trade_no, amount_fen)
    raise PaymentError("PAYMENT_CHANNEL_INVALID", "支付方式无效", 400, "当前仅支持支付宝当面付。")


def _create_wechat_native(out_trade_no: str, amount_fen: int, expires_at: str) -> CheckoutResult:
    if "wechat" not in configured_payment_channels():
        raise PaymentError("PAYMENT_NOT_CONFIGURED", "微信支付尚未配置", 503, "请先配置微信支付 Native 商户参数。")
    path = "/v3/pay/transactions/native"
    body = json.dumps({
        "appid": _env("WECHAT_APP_ID"), "mchid": _env("WECHAT_MCH_ID"),
        "description": "PosterFlow AI 图片生成积分", "out_trade_no": out_trade_no,
        "notify_url": f"{public_base_url()}/api/payments/webhook/wechat",
        "time_expire": expires_at, "amount": {"total": amount_fen, "currency": "CNY"},
    }, ensure_ascii=False, separators=(",", ":"))
    timestamp, nonce = str(int(time.time())), secrets.token_hex(16)
    signature = _rsa_sign("WECHAT_MCH_PRIVATE_KEY", f"POST\n{path}\n{timestamp}\n{nonce}\n{body}\n".encode())
    authorization = ("WECHATPAY2-SHA256-RSA2048 "
        f'mchid="{_env("WECHAT_MCH_ID")}",nonce_str="{nonce}",timestamp="{timestamp}",'
        f'serial_no="{_env("WECHAT_SERIAL_NO")}",signature="{signature}"')
    try:
        response = requests.post(
            f"{_env('WECHAT_API_BASE') or 'https://api.mch.weixin.qq.com'}{path}",
            data=body.encode(),
            headers={"Authorization": authorization, "Accept": "application/json", "Content-Type": "application/json"},
            timeout=PAYMENT_REQUEST_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise PaymentError("PAYMENT_PROVIDER_UNAVAILABLE", "微信支付暂时不可用", 502, "下单请求未能送达微信支付。") from exc
    _verify_wechat_message(response.headers, response.content)
    if response.status_code >= 400:
        try:
            payload = response.json()
            detail = payload.get("message") or payload.get("code")
        except ValueError:
            detail = "未知错误"
        raise PaymentError("PAYMENT_PROVIDER_REJECTED", "微信支付下单失败", 502, str(detail or "未知错误"))
    try:
        code_url = str(response.json().get("code_url", "")).strip()
    except ValueError as exc:
        raise PaymentError("PAYMENT_PROVIDER_BAD_RESPONSE", "微信支付返回异常", 502, "没有返回有效 JSON。") from exc
    if not code_url:
        raise PaymentError("PAYMENT_PROVIDER_BAD_RESPONSE", "微信支付下单失败", 502, "响应中没有付款二维码地址。")
    return CheckoutResult(code_url=code_url)


def _verify_wechat_message(headers, body: bytes) -> None:
    timestamp, nonce, signature = (str(headers.get(name, "")) for name in ("Wechatpay-Timestamp", "Wechatpay-Nonce", "Wechatpay-Signature"))
    serial, expected = str(headers.get("Wechatpay-Serial", "")), _env("WECHAT_PLATFORM_PUBLIC_KEY_ID")
    if not timestamp or not nonce or not signature:
        raise PaymentError("PAYMENT_SIGNATURE_INVALID", "微信支付签名缺失", 401, "支付消息缺少必要签名头。")
    try:
        if abs(int(time.time()) - int(timestamp)) > 300:
            raise PaymentError("PAYMENT_CALLBACK_EXPIRED", "支付通知已过期", 401, "拒绝处理超过 5 分钟的支付消息。")
    except ValueError as exc:
        raise PaymentError("PAYMENT_SIGNATURE_INVALID", "微信支付签名无效", 401, "支付消息时间戳无效。") from exc
    if expected and serial != expected:
        raise PaymentError("PAYMENT_SIGNATURE_INVALID", "微信支付公钥标识不匹配", 401, "请更新微信支付平台公钥配置。")
    _rsa_verify("WECHAT_PLATFORM_PUBLIC_KEY", f"{timestamp}\n{nonce}\n".encode() + body + b"\n", signature)


def parse_wechat_callback(headers, body: bytes) -> PaidOrder:
    _verify_wechat_message(headers, body)
    try:
        notification = json.loads(body)
        resource = notification["resource"]
        api_key = _env("WECHAT_API_V3_KEY").encode()
        if len(api_key) != 32:
            raise ValueError("API v3 key length")
        plaintext = AESGCM(api_key).decrypt(
            str(resource["nonce"]).encode(),
            base64.b64decode(resource["ciphertext"]),
            str(resource.get("associated_data", "")).encode(),
        )
        transaction = json.loads(plaintext)
    except (InvalidTag, KeyError, TypeError, ValueError) as exc:
        raise PaymentError("PAYMENT_CALLBACK_INVALID", "微信支付通知解析失败", 400, "支付通知无法解密或字段不完整。") from exc
    if notification.get("event_type") != "TRANSACTION.SUCCESS" or transaction.get("trade_state") != "SUCCESS":
        raise PaymentError("PAYMENT_NOT_SUCCEEDED", "支付尚未成功", 409, "本次通知不是支付成功事件。")
    if transaction.get("mchid") != _env("WECHAT_MCH_ID") or transaction.get("appid") != _env("WECHAT_APP_ID"):
        raise PaymentError("PAYMENT_MERCHANT_MISMATCH", "支付商户信息不匹配", 401, "拒绝处理其他商户的订单。")
    out_trade_no = str(transaction.get("out_trade_no", "")).strip()
    provider_trade_no = str(transaction.get("transaction_id", "")).strip()
    amount = transaction.get("amount") or {}
    try:
        paid_amount_fen = int(amount.get("total", 0))
    except (TypeError, ValueError) as exc:
        raise PaymentError("PAYMENT_CALLBACK_INVALID", "微信支付金额无效", 400, "支付通知中的金额无法识别。") from exc
    if not out_trade_no or not provider_trade_no or paid_amount_fen <= 0:
        raise PaymentError("PAYMENT_CALLBACK_INVALID", "微信支付通知不完整", 400, "支付通知缺少订单号、交易号或金额。")
    return PaidOrder(
        out_trade_no,
        provider_trade_no,
        paid_amount_fen,
        {"channel": "wechat", "trade_state": transaction.get("trade_state")},
    )


def _alipay_canonical(params: dict[str, Any], *, exclude_sign_type: bool = False) -> str:
    return "&".join(
        f"{key}={params[key]}"
        for key in sorted(params)
        if key != "sign" and (not exclude_sign_type or key != "sign_type") and params[key] not in (None, "")
    )


def _extract_json_value(raw: str, key: str) -> str:
    marker = f'"{key}"'
    start = raw.find(marker)
    if start < 0:
        return ""
    value_start = raw.find("{", raw.find(":", start + len(marker)) + 1)
    if value_start < 0:
        return ""
    depth, in_string, escaped = 0, False, False
    for index in range(value_start, len(raw)):
        char = raw[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return raw[value_start : index + 1]
    return ""


def _create_alipay_precreate(out_trade_no: str, amount_fen: int) -> CheckoutResult:
    if "alipay" not in configured_payment_channels():
        raise PaymentError("PAYMENT_NOT_CONFIGURED", "支付宝尚未配置", 503, "请先配置支付宝应用与 RSA2 密钥。")
    response_key = "alipay_trade_precreate_response"
    params: dict[str, str] = {
        "app_id": _env("ALIPAY_APP_ID"),
        "method": "alipay.trade.precreate",
        "format": "JSON",
        "charset": "utf-8",
        "sign_type": "RSA2",
        "timestamp": datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S"),
        "version": "1.0",
        "notify_url": f"{public_base_url()}/api/payments/webhook/alipay",
        "biz_content": json.dumps({
            "out_trade_no": out_trade_no,
            "total_amount": f"{Decimal(amount_fen) / Decimal(100):.2f}",
            "subject": "PosterFlow AI 图片生成积分",
            "timeout_express": "30m",
        }, ensure_ascii=False, separators=(",", ":")),
    }
    params["sign"] = _rsa_sign("ALIPAY_PRIVATE_KEY", _alipay_canonical(params).encode())
    try:
        response = requests.post(
            _env("ALIPAY_GATEWAY") or "https://openapi.alipay.com/gateway.do",
            data=params,
            timeout=PAYMENT_REQUEST_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise PaymentError("PAYMENT_PROVIDER_UNAVAILABLE", "支付宝暂时不可用", 502, "下单请求未能送达支付宝。") from exc
    try:
        payload = response.json()
        result = payload[response_key]
    except (ValueError, KeyError, TypeError) as exc:
        raise PaymentError("PAYMENT_PROVIDER_BAD_RESPONSE", "支付宝返回异常", 502, "支付宝没有返回有效下单结果。") from exc
    signed_content = _extract_json_value(response.text, response_key)
    if not payload.get("sign") or not signed_content:
        raise PaymentError("PAYMENT_SIGNATURE_INVALID", "支付宝响应签名缺失", 502, "无法确认支付宝下单响应来源。")
    _rsa_verify("ALIPAY_PUBLIC_KEY", signed_content.encode(), str(payload["sign"]))
    if str(result.get("code")) != "10000":
        detail = result.get("sub_msg") or result.get("msg") or result.get("sub_code") or "未知错误"
        raise PaymentError("PAYMENT_PROVIDER_REJECTED", "支付宝下单失败", 502, str(detail))
    code_url = str(result.get("qr_code", "")).strip()
    if not code_url:
        raise PaymentError("PAYMENT_PROVIDER_BAD_RESPONSE", "支付宝下单失败", 502, "响应中没有付款二维码地址。")
    return CheckoutResult(
        code_url=code_url,
        payment_url=f"alipays://platformapi/startapp?appId=20000067&url={quote(code_url, safe='')}",
    )


def parse_alipay_callback(form: dict[str, str]) -> PaidOrder:
    signature = str(form.get("sign", ""))
    if not signature:
        raise PaymentError("PAYMENT_SIGNATURE_INVALID", "支付宝签名缺失", 401, "支付通知没有携带签名。")
    _rsa_verify("ALIPAY_PUBLIC_KEY", _alipay_canonical(form, exclude_sign_type=True).encode(), signature)
    if form.get("app_id") != _env("ALIPAY_APP_ID"):
        raise PaymentError("PAYMENT_MERCHANT_MISMATCH", "支付宝应用不匹配", 401, "拒绝处理其他应用的订单。")
    seller_id = _env("ALIPAY_SELLER_ID")
    if seller_id and form.get("seller_id") != seller_id:
        raise PaymentError("PAYMENT_MERCHANT_MISMATCH", "支付宝收款账号不匹配", 401, "拒绝处理其他收款账号的订单。")
    if form.get("trade_status") not in {"TRADE_SUCCESS", "TRADE_FINISHED"}:
        raise PaymentError("PAYMENT_NOT_SUCCEEDED", "支付尚未成功", 409, "本次通知不是支付成功状态。")
    out_trade_no = str(form.get("out_trade_no", "")).strip()
    provider_trade_no = str(form.get("trade_no", "")).strip()
    try:
        amount_decimal = Decimal(str(form.get("total_amount", "0")))
        amount_fen_decimal = amount_decimal * 100
        if amount_decimal <= 0 or amount_fen_decimal != amount_fen_decimal.to_integral_value():
            raise ValueError("amount must be a positive number of fen")
        amount_fen = int(amount_fen_decimal)
    except (InvalidOperation, ValueError) as exc:
        raise PaymentError("PAYMENT_CALLBACK_INVALID", "支付宝金额无效", 400, "支付通知中的金额无法识别。") from exc
    if not out_trade_no or not provider_trade_no:
        raise PaymentError("PAYMENT_CALLBACK_INVALID", "支付宝通知不完整", 400, "支付通知缺少订单号或交易号。")
    return PaidOrder(
        out_trade_no,
        provider_trade_no,
        amount_fen,
        {"channel": "alipay", "trade_status": form.get("trade_status")},
    )


def alipay_success_response() -> str:
    return "success"
