"""Documented APIMart image protocols; never routes the three legacy models."""
import base64
import io
import ipaddress
import json
import math
import re
import socket
from urllib.parse import urlsplit

import requests
import urllib3
from PIL import Image
try:
    from backend.generation_failures import image_failure_code, image_failure_reason, IMAGE_TIMEOUT, IMAGE_TIMEOUT_RECOVERY
except ModuleNotFoundError:
    from generation_failures import image_failure_code, image_failure_reason, IMAGE_TIMEOUT, IMAGE_TIMEOUT_RECOVERY

BASE = "https://api.apimart.ai/v1"
MODELS = {
    "gpt-image-2.6-flare": {"name": "GPT Image 2.6 Flare", "version": "flare", "references": 8, "count": 1, "resolutions": ("1K",), "credit_cost": 1, "canvas_edit": False},
    "gpt-image-2.6-sunburst": {"name": "GPT Image 2.6 Sunburst", "version": "sunburst", "references": 8, "count": 1, "resolutions": ("1K",), "credit_cost": 1, "canvas_edit": False},
    "gemini-nano-banana-2.1": {"name": "Nano Banana 2.1", "references": 8, "count": 1, "resolutions": ("1K", "2K", "4K"), "resolution_credit_costs": {"4K": 2}},
    "grok-imagine-image-2.0": {"name": "Grok Imagine Image 2.0", "references": 3, "count": 4, "resolutions": ("1K", "2K"), "reference_credit_cost": 2, "automatic_resolution": True},
    "grok-imagine-2.0-ext": {"name": "grok-imagine-2.0-ext", "references": 0, "count": 4, "resolutions": ("quality",), "automatic_resolution": True},
    "seedream-5-0-pro": {"name": "（即梦）Seedream 5.0 Pro", "references": 8, "count": 1, "resolutions": ("1K", "1.5K", "2K"), "credit_cost": 2, "canvas_edit": True},
    "seedream-5-0-lite": {"name": "（即梦）Seedream 5.0 Lite", "references": 8, "count": 4, "resolutions": ("2K", "3K", "4K"), "credit_cost": 1, "canvas_edit": False},
    "seedream-5-0-flash": {"name": "（即梦）Seedream 5.0 Flash", "references": 8, "count": 1, "resolutions": ("1K", "1.5K", "2K"), "credit_cost": 0.5, "canvas_edit": True},
}
RATIOS = {"square_1_1": "1:1", "landscape_3_2": "3:2", "portrait_2_3": "2:3", "landscape_16_9": "16:9", "portrait_9_16": "9:16", "landscape_4_3": "4:3", "portrait_3_4": "3:4", "wide_21_9": "21:9"}
TASK_ID = re.compile(r"^[A-Za-z0-9_-]{8,160}$")
MAX_BYTES = 25 * 1024 * 1024
REFERENCE_UPLOAD_HOSTS = frozenset({"upload.apimart.ai", "getapib.org"})


class ImageTaskError(Exception):
    def __init__(self, code, message, status=400, uncertain=False):
        super().__init__(message)
        self.code, self.message, self.status, self.uncertain = code, message, status, uncertain


def build_request(model, data, references=()):
    if model not in MODELS:
        raise ImageTaskError("MODEL_NOT_ALLOWED", "请选择已接入的图片模型。")
    spec = MODELS[model]
    if model.startswith("gpt-image-2.6-"):
        return build_gpt26_request(model, data, references)
    if model.startswith("seedream-"):
        return build_seedream_request(model, data, references)
    prompt = data.get("prompt", "")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.strip()) > 6000:
        raise ImageTaskError("PROMPT_INVALID", "提示词须为 1–6000 个字符。")
    count = data.get("count", 1)
    if type(count) is not int or not 1 <= count <= spec["count"]:
        raise ImageTaskError("IMAGE_COUNT_INVALID", f"{spec['name']} 单次最多生成 {spec['count']} 张。")
    if len(references) > spec["references"]:
        raise ImageTaskError("REFERENCE_MODEL_LIMIT", f"{spec['name']} 最多支持 {spec['references']} 张参考图。" if spec["references"] else "Grok Ext 仅支持文生图，请移除参考图或更换模型。")
    if data.get("mask_b64") or data.get("mask_storage_path"):
        raise ImageTaskError("IMAGE_MASK_UNSUPPORTED", "该模型当前未接入蒙版编辑，请使用参考图编辑或原有模型。")
    size = data.get("size", "")
    ratio = RATIOS.get(size) if size else "auto"
    if size == "custom":
        try:
            width, height = int(data.get("custom_width", 0)), int(data.get("custom_height", 0))
            if not 256 <= width <= 4096 or not 256 <= height <= 4096:
                raise ValueError()
            divisor = math.gcd(width, height)
            ratio = f"{width // divisor}:{height // divisor}"
        except (ValueError, TypeError):
            raise ImageTaskError("IMAGE_SIZE_INVALID", "请填写有效尺寸，或直接选择画面比例。") from None
    allowed = {"auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"}
    if model == "grok-imagine-image-2.0":
        allowed = {"auto", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "9:19.5", "19.5:9", "9:20", "20:9", "1:2", "2:1"}
    if model == "grok-imagine-2.0-ext":
        allowed = {"1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"}
        if not size:
            ratio = "1:1"
    if ratio not in allowed:
        raise ImageTaskError("IMAGE_SIZE_INVALID", "此模型不支持所选比例，请选择其他画面比例。")
    body = {"model": model, "prompt": prompt.strip(), "n": count}
    if model == "gemini-nano-banana-2.1":
        body.update(model="gemini-nano-banana-2.1-ext", official_fallback=True)
    if not spec.get("automatic_resolution"):
        resolution = data.get("resolution", spec["resolutions"][0])
        if resolution not in spec["resolutions"]:
            raise ImageTaskError("IMAGE_RESOLUTION_INVALID", "此模型不支持所选清晰度档位。")
        body["resolution"] = resolution
    if model == "grok-imagine-image-2.0":
        body["aspect_ratio"] = ratio
    else:
        body["size"] = ratio
    if references:
        body["image_urls"] = list(references)
    if model == "grok-imagine-2.0-ext":
        body["response_format"] = "url"
    return body


def normalize_model_references(model, references):
    if model.startswith("gpt-image-2.6-") and any(len(base64.b64decode(ref)) > 20 * 1024 * 1024 for ref in references):
        raise ImageTaskError("REFERENCE_IMAGE_INVALID", "GPT Image 2.6 每张参考图不能超过 20 MB。")
    if model == "gemini-nano-banana-2.1" and sum(len(base64.b64decode(ref)) for ref in references) > 50 * 1024 * 1024:
        raise ImageTaskError("REFERENCE_IMAGE_INVALID", "Nano 参考图合计不能超过 50 MB。")
    if not model.startswith("seedream-"):
        return references
    result = []
    lite = model == "seedream-5-0-lite"
    try:
        for encoded in references:
            raw = base64.b64decode(encoded, validate=True)
            with Image.open(io.BytesIO(raw)) as image:
                ratio = image.width / image.height
                if min(image.size) <= 14 or image.width * image.height > 36_000_000 or not (1/3 <= ratio <= 3 if lite else 1/16 <= ratio <= 16):
                    raise ValueError()
                if lite and image.format not in ("PNG", "JPEG"):
                    output = io.BytesIO()
                    image.convert("RGBA" if "A" in image.getbands() else "RGB").save(output, format="PNG")
                    raw = output.getvalue()
                if len(raw) > (10 if lite else 30) * 1024 * 1024:
                    raise ValueError()
                result.append(base64.b64encode(raw).decode("ascii"))
    except Exception:
        raise ImageTaskError("REFERENCE_IMAGE_INVALID", "参考图不符合所选即梦模型的尺寸、比例或大小限制，请更换或压缩图片。") from None
    return result


def build_gpt26_request(model, data, references):
    version = MODELS[model]["version"]
    prompt, count = data.get("prompt"), data.get("count", 1)
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 6000:
        raise ImageTaskError("PROMPT_INVALID", "提示词须为 1–6000 个字符。")
    if type(count) is not int or count != 1:
        raise ImageTaskError("IMAGE_COUNT_INVALID", "GPT Image 2.6 Ext 当前仅支持单次生成 1 张。")
    if len(references) > 8:
        raise ImageTaskError("REFERENCE_MODEL_LIMIT", "本站 GPT Image 2.6 最多支持 8 张参考图。")
    if str(data.get("resolution", "1K")).lower() != "1k":
        raise ImageTaskError("IMAGE_RESOLUTION_INVALID", "GPT Image 2.6 Ext 当前仅开放 1K。")
    if data.get("canvas_workflow") or any(data.get(key) for key in ("mask_b64", "mask_storage_path", "markup", "markup_url", "selection_regions")):
        raise ImageTaskError("IMAGE_EDIT_UNSUPPORTED", "GPT Image 2.6 Ext 尚未支持蒙版或标注局部编辑，请使用普通参考图创作。")
    output_format = data.get("output_format", "png")
    if data.get("version", version) != version or output_format not in ("png", "gif"):
        raise ImageTaskError("IMAGE_FEATURE_UNSUPPORTED", "当前入口支持 PNG 或 GIF，请勿覆盖所选 Ext 版本。")
    if output_format == "gif" and (references or data.get("size") not in (None, "", "auto")):
        raise ImageTaskError("IMAGE_GIF_INVALID", "GIF 动图仅支持文字生成，不能带参考图或指定比例。")
    size = data.get("size", "")
    ratio = "auto" if size in ("", "auto") else RATIOS.get(size)
    if ratio not in {"auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9"}:
        raise ImageTaskError("IMAGE_SIZE_INVALID", "GPT Image 2.6 Ext 仅支持画面比例，不能指定像素尺寸。")
    quality = data.get("quality", "auto")
    if quality not in ("auto", "low", "medium", "high", "xhigh", "max"):
        raise ImageTaskError("IMAGE_QUALITY_INVALID", "请选择有效的图片质量。")
    body = {"model": "gpt-image-2.6-ext", "version": version, "prompt": prompt.strip(), "resolution": "1k", "size": ratio, "output_format": output_format, "n": 1}
    if "quality" in data:
        body["quality"] = quality
    if references:
        body["image_urls"] = list(references)
    return body


def build_seedream_request(model, data, references):
    spec = MODELS[model]
    prompt, count = data.get("prompt"), data.get("count", 1)
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 6000:
        raise ImageTaskError("PROMPT_INVALID", "提示词须为 1–6000 个字符。")
    if type(count) is not int or not 1 <= count <= spec["count"] or len(references) > spec["references"] or len(references) + count > 15:
        raise ImageTaskError("REFERENCE_MODEL_LIMIT", "所选即梦模型的出图数量或参考图数量超出限制。")
    if data.get("mask_b64") or data.get("mask_storage_path") or data.get("layer_decomposition") or data.get("background") == "transparent" or data.get("stream") or data.get("tools"):
        raise ImageTaskError("IMAGE_FEATURE_UNSUPPORTED", "此创作入口未开放蒙版、图层拆分、透明背景、流式或联网搜索参数。")
    if data.get("canvas_workflow") and not spec["canvas_edit"]:
        raise ImageTaskError("IMAGE_EDIT_UNSUPPORTED", "该模型尚未确认支持局部编辑，请切换其他模型使用无限画布。")
    resolution = data.get("resolution", spec["resolutions"][0])
    if resolution not in spec["resolutions"]:
        raise ImageTaskError("IMAGE_RESOLUTION_INVALID", "请选择当前即梦模型支持的清晰度。")
    size = data.get("size", "")
    ratio = RATIOS.get(size) if size else ("1:1" if model.endswith("lite") and not references else "auto")
    body = {"model": model, "prompt": prompt.strip(), "n": count, "resolution": resolution, "output_format": "png"}
    if size == "custom":
        try:
            width, height = int(data.get("custom_width", 0)), int(data.get("custom_height", 0))
            if width <= 0 or height <= 0:
                raise ValueError()
            if model.endswith("lite"):
                divisor = math.gcd(width, height)
                ratio = f"{width//divisor}:{height//divisor}"
            else:
                if not 921600 <= width * height <= 4624220 or not 1/16 <= width / height <= 16:
                    raise ValueError()
                body["size"] = f"{width}x{height}"
                body.pop("resolution")  # Exact pixels override resolution upstream.
        except (ValueError, TypeError):
            raise ImageTaskError("IMAGE_SIZE_INVALID", "即梦精确尺寸须为 921600–4624220 总像素、宽高比不超过 16:1。") from None
    if "size" not in body:
        if ratio not in {"auto", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "2:1", "1:2", "21:9"}:
            raise ImageTaskError("IMAGE_SIZE_INVALID", "当前即梦模型不支持此画面比例。")
        body["size"] = ratio
    if references:
        body["image_urls"] = list(references)
    return body


def api_request(method, path, key, *, body=None, request_id=None, files=None, timeout=(8, 35)):
    headers = {"Authorization": "Bearer " + key, "Accept": "application/json", "X-APIMart-Response-Version": "2026-07-27"}
    if request_id:
        headers["Idempotency-Key"] = request_id
    if files is None:
        headers["Content-Type"] = "application/json"
    try:
        response = requests.request(method, BASE + path, headers=headers, json=body, files=files, timeout=timeout, allow_redirects=False, stream=True)
    except requests.RequestException:
        raise ImageTaskError("APIMART_CONNECTION_FAILED", "图片服务连接未完成，请保留任务记录并查询状态。", 503, uncertain=method == "POST") from None
    try:
        content = bytearray()
        for chunk in response.iter_content(65536):
            content.extend(chunk)
            if len(content) > 2 * 1024 * 1024:
                raise ValueError()
        try:
            payload = json.loads(content)
        except ValueError:
            if 200 <= response.status_code < 300:
                raise
            payload = {'message': content.decode('utf-8', errors='replace')}
        if not 200 <= response.status_code < 300:
            code = image_failure_code(payload, response.status_code)
            uncertain = method == 'POST' and (response.status_code >= 500 or response.status_code in (408, 409) or 300 <= response.status_code < 400 or code == 'IMAGE_PROVIDER_TIMEOUT')
            if code == 'IMAGE_PROVIDER_TIMEOUT':
                raise ImageTaskError(code, IMAGE_TIMEOUT + ' ' + IMAGE_TIMEOUT_RECOVERY[0], 503, uncertain=uncertain)
            raise ImageTaskError("APIMART_REQUEST_REJECTED", "图片服务未接受本次请求，请检查提示词、参考图、余额或稍后重试。", 502, uncertain=uncertain)
        if not isinstance(payload, dict) or payload.get("error") or payload.get("code", 200) not in (200, 201, 202):
            if image_failure_code(payload) == 'IMAGE_PROVIDER_TIMEOUT':
                raise ImageTaskError('IMAGE_PROVIDER_TIMEOUT', IMAGE_TIMEOUT + ' ' + IMAGE_TIMEOUT_RECOVERY[0], 503, uncertain=method == 'POST')
            raise ValueError()
        return payload
    except (ValueError, requests.RequestException):
        raise ImageTaskError("APIMART_RESPONSE_UNCERTAIN", "图片服务返回暂时无法确认，请查询原任务，勿重复生成。", 503, uncertain=method == "POST") from None
    finally:
        response.close()


def submit(key, body, request_id):
    payload = api_request("POST", "/images/generations", key, body=body, request_id=request_id)
    data = payload.get("data")
    row = data[0] if isinstance(data, list) and data else data
    task_id = (row.get("task_id") or row.get("id")) if isinstance(row, dict) else None
    if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id):
        raise ImageTaskError("APIMART_RESPONSE_UNCERTAIN", "提交结果未确认，请先核对服务商任务记录。", 503, uncertain=True)
    return task_id


def query(key, task_id):
    if not TASK_ID.fullmatch(task_id):
        raise ImageTaskError("APIMART_TASK_INVALID", "图片任务编号无效。")
    payload = api_request("GET", f"/tasks/{task_id}?language=zh", key)
    row = payload.get("data", payload)
    if not isinstance(row, dict) or (row.get("id") and row["id"] != task_id):
        raise ImageTaskError("APIMART_TASK_INVALID", "图片任务状态暂时无法确认。", 503)
    images = (row.get("result") or {}).get("images", [])
    urls = []
    if isinstance(images, list):
        for image in images:
            value = image.get("url") if isinstance(image, dict) else image
            for url in value if isinstance(value, list) else [value]:
                if isinstance(url, str):
                    urls.append(url)
    status = row.get("status")
    if status == "success":
        status = "completed"
    return {"status": status if status in ("pending", "processing", "completed", "failed", "cancelled") else "unknown", "urls": urls,
            "error_code": image_failure_code(row.get('error') or row) if status in ('failed', 'cancelled') else None}


def upload_reference(key, encoded):
    try:
        raw = encoded.split(",", 1)[-1]
        data = base64.b64decode(raw, validate=True)
        image = Image.open(io.BytesIO(data))
        mime = Image.MIME.get(image.format, "image/png")
        image.verify()
    except Exception:
        raise ImageTaskError("REFERENCE_IMAGE_INVALID", "参考图无法读取，请更换图片。") from None
    try:
        payload = api_request("POST", "/uploads/images", key, files={"file": ("reference", data, mime)})
    except ImageTaskError:
        # A failed upload never implies that the paid generation was submitted.
        raise ImageTaskError("REFERENCE_UPLOAD_FAILED", "参考图上传暂未完成，本次未提交生图，请稍后重试。", 502) from None
    url = payload.get("url")
    try:
        if not isinstance(url, str) or len(url) > 4096 or any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in url):
            raise ValueError()
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname not in REFERENCE_UPLOAD_HOSTS or parsed.username is not None or parsed.password is not None or parsed.port not in (None, 443) or parsed.fragment or not parsed.path.strip("/"):
            raise ValueError()
    except ValueError:
        raise ImageTaskError("REFERENCE_UPLOAD_FAILED", "参考图上传结果无法识别，本次未提交生图，请稍后重试。", 502) from None
    return url


def download_image(url):
    """Fetch public media with pinned DNS/TLS and no credentials or redirects."""
    try:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
            raise ValueError()
        addresses = sorted({row[4][0] for row in socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)})
        if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
            raise ValueError()
    except (ValueError, socket.gaierror):
        raise ImageTaskError("APIMART_IMAGE_URL_INVALID", "图片文件地址暂不可读取。", 502) from None
    pool = urllib3.HTTPSConnectionPool(addresses[0], port=443, assert_hostname=parsed.hostname, server_hostname=parsed.hostname, timeout=urllib3.Timeout(connect=8, read=45), retries=False)
    response = None
    try:
        response = pool.urlopen("GET", (parsed.path or "/") + ("?" + parsed.query if parsed.query else ""), headers={"Host": parsed.hostname}, preload_content=False, redirect=False, retries=False)
        if response.status != 200:
            raise ValueError()
        data = bytearray()
        for chunk in response.stream(65536):
            data.extend(chunk)
            if len(data) > MAX_BYTES:
                raise ValueError()
        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > 40_000_000:
                raise ValueError()
            if image.format == "GIF":
                # Preserve original frame timing, loop and disposal byte-for-byte.
                if image.n_frames > 300 or image.width * image.height * image.n_frames > 400_000_000:
                    raise ValueError()
                for index in range(image.n_frames):
                    image.seek(index)
                    image.load()
                return bytes(data)
            image.load()
            output = io.BytesIO()
            image.save(output, format="PNG")
        if output.tell() > MAX_BYTES:
            raise ValueError()
        return output.getvalue()
    except (ValueError, OSError, urllib3.exceptions.HTTPError):
        raise ImageTaskError("APIMART_IMAGE_READ_FAILED", "任务已受理，图片暂未保存成功；请查询原任务，不要重新生成。", 503) from None
    finally:
        if response:
            response.close()
        pool.close()
