import base64
import io
import ipaddress
import json
import os
import shutil
import secrets


def _load_local_env():
    """Load the project-root .env during local development, without overriding process env."""
    env_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".env"))
    if not os.path.isfile(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as env_file:
            for raw_line in env_file:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in {chr(34), chr(39)}:
                    value = value[1:-1]
                os.environ.setdefault(key, value)
    except OSError:
        return


_load_local_env()
import re
import socket
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, quote, urlsplit

import requests
from flask import Flask, g, jsonify, make_response, redirect, render_template, request, send_file, send_from_directory
from flask_cors import CORS

try:
    from backend.password_recovery import password_recovery
    from backend.image_preview import create_image_preview, preview_filename
    from backend.supabase_service import (
        AuthenticatedUser,
        SupabaseError,
        SupabaseGateway,
        authenticate_access_token,
        is_supabase_configured,
        utc_milliseconds_since,
    )
    from backend.payment_service import PaymentError, configured_payment_channels, create_checkout, parse_alipay_callback, parse_wechat_callback
except ModuleNotFoundError:  # Allows `python backend/server.py` in local development.
    from password_recovery import password_recovery
    from image_preview import create_image_preview, preview_filename
    from supabase_service import (
        AuthenticatedUser,
        SupabaseError,
        SupabaseGateway,
        authenticate_access_token,
        is_supabase_configured,
        utc_milliseconds_since,
    )
    from payment_service import PaymentError, configured_payment_channels, create_checkout, parse_alipay_callback, parse_wechat_callback


APP_DIR = os.path.dirname(__file__)
DATA_DIR = os.path.abspath(os.getenv("DATA_DIR", APP_DIR))
SAVE_FOLDER = os.path.join(DATA_DIR, "outputs")
LEGACY_HISTORY_FILE = os.path.join(DATA_DIR, "history.json")
FRONTEND_BUILD = os.path.join(APP_DIR, "..", "frontend", "dist")
BLOB_READ_WRITE_TOKEN = os.getenv("BLOB_READ_WRITE_TOKEN", "").strip()
BLOB_API_URL = os.getenv("VERCEL_BLOB_API_URL", "https://vercel.com/api/blob").rstrip("/")
BLOB_API_VERSION = "12"
BLOB_STORAGE_ENABLED = bool(BLOB_READ_WRITE_TOKEN)
IMAGE_STORAGE_BACKEND = os.getenv("IMAGE_STORAGE_BACKEND", "auto").strip().lower()
if IMAGE_STORAGE_BACKEND not in {"auto", "supabase", "vercel-blob", "local"}:
    IMAGE_STORAGE_BACKEND = "auto"
SUPABASE_STORAGE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_STORAGE_SERVICE_KEY = (
    os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    or os.getenv("SUPABASE_SECRET_KEY", "").strip()
)
SUPABASE_STORAGE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "posterflow-images").strip()
SUPABASE_STORAGE_ENABLED = bool(
    SUPABASE_STORAGE_URL and SUPABASE_STORAGE_SERVICE_KEY and SUPABASE_STORAGE_BUCKET
)

OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/images"
OPENROUTER_MODEL = "openai/gpt-image-2.5-flare"
DEFAULT_API_KEY = os.getenv("IMAGE_API_KEY", "").strip() or os.getenv("OPENROUTER_API_KEY", "").strip()
DEFAULT_ENDPOINT = os.getenv("IMAGE_API_ENDPOINT", "").strip()
DEFAULT_MODEL = os.getenv("IMAGE_API_MODEL", "").strip()
DEFAULT_AUTH_TYPE = os.getenv("IMAGE_API_AUTH_TYPE", "bearer").strip().lower()
ALLOW_LEGACY_SERVER_PROVIDER = os.getenv("ALLOW_LEGACY_SERVER_PROVIDER", "0") == "1"
PLATFORM_API_KEY = os.getenv("PLATFORM_IMAGE_API_KEY", "").strip()
PLATFORM_ENDPOINT = os.getenv("PLATFORM_IMAGE_API_ENDPOINT", "").strip()
PLATFORM_MODEL = os.getenv("PLATFORM_IMAGE_MODEL", "gpt-image-2.5-flare").strip()
PLATFORM_IMAGE_MODELS = {
    "gpt-image-2.5-flare": 1,
    "gpt-image-2.5-sunburst": 1,
    "gpt-image-2": 1,
}
if PLATFORM_MODEL not in PLATFORM_IMAGE_MODELS:
    PLATFORM_MODEL = "gpt-image-2.5-flare"
PLATFORM_AUTH_TYPE = os.getenv("PLATFORM_IMAGE_AUTH_TYPE", "bearer").strip().lower()
ADMIN_USER_IDS = {item.strip() for item in os.getenv("ADMIN_USER_IDS", "").split(",") if item.strip()}
PAYMENT_PROVIDER = os.getenv("PAYMENT_PROVIDER", "disabled").strip().lower()
AUTH_COOKIE_NAME = "posterflow_session"
AUTH_COOKIE_SECURE = os.getenv("AUTH_COOKIE_SECURE", "1" if os.getenv("VERCEL") else "0") == "1"

# Keep the former OpenRouter environment variable working without embedding a secret.
if os.getenv("OPENROUTER_API_KEY", "").strip():
    DEFAULT_ENDPOINT = DEFAULT_ENDPOINT or OPENROUTER_ENDPOINT
    DEFAULT_MODEL = DEFAULT_MODEL or OPENROUTER_MODEL

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]
ALLOW_PRIVATE_PROVIDER_HOSTS = os.getenv("ALLOW_PRIVATE_PROVIDER_HOSTS", "0") == "1"
ALLOW_INSECURE_PROVIDER_HTTP = os.getenv("ALLOW_INSECURE_PROVIDER_HTTP", "0") == "1"
MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024
MAX_REFERENCE_IMAGE_BYTES = 16 * 1024 * 1024
MAX_REFERENCE_IMAGES = 8
REFERENCE_UPLOAD_MAX_BYTES = 16 * 1024 * 1024
PROVIDER_REQUEST_TIMEOUT_BASE_SECONDS = 240
PROVIDER_REQUEST_TIMEOUT_MAX_SECONDS = 280
REFERENCE_UPLOAD_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}

app = Flask(__name__, static_folder=None)
app.register_blueprint(password_recovery)
app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("MAX_REQUEST_BYTES", str(24 * 1024 * 1024)))
CORS(
    app,
    resources={r"/api/*": {"origins": ALLOWED_ORIGINS}},
    allow_headers=[
        "Content-Type",
        "X-Provider-Api-Key",
        "X-Provider-Endpoint",
        "X-Provider-Model",
        "X-Provider-Auth-Type",
        "X-Client-Id",
        "Authorization",
        "X-Billing-Mode",
        "X-Request-Id",
    ],
    supports_credentials=True,
)
if IMAGE_STORAGE_BACKEND == "local" or (IMAGE_STORAGE_BACKEND == "auto" and not SUPABASE_STORAGE_ENABLED):
    os.makedirs(SAVE_FOLDER, exist_ok=True)


class ProviderError(Exception):
    def __init__(self, code, message, status=502, detail="", recovery=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.detail = detail
        self.recovery = recovery or []


@dataclass(frozen=True)
class ProviderConfig:
    api_key: str
    endpoint: str
    model: str
    auth_type: str
    source: str

    @property
    def host(self):
        return urlsplit(self.endpoint).hostname or "自定义服务"


CLIENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
HTTP_HEADER_NAME_PATTERN = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")

REQUEST_RATE_WINDOWS = {}


def current_storage_scope():
    return getattr(g, "posterflow_storage_scope", None) or current_client_id()


def storage_scope_name():
    """Return a path-safe per-user/browser storage namespace."""
    candidate = current_storage_scope()
    if re.fullmatch(r"(?:user-)?[A-Za-z0-9_-]{8,96}", candidate):
        return candidate
    return "local-user"


def current_client_id():
    candidate = request.headers.get("X-Client-Id", "").strip() or request.args.get("client_id", "").strip()
    if CLIENT_ID_PATTERN.fullmatch(candidate):
        return candidate
    return "local-user"


def access_token_from_request():
    authorization = request.headers.get("Authorization", "").strip()
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return request.cookies.get(AUTH_COOKIE_NAME, "").strip()


def optional_authenticated_user():
    token = access_token_from_request()
    if not token:
        return None
    try:
        return authenticate_access_token(token)
    except SupabaseError:
        # A stale resource cookie must not prevent anonymous self-key usage.
        if request.headers.get("Authorization", "").strip():
            raise
        return None


def require_authenticated_user():
    user = optional_authenticated_user()
    if not user:
        raise ProviderError(
            "AUTH_REQUIRED",
            "请先登录后再使用平台积分",
            401,
            "平台积分模式需要已登录且邮箱已验证的 PosterFlow AI 账户。",
            ["登录账户", "完成邮箱验证", "或改用自带 Key 模式"],
        )
    g.posterflow_storage_scope = f"user-{user.id}"
    return user


def set_optional_storage_scope():
    user = optional_authenticated_user()
    if user:
        g.posterflow_storage_scope = f"user-{user.id}"
    return user


def parse_billing_mode(data):
    value = str(data.get("billing_mode") or request.headers.get("X-Billing-Mode") or "own_key").strip().lower()
    if value not in {"platform", "own_key"}:
        raise ProviderError(
            "BILLING_MODE_INVALID",
            "生图模式无效",
            400,
            "请在平台积分模式与自带 Key 模式之间选择其一。",
        )
    return value


def parse_request_id(data):
    value = str(data.get("request_id") or request.headers.get("X-Request-Id") or uuid.uuid4()).strip()
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError) as exc:
        raise ProviderError("REQUEST_ID_INVALID", "请求标识无效", 400, "请重新发起本次生成请求。") from exc


def enforce_rate_limit(bucket, subject, maximum, window_seconds):
    now = time.monotonic()
    key = (bucket, subject)
    attempts = [value for value in REQUEST_RATE_WINDOWS.get(key, []) if value > now - window_seconds]
    if len(attempts) >= maximum:
        raise ProviderError(
            "RATE_LIMITED",
            "操作过于频繁，请稍后再试",
            429,
            "为保护平台积分和图片服务，本操作暂时触发了频率限制。",
            ["稍等一分钟", "避免重复点击生成", "确认上一任务已结束"],
        )
    attempts.append(now)
    REQUEST_RATE_WINDOWS[key] = attempts


def _blob_store_id():
    parts = BLOB_READ_WRITE_TOKEN.split("_")
    if len(parts) < 5 or not parts[3]:
        raise ProviderError("STORAGE_CONFIG_INVALID", "Blob Store 配置无效", 503)
    return parts[3]


def _blob_headers(**extra):
    store_id = _blob_store_id()
    return {
        "Authorization": f"Bearer {BLOB_READ_WRITE_TOKEN}",
        "x-api-version": BLOB_API_VERSION,
        "x-vercel-blob-store-id": store_id,
        "x-api-blob-request-id": f"{store_id}:{time.time_ns()}:{uuid.uuid4().hex[:8]}",
        "x-api-blob-request-attempt": "0",
        **extra,
    }


def _blob_request(method, path="", **kwargs):
    try:
        response = requests.request(
            method,
            f"{BLOB_API_URL}{path}",
            headers={**_blob_headers(), **kwargs.pop("headers", {})},
            timeout=60,
            **kwargs,
        )
        response.raise_for_status()
        return response
    except requests.RequestException as exc:
        raise ProviderError(
            "STORAGE_UNAVAILABLE",
            "云端图片存储暂时不可用",
            503,
            "Vercel Blob 没有完成本次读写操作。",
            ["稍后重试", "检查 Blob Store 连接", "查看 Vercel Function 日志"],
        ) from exc


def _blob_put(pathname, content, content_type):
    response = _blob_request(
        "PUT",
        params={"pathname": pathname},
        headers={
            "x-vercel-blob-access": "private",
            "x-content-type": content_type,
            "x-add-random-suffix": "0",
            "x-allow-overwrite": "0",
        },
        data=content,
    )
    return response.json()


def _blob_list(prefix, cursor=None):
    params = {"prefix": prefix, "limit": 1000}
    if cursor:
        params["cursor"] = cursor
    response = _blob_request("GET", params=params)
    return response.json()


def _blob_delete(urls_or_pathnames):
    items = [item for item in urls_or_pathnames if item]
    if not items:
        return
    _blob_request(
        "POST",
        "/delete",
        headers={"Content-Type": "application/json"},
        json={"urls": items},
    )


def _blob_url(pathname):
    return f"https://{_blob_store_id()}.private.blob.vercel-storage.com/{quote(pathname, safe='/')}"


def _blob_download(pathname, stream=False):
    try:
        response = requests.get(
            _blob_url(pathname),
            params={"cache": "0"},
            headers={"Authorization": f"Bearer {BLOB_READ_WRITE_TOKEN}"},
            timeout=60,
            stream=stream,
        )
        if response.status_code == 404:
            raise ProviderError("STORAGE_FILE_MISSING", "图片不存在或暂时无法读取", 404)
        response.raise_for_status()
        return response
    except requests.RequestException as exc:
        raise ProviderError("STORAGE_UNAVAILABLE", "云端图片存储暂时不可用", 503) from exc


def _storage_backend():
    """Resolve the active image backend without exposing any server credential."""
    if IMAGE_STORAGE_BACKEND == "local":
        return "local"
    if IMAGE_STORAGE_BACKEND == "vercel-blob":
        raise ProviderError(
            "STORAGE_CONFIG_INVALID",
            "图片存储已迁移到 Supabase Storage",
            503,
            "当前版本不再使用 Vercel Blob 读写图片。请将 IMAGE_STORAGE_BACKEND 设置为 supabase。",
            ["检查 Supabase Storage 配置", "修改 IMAGE_STORAGE_BACKEND", "重新部署服务"],
        )
    if IMAGE_STORAGE_BACKEND == "supabase":
        if not SUPABASE_STORAGE_ENABLED:
            raise ProviderError(
                "STORAGE_CONFIG_INVALID",
                "Supabase Storage 配置无效",
                503,
                "请在服务端配置 SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY 和 SUPABASE_STORAGE_BUCKET。",
                ["创建私有 Storage bucket", "补齐 Vercel 环境变量", "重新部署服务"],
            )
        return "supabase"
    if SUPABASE_STORAGE_ENABLED:
        return "supabase"
    return "local"


def storage_backend_name():
    """Return a stable health-check label, including an explicit misconfiguration."""
    if IMAGE_STORAGE_BACKEND == "supabase":
        return "supabase-storage"
    if IMAGE_STORAGE_BACKEND == "local":
        return "local-filesystem"
    if SUPABASE_STORAGE_ENABLED:
        return "supabase-storage"
    return "local-filesystem"


def _supabase_storage_headers(**extra):
    if not SUPABASE_STORAGE_ENABLED:
        raise ProviderError("STORAGE_CONFIG_INVALID", "Supabase Storage 配置无效", 503)
    headers = {
        "apikey": SUPABASE_STORAGE_SERVICE_KEY,
        "Accept": "application/json",
    }
    if not SUPABASE_STORAGE_SERVICE_KEY.startswith("sb_secret_"):
        headers["Authorization"] = f"Bearer {SUPABASE_STORAGE_SERVICE_KEY}"
    return {**headers, **extra}


def _supabase_storage_url(path=""):
    return f"{SUPABASE_STORAGE_URL}/storage/v1{path}"


def _supabase_storage_request(method, path, **kwargs):
    allow_missing = kwargs.pop("_allow_missing", False)
    try:
        response = requests.request(
            method,
            _supabase_storage_url(path),
            headers={**_supabase_storage_headers(), **kwargs.pop("headers", {})},
            timeout=60,
            **kwargs,
        )
    except requests.RequestException as exc:
        raise ProviderError(
            "STORAGE_UNAVAILABLE",
            "云端图片存储暂时不可用",
            503,
            "Supabase Storage 没有完成本次读写操作。",
            ["稍后重试", "检查 Supabase Storage 配置", "查看 Vercel Function 日志"],
        ) from exc
    if response.status_code == 404:
        if allow_missing:
            raise ProviderError("STORAGE_FILE_MISSING", "图片不存在或暂时无法读取", 404)
        raise ProviderError("STORAGE_UNAVAILABLE", "Supabase Storage 配置或对象路径无效", 503)
    if not 200 <= response.status_code < 300:
        raise ProviderError(
            "STORAGE_UNAVAILABLE",
            "云端图片存储暂时不可用",
            503,
            f"Supabase Storage 返回 HTTP {response.status_code}。",
            ["检查 bucket 是否为私有且已创建", "检查服务端 Storage 密钥", "稍后重试"],
        )
    return response


def _supabase_object_path(pathname):
    return quote(SUPABASE_STORAGE_BUCKET, safe="") + "/" + quote(pathname, safe="/")


def _supabase_put(pathname, content, content_type):
    response = _supabase_storage_request(
        "POST",
        f"/object/{_supabase_object_path(pathname)}",
        headers={"Content-Type": content_type, "x-upsert": "true"},
        data=content,
    )
    try:
        return response.json()
    except ValueError:
        return {"path": pathname}


def _supabase_create_signed_upload(pathname):
    response = _supabase_storage_request(
        "POST",
        f"/object/upload/sign/{_supabase_object_path(pathname)}",
        headers={"Content-Type": "application/json", "x-upsert": "false"},
        json={},
    )
    try:
        payload = response.json()
    except ValueError as exc:
        raise ProviderError(
            "REFERENCE_UPLOAD_UNAVAILABLE",
            "参考图上传服务暂时不可用",
            503,
            "Supabase Storage 没有返回有效的临时上传地址。",
            ["稍后重试", "检查 Supabase Storage 配置"],
        ) from exc
    raw_url = str(payload.get("url") or "").strip()
    upload_url = raw_url if raw_url.startswith("http") else _supabase_storage_url(raw_url)
    token = parse_qs(urlsplit(upload_url).query).get("token", [""])[0]
    if not upload_url or not token:
        raise ProviderError(
            "REFERENCE_UPLOAD_UNAVAILABLE",
            "参考图上传服务暂时不可用",
            503,
            "Supabase Storage 没有返回可用的临时上传地址。",
            ["稍后重试", "检查 Supabase Storage 配置"],
        )
    return {"bucket": SUPABASE_STORAGE_BUCKET, "path": pathname, "signed_url": upload_url, "token": token}


def _supabase_download(pathname, stream=False):
    return _supabase_storage_request(
        "GET",
        f"/object/authenticated/{_supabase_object_path(pathname)}",
        params={"cache": "0"},
        headers={"Accept": "application/octet-stream"},
        _allow_missing=True,
        stream=stream,
    )


def _supabase_create_signed_url(pathname, expires_in=3600):
    """Create a short-lived browser URL without proxying image bytes through Flask."""
    response = _supabase_storage_request(
        "POST",
        f"/object/sign/{_supabase_object_path(pathname)}",
        headers={"Content-Type": "application/json"},
        json={"expiresIn": max(60, min(int(expires_in), 86400))},
    )
    try:
        payload = response.json()
    except ValueError as exc:
        raise ProviderError(
            "STORAGE_SIGNING_FAILED",
            "图片临时地址生成失败",
            503,
            "Supabase Storage 没有返回有效的签名地址。",
            ["稍后重试", "检查 Supabase Storage 配置"],
        ) from exc
    raw_url = str(payload.get("signedURL") or payload.get("signed_url") or payload.get("signedUrl") or "").strip()
    if not raw_url:
        raise ProviderError(
            "STORAGE_SIGNING_FAILED",
            "图片临时地址生成失败",
            503,
            "Supabase Storage 没有返回可用的签名地址。",
            ["稍后重试", "检查 Supabase Storage 配置"],
        )
    if raw_url.startswith("http"):
        return raw_url
    if raw_url.startswith("/storage/v1/"):
        return f"{SUPABASE_STORAGE_URL}{raw_url}"
    return _supabase_storage_url(raw_url)


def _supabase_list(prefix, offset=0):
    response = _supabase_storage_request(
        "POST",
        f"/object/list/{quote(SUPABASE_STORAGE_BUCKET, safe='')}",
        headers={"Content-Type": "application/json"},
        json={
            "prefix": prefix,
            "limit": 1000,
            "offset": offset,
            "sortBy": {"column": "name", "order": "asc"},
        },
    )
    payload = response.json()
    return payload if isinstance(payload, list) else []


def _storage_join_path(prefix, name):
    if name.startswith(prefix):
        return name
    return f"{prefix.rstrip('/')}/{name}" if prefix else name


def _supabase_file_paths(prefix="posterflow/"):
    """Walk v1 Storage list results, which expose one folder level at a time."""
    pending = [prefix]
    while pending:
        current_prefix = pending.pop()
        offset = 0
        previous_page = None
        while True:
            objects = _supabase_list(current_prefix, offset)
            for item in objects:
                name = str(item.get("name") or "").strip()
                if not name:
                    continue
                path = _storage_join_path(current_prefix, name)
                if item.get("id") is None:
                    pending.append(path.rstrip("/") + "/")
                else:
                    yield path
            if len(objects) < 1000:
                break
            if objects == previous_page:
                raise ProviderError(
                    "STORAGE_LIST_INCOMPLETE",
                    "Supabase Storage 图片清理未完成",
                    503,
                    "Supabase Storage 返回了重复分页，为避免误报已停止清理。",
                    ["稍后重试", "检查 Supabase Storage 状态", "查看 Vercel Function 日志"],
                )
            previous_page = objects
            offset += len(objects)


def _supabase_delete(pathnames):
    items = [item for item in pathnames if item]
    for start in range(0, len(items), 1000):
        _supabase_storage_request(
            "DELETE",
            f"/object/{quote(SUPABASE_STORAGE_BUCKET, safe='')}",
            headers={"Content-Type": "application/json"},
            json={"prefixes": items[start : start + 1000]},
        )


def _storage_download(pathname, stream=False):
    backend = _storage_backend()
    if backend == "supabase":
        return _supabase_download(pathname, stream=stream)
    raise ProviderError("STORAGE_FILE_MISSING", "图片不存在或暂时无法读取", 404)


def _image_blob_path(filename):
    return f"posterflow/{storage_scope_name()}/images/{filename}"


def _reference_storage_prefix():
    return f"posterflow/{storage_scope_name()}/references/"


def validate_reference_storage_paths(values):
    if values in (None, ""):
        return []
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_REFERENCE_IMAGES:
        raise ProviderError(
            "REFERENCE_STORAGE_INVALID",
            "参考图数量无效",
            400,
            "参考图列表必须包含 1 至 8 个临时文件。",
            ["重新选择参考图", "减少参考图数量", "再次生成"],
        )
    prefix = _reference_storage_prefix()
    paths = []
    for value in values:
        path = str(value or "").strip().lstrip("/")
        suffix = path[len(prefix) :] if path.startswith(prefix) else ""
        if (
            not suffix
            or "/" in suffix
            or "\\" in suffix
            or ".." in suffix
            or not re.fullmatch(r"[0-9a-f]{32}\.(?:png|jpg|webp|gif)", suffix, flags=re.IGNORECASE)
        ):
            raise ProviderError(
                "REFERENCE_STORAGE_INVALID",
                "参考图临时文件无效",
                400,
                "参考图临时文件已失效，请重新选择图片。",
                ["重新选择参考图", "再次生成"],
            )
        paths.append(path)
    return paths


def validate_reference_storage_path(value):
    if value in (None, ""):
        return None
    return validate_reference_storage_paths([value])[0]


def _reference_image_mime(image_bytes):
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if image_bytes.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(image_bytes) >= 12 and image_bytes[:4] == b"RIFF" and image_bytes[8:12] == b"WEBP":
        return "image/webp"
    return None


def validate_reference_image_bytes(image_bytes):
    if not isinstance(image_bytes, (bytes, bytearray)):
        raise ProviderError(
            "REFERENCE_IMAGE_INVALID",
            "参考图格式无效",
            400,
            "参考图内容无法读取。",
            ["重新选择参考图", "再次生成"],
        )
    if len(image_bytes) > MAX_REFERENCE_IMAGE_BYTES:
        raise ProviderError(
            "REFERENCE_IMAGE_TOO_LARGE",
            "参考图超过大小限制",
            413,
            "参考图解码后不能超过 16 MB。",
            ["压缩参考图", "降低图片大小", "再次生成"],
        )
    if not _reference_image_mime(bytes(image_bytes)):
        raise ProviderError(
            "REFERENCE_IMAGE_UNSUPPORTED",
            "不支持此参考图格式",
            400,
            "参考图仅支持 PNG、JPG、WebP 或 GIF。",
            ["转换图片格式", "重新导入图片", "再次生成"],
        )
    return bytes(image_bytes)


def stored_reference_to_base64(pathname):
    if _storage_backend() != "supabase":
        raise ProviderError(
            "REFERENCE_STORAGE_UNAVAILABLE",
            "参考图上传服务未配置",
            503,
            "线上参考图需要启用 Supabase Storage。",
            ["检查 Supabase Storage 配置", "稍后重试"],
        )
    response = _storage_download(pathname)
    content = validate_reference_image_bytes(response.content)
    return base64.b64encode(content).decode("ascii")


def cleanup_reference_storage_paths(paths):
    if not paths or _storage_backend() != "supabase":
        return
    try:
        _supabase_delete(paths)
    except ProviderError:
        app.logger.exception("Failed to clean up temporary reference images")


@app.route("/api/auth/confirm", methods=["GET", "POST"])
def confirm_signup_email():
    nonce = secrets.token_urlsafe(24)
    if request.method in {"GET", "HEAD"}:
        # Merely opening or prefetching this page must not consume the link.
        response = make_response(render_template("email_confirmation.html", nonce=nonce))
    else:
        data = request.get_json(silent=True)
        token_hash = data.get("token_hash") if isinstance(data, dict) else None
        action = data.get("type") if isinstance(data, dict) else None
        if action != "email" or not isinstance(token_hash, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token_hash):
            response = make_response(jsonify(
                verified=False, title="验证链接不完整",
                message="请从验证邮件中重新打开完整链接。", retryable=False,
            ), 400)
        else:
            try:
                SupabaseGateway().confirm_signup_email(token_hash)
                response = make_response(jsonify(
                    verified=True, title="邮箱验证成功",
                    message="验证已完成，可以关闭此页面。",
                    retryable=False,
                ))
            except SupabaseError as error:
                invalid = error.code in {"otp_expired", "token_expired", "validation_failed", "bad_code_verifier"}
                response = make_response(jsonify(
                    verified=False,
                    title="验证链接已失效" if invalid else "暂时无法完成验证",
                    message=("链接可能已使用或已过期。如果之前已验证成功，可直接返回网站登录。"
                             if invalid else "验证服务暂时没有响应，请稍后点击重试。"),
                    retryable=not invalid,
                ), 400 if invalid else 503)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = (
        f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; "
        "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    )
    return response


def provider_error_response(error):
    return jsonify(
        {
            "error": error.message,
            "code": error.code,
            "detail": error.detail,
            "recovery": error.recovery,
        }
    ), error.status


def _is_blocked_ip(value):
    ip = ipaddress.ip_address(value)
    return not ip.is_global


def validate_provider_endpoint(endpoint, resolve_dns=True):
    try:
        parsed = urlsplit(endpoint)
    except ValueError as exc:
        raise ProviderError(
            "PROVIDER_ENDPOINT_INVALID",
            "中转站接口地址无效",
            400,
            "请输入完整的 OpenAI 兼容图片生成接口地址。",
            ["检查接口地址", "确认地址包含 https://", "重新保存配置"],
        ) from exc

    if parsed.scheme not in ({"https", "http"} if ALLOW_INSECURE_PROVIDER_HTTP else {"https"}):
        raise ProviderError(
            "PROVIDER_ENDPOINT_HTTPS_REQUIRED",
            "中转站必须使用 HTTPS",
            400,
            "公开部署时仅允许 HTTPS 接口，避免 API Key 在传输过程中泄露。",
            ["改用 HTTPS 地址", "确认中转站支持 TLS", "重新保存配置"],
        )
    if not parsed.hostname or parsed.username or parsed.password:
        raise ProviderError(
            "PROVIDER_ENDPOINT_INVALID",
            "中转站接口地址无效",
            400,
            "接口地址不能包含用户名或密码，并且必须包含有效域名。",
            ["检查接口地址", "移除 URL 中的凭据", "重新保存配置"],
        )

    host = parsed.hostname.lower().rstrip(".")
    if not ALLOW_PRIVATE_PROVIDER_HOSTS:
        if host == "localhost" or host.endswith(".local"):
            raise ProviderError(
                "PROVIDER_ENDPOINT_PRIVATE_BLOCKED",
                "不允许访问本地或私网中转站",
                400,
                "为防止公开服务被用于访问内网，默认禁止 localhost、.local 和私有 IP。",
                ["使用公网 HTTPS 中转站", "自部署时显式开启私网端点", "重新保存配置"],
            )
        try:
            if _is_blocked_ip(host):
                raise ProviderError(
                    "PROVIDER_ENDPOINT_PRIVATE_BLOCKED",
                    "不允许访问本地或私网中转站",
                    400,
                    "该接口地址指向非公网 IP，已被服务端安全策略拦截。",
                    ["使用公网 HTTPS 中转站", "检查域名解析", "重新保存配置"],
                )
        except ValueError:
            pass

        if resolve_dns:
            try:
                addresses = {item[4][0] for item in socket.getaddrinfo(host, parsed.port or 443)}
            except socket.gaierror as exc:
                raise ProviderError(
                    "PROVIDER_DNS_FAILED",
                    "无法解析中转站域名",
                    502,
                    f"服务器无法解析 {host}，请检查域名或服务器 DNS。",
                    ["检查中转站域名", "检查服务器 DNS", "稍后重试"],
                ) from exc
            if any(_is_blocked_ip(address) for address in addresses):
                raise ProviderError(
                    "PROVIDER_ENDPOINT_PRIVATE_BLOCKED",
                    "中转站域名解析到了私网地址",
                    400,
                    "为防止服务端请求伪造，该域名已被安全策略拦截。",
                    ["使用公网 HTTPS 中转站", "检查域名解析", "重新保存配置"],
                )

    return parsed


def resolve_provider_config(billing_mode="own_key", resolve_dns=True, platform_model=None):
    """Resolve an image provider without ever mixing platform and user keys."""
    if billing_mode == "platform":
        if any(request.headers.get(header, "").strip() for header in (
            "X-Provider-Api-Key", "X-Provider-Endpoint", "X-Provider-Model", "X-Provider-Auth-Type"
        )):
            raise ProviderError(
                "PLATFORM_PROVIDER_OVERRIDE_BLOCKED",
                "平台积分模式不能使用浏览器中的服务商配置",
                400,
                "请切换到自带 Key 模式，或清除个人服务配置后使用平台积分。",
                ["切换到自带 Key", "或使用平台默认服务"],
            )
        api_key = PLATFORM_API_KEY
        endpoint = PLATFORM_ENDPOINT
        model = platform_model or PLATFORM_MODEL
        auth_type = PLATFORM_AUTH_TYPE
        source = "platform"
    else:
        request_key = request.headers.get("X-Provider-Api-Key", "").strip()
        api_key = request_key
        endpoint = request.headers.get("X-Provider-Endpoint", "").strip()
        model = request.headers.get("X-Provider-Model", "").strip()
        auth_type = request.headers.get("X-Provider-Auth-Type", "").strip()
        source = "browser"
        if ALLOW_LEGACY_SERVER_PROVIDER and not request_key:
            api_key = DEFAULT_API_KEY
            endpoint = endpoint or DEFAULT_ENDPOINT
            model = model or DEFAULT_MODEL
            auth_type = auth_type or DEFAULT_AUTH_TYPE
            source = "legacy-server"

    if not api_key:
        raise ProviderError(
            "PROVIDER_KEY_MISSING",
            "尚未配置图片服务 API Key",
            400,
            "自带 Key 模式需要在当前浏览器标签页填写自己的 Key。",
            ["打开服务配置", "填写 API Key", "保存后重新生成"],
        )
    if not endpoint:
        raise ProviderError(
            "PROVIDER_ENDPOINT_MISSING",
            "尚未配置图片服务接口地址",
            400,
            "请填写 OpenAI 兼容图片生成接口地址。",
            ["打开服务配置", "填写接口地址", "保存后重新生成"],
        )
    if not model:
        raise ProviderError(
            "PROVIDER_MODEL_MISSING",
            "尚未配置图片生成模型",
            400,
            "请输入中转站支持的图片模型标识。",
            ["查看中转站模型文档", "填写模型标识", "保存后重新生成"],
        )
    auth_type = auth_type.strip()
    auth_type_key = auth_type.lower()
    if not auth_type:
        auth_type = "bearer"
        auth_type_key = "bearer"
    if auth_type_key not in {"bearer", "x-api-key"} and not HTTP_HEADER_NAME_PATTERN.fullmatch(auth_type):
        raise ProviderError(
            "PROVIDER_AUTH_INVALID",
            "鉴权方式不受支持",
            400,
            "鉴权方式请填写 bearer、x-api-key，或其他合法的 HTTP 请求头名称。",
            ["查看中转站文档", "填写鉴权请求头名称", "重新保存配置"],
        )

    validate_provider_endpoint(endpoint, resolve_dns=resolve_dns)
    return ProviderConfig(api_key, endpoint, model, auth_type, source)


def provider_headers(provider, content_type="application/json"):
    headers = {}
    if content_type:
        headers["Content-Type"] = content_type
    auth_type = provider.auth_type.strip()
    auth_type_key = auth_type.lower()
    if auth_type_key == "x-api-key":
        headers["x-api-key"] = provider.api_key
    elif auth_type_key == "bearer":
        headers["Authorization"] = f"Bearer {provider.api_key}"
    else:
        headers[auth_type] = provider.api_key
    return headers


RPC_ERROR_MESSAGES = {
    "EMAIL_UNVERIFIED": ("请先完成邮箱验证", 403, "验证邮箱后会自动获得注册赠送积分。", ["打开邮箱完成验证", "重新登录后刷新账户"]),
    "ACCOUNT_FROZEN": ("账户当前不可使用平台积分", 403, "该账户已被平台暂停使用。", ["联系平台管理员", "切换到自带 Key 模式"]),
    "CREDITS_INSUFFICIENT": ("平台积分不足", 402, "本次生成所需积分高于当前可用积分。", ["切换到自带 Key 模式", "等待管理员补充积分"]),
    "USER_DAILY_LIMIT": ("今日平台积分生成额度已用完", 429, "请明天再试，或切换到自带 Key 模式。", ["切换到自带 Key", "明日再生成"]),
    "PLATFORM_DAILY_LIMIT": ("平台今日免费生成额度已用完", 429, "平台限额会在下一日自动恢复。", ["稍后再试", "切换到自带 Key 模式"]),
    "REQUEST_ID_CONFLICT": ("该生成请求不能重复使用", 409, "请重新发起生成请求。", ["重新点击生成"]),
    "ADMIN_REQUIRED": ("没有管理员权限", 403, "该操作仅对管理员开放。", ["切换管理员账号"]),
    "CREDIT_DELTA_INVALID": ("积分调整数量无效", 400, "请输入不为 0 的整数积分。", ["检查调整数量"]),
    "SIGNUP_BONUS_INVALID": ("注册赠送积分无效", 400, "请输入 0 到 10000 之间的整数。", ["检查积分数量"]),
    "ANNOUNCEMENT_TITLE_INVALID": ("公告标题无效", 400, "标题不能为空，且最多 120 个字符。", ["检查公告标题"]),
    "ANNOUNCEMENT_CONTENT_INVALID": ("公告内容无效", 400, "公告内容不能为空，且最多 5000 个字符。", ["检查公告内容"]),
    "ANNOUNCEMENT_TYPE_INVALID": ("公告类型无效", 400, "请选择有效的公告类型。", ["检查公告类型"]),
    "ANNOUNCEMENT_STATUS_INVALID": ("公告状态无效", 400, "请选择草稿、已发布或已下线。", ["检查公告状态"]),
    "ANNOUNCEMENT_TIME_INVALID": ("公告时间无效", 400, "结束时间必须晚于开始时间。", ["检查展示时间"]),
    "ANNOUNCEMENT_NOT_FOUND": ("公告不存在", 404, "这条公告可能已被删除或下线。", ["刷新公告列表"]),
    "USER_NOT_FOUND": ("用户不存在或已停用", 404, "请选择一个仍处于正常状态的用户。", ["刷新用户列表"]),
    "CREDITS_BALANCE_INVALID": ("积分不能低于 0", 400, "本次扣减超过了用户当前余额。", ["减少扣减数量"]),
    "IDEMPOTENCY_KEY_INVALID": ("操作编号无效", 400, "请重新提交这次调整。", ["重新提交"]),
    "PAYMENT_NOT_CONFIGURED": ("在线支付尚未配置", 503, "管理员需要先配置合规的支付宝当面付商户通道。", ["联系管理员"]),
    "PAYMENT_AMOUNT_INVALID": ("充值金额无效", 400, "充值金额最低 10 元，且必须是整数元。", ["重新选择金额"]),
    "PAYMENT_CHANNEL_INVALID": ("支付方式无效", 400, "当前仅支持支付宝当面付。", ["选择支付宝", "联系管理员"]),
    "PAYMENT_CHANNEL_DISABLED": ("支付方式已停用", 410, "当前仅支持支付宝当面付，微信支付已安全停用。", ["选择支付宝"]),
    "PAYMENT_PROVIDER_UNAVAILABLE": ("支付平台暂时不可用", 502, "支付平台没有及时响应，请稍后重试。", ["稍后重试", "检查支付商户配置"]),
    "PAYMENT_PROVIDER_REJECTED": ("支付订单创建失败", 502, "支付平台拒绝了本次下单请求。", ["检查商户配置", "稍后重试"]),
    "PAYMENT_PROVIDER_BAD_RESPONSE": ("支付平台返回异常", 502, "支付平台没有返回有效的付款二维码。", ["稍后重试", "检查支付商户配置"]),
    "PAYMENT_SIGNATURE_INVALID": ("支付回调校验失败", 401, "这笔支付无法通过平台签名校验，积分不会到账。", ["联系管理员"]),
    "PAYMENT_CALLBACK_INVALID": ("支付回调格式错误", 400, "支付平台通知内容不完整，积分不会到账。", ["联系管理员"]),
    "PAYMENT_MERCHANT_MISMATCH": ("支付商户不匹配", 401, "支付通知来自其他商户，积分不会到账。", ["联系管理员"]),
    "PAYMENT_CALLBACK_EXPIRED": ("支付回调已过期", 401, "支付通知超过安全时间窗口，积分不会到账。", ["联系管理员"]),
    "PAYMENT_NOT_SUCCEEDED": ("支付尚未成功", 409, "只有支付平台确认成功后才会到账。", ["等待支付完成"]),
    "PAYMENT_KEY_INVALID": ("支付密钥配置无效", 503, "管理员需要检查支付商户密钥配置。", ["联系管理员"]),
    "ORDER_NOT_FOUND": ("充值订单不存在", 404, "请重新创建充值订单。", ["重新充值"]),
    "ORDER_NOT_PAYABLE": ("充值订单状态不可用", 409, "该订单已经处理或已关闭。", ["重新充值"]),
    "ORDER_EXPIRED": ("充值订单已过期", 409, "请重新创建充值订单。", ["重新充值"]),
    "PAYMENT_AMOUNT_MISMATCH": ("支付金额校验失败", 400, "支付平台回调金额与订单金额不一致，积分不会到账。", ["联系管理员"]),
    "PAYMENT_TRADE_CONFLICT": ("支付交易号冲突", 409, "该支付平台交易号已经用于其他订单，积分不会重复到账。", ["联系管理员"]),
    "ORDER_CREATE_FAILED": ("充值订单创建失败", 503, "账户服务没有成功创建充值订单，请稍后重试。", ["稍后重试"]),
}


def as_provider_error(error):
    if isinstance(error, ProviderError):
        return error
    if isinstance(error, PaymentError):
        return ProviderError(error.code, error.message, error.status, error.detail)
    if isinstance(error, SupabaseError):
        return ProviderError(error.code, error.message, error.status, error.detail)
    return ProviderError("SERVER_ERROR", "服务暂时不可用，请稍后重试", 503)


def raise_for_rpc_result(result):
    if isinstance(result, dict) and result.get("ok") is False:
        code = str(result.get("code") or "ACCOUNT_OPERATION_FAILED")
        message, status, detail, recovery = RPC_ERROR_MESSAGES.get(
            code,
            ("账户或积分处理失败", 503, "平台没有完成本次账户处理。", ["稍后重试", "检查账户状态"]),
        )
        raise ProviderError(code, message, status, detail, recovery)
    return result or {}


def platform_provider_configured():
    return bool(PLATFORM_API_KEY and PLATFORM_ENDPOINT and PLATFORM_MODEL)


def execute_generation(data, *, requested_count, prompt, generate_callback):
    """Run one image request with isolated keys, idempotency and credit settlement."""
    billing_mode = parse_billing_mode(data)
    request_id = parse_request_id(data)
    user = None
    gateway = None
    job_id = None
    provider = None
    created_filenames = []
    started_at = time.monotonic()

    try:
        if billing_mode == "platform":
            if not platform_provider_configured():
                raise ProviderError(
                    "PLATFORM_PROVIDER_NOT_CONFIGURED",
                    "平台免费生图暂未配置",
                    503,
                    "管理员尚未在服务端配置平台图片服务。",
                    ["切换到自带 Key 模式", "稍后重试"],
                )
            user = require_authenticated_user()
            gateway = SupabaseGateway()
            gateway.recover_stale_generation_jobs(user.id)
            requested_platform_model = str(data.get("platform_model") or PLATFORM_MODEL).strip()
            if requested_platform_model not in PLATFORM_IMAGE_MODELS:
                raise ProviderError("MODEL_NOT_ALLOWED", "平台模型不可用", 400, "请选择平台提供的模型。", ["重新选择模型", "再次生成"])
            provider = resolve_provider_config("platform", platform_model=requested_platform_model)
            enforce_rate_limit("platform-generate", user.id, 8, 60)
            reservation = raise_for_rpc_result(
                gateway.reserve_credits(
                    user.id,
                    request_id,
                    requested_count,
                    provider.host,
                    provider.model,
                    prompt,
                    # No per-user or platform-wide daily cap. Legacy daily-limit
                    # environment variables must not re-enable these limits.
                    None,
                    None,
                )
            )
            job_id = reservation.get("job_id")
            if reservation.get("existing"):
                status = reservation.get("status")
                if status == "succeeded":
                    filenames = [name for name in reservation.get("images", []) if isinstance(name, str)]
                    return {
                        "images": [{"filename": name, "index": index + 1} for index, name in enumerate(filenames)],
                        "credit_balance": reservation.get("balance"),
                        "idempotent": True,
                        "provider": provider,
                    }
                raise ProviderError(
                    "REQUEST_ALREADY_PROCESSED",
                    "该生成请求已处理，请重新发起",
                    409,
                    "重复请求不会再次扣除积分或重复调用图片服务。",
                    ["重新点击生成", "刷新账户积分"],
                )
        else:
            user = optional_authenticated_user()
            if user:
                g.posterflow_storage_scope = f"user-{user.id}"
            provider = resolve_provider_config("own_key")

        images = generate_callback(provider)
        if not isinstance(images, list) or not images:
            raise ProviderError(
                "PROVIDER_EMPTY_RESULT",
                "图片生成服务没有返回图片",
                502,
                "图片服务没有返回可保存的图片，本次请求不会计费。",
                ["检查中转站响应格式", "检查模型标识", "重新生成"],
            )
        filenames = [image["filename"] for image in images]
        created_filenames = filenames
        duration_ms = utc_milliseconds_since(started_at)
        credit_balance = None
        if billing_mode == "platform":
            settled = raise_for_rpc_result(gateway.settle_generation(job_id, len(images), duration_ms, filenames))
            credit_balance = settled.get("balance")
        elif user:
            # Own-key requests are logged only after success and never include the API key.
            gateway = SupabaseGateway()
            gateway.record_own_key_generation(
                user.id, request_id, provider.host, provider.model, prompt, requested_count, len(images), duration_ms, filenames
            )
        return {"images": images, "credit_balance": credit_balance, "idempotent": False, "provider": provider}
    except Exception as error:
        if billing_mode == "platform" and gateway and job_id:
            if created_filenames:
                try:
                    remove_stored_images(created_filenames)
                except Exception:
                    app.logger.exception("Failed to remove orphaned generated images")
            try:
                raise_for_rpc_result(
                    gateway.refund_generation(job_id, getattr(error, "code", "generation_failed"))
                )
            except (ProviderError, SupabaseError):
                app.logger.exception("Failed to refund platform generation")
        elif billing_mode == "own_key" and user and provider:
            try:
                (gateway or SupabaseGateway()).record_own_key_generation(
                    user.id, request_id, provider.host, provider.model, prompt, requested_count, 0,
                    utc_milliseconds_since(started_at), [], getattr(error, "code", "generation_failed")
                )
            except SupabaseError:
                app.logger.exception("Failed to record own-key generation failure")
        raise as_provider_error(error)


STYLE_TEMPLATES = {
    "商务科技": "国际商务科技风，主色为深海蓝、科技银灰和冷白高光。构图理性克制，几何线条与低饱和科技元素交织，现代无衬线字体排版，适合企业招商海报。",
    "极简高级": "极简主义设计，大量留白，深色背景配金色或白色点缀。几何构图精准，字体纤细现代，画面干净克制，突出主体。",
    "霓虹都市": "赛博朋克都市夜景，霓虹灯光渲染，深紫与青色为主调。科技感数据流、全息投影元素，未来主义风格。",
    "自然生态": "自然光摄影风格，柔和色调，绿色植被与蓝天。画面清新通透，适合环保、ESG主题海报。",
    "工业制造": "工业纪实风格，金属质感与机械结构特写。深灰与橙色搭配，展现制造实力与精密工艺。",
    "金融财经": "金融商务风格，深蓝与金色搭配。数据图表、世界地图、货币符号等元素，稳健专业的视觉调性。",
    "医疗健康": "医疗科技风格，白色与浅蓝为主。洁净明亮，DNA双螺旋、分子结构等生命科学元素，专业可信。",
    "智慧城市": "智慧城市俯瞰图，5G网络、IoT设备、智能交通。蓝色数据流连接城市建筑，科技与人文融合。",
}

SIZE_OPTIONS = {
    "square_1_1": {"label": "正方形 1:1", "width": 1024, "height": 1024},
    "landscape_16_9": {"label": "横版 16:9", "width": 1792, "height": 1008},
    "portrait_9_16": {"label": "竖版 9:16", "width": 1008, "height": 1792},
    "landscape_4_3": {"label": "横版 4:3", "width": 1360, "height": 1024},
    "portrait_3_4": {"label": "竖版 3:4", "width": 1024, "height": 1360},
    "wide_21_9": {"label": "超宽 21:9", "width": 2016, "height": 864},
}
CUSTOM_SIZE_MIN = 256
CUSTOM_SIZE_MAX = 4096
CUSTOM_SIZE_MAX_PIXELS = 16_000_000


def image_to_base64(file_path):
    try:
        with open(file_path, "rb") as file:
            return base64.b64encode(file.read()).decode("utf-8")
    except OSError:
        return None


def stored_image_to_base64(filename):
    backend = _storage_backend()
    if backend == "supabase":
        try:
            response = _storage_download(_image_blob_path(filename))
            if len(response.content) > MAX_REMOTE_IMAGE_BYTES:
                return None
            return base64.b64encode(response.content).decode("utf-8")
        except ProviderError:
            app.logger.exception("Failed to read remote reference image")
            return None
    image_folder = SAVE_FOLDER if storage_scope_name() == "local-user" else os.path.join(SAVE_FOLDER, storage_scope_name())
    path = os.path.join(image_folder, filename)
    return image_to_base64(path) if os.path.exists(path) else None


def validate_reference_image_b64(value):
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ProviderError(
            "REFERENCE_IMAGE_INVALID",
            "参考图格式无效",
            400,
            "参考图必须使用 Base64 字符串传输。",
            ["重新选择参考图", "使用 PNG、JPG、WebP 或 GIF", "再次生成"],
        )

    encoded = value.strip()
    if encoded.startswith("data:"):
        match = re.fullmatch(
            r"data:image/(png|jpe?g|webp|gif);base64,(.+)",
            encoded,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if not match:
            raise ProviderError(
                "REFERENCE_IMAGE_INVALID",
                "参考图格式无效",
                400,
                "参考图 Data URL 不是受支持的图片 Base64。",
                ["重新选择参考图", "使用 PNG、JPG、WebP 或 GIF", "再次生成"],
            )
        encoded = match.group(2).strip()

    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise ProviderError(
            "REFERENCE_IMAGE_INVALID",
            "参考图无法读取",
            400,
            "参考图 Base64 内容不完整或已损坏。",
            ["重新导入图片", "降低图片大小", "再次生成"],
        ) from exc

    return base64.b64encode(validate_reference_image_bytes(image_bytes)).decode("ascii")


def validate_reference_images_b64(values):
    if values in (None, ""):
        return []
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_REFERENCE_IMAGES:
        raise ProviderError(
            "REFERENCE_IMAGES_INVALID",
            "参考图数量无效",
            400,
            "参考图列表必须包含 1 至 8 张图片。",
            ["重新选择画布原图", "减少参考图数量", "再次生成"],
        )
    return [validate_reference_image_b64(value) for value in values]


def reference_image_data_url(encoded):
    image_bytes = base64.b64decode(encoded, validate=True)
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        mime = "image/png"
    elif image_bytes.startswith(b"\xff\xd8\xff"):
        mime = "image/jpeg"
    elif image_bytes.startswith((b"GIF87a", b"GIF89a")):
        mime = "image/gif"
    else:
        mime = "image/webp"
    return f"data:{mime};base64,{encoded}"


def is_openrouter_image_endpoint(endpoint):
    parsed = urlsplit(endpoint)
    return parsed.hostname == "openrouter.ai" and parsed.path.rstrip("/").endswith("/api/v1/images")


def reference_image_upload(encoded, index):
    image_bytes = base64.b64decode(encoded, validate=True)
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        extension, mime = "png", "image/png"
    elif image_bytes.startswith(b"\xff\xd8\xff"):
        extension, mime = "jpg", "image/jpeg"
    elif image_bytes.startswith((b"GIF87a", b"GIF89a")):
        extension, mime = "gif", "image/gif"
    else:
        extension, mime = "webp", "image/webp"
    return f"reference-{index}.{extension}", image_bytes, mime


def provider_edit_endpoint(provider):
    parsed = urlsplit(provider.endpoint)
    path = parsed.path.rstrip("/")
    if path.endswith("/images/generations"):
        path = f"{path[:-len('/images/generations')]}/images/edits"
    elif not path.endswith("/images/edits"):
        raise ProviderError(
            "PROVIDER_EDIT_ENDPOINT_UNKNOWN",
            "无法确定图片编辑接口",
            400,
            "当前生成接口地址不是标准的 /v1/images/generations，无法自动推导 /v1/images/edits。",
            ["将接口地址改为标准 OpenAI 图片生成端点", "确认服务商支持图片编辑", "重新保存服务配置"],
        )
    edit_endpoint = parsed._replace(path=path).geturl()
    validate_provider_endpoint(edit_endpoint, resolve_dns=False)
    return edit_endpoint


def store_generated_image(filename, image_bytes):
    backend = _storage_backend()
    if backend == "supabase":
        _supabase_put(_image_blob_path(filename), image_bytes, "image/png")
    else:
        image_folder = SAVE_FOLDER if storage_scope_name() == "local-user" else os.path.join(SAVE_FOLDER, storage_scope_name())
        os.makedirs(image_folder, exist_ok=True)
        with open(os.path.join(image_folder, filename), "wb") as file:
            file.write(image_bytes)
    try:
        # Build from bytes already received from the provider: no Storage read.
        preview = create_image_preview(image_bytes)
        if backend == "supabase":
            _supabase_put(_image_blob_path(preview_filename(filename)), preview, "image/png")
        else:
            with open(os.path.join(image_folder, preview_filename(filename)), "wb") as file:
                file.write(preview)
    except Exception:
        # An optional thumbnail must never turn a successful generation into a
        # failure/refund or force re-generation of a charged image.
        app.logger.warning("Optional gallery preview unavailable")


def remove_stored_images(filenames):
    originals = [os.path.basename(str(filename)) for filename in filenames]
    safe_names = list(dict.fromkeys(name for original in originals for name in (original, preview_filename(original))))
    backend = _storage_backend()
    if backend == "supabase":
        paths = list(dict.fromkeys(_image_blob_path(filename) for filename in safe_names))
        _supabase_delete(paths)
        return
    image_folder = SAVE_FOLDER if storage_scope_name() == "local-user" else os.path.join(SAVE_FOLDER, storage_scope_name())
    for filename in safe_names:
        path = os.path.join(image_folder, filename)
        if os.path.exists(path):
            os.remove(path)


def clear_all_stored_images():
    """Delete generated image/history objects after the admin confirms a full cleanup."""
    backend = _storage_backend()
    removed = 0
    if backend == "supabase":
        paths = list(_supabase_file_paths())
        if paths:
            _supabase_delete(paths)
            removed += len(paths)
        return removed

    if os.path.isdir(SAVE_FOLDER):
        for entry in os.listdir(SAVE_FOLDER):
            if entry == ".gitkeep":
                continue
            path = os.path.join(SAVE_FOLDER, entry)
            if os.path.isdir(path):
                shutil.rmtree(path)
                removed += 1
            elif os.path.isfile(path):
                os.remove(path)
                removed += 1
    history_dir = os.path.join(DATA_DIR, "history")
    if os.path.isdir(history_dir):
        shutil.rmtree(history_dir)
    if os.path.isfile(LEGACY_HISTORY_FILE):
        os.remove(LEGACY_HISTORY_FILE)
        removed += 1
    return removed


def decode_provider_image(image_data):
    encoded = image_data.get("b64_json") or image_data.get("base64") or image_data.get("b64")
    if encoded:
        if isinstance(encoded, str) and encoded.startswith("data:"):
            encoded = encoded.split(",", 1)[-1]
        try:
            return base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise ProviderError(
                "PROVIDER_IMAGE_INVALID",
                "图片服务返回了无效的图片数据",
                502,
                "响应中的 Base64 图片无法解码。",
                ["确认中转站兼容 OpenAI 图片响应格式", "稍后重试", "联系中转站服务商"],
            ) from exc

    image_url = image_data.get("url")
    if image_url:
        validate_provider_endpoint(image_url, resolve_dns=True)
        try:
            response = requests.get(image_url, timeout=60, stream=True)
            response.raise_for_status()
            buffer = io.BytesIO()
            for chunk in response.iter_content(64 * 1024):
                buffer.write(chunk)
                if buffer.tell() > MAX_REMOTE_IMAGE_BYTES:
                    raise ProviderError(
                        "PROVIDER_IMAGE_TOO_LARGE",
                        "中转站返回的图片过大",
                        502,
                        "远程图片超过 25 MB 安全限制。",
                        ["降低生成尺寸", "调整中转站返回格式", "重新生成"],
                    )
            return buffer.getvalue()
        except requests.RequestException as exc:
            raise ProviderError(
                "PROVIDER_IMAGE_DOWNLOAD_FAILED",
                "无法下载中转站返回的图片",
                502,
                "图片服务返回了 URL，但服务器没有成功取得图片文件。",
                ["稍后重试", "检查中转站图片链接", "改用 Base64 返回格式"],
            ) from exc

    raise ProviderError(
        "PROVIDER_IMAGE_MISSING",
        "图片服务响应中没有可用图片",
        502,
        "响应项中未找到 b64_json、base64 或 url 字段。",
        ["确认中转站兼容 OpenAI 图片接口", "检查模型标识", "联系中转站服务商"],
    )


def provider_request_timeout_seconds(count):
    """Give batched requests extra time while staying below Vercel's 300s limit."""
    try:
        normalized_count = max(1, int(count))
    except (TypeError, ValueError):
        normalized_count = 1
    return min(
        PROVIDER_REQUEST_TIMEOUT_MAX_SECONDS,
        PROVIDER_REQUEST_TIMEOUT_BASE_SECONDS + max(normalized_count - 1, 0) * 13,
    )


def generate_images(provider, prompt, ref_b64=None, strength=0.65, size="", quality="auto", count=1, custom_size=None, mask_b64=None):
    # Keep the provider request aligned with the product default even for legacy callers.
    quality = "auto"
    request_timeout_seconds = provider_request_timeout_seconds(count)
    size_cfg = custom_size or SIZE_OPTIONS.get(size)
    payload = {
        "model": provider.model,
        "prompt": prompt,
        "n": count,
        "quality": quality,
    }
    if size_cfg:
        payload["size"] = f"{size_cfg['width']}x{size_cfg['height']}"
    references = ref_b64 if isinstance(ref_b64, list) else ([ref_b64] if ref_b64 else [])

    try:
        if references:
            normalized_references = [validate_reference_image_b64(value) for value in references]
            if is_openrouter_image_endpoint(provider.endpoint):
                openrouter_payload = {
                    "model": provider.model,
                    "prompt": prompt,
                    "n": count,
                    **({"size": payload["size"]} if "size" in payload else {}),
                    "quality": quality,
                    "input_references": [
                        {"type": "image_url", "image_url": {"url": reference_image_data_url(encoded)}}
                        for encoded in normalized_references
                    ],
                    **({"mask": reference_image_data_url(validate_reference_image_b64(mask_b64))} if mask_b64 else {}),
                }
                response = requests.post(
                    provider.endpoint,
                    headers=provider_headers(provider),
                    json=openrouter_payload,
                    timeout=request_timeout_seconds,
                )
            else:
                file_field = "image" if len(normalized_references) == 1 else "image[]"
                files = [
                    (file_field, reference_image_upload(encoded, index))
                    for index, encoded in enumerate(normalized_references, start=1)
                ]
                if mask_b64:
                    files.append(("mask", reference_image_upload(validate_reference_image_b64(mask_b64), 0)))
                response = requests.post(
                    provider_edit_endpoint(provider),
                    headers=provider_headers(provider, content_type=None),
                    data={
                        "model": provider.model,
                        "prompt": prompt,
                        "n": str(count),
                        **({"size": payload["size"]} if "size" in payload else {}),
                        "response_format": "b64_json",
                    },
                    files=files,
                    timeout=request_timeout_seconds,
                )
        else:
            response = requests.post(
                provider.endpoint,
                headers=provider_headers(provider),
                json=payload,
                timeout=request_timeout_seconds,
            )
    except requests.exceptions.Timeout as exc:
        raise ProviderError(
            "PROVIDER_TIMEOUT",
            "图片生成服务响应超时",
            504,
            f"{provider.host} 在 {request_timeout_seconds} 秒内没有返回生成结果。",
            ["稍后重试", "降低批量数量", "检查中转站网络状态"],
        ) from exc
    except requests.exceptions.ConnectionError as exc:
        raise ProviderError(
            "PROVIDER_NETWORK_BLOCKED",
            "无法连接图片生成服务",
            502,
            f"服务器无法连接 {provider.host}:443，请检查中转站地址、DNS、防火墙或代理设置。",
            ["检查中转站接口地址", "确认服务器允许出站 HTTPS", "稍后重试"],
        ) from exc
    except requests.exceptions.RequestException as exc:
        raise ProviderError(
            "PROVIDER_REQUEST_FAILED",
            "图片生成请求未能送达服务商",
            502,
            f"向 {provider.host} 发送请求时发生网络异常。",
            ["检查服务器网络", "确认中转站服务状态", "稍后重试"],
        ) from exc

    try:
        result = response.json()
    except ValueError as exc:
        raise ProviderError(
            "PROVIDER_BAD_RESPONSE",
            "图片服务返回了无法识别的响应",
            502,
            f"HTTP {response.status_code}，响应内容不是有效 JSON。",
            ["确认接口地址是图片生成端点", "检查中转站兼容性", "稍后重试"],
        ) from exc

    if response.status_code >= 400 or result.get("error"):
        provider_error = result.get("error") or result.get("message") or f"HTTP {response.status_code}"
        if isinstance(provider_error, dict):
            provider_error = provider_error.get("message") or json.dumps(provider_error, ensure_ascii=False)
        raise ProviderError(
            "PROVIDER_REJECTED",
            "图片生成服务拒绝了本次请求",
            response.status_code if response.status_code >= 400 else 502,
            str(provider_error),
            [
                "检查 API Key、余额与模型权限",
                "参考图编辑需确认模型支持 input_references 或标准图片编辑接口",
                "核对接口地址和模型标识",
            ],
        )

    items = result.get("data") or result.get("images") or []
    if isinstance(items, dict):
        items = [items]
    if not items:
        raise ProviderError(
            "PROVIDER_EMPTY_RESULT",
            "图片生成服务没有返回图片",
            502,
            "接口响应成功，但 data 或 images 中没有可保存的图片。",
            ["检查中转站响应格式", "检查模型标识", "重新生成"],
        )

    images = []
    task_id = uuid.uuid4().hex[:12]
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    for index, image_data in enumerate(items[:count]):
        if not isinstance(image_data, dict):
            continue
        image_bytes = decode_provider_image(image_data)
        filename = f"{timestamp}_{task_id}_{index + 1}.png"
        store_generated_image(filename, image_bytes)
        images.append({"filename": filename, "index": index + 1})

    if not images:
        raise ProviderError(
            "PROVIDER_EMPTY_RESULT",
            "图片生成服务没有返回可保存的图片",
            502,
            "响应数组存在，但其中没有兼容的图片数据。",
            ["确认中转站兼容 OpenAI 图片响应格式", "检查模型标识", "重新生成"],
        )
    return images


def parse_generation_request(data):
    prompt = str(data.get("prompt", "")).strip()
    if not prompt:
        raise ProviderError("PROMPT_REQUIRED", "请输入提示词", 400, "提示词不能为空。", ["填写提示词", "重新生成"])
    if len(prompt) > 6000:
        raise ProviderError(
            "PROMPT_TOO_LONG",
            "提示词超过长度限制",
            400,
            "提示词最多 6000 个字符。",
            ["精简提示词", "保留核心画面要求", "重新生成"],
        )
    size = data.get("size", "")
    if (size and size not in SIZE_OPTIONS and size != "custom"):
        raise ProviderError(
            "PARAMETER_INVALID",
            "生成参数无效",
            400,
            "尺寸不在允许范围内。",
            ["需要时选择尺寸", "恢复默认参数", "再次生成"],
        )
    # The product no longer exposes a quality selector. Ignore legacy client values.
    quality = "auto"
    custom_size = None
    try:
        if size == "custom":
            custom_width = int(data.get("custom_width", 0))
            custom_height = int(data.get("custom_height", 0))
            if not (
                CUSTOM_SIZE_MIN <= custom_width <= CUSTOM_SIZE_MAX
                and CUSTOM_SIZE_MIN <= custom_height <= CUSTOM_SIZE_MAX
                and custom_width * custom_height <= CUSTOM_SIZE_MAX_PIXELS
            ):
                raise ValueError("custom size outside supported bounds")
            custom_size = {"width": custom_width, "height": custom_height}
        count = max(1, min(int(data.get("count", 1)), 4))
        strength = max(0.0, min(float(data.get("strength", 0.65)), 1.0))
    except (TypeError, ValueError) as exc:
        raise ProviderError(
            "PARAMETER_INVALID",
            "生成参数无效",
            400,
            "自定义尺寸、批量数量或参考强度格式不正确。自定义尺寸单边应为 256–4096 px，且总像素不超过 1600 万。",
            ["检查自定义宽高", "恢复默认参数", "再次生成"],
        ) from exc
    return prompt, size, custom_size, quality, count, strength


@app.errorhandler(413)
def request_too_large(_error):
    return provider_error_response(
        ProviderError(
            "REQUEST_TOO_LARGE",
            "上传内容超过大小限制",
            413,
            "请求体超过服务端限制，请压缩参考图后重试。",
            ["压缩参考图", "改用较小图片", "重新上传"],
        )
    )


@app.route("/api/styles", methods=["GET"])
def get_styles():
    return jsonify({"styles": STYLE_TEMPLATES, "sizes": SIZE_OPTIONS})


@app.route("/api/auth/session", methods=["POST"])
def create_auth_session():
    try:
        user = require_authenticated_user()
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))
    response = jsonify({"success": True, "user_id": user.id})
    response.set_cookie(
        AUTH_COOKIE_NAME,
        access_token_from_request(),
        max_age=3600,
        secure=AUTH_COOKIE_SECURE,
        httponly=True,
        samesite="Lax",
        path="/",
    )
    return response


@app.route("/api/auth/session", methods=["DELETE"])
def delete_auth_session():
    response = jsonify({"success": True})
    response.delete_cookie(AUTH_COOKIE_NAME, path="/", secure=AUTH_COOKIE_SECURE, httponly=True, samesite="Lax")
    return response


@app.route("/api/account", methods=["GET"])
def account():
    try:
        user = require_authenticated_user()
        snapshot = SupabaseGateway().account_snapshot(user.id)
        bonus = snapshot.get("signup_bonus") or {}
        if bonus.get("ok") is False and bonus.get("code") != "EMAIL_UNVERIFIED":
            raise_for_rpc_result(bonus)
        profile = snapshot.get("profile") or {}
        return jsonify({"success": True, "is_admin": user.id in ADMIN_USER_IDS or profile.get("role") == "admin", **snapshot})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/account", methods=["DELETE"])
def delete_account():
    try:
        user = require_authenticated_user()
        SupabaseGateway().delete_user(user.id)
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))
    response = jsonify({"success": True})
    response.delete_cookie(AUTH_COOKIE_NAME, path="/", secure=AUTH_COOKIE_SECURE, httponly=True, samesite="Lax")
    return response


@app.route("/api/admin/metrics", methods=["GET"])
def admin_metrics():
    try:
        user = require_authenticated_user()
        gateway = SupabaseGateway()
        profile = gateway.account_snapshot(user.id).get("profile") or {}
        if user.id not in ADMIN_USER_IDS and profile.get("role") != "admin":
            raise ProviderError("ADMIN_REQUIRED", "没有查看平台数据的权限", 403, "该页面仅对管理员开放。")
        today = datetime.now(timezone.utc).date()
        from_value = request.args.get("from", "")
        to_value = request.args.get("to", "")
        try:
            from_date = datetime.strptime(from_value, "%Y-%m-%d").date() if from_value else today - timedelta(days=29)
            to_date = datetime.strptime(to_value, "%Y-%m-%d").date() if to_value else today
        except ValueError as exc:
            raise ProviderError("METRICS_DATE_INVALID", "统计日期格式无效", 400, "日期格式应为 YYYY-MM-DD。") from exc
        if from_date > to_date or to_date > today or (to_date - from_date).days > 89:
            raise ProviderError("METRICS_DATE_INVALID", "统计日期范围无效", 400, "请选择今天之前且不超过 90 天的日期范围。")
        return jsonify({"success": True, "from": from_date.isoformat(), "to": to_date.isoformat(), "metrics": gateway.admin_metrics(from_date, to_date)})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


def require_admin_user():
    user = require_authenticated_user()
    gateway = SupabaseGateway()
    profile = gateway.account_snapshot(user.id).get("profile") or {}
    if user.id not in ADMIN_USER_IDS and profile.get("role") != "admin":
        raise ProviderError("ADMIN_REQUIRED", "没有管理员权限", 403, "该操作仅对管理员开放。")
    return user, gateway


@app.route("/api/admin/console", methods=["GET"])
def admin_console():
    try:
        _user, gateway = require_admin_user()
        today = datetime.now(timezone.utc).date()
        from_value = request.args.get("from", "")
        to_value = request.args.get("to", "")
        try:
            from_date = datetime.strptime(from_value, "%Y-%m-%d").date() if from_value else today - timedelta(days=29)
            to_date = datetime.strptime(to_value, "%Y-%m-%d").date() if to_value else today
        except ValueError as exc:
            raise ProviderError("METRICS_DATE_INVALID", "统计日期格式无效", 400, "日期格式应为 YYYY-MM-DD。") from exc
        if from_date > to_date or to_date > today or (to_date - from_date).days > 89:
            raise ProviderError("METRICS_DATE_INVALID", "统计日期范围无效", 400, "请选择今天之前且不超过 90 天的日期范围。")
        snapshot = gateway.admin_console_snapshot(from_date, to_date, request.args.get("search", ""), 100)
        return jsonify({"success": True, "from": from_date.isoformat(), "to": to_date.isoformat(), **snapshot})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/admin/storage/clear-history", methods=["POST"])
def clear_history_storage():
    try:
        require_admin_user()
        removed = clear_all_stored_images()
        return jsonify({"success": True, "removed": removed})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/announcements", methods=["GET"])
def public_announcements():
    try:
        if not is_supabase_configured():
            return jsonify({"success": True, "announcements": []})
        limit = min(max(int(request.args.get("limit", 5)), 1), 20)
        announcements = SupabaseGateway().public_announcements(limit)
        return jsonify({"success": True, "announcements": announcements})
    except (ValueError, SupabaseError) as error:
        # Announcements should never block the image workspace if the optional
        # table has not been migrated yet or the account service is unavailable.
        app.logger.warning("Unable to load public announcements: %s", error)
        return jsonify({"success": True, "announcements": []})


def parse_announcement_payload(data):
    data = data if isinstance(data, dict) else {}
    title = str(data.get("title", "")).strip()
    content = str(data.get("content", "")).strip()
    announcement_type = str(data.get("announcement_type", "info")).strip().lower()
    status = str(data.get("status", "draft")).strip().lower()
    is_pinned = data.get("is_pinned", False)
    if not isinstance(is_pinned, bool):
        raise ProviderError("ANNOUNCEMENT_STATUS_INVALID", "公告状态无效", 400, "置顶必须是布尔值。")
    if not title or len(title) > 120:
        raise ProviderError("ANNOUNCEMENT_TITLE_INVALID", "公告标题无效", 400, "标题不能为空，且最多 120 个字符。")
    if not content or len(content) > 5000:
        raise ProviderError("ANNOUNCEMENT_CONTENT_INVALID", "公告内容无效", 400, "公告内容不能为空，且最多 5000 个字符。")
    if announcement_type not in {"info", "important", "maintenance"}:
        raise ProviderError("ANNOUNCEMENT_TYPE_INVALID", "公告类型无效", 400, "请选择有效的公告类型。")
    if status not in {"draft", "published", "offline"}:
        raise ProviderError("ANNOUNCEMENT_STATUS_INVALID", "公告状态无效", 400, "请选择草稿、已发布或已下线。")

    def parse_time(value):
        if value in (None, ""):
            return None
        raw = str(value).strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError as exc:
            raise ProviderError("ANNOUNCEMENT_TIME_INVALID", "公告时间无效", 400, "展示时间格式无效。") from exc
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat()

    starts_at = parse_time(data.get("starts_at"))
    ends_at = parse_time(data.get("ends_at"))
    if starts_at and ends_at and datetime.fromisoformat(ends_at) <= datetime.fromisoformat(starts_at):
        raise ProviderError("ANNOUNCEMENT_TIME_INVALID", "公告时间无效", 400, "结束时间必须晚于开始时间。")
    return title, content, announcement_type, status, is_pinned, starts_at, ends_at


@app.route("/api/admin/announcements", methods=["GET"])
def admin_announcements():
    try:
        _user, gateway = require_admin_user()
        status = request.args.get("status", "all").strip().lower()
        if status not in {"all", "draft", "published", "offline"}:
            raise ProviderError("ANNOUNCEMENT_STATUS_INVALID", "公告状态无效", 400, "请选择有效的公告筛选状态。")
        announcements = gateway.admin_announcements(request.args.get("search", ""), status, 200)
        return jsonify({"success": True, "announcements": announcements})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/admin/announcements", methods=["POST"])
def create_admin_announcement():
    try:
        user, gateway = require_admin_user()
        values = parse_announcement_payload(request.get_json(silent=True) or {})
        result = raise_for_rpc_result(gateway.create_announcement(user.id, *values))
        return jsonify({"success": True, **result})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/admin/announcements/<announcement_id>", methods=["PATCH"])
def update_admin_announcement(announcement_id):
    try:
        user, gateway = require_admin_user()
        try:
            uuid.UUID(announcement_id)
        except ValueError as exc:
            raise ProviderError("ANNOUNCEMENT_NOT_FOUND", "公告不存在", 404, "公告编号无效。") from exc
        values = parse_announcement_payload(request.get_json(silent=True) or {})
        result = raise_for_rpc_result(gateway.update_announcement(user.id, announcement_id, *values))
        return jsonify({"success": True, **result})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/admin/announcements/<announcement_id>", methods=["DELETE"])
def delete_admin_announcement(announcement_id):
    try:
        user, gateway = require_admin_user()
        try:
            uuid.UUID(announcement_id)
        except ValueError as exc:
            raise ProviderError("ANNOUNCEMENT_NOT_FOUND", "公告不存在", 404, "公告编号无效。") from exc
        result = raise_for_rpc_result(gateway.delete_announcement(user.id, announcement_id))
        return jsonify({"success": True, **result})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/admin/settings/credits", methods=["GET"])
def get_admin_credit_settings():
    try:
        _user, gateway = require_admin_user()
        return jsonify({"success": True, "settings": raise_for_rpc_result(gateway.get_credit_settings())})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/admin/settings/credits", methods=["POST"])
def update_admin_credit_settings():
    try:
        user, gateway = require_admin_user()
        data = request.get_json(silent=True) or {}
        raw_credits = data.get("signup_bonus_credits")
        if isinstance(raw_credits, bool) or (
            isinstance(raw_credits, float) and not raw_credits.is_integer()
        ) or (isinstance(raw_credits, str) and not raw_credits.strip().isdigit()):
            raise ProviderError(
                "SIGNUP_BONUS_INVALID",
                "注册赠送积分无效",
                400,
                "请输入 0 到 10000 之间的整数。",
                ["检查积分数量"],
            )
        try:
            signup_bonus_credits = int(raw_credits)
        except (TypeError, ValueError) as exc:
            raise ProviderError(
                "SIGNUP_BONUS_INVALID",
                "注册赠送积分无效",
                400,
                "请输入 0 到 10000 之间的整数。",
                ["检查积分数量"],
            ) from exc
        if not 0 <= signup_bonus_credits <= 10000:
            raise ProviderError(
                "SIGNUP_BONUS_INVALID",
                "注册赠送积分无效",
                400,
                "请输入 0 到 10000 之间的整数。",
                ["检查积分数量"],
            )
        reason = str(data.get("reason", "")).strip()[:240]
        result = raise_for_rpc_result(
            gateway.update_signup_bonus_credits(user.id, signup_bonus_credits, reason)
        )
        return jsonify({"success": True, "settings": result.get("settings", result)})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/admin/credits/adjust", methods=["POST"])
def admin_adjust_credits():
    try:
        user, gateway = require_admin_user()
        data = request.get_json(silent=True) or {}
        user_id = str(data.get("user_id", "")).strip()
        try:
            delta = int(data.get("delta"))
        except (TypeError, ValueError) as exc:
            raise ProviderError("CREDIT_DELTA_INVALID", "积分调整数量无效", 400, "请输入不为 0 的整数积分。") from exc
        if not user_id or not -100000 <= delta <= 100000 or delta == 0:
            raise ProviderError("CREDIT_DELTA_INVALID", "积分调整数量无效", 400, "请输入 -100000 到 100000 之间且不为 0 的整数积分。")
        reason = str(data.get("reason", "")).strip()[:240]
        idempotency_key = str(data.get("idempotency_key", "")).strip() or f"admin:{uuid.uuid4()}"
        result = raise_for_rpc_result(gateway.admin_adjust_credits(user.id, user_id, delta, reason, idempotency_key))
        return jsonify({"success": True, **result})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/credits/orders", methods=["POST"])
def create_credit_order():
    try:
        user = require_authenticated_user()
        data = request.get_json(silent=True) or {}
        channel = str(data.get("channel", "")).strip().lower()
        try:
            amount_yuan = int(data.get("amount_yuan"))
        except (TypeError, ValueError) as exc:
            raise ProviderError("PAYMENT_AMOUNT_INVALID", "充值金额无效", 400, "充值金额最低 10 元，且必须是整数元。") from exc
        if channel != "alipay":
            raise ProviderError("PAYMENT_CHANNEL_INVALID", "支付方式无效", 400, "当前仅支持支付宝当面付。")
        if amount_yuan < 10 or amount_yuan > 10000:
            raise ProviderError("PAYMENT_AMOUNT_INVALID", "充值金额无效", 400, "充值金额必须在 10 元到 10000 元之间。")
        channels = configured_payment_channels()
        if PAYMENT_PROVIDER not in {"enabled", "alipay"} or channel not in channels:
            raise ProviderError("PAYMENT_NOT_CONFIGURED", "在线支付尚未配置", 503, "请先在服务端配置已审核的支付宝当面付商户通道。")
        enforce_rate_limit("credit-order", user.id, 5, 600)
        expires_at_dt = datetime.now(timezone.utc) + timedelta(minutes=30)
        expires_at = expires_at_dt.isoformat()
        out_trade_no = f"PF{datetime.now(timezone.utc).strftime('%y%m%d%H%M%S')}{uuid.uuid4().hex[:14].upper()}"
        gateway = SupabaseGateway()
        account_snapshot = gateway.account_snapshot(user.id)
        if not account_snapshot.get("email_verified"):
            raise ProviderError("EMAIL_UNVERIFIED", "请先完成邮箱验证", 403, "邮箱验证通过后才能使用在线充值。")
        order = gateway.create_credit_order(user.id, channel, amount_yuan * 100, amount_yuan * 10, out_trade_no, expires_at)
        if not order:
            raise ProviderError("ORDER_CREATE_FAILED", "充值订单创建失败", 503, "数据库没有返回充值订单。")
        try:
            checkout = create_checkout(channel, out_trade_no=out_trade_no, amount_fen=amount_yuan * 100, expires_at=expires_at_dt.strftime("%Y-%m-%dT%H:%M:%S+00:00"))
        except PaymentError:
            gateway.update_credit_order_payment(order["id"], status="failed", metadata={"reason": "provider_order_failed"})
            raise
        updated = gateway.update_credit_order_payment(order["id"], code_url=checkout.code_url, payment_url=checkout.payment_url)
        return jsonify({"success": True, "order": {**(updated or order), "code_url": checkout.code_url, "payment_url": checkout.payment_url}})
    except (ProviderError, PaymentError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/credits/orders/<order_id>", methods=["GET"])
def get_credit_order(order_id):
    try:
        user = require_authenticated_user()
        order = SupabaseGateway().get_credit_order(user.id, order_id)
        if not order:
            raise ProviderError("ORDER_NOT_FOUND", "充值订单不存在", 404, "请重新创建充值订单。")
        return jsonify({"success": True, "order": order})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/payments/webhook/<channel>", methods=["POST"])
def payment_webhook(channel):
    """Verify an official payment notification and settle the matching order."""
    try:
        if channel != "alipay" or channel not in configured_payment_channels():
            raise PaymentError("PAYMENT_NOT_CONFIGURED", "在线支付尚未配置", 503, "支付回调尚未配置。")
        paid = parse_wechat_callback(request.headers, request.get_data()) if channel == "wechat" else parse_alipay_callback(request.form.to_dict(flat=True))
        raise_for_rpc_result(
            SupabaseGateway().complete_credit_order(
                paid.out_trade_no,
                paid.provider_trade_no,
                paid.paid_amount_fen,
                paid.metadata,
            )
        )
        return ("success", 200, {"Content-Type": "text/plain; charset=utf-8"})
    except (ProviderError, PaymentError, SupabaseError, TypeError, ValueError) as error:
        normalized = as_provider_error(error)
        if channel == "alipay":
            return ("failure", normalized.status, {"Content-Type": "text/plain; charset=utf-8"})
        return jsonify({"code": "FAIL", "message": normalized.message}), normalized.status


@app.route("/api/provider/validate", methods=["POST"])
def validate_provider():
    try:
        provider = resolve_provider_config("own_key", resolve_dns=False)
    except ProviderError as error:
        return provider_error_response(error)
    return jsonify(
        {
            "success": True,
            "provider": {
                "host": provider.host,
                "model": provider.model,
                "auth_type": provider.auth_type,
                "source": provider.source,
            },
        }
    )


@app.route("/api/reference-upload-url", methods=["POST"])
def reference_upload_url():
    data = request.get_json(silent=True) or {}
    try:
        billing_mode = parse_billing_mode(data)
        if billing_mode == "platform":
            require_authenticated_user()
        else:
            set_optional_storage_scope()
        if _storage_backend() != "supabase":
            raise ProviderError(
                "REFERENCE_STORAGE_UNAVAILABLE",
                "参考图上传服务未配置",
                503,
                "线上参考图需要启用 Supabase Storage。",
                ["检查 Supabase Storage 配置", "稍后重试"],
            )
        content_type = str(data.get("content_type") or "").strip().lower()
        extension = REFERENCE_UPLOAD_EXTENSIONS.get(content_type)
        if not extension:
            raise ProviderError(
                "REFERENCE_UPLOAD_INVALID",
                "参考图格式不支持",
                400,
                "参考图仅支持 PNG、JPG、WebP 或 GIF。",
                ["选择 PNG、JPG、WebP 或 GIF", "重新上传"],
            )
        try:
            announced_size = int(data.get("size") or 0)
        except (TypeError, ValueError) as exc:
            raise ProviderError("REFERENCE_UPLOAD_INVALID", "参考图大小无效", 400, "请重新选择图片。") from exc
        if announced_size < 0 or announced_size > REFERENCE_UPLOAD_MAX_BYTES:
            raise ProviderError(
                "REFERENCE_IMAGE_TOO_LARGE",
                "参考图超过大小限制",
                413,
                "参考图不能超过 16 MB。",
                ["压缩参考图", "选择较小图片", "重新上传"],
            )
        pathname = f"{_reference_storage_prefix()}{uuid.uuid4().hex}.{extension}"
        signed = _supabase_create_signed_upload(pathname)
        return jsonify({"success": True, **signed, "max_bytes": REFERENCE_UPLOAD_MAX_BYTES})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/reference-cleanup", methods=["POST"])
def reference_cleanup():
    data = request.get_json(silent=True) or {}
    try:
        billing_mode = parse_billing_mode(data)
        if billing_mode == "platform":
            require_authenticated_user()
        else:
            set_optional_storage_scope()
        raw_paths = data.get("paths", data.get("reference_storage_paths"))
        paths = [] if raw_paths in (None, "") else validate_reference_storage_paths(raw_paths)
        if paths:
            if _storage_backend() != "supabase":
                raise ProviderError(
                    "REFERENCE_STORAGE_UNAVAILABLE",
                    "参考图上传服务未配置",
                    503,
                    "线上参考图需要启用 Supabase Storage。",
                    ["检查 Supabase Storage 配置", "稍后重试"],
                )
            _supabase_delete(paths)
        return jsonify({"success": True, "deleted": len(paths)})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/generations/<request_id>", methods=["GET"])
def generation_status(request_id):
    """Recover a completed generation when the original long request lost its response."""
    try:
        user = require_authenticated_user()
        normalized_request_id = str(uuid.UUID(str(request_id)))
        job = SupabaseGateway().generation_by_request_id(user.id, normalized_request_id)
        if not job:
            return jsonify({"error": "生成任务不存在", "code": "GENERATION_NOT_FOUND"}), 404

        raw_keys = job.get("image_keys") or []
        filenames = [os.path.basename(str(value)) for value in raw_keys if str(value).strip()]
        images = (
            [{"filename": filename, "index": index + 1} for index, filename in enumerate(filenames)]
            if job.get("status") == "succeeded"
            else []
        )
        return jsonify(
            {
                "success": True,
                "status": job.get("status"),
                "images": images,
                "prompt": job.get("prompt") or "",
                "error_code": job.get("error_code"),
            }
        )
    except ValueError:
        return provider_error_response(
            ProviderError("REQUEST_ID_INVALID", "请求标识无效", 400, "请重新发起本次生成请求。")
        )
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/generate", methods=["POST"])
def generate():
    data = request.get_json(silent=True) or {}
    reference_storage_paths = []
    try:
        if parse_billing_mode(data) == "platform":
            require_authenticated_user()
        else:
            set_optional_storage_scope()
        prompt, size, custom_size, quality, count, strength = parse_generation_request(data)
        style_name = data.get("style_name", "")
        if style_name in STYLE_TEMPLATES and STYLE_TEMPLATES[style_name] not in prompt:
            prompt = f"{prompt}。{STYLE_TEMPLATES[style_name]}"
        reference_storage_paths = validate_reference_storage_paths(data.get("reference_storage_paths"))
        if reference_storage_paths:
            reference_b64 = [stored_reference_to_base64(path) for path in reference_storage_paths]
        else:
            reference_b64 = validate_reference_images_b64(data.get("reference_images_b64"))
            if not reference_b64:
                single_reference = validate_reference_image_b64(data.get("reference_b64"))
                reference_b64 = [single_reference] if single_reference else []
        reference_b64 = reference_b64 or None
        execution = execute_generation(
            data,
            requested_count=count,
            prompt=prompt,
            generate_callback=lambda provider: generate_images(
                provider, prompt, reference_b64, strength, size, quality, count, custom_size
            ),
        )
    except (ProviderError, SupabaseError) as error:
        error = as_provider_error(error)
        return provider_error_response(error)
    except Exception:
        app.logger.exception("Unexpected generation failure")
        return provider_error_response(
            ProviderError(
                "SERVER_GENERATE_ERROR",
                "后端处理生成任务时发生异常",
                500,
                "服务端未完成本次生成，请查看后端日志。",
                ["确认输出目录权限", "检查后端日志", "重新发起生成"],
            )
        )
    finally:
        cleanup_reference_storage_paths(reference_storage_paths)

    images = execution["images"]
    if execution["idempotent"]:
        return jsonify({"success": True, "images": images, "prompt": prompt, "credit_balance": execution["credit_balance"], "idempotent": True})
    return jsonify({"success": True, "images": images, "prompt": prompt, "credit_balance": execution["credit_balance"]})


@app.route("/api/modify", methods=["POST"])
def modify():
    data = request.get_json(silent=True) or {}
    temporary_storage_paths = []
    try:
        if parse_billing_mode(data) == "platform":
            require_authenticated_user()
        else:
            set_optional_storage_scope()
        prompt, size, custom_size, quality, _count, strength = parse_generation_request(data)
        reference_storage_paths = validate_reference_storage_paths(data.get("reference_storage_paths"))
        mask_storage_path = validate_reference_storage_path(data.get("mask_storage_path"))
        temporary_storage_paths = reference_storage_paths + ([mask_storage_path] if mask_storage_path else [])
        if reference_storage_paths:
            direct_references = [stored_reference_to_base64(path) for path in reference_storage_paths]
        else:
            direct_references = validate_reference_images_b64(data.get("reference_images_b64"))
            if not direct_references:
                single_reference = validate_reference_image_b64(data.get("reference_b64"))
                direct_references = [single_reference] if single_reference else []
        mask_b64 = stored_reference_to_base64(mask_storage_path) if mask_storage_path else validate_reference_image_b64(data.get("mask_b64"))
        previous_image = os.path.basename(str(data.get("previous_image", ""))) if not direct_references else ""
        ref_b64 = direct_references or (stored_image_to_base64(previous_image) if previous_image else None)
        if not ref_b64:
            raise ProviderError(
                "PREVIOUS_IMAGE_MISSING",
                "找不到重绘参考图",
                400,
                "局部重绘需要一张仍保存在服务端的历史图片，或由画布提交一张参考图。",
                ["重新选择画布图片", "确认历史图片没有过期", "再发起局部重绘"],
            )
        execution = execute_generation(
            data,
            requested_count=1,
            prompt=prompt,
            generate_callback=lambda provider: generate_images(
                provider, prompt, ref_b64, strength, size, quality, 1, custom_size, mask_b64=mask_b64
            ),
        )
    except (ProviderError, SupabaseError) as error:
        error = as_provider_error(error)
        return provider_error_response(error)
    except Exception:
        app.logger.exception("Unexpected modification failure")
        return provider_error_response(
            ProviderError(
                "SERVER_MODIFY_ERROR",
                "后端处理迭代任务时发生异常",
                500,
                "服务端未完成本次迭代，请查看后端日志。",
                ["确认原图仍存在", "检查后端日志", "重新发起迭代"],
            )
        )
    finally:
        cleanup_reference_storage_paths(temporary_storage_paths)

    images = execution["images"]
    if execution["idempotent"]:
        return jsonify({"success": True, "images": images, "prompt": prompt, "credit_balance": execution["credit_balance"], "idempotent": True})
    return jsonify({"success": True, "images": images, "prompt": prompt, "credit_balance": execution["credit_balance"]})


@app.route("/api/images/<filename>", methods=["GET"])
def serve_image(filename):
    try:
        set_optional_storage_scope()
    except SupabaseError as error:
        return provider_error_response(as_provider_error(error))
    safe_name = os.path.basename(filename)
    try:
        backend = _storage_backend()
        if backend == "supabase":
            return redirect_to_stored_image(safe_name)
    except ProviderError as error:
        return provider_error_response(error)
    image_folder = SAVE_FOLDER if storage_scope_name() == "local-user" else os.path.join(SAVE_FOLDER, storage_scope_name())
    path = os.path.join(image_folder, safe_name)
    if not os.path.exists(path):
        return jsonify({"error": "图片不存在"}), 404
    return send_file(path, mimetype="image/png")


def redirect_to_stored_image(filename, *, download=False):
    """Keep even legacy/fallback callers off the Function's image byte path."""
    url = _supabase_create_signed_url(_image_blob_path(filename))
    if download:
        url += ("&" if "?" in url else "?") + "download=" + quote(filename, safe="")
    response = redirect(url, code=302)
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.route("/api/images/<filename>/url", methods=["GET"])
def image_url(filename):
    """Authorize access, then let the browser read the private object directly."""
    try:
        set_optional_storage_scope()
        safe_name = os.path.basename(filename)
        variant = request.args.get("variant", "original")
        if variant not in {"original", "thumbnail"}:
            raise ProviderError("IMAGE_VARIANT_INVALID", "图片类型无效", 400)
        if _storage_backend() == "supabase":
            actual_variant = variant
            try:
                signed_url = _supabase_create_signed_url(_image_blob_path(
                    preview_filename(safe_name) if variant == "thumbnail" else safe_name
                ))
            except ProviderError:
                if variant != "thumbnail":
                    raise
                # Older images have no sidecar; don't download them to backfill.
                actual_variant = "original"
                signed_url = _supabase_create_signed_url(_image_blob_path(safe_name))
            response = jsonify(
                {
                    "success": True,
                    "url": signed_url,
                    "variant": actual_variant,
                    "expires_in": 3600,
                }
            )
            response.headers["Cache-Control"] = "private, no-store"
            return response
        # Keep local development and legacy local data usable without a storage request.
        query = f"?client_id={quote(current_client_id())}" if current_storage_scope() == current_client_id() else ""
        image_folder = SAVE_FOLDER if storage_scope_name() == "local-user" else os.path.join(SAVE_FOLDER, storage_scope_name())
        if variant == "thumbnail" and os.path.isfile(os.path.join(image_folder, preview_filename(safe_name))):
            safe_name = preview_filename(safe_name)
        return jsonify({"success": True, "url": f"/api/images/{quote(safe_name)}{query}", "direct": False})
    except (ProviderError, SupabaseError) as error:
        return provider_error_response(as_provider_error(error))


@app.route("/api/download/<filename>", methods=["GET"])
def download_image(filename):
    try:
        set_optional_storage_scope()
    except SupabaseError as error:
        return provider_error_response(as_provider_error(error))
    safe_name = os.path.basename(filename)
    try:
        backend = _storage_backend()
        if backend == "supabase":
            return redirect_to_stored_image(safe_name, download=True)
    except ProviderError as error:
        return provider_error_response(error)
    image_folder = SAVE_FOLDER if storage_scope_name() == "local-user" else os.path.join(SAVE_FOLDER, storage_scope_name())
    path = os.path.join(image_folder, safe_name)
    if not os.path.exists(path):
        return jsonify({"error": "图片不存在"}), 404
    return send_file(path, mimetype="image/png", as_attachment=True, download_name=safe_name)


@app.route("/api/download-batch", methods=["POST"])
def download_batch():
    import zipfile

    data = request.get_json(silent=True) or {}
    try:
        set_optional_storage_scope()
    except SupabaseError as error:
        return provider_error_response(as_provider_error(error))
    filenames = data.get("filenames", [])
    if not isinstance(filenames, list) or not filenames:
        return jsonify({"error": "请选择要下载的图片"}), 400
    buffer = io.BytesIO()
    try:
        backend = _storage_backend()
    except ProviderError as error:
        return provider_error_response(error)
    if backend == "supabase":
        # Current clients zip direct Storage downloads in the browser. Old tabs
        # must refresh, rather than silently proxying another large archive.
        return provider_error_response(
            ProviderError(
                "DIRECT_DOWNLOAD_REQUIRED",
                "请刷新页面后重新导出",
                409,
                "批量导出已改为浏览器直接读取云端图片并打包，不再经过网站后端。",
                ["刷新页面", "重新选择图片", "再次导出"],
            )
        )
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for filename in filenames[:100]:
            safe_name = os.path.basename(str(filename))
            image_folder = SAVE_FOLDER if storage_scope_name() == "local-user" else os.path.join(SAVE_FOLDER, storage_scope_name())
            path = os.path.join(image_folder, safe_name)
            if os.path.exists(path):
                archive.write(path, safe_name)
    buffer.seek(0)
    return send_file(
        buffer,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"ai_images_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip",
    )


@app.route("/api/health", methods=["GET"])
def health():
    payment_channels = configured_payment_channels()
    return jsonify(
        {
            "status": "ok",
            "server_provider_configured": bool(DEFAULT_API_KEY and DEFAULT_ENDPOINT and DEFAULT_MODEL),
            "platform_provider_configured": platform_provider_configured() and is_supabase_configured(),
            "storage_backend": storage_backend_name(),
            "history_enabled": False,
            "payment_enabled": bool(payment_channels),
            "payment_channels": payment_channels,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )


if os.path.exists(FRONTEND_BUILD):
    app.static_folder = FRONTEND_BUILD
    app.static_url_path = ""

    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_frontend(path):
        if path and os.path.exists(os.path.join(FRONTEND_BUILD, path)):
            return send_from_directory(FRONTEND_BUILD, path)
        return send_from_directory(FRONTEND_BUILD, "index.html")


if __name__ == "__main__":
    print("=" * 58)
    print("  PosterFlow AI - OpenAI-compatible image API server")
    print("  Configure a provider in the browser or with environment variables")
    print("=" * 58)
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    host = os.getenv("HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.getenv("PORT", "5000"))
    app.run(host=host, port=port, debug=debug, use_reloader=False)
