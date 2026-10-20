"""Keep the platform image service's error information without inferring a cause."""

import json
import re


PLATFORM_FAILURE_DETAIL = "一般为以下原因：\n1.提示词有模型不支持的参数或违规用词触发审核拒绝\n2.余额不足\n3.高峰期使用人数过多"


def _safe_text(value, provider, prompt="", limit=1600):
    text = value[:16000] if isinstance(value, str) else ""
    # Exact credentials first, including providers whose keys have no common prefix.
    if provider.api_key:
        text = text.replace(provider.api_key, "[密钥已隐藏]")
    if prompt and len(prompt) >= 16:
        text = text.replace(prompt, "[提示词已省略]")
    text = re.sub(r"data:image/[^\s,]+,[A-Za-z0-9+/=_-]+", "[图片数据已省略]", text, flags=re.I)
    text = re.sub(r"https?://[^\s<>\"')]+", "[服务链接已隐藏]", text, flags=re.I)
    if provider.source == "platform" and provider.host:
        text = re.sub(re.escape(provider.host), "[服务地址已隐藏]", text, flags=re.I)
    text = re.sub(r"\b(?:sk-|sb_secret_)[A-Za-z0-9_-]{8,}", "[密钥已隐藏]", text)
    text = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[凭证已隐藏]", text)
    text = re.sub(r"(?i)\bBearer\s+\S+", "Bearer [凭证已隐藏]", text)
    text = re.sub(r"(?i)([\"']?(?:api[_ -]?key|access_token|refresh_token|authorization)[\"']?\s*[:=]\s*)[\"']?[^\s,;\"'}]+", r"\1[凭证已隐藏]", text)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text).strip()
    return text[:limit] + ("…" if len(text) > limit else "")


def _layers(payload):
    layers = [payload]
    for _ in range(4):
        current = layers[-1]
        nested = next((current[key] for key in ("error", "innererror", "cause") if isinstance(current.get(key), dict)), None)
        if nested is None:
            for key in ("error", "message"):
                value = current.get(key)
                if isinstance(value, str) and len(value) <= 16000 and value.lstrip().startswith("{"):
                    try:
                        candidate = json.loads(value)
                    except ValueError:
                        continue
                    if isinstance(candidate, dict):
                        nested = candidate
                        break
        if nested is None:
            break
        layers.append(nested)
    return layers


def _identifier(value, provider):
    text = _safe_text(value, provider, limit=128)
    return text if re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", text) else ""


def describe_provider_rejection(payload, status, provider, headers=None, prompt=""):
    layers = _layers(payload if isinstance(payload, dict) else {})
    message = ""
    for layer in reversed(layers):
        for key in ("message", "detail", "reason", "refusal", "error"):
            value = layer.get(key)
            if isinstance(value, str) and value.strip() and not value.lstrip().startswith(("{", "[")):
                message = _safe_text(value, provider, prompt)
                break
        if message:
            break
    message = message or f"图片服务未提供具体拒绝原因（HTTP {status}）。"
    upstream_code = next((_identifier(layer.get("code"), provider) for layer in reversed(layers) if _identifier(layer.get("code"), provider)), "")
    upstream_type = next((_identifier(layer.get("type"), provider) for layer in reversed(layers) if _identifier(layer.get("type"), provider)), "")
    request_id = ""
    if headers is not None:
        for name in ("x-request-id", "request-id", "x-amzn-requestid"):
            request_id = _identifier(headers.get(name), provider)
            if request_id:
                break
    return {
        "code": "PROVIDER_REJECTED", "message": "图片生成服务拒绝了本次请求",
        "detail": PLATFORM_FAILURE_DETAIL, "recovery": ["稍后重试", "联系站主核对本次请求"],
        "status": status if 400 <= status <= 599 else 502,
        "upstream_error": {"message": message, "code": upstream_code, "type": upstream_type, "http_status": status, "request_id": request_id},
    }
