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
    "gemini-nano-banana-2.1": {"name": "Nano Banana 2.1", "references": 8, "count": 4, "resolutions": ("1K", "2K", "4K"), "resolution_credit_costs": {"4K": 2}},
    "grok-imagine-image-2.0": {"name": "Grok Imagine Image 2.0", "references": 3, "count": 4, "resolutions": ("1K", "2K"), "reference_credit_cost": 2, "automatic_resolution": True},
    "grok-imagine-2.0-ext": {"name": "grok-imagine-2.0-ext", "references": 0, "count": 4, "resolutions": ("quality",), "automatic_resolution": True},
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
    row = payload.get("data")
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
