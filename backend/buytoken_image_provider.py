"""BuyToken synchronous images, using the existing 2.5 compatibility contract.

Never upload references to APIMart and never retry a paid POST. Result URLs
are persisted by the route before download so a failed save can be resumed.
"""
import io
import json
from urllib.parse import urljoin, urlsplit

import requests
from PIL import Image
try:
    from backend import image_tier_pricing as tiers
except ModuleNotFoundError:
    import image_tier_pricing as tiers

try:
    from backend.apimart_image_provider import ImageTaskError, build_gpt26_request
except ModuleNotFoundError:
    from apimart_image_provider import ImageTaskError, build_gpt26_request

MODELS = frozenset(("gpt-image-2.6-flare", "gpt-image-2.6-sunburst"))
HOST = "api.buytoken.work"
MAX_JSON = 1024 * 1024
MAX_IMAGE = 25 * 1024 * 1024


def configured(server):
    try:
        parsed = urlsplit(server.PLATFORM_ENDPOINT)
        return bool(server.PLATFORM_API_KEY and parsed.scheme == "https" and parsed.hostname == HOST
                    and not parsed.username and not parsed.password and parsed.port in (None, 443)
                    and parsed.path.rstrip("/") == "/v1/images/generations" and not parsed.query and not parsed.fragment)
    except ValueError:
        return False


def resolve_config(server, mode, model):
    config = server.resolve_provider_config(mode, platform_model=model)
    parsed = urlsplit(config.endpoint)
    if parsed.scheme != "https" or parsed.hostname != HOST or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.path.rstrip("/") != "/v1/images/generations" or parsed.query or parsed.fragment:
        raise ImageTaskError("BUYTOKEN_ENDPOINT_INVALID", "请配置 BuyToken 的完整图片生成地址，并确认使用对应的图片服务 Key。")
    return config


def build_request(server, model, data, references, mask=None):
    if not isinstance(model, str) or model not in MODELS:
        raise ImageTaskError("MODEL_NOT_ALLOWED", "请选择当前提供的图片模型。")
    if data.get("output_format", "png") != "png":
        raise ImageTaskError("IMAGE_FEATURE_UNSUPPORTED", "当前图片服务尚未确认支持 GIF，请选择 PNG。")
    # Preserve the existing reference/count/mask/workflow validation. This is a
    # local validator only; it performs no APIMart request.
    try:
        tier = tiers.resolution(model, data)
        selected_size = tiers.pixels(server, {**data, "model": model})
    except ValueError as error:
        raise ImageTaskError("IMAGE_RESOLUTION_INVALID", str(error)) from None
    checked = build_gpt26_request(model, {**data, "resolution": "1K"}, references, mask=mask)
    payload = {"model": model, "prompt": checked["prompt"], "n": checked["n"], "quality": "auto"}
    payload["size"] = selected_size
    return {"provider": "buytoken", "payload": payload, "references": list(references), "mask": mask, "pricing_resolution": tier, "pricing_policy_version": 3 if data.get('pricing_version') == 3 else 1}


def validate_result_url(server, url, *, resolve_dns=True):
    if not isinstance(url, str) or not 1 <= len(url) <= 8192:
        raise ImageTaskError("IMAGE_RESULT_PENDING", "图片结果地址暂未确认，请保留原任务。", 503, True)
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.fragment:
        raise ImageTaskError("IMAGE_RESULT_PENDING", "图片结果地址暂未确认，请保留原任务。", 503, True)
    server.validate_provider_endpoint(url, resolve_dns=resolve_dns)
    return url


def submit(server, config, body, request_id):
    payload = body["payload"]
    kwargs = {"headers": server.provider_headers(config), "timeout": (10, 210), "allow_redirects": False, "stream": True}
    endpoint = config.endpoint
    if body["references"]:
        kwargs["headers"] = server.provider_headers(config, content_type=None)
        field = "image" if len(body["references"]) == 1 else "image[]"
        kwargs["files"] = [(field, server.reference_image_upload(image, index)) for index, image in enumerate(body["references"], 1)]
        if body["mask"]:
            kwargs["files"].append(("mask", server.reference_image_upload(body["mask"], 0)))
        kwargs["data"] = {key: str(value) for key, value in payload.items()}
        endpoint = server.provider_edit_endpoint(config)
    else:
        kwargs["json"] = payload
    kwargs["headers"]["X-Request-Id"] = request_id
    response = None
    try:
        response = requests.post(endpoint, **kwargs)
        # Only unequivocal validation/auth rejections are safe to refund.
        # Timeouts, redirects, 429 and 5xx may occur after upstream acceptance.
        if response.status_code in (400, 401, 403, 404, 405, 413, 415, 422):
            raise ImageTaskError("BUYTOKEN_REQUEST_REJECTED", "图片服务未接受本次请求，请核对模型权限、参数或服务余额。", 502)
        if response.status_code != 200:
            raise ImageTaskError("IMAGE_SUBMISSION_UNKNOWN", "图片提交结果尚未确认，请查询原任务，勿重复生成。", 503, True)
        raw = bytearray()
        for chunk in response.iter_content(16384):
            raw.extend(chunk)
            if len(raw) > MAX_JSON:
                raise ValueError("oversized result")
        result = json.loads(raw)
        items = result.get("data") if isinstance(result, dict) else None
        if not isinstance(items, list) or not 1 <= len(items) <= payload["n"]:
            raise ValueError("unconfirmed output count")
        # BuyToken explicitly documents stored URL results. Never silently
        # convert an unexpected synchronous response into a retryable failure.
        return [validate_result_url(server, item.get("url") if isinstance(item, dict) else None, resolve_dns=False) for item in items]
    except ImageTaskError:
        raise
    except Exception:
        raise ImageTaskError("IMAGE_SUBMISSION_UNKNOWN", "图片提交结果尚未确认，请保留原任务并核对服务记录，勿重复生成。", 503, True) from None
    finally:
        if response is not None:
            response.close()


def download(server, url):
    for _ in range(4):
        validate_result_url(server, url)
        response = requests.get(url, timeout=(10, 60), stream=True, allow_redirects=False)
        try:
            if response.status_code in (301, 302, 303, 307, 308):
                url = urljoin(url, response.headers.get("Location", ""))
                continue
            response.raise_for_status()
            raw = bytearray()
            for chunk in response.iter_content(65536):
                raw.extend(chunk)
                if len(raw) > MAX_IMAGE:
                    raise ValueError("image too large")
            with Image.open(io.BytesIO(raw)) as image:
                frames = getattr(image, "n_frames", 1)
                if image.width * image.height > 24_000_000:
                    raise ValueError("unsupported image")
                if image.format == "GIF":
                    if not 1 <= frames <= 240 or image.width * image.height * frames > 48_000_000:
                        raise ValueError("animation budget exceeded")
                    for frame in range(frames):
                        image.seek(frame)
                        image.load()
                    # Prompt-only animation is unconfirmed. If upstream really
                    # returns a GIF, preserve its exact bytes, frames and timing.
                    return bytes(raw)
                if frames != 1:
                    raise ValueError("unsupported animation format")
                output = io.BytesIO()
                image.convert("RGBA" if "A" in image.getbands() else "RGB").save(output, format="PNG")
                if output.tell() > MAX_IMAGE:
                    raise ValueError("decoded image too large")
                return output.getvalue()
        finally:
            response.close()
    raise ValueError("too many redirects")
