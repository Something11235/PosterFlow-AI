"""Authenticated, bounded fallback for clients unable to reach Storage directly."""
import re
import time

import requests
from flask import g, make_response, request

CHUNK_BYTES = 1024 * 1024
MAX_BYTES = 25 * CHUNK_BYTES


def image_content(server, filename):
    error = server.ProviderError
    upstream = None
    try:
        user = server.require_authenticated_user()
        g.posterflow_storage_scope = "user-" + user.id
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,180}\.(?:png|gif)", filename) or ".." in filename:
            raise error("IMAGE_NAME_INVALID", "图片文件名无效", 400)
        raw_offset = request.args.get("offset", "0")
        if not re.fullmatch(r"[0-9]{1,8}", raw_offset):
            raise error("IMAGE_RANGE_INVALID", "图片读取范围无效", 400)
        offset = int(raw_offset)
        if offset % CHUNK_BYTES or offset >= MAX_BYTES:
            raise error("IMAGE_RANGE_INVALID", "图片读取范围无效", 400)
        version = request.headers.get("X-Image-Version", "")
        if (offset and not version) or (version and not re.fullmatch(r'"[A-Za-z0-9._-]{1,128}"', version)):
            raise error("IMAGE_VERSION_INVALID", "请重新加载完整原图", 400)
        server.enforce_rate_limit("image-relay", user.id, 180, 60)
        if server._storage_backend() != "supabase":
            raise error("IMAGE_RELAY_UNAVAILABLE", "请使用原图下载或备用下载", 503)
        started = time.monotonic()
        upstream = server._supabase_storage_request(
            "GET", "/object/authenticated/" + server._supabase_object_path(server._image_blob_path(filename)),
            headers={"Accept": "application/octet-stream", "Range": f"bytes={offset}-{offset + CHUNK_BYTES - 1}",
                     **({"If-Match": version} if version else {})},
            _allow_missing=True, stream=True, timeout=(4, 12), allow_redirects=False,
        )
        # Never accept an ignored range and accidentally proxy an unbounded file.
        content_range = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", upstream.headers.get("Content-Range", ""))
        tag = upstream.headers.get("ETag", "")
        if upstream.status_code != 206 or not content_range or not re.fullmatch(r'"[A-Za-z0-9._-]{1,128}"', tag):
            raise error("IMAGE_RELAY_INVALID", "网站备用通道暂不可用，请使用备用下载", 502)
        start, end, total = map(int, content_range.groups())
        if not 0 < total <= MAX_BYTES or start != offset or end != min(offset + CHUNK_BYTES, total) - 1 or (version and tag != version):
            raise error("IMAGE_RELAY_INVALID", "原图读取范围不一致，请重新加载", 502)
        content = bytearray()
        for chunk in upstream.iter_content(64 * 1024):
            if len(content) + len(chunk) > end - start + 1 or time.monotonic() - started > 30:
                raise error("IMAGE_RELAY_INVALID", "原图读取未完成，请稍后重试", 502)
            content.extend(chunk)
        if len(content) != end - start + 1:
            raise error("IMAGE_RELAY_INVALID", "原图读取不完整，请重试", 502)
        if offset == 0 and not (content[:6] in (b"GIF87a", b"GIF89a") if filename.endswith(".gif") else content.startswith(b"\x89PNG\r\n\x1a\n")):
            raise error("IMAGE_RELAY_INVALID", "原图格式异常，请重试", 502)
        response = make_response(bytes(content))
        response.headers.update({"Content-Type": "application/octet-stream", "Cache-Control": "private, no-store",
                                 "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
                                 "X-Image-Size": str(total), "X-Image-Offset": str(offset), "ETag": tag})
        return response
    except (server.ProviderError, server.SupabaseError) as reason:
        return server.provider_error_response(server.as_provider_error(reason))
    except requests.RequestException:
        return server.provider_error_response(error("IMAGE_RELAY_UNAVAILABLE", "网站备用通道读取失败，请稍后重试", 502))
    finally:
        if upstream is not None:
            upstream.close()
