"""Deliver validated references without consuming APIMart's upload quota.

Inline-capable models receive Data URIs. URL-only Grok receives an independent
private Storage copy, so browser/source cleanup cannot break an async task.
The dedicated retention migration removes abandoned copies after twelve hours.
"""
import base64
import hashlib
import logging
import re
import time
import uuid
from urllib.parse import parse_qs, urlsplit

try:
    from backend.apimart_image_provider import ImageTaskError
except ModuleNotFoundError:
    from apimart_image_provider import ImageTaskError

INLINE_MODELS = frozenset({"gemini-nano-banana-2.1", "seedream-5-5", "seedream-5-0-pro",
                           "seedream-5-0-lite", "seedream-5-0-flash"})
LINK_MODELS = frozenset({"grok-imagine-image-2.0", "grok-imagine-2.0-ext"})
LINK_SECONDS = 3600
RETENTION_SECONDS = 12 * 3600
COPY_PATH = re.compile(r"^posterflow/image-reference-[a-f0-9]{64}/references/[0-9]{10}-[a-f0-9]{32}\.(png|jpg|webp|gif)$")


def cleanup_copies(server, paths):
    """Only server-created delivery objects; never delete arbitrary client paths."""
    safe = [path for path in paths if isinstance(path, str) and COPY_PATH.fullmatch(path)]
    if not safe:
        return
    try:
        server._supabase_delete(safe)
    except Exception:
        # The cron retention fallback will retry. Never log signed URLs/errors.
        logging.getLogger(__name__).warning("image_reference_copy_cleanup_pending count=%s", len(safe))


def _signed_url(server, path):
    url = server._supabase_create_signed_url(path, expires_in=LINK_SECONDS)
    try:
        actual, expected = urlsplit(url), urlsplit(server.SUPABASE_STORAGE_URL)
        if (not isinstance(url, str) or len(url) > 16384
                or any(char.isspace() or ord(char) < 32 for char in url)
                or actual.scheme != "https" or expected.scheme != "https"
                or not actual.netloc or actual.netloc != expected.netloc
                or actual.username or actual.password or actual.fragment
                or actual.path != "/storage/v1/object/sign/" + server._supabase_object_path(path)
                or not parse_qs(actual.query).get("token", [""])[0]):
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise ImageTaskError("REFERENCE_LINK_UNAVAILABLE", "参考图临时链接暂时不可用，本次尚未提交生图。", 503) from None
    return url


def prepare_references(server, model, references, owner):
    """Return ordered inputs and private copy paths; no paid provider requests."""
    if model in INLINE_MODELS:
        return [server.reference_image_data_url(encoded) for encoded in references], []
    if model not in LINK_MODELS:
        raise ImageTaskError("REFERENCE_MODEL_LIMIT", "当前模型未配置此参考图传输方式。")
    if not references:
        return [], []
    if not server.SUPABASE_STORAGE_ENABLED:
        raise ImageTaskError("REFERENCE_LINK_UNAVAILABLE", "参考图临时链接服务尚未配置，本次尚未提交生图。", 503)
    paths, urls = [], []
    scope = hashlib.sha256(owner.encode()).hexdigest()
    try:
        for index, encoded in enumerate(references, 1):
            # Re-validate bytes; no arbitrary incoming URLs or filesystem paths.
            raw = server.validate_reference_image_bytes(base64.b64decode(encoded, validate=True))
            _, _, mime = server.reference_image_upload(encoded, index)
            extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}[mime]
            path = f"posterflow/image-reference-{scope}/references/{int(time.time())}-{uuid.uuid4().hex}.{extension}"
            # Track before PUT: an interrupted response may still have stored it.
            paths.append(path)
            server._supabase_put(path, raw, mime)
            urls.append(_signed_url(server, path))
        return urls, paths
    except Exception:
        cleanup_copies(server, paths)
        raise ImageTaskError("REFERENCE_LINK_UNAVAILABLE", "参考图临时链接准备失败，本次尚未提交生图，请稍后重试。", 503) from None
