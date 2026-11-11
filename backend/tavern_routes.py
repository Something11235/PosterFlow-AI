"""Role chat with isolated own-key transport and durable platform billing."""
import hashlib
import http.client
import ipaddress
import json
import math
import re
import socket
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from urllib.parse import quote, unquote, urlsplit

from flask import Blueprint, Response, jsonify, request

try:
    from backend.music_provider import safe_media_url
    from backend.tavern_pricing import get_tavern_pricing
    from backend.tavern_platform import (TavernPlatformError, platform_available, platform_chat,
                                         register_platform_routes)
    from backend.supabase_service import SupabaseError
except ModuleNotFoundError:
    from music_provider import safe_media_url
    from tavern_pricing import get_tavern_pricing
    from tavern_platform import (TavernPlatformError, platform_available, platform_chat,
                                 register_platform_routes)
    from supabase_service import SupabaseError


DEFAULT_MODEL = "deepseek-v4.1-flash"
DEFAULT_ENDPOINT = "https://api.buytoken.work/v1/chat/completions"
REQUEST_SECONDS = 120
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_CONTENT_CHARS = 65536
MAX_SAFE_TOKENS = 2 ** 53 - 1
IMPORT_JSON_BYTES = 1024 * 1024
IMPORT_PNG_BYTES = 8 * 1024 * 1024
IMPORT_SECONDS = 45
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
CHUB_HOSTS = frozenset(("chub.ai", "www.chub.ai", "characterhub.org", "www.characterhub.org"))
_DNS_WORKERS = ThreadPoolExecutor(max_workers=4, thread_name_prefix="tavern-dns")
_DNS_SLOTS = threading.BoundedSemaphore(4)


class TavernError(Exception):
    def __init__(self, code, message, status=400, uncertain=False):
        super().__init__(message)
        self.code, self.message, self.status, self.uncertain = code, message, status, uncertain


def normalize_usage(raw):
    """Keep only actual, consistent provider counts. Never estimate from text."""
    result = dict.fromkeys(("input_tokens", "output_tokens", "total_tokens", "cache_read_tokens",
                            "cache_miss_tokens", "reasoning_tokens"))
    if raw is None:
        return {"status": "missing", **result}
    if not isinstance(raw, dict):
        return {"status": "invalid", **result}
    invalid = False

    def count(source, name):
        nonlocal invalid
        value = source.get(name)
        if value is None:
            return None
        # JSON numbers may spell integral values as 12.0; bool is never a count.
        if type(value) in (int, float) and 0 <= value <= MAX_SAFE_TOKENS and value == int(value):
            return int(value)
        invalid = True
        return None

    def details(name):
        nonlocal invalid
        value = raw.get(name)
        if value is None:
            return {}
        if isinstance(value, dict):
            return value
        invalid = True
        return {}

    result["input_tokens"] = count(raw, "prompt_tokens")
    result["output_tokens"] = count(raw, "completion_tokens")
    result["total_tokens"] = count(raw, "total_tokens")
    deepseek_cache = count(raw, "prompt_cache_hit_tokens")
    openai_cache = count(details("prompt_tokens_details"), "cached_tokens")
    if deepseek_cache is not None and openai_cache is not None and deepseek_cache != openai_cache:
        invalid = True
    else:
        result["cache_read_tokens"] = deepseek_cache if deepseek_cache is not None else openai_cache
    result["cache_miss_tokens"] = count(raw, "prompt_cache_miss_tokens")
    result["reasoning_tokens"] = count(details("completion_tokens_details"), "reasoning_tokens")

    incoming, outgoing, total = result["input_tokens"], result["output_tokens"], result["total_tokens"]
    if incoming is not None and outgoing is not None:
        combined = incoming + outgoing
        if combined > MAX_SAFE_TOKENS:
            result["total_tokens"] = None
            invalid = True
        elif raw.get("total_tokens") is None:
            result["total_tokens"] = combined
        elif total is not None and total != combined:
            result["total_tokens"] = None
            invalid = True
    elif total is not None and any(value is not None and value > total for value in (incoming, outgoing)):
        result["total_tokens"] = None
        invalid = True

    if incoming is not None:
        for field in ("cache_read_tokens", "cache_miss_tokens"):
            if result[field] is not None and result[field] > incoming:
                result[field] = None
                invalid = True
        cached, missed = result["cache_read_tokens"], result["cache_miss_tokens"]
        if cached is not None and missed is not None and cached + missed != incoming:
            result["cache_read_tokens"] = result["cache_miss_tokens"] = None
            invalid = True
    if outgoing is not None and result["reasoning_tokens"] is not None and result["reasoning_tokens"] > outgoing:
        result["reasoning_tokens"] = None
        invalid = True

    known = any(value is not None for value in result.values())
    complete = all(result[name] is not None for name in ("input_tokens", "output_tokens", "total_tokens"))
    status = ("confirmed" if complete and not invalid else "partial") if known else ("invalid" if invalid else "missing")
    return {"status": status, **result}


def build_chat_request(data):
    if not isinstance(data, dict):
        raise TavernError("TAVERN_INVALID_INPUT", "对话请求格式无效。")
    if set(data) - {"billing_mode", "model", "messages", "temperature", "max_tokens"}:
        raise TavernError("TAVERN_INVALID_INPUT", "对话请求包含不支持的参数。")
    model = data.get("model", DEFAULT_MODEL)
    if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}", model):
        raise TavernError("TAVERN_INVALID_MODEL", "请填写有效的对话模型标识。")
    messages = data.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= 64:
        raise TavernError("TAVERN_CONTEXT_LIMIT", "每次对话须包含 1–64 条消息，请缩短历史上下文。")
    clean, total = [], 0
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or set(message) != {"role", "content"}:
            raise TavernError("TAVERN_INVALID_INPUT", "消息须仅包含角色和文字内容。")
        role, content = message["role"], message["content"]
        if role not in ("system", "user", "assistant") or role == "system" and index != 0:
            raise TavernError("TAVERN_INVALID_INPUT", "消息角色或排列无效。")
        if not isinstance(content, str) or not content.strip() or len(content) > MAX_CONTENT_CHARS:
            raise TavernError("TAVERN_CONTEXT_LIMIT", "消息不能为空，单条最多 65536 个字符。")
        try:
            content.encode("utf-8")
        except UnicodeError:
            raise TavernError("TAVERN_INVALID_INPUT", "消息包含无效的文字编码。") from None
        total += len(content)
        clean.append({"role": role, "content": content})
    if total > 131072 or clean[-1]["role"] != "user":
        raise TavernError("TAVERN_CONTEXT_LIMIT", "上下文过长或缺少本轮用户消息，请调整后发送。")
    temperature = data.get("temperature", 0.8)
    if type(temperature) not in (int, float) or not 0 <= temperature <= 2 or not math.isfinite(temperature):
        raise TavernError("TAVERN_INVALID_INPUT", "温度须在 0–2 之间。")
    maximum = data.get("max_tokens", 1024)
    if type(maximum) is not int or not 64 <= maximum <= 4096:
        raise TavernError("TAVERN_INVALID_INPUT", "回复上限须为 64–4096 的整数。")
    return {"model": model, "messages": clean, "temperature": temperature,
            "max_tokens": maximum, "stream": False}


def validate_endpoint(value):
    if (not isinstance(value, str) or not value or len(value) > 2048
            or any(char.isspace() or ord(char) < 32 for char in value)
            or "\\" in value or not safe_media_url(value)):
        raise TavernError("TAVERN_ENDPOINT_INVALID", "请填写公网 HTTPS 对话接口完整地址。")
    parsed = urlsplit(value)
    if parsed.query or parsed.fragment or not parsed.path.endswith("/chat/completions"):
        raise TavernError("TAVERN_ENDPOINT_INVALID", "接口须以 /chat/completions 结尾，不能含查询参数或凭据。")
    return parsed


class PinnedConnection(http.client.HTTPSConnection):
    """Connect to the validated IP, while TLS verifies the original hostname."""
    def __init__(self, host, address, timeout):
        super().__init__(host, port=443, timeout=timeout, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        raw = socket.create_connection((self.address, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


def resolve_public_host(host, timeout=8):
    # Bound resolver waiting as well as its concurrency. A stalled system DNS
    # call may finish later, but it never has credentials or submits a request.
    if not _DNS_SLOTS.acquire(blocking=False):
        raise TavernError("TAVERN_DNS_BUSY", "域名解析暂时繁忙，本次尚未提交，请稍后再试。", 503)
    try:
        future = _DNS_WORKERS.submit(socket.getaddrinfo, host, 443, type=socket.SOCK_STREAM)
    except Exception:
        _DNS_SLOTS.release()
        raise TavernError("TAVERN_DNS_UNAVAILABLE", "暂时无法解析对话服务域名，本次尚未提交。", 502) from None
    future.add_done_callback(lambda _future: _DNS_SLOTS.release())
    try:
        addresses = sorted({item[4][0] for item in future.result(timeout=timeout)})
        if not addresses or any(not ipaddress.ip_address(address).is_global
                                or ipaddress.ip_address(address).is_multicast for address in addresses):
            raise TavernError("TAVERN_ENDPOINT_PRIVATE", "对话接口须指向可公开访问的服务器。")
        return addresses
    except (FutureTimeout, OSError, ValueError):
        future.cancel()
        raise TavernError("TAVERN_DNS_UNAVAILABLE", "暂时无法解析对话服务域名，本次尚未提交。", 502) from None


def submit_chat(endpoint, key, body):
    parsed = validate_endpoint(endpoint)
    deadline = time.monotonic() + REQUEST_SECONDS
    try:
        host = parsed.hostname.encode("idna").decode("ascii")
        addresses = resolve_public_host(host)
    except (socket.gaierror, UnicodeError, ValueError):
        raise TavernError("TAVERN_DNS_UNAVAILABLE", "暂时无法解析对话服务域名，本次尚未提交。", 502) from None

    def remaining():
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            raise TimeoutError()
        return seconds

    connection, watchdog, started = None, None, False
    try:
        connection = PinnedConnection(host, addresses[0], min(8, remaining()))
        connection.connect()
        transport = connection.sock
        # read timeout alone can be defeated by slow HTTP headers/chunk framing.
        # Shutdown interrupts the underlying socket even while http.client is
        # inside a buffered read; this timer does no business work after return.
        def close_at_deadline():
            try:
                transport.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        watchdog = threading.Timer(remaining(), close_at_deadline)
        watchdog.daemon = True
        watchdog.start()
        transport.settimeout(remaining())
        started = True
        connection.request("POST", parsed.path, body=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                           headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                                    "Accept": "application/json", "Accept-Encoding": "identity"})
        transport.settimeout(remaining())
        response = connection.getresponse()
        # This client never follows redirects or retries a paid request.
        if 300 <= response.status < 400:
            raise TavernError("TAVERN_REDIRECT_BLOCKED", "对话服务返回了跳转，已停止本次请求；请核对服务记录后再操作。", 502, True)
        if response.status >= 400:
            rejected = response.status in (400, 401, 403, 404, 422, 429)
            message = "对话服务未接受请求，请检查 Key、模型权限和参数。" if rejected else "对话服务结果暂未确认，请核对服务记录，不要重复发送。"
            raise TavernError("TAVERN_REQUEST_REJECTED" if rejected else "TAVERN_RESULT_UNKNOWN", message, 502, not rejected)
        chunks, length = [], 0
        while not response.isclosed():
            transport.settimeout(remaining())
            chunk = response.read1(min(65536, MAX_RESPONSE_BYTES + 1 - length))
            if not chunk:
                break
            length += len(chunk)
            if length > MAX_RESPONSE_BYTES:
                raise TavernError("TAVERN_RESPONSE_INVALID", "对话响应超过读取上限，请核对服务记录，不要重复发送。", 502, True)
            chunks.append(chunk)
        remaining()
        payload = json.loads(b"".join(chunks))
        choices = payload.get("choices") if isinstance(payload, dict) else None
        message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip() or len(content) > MAX_CONTENT_CHARS:
            raise TavernError("TAVERN_RESPONSE_INVALID", "对话服务未返回有效文字，请核对服务记录，不要重复发送。", 502, True)
        return {"content": content, "usage": normalize_usage(payload.get("usage"))}
    except TavernError:
        raise
    except (OSError, http.client.HTTPException, ValueError, TypeError, RecursionError):
        raise TavernError("TAVERN_RESULT_UNKNOWN" if started else "TAVERN_CONNECTION_FAILED",
                          "连接中断或响应无效，结果暂未确认；请核对服务记录，不要重复发送。" if started else "暂时无法连接对话服务，本次尚未提交。",
                          502, started) from None
    finally:
        if watchdog:
            watchdog.cancel()
        if connection:
            connection.close()


def validate_import_url(value):
    if (not isinstance(value, str) or not value or len(value) > 4096
            or any(char.isspace() or ord(char) < 32 for char in value)
            or "\\" in value or not safe_media_url(value)):
        raise TavernError("TAVERN_IMPORT_URL_INVALID", "请填写公开文件的 HTTPS 下载链接。")
    parsed = urlsplit(value)
    if parsed.username is not None or parsed.password is not None or parsed.fragment:
        raise TavernError("TAVERN_IMPORT_URL_INVALID", "下载链接不能包含登录凭据或页面片段。")
    if parsed.path.rstrip("/").lower() in ("", "/search", "/explore", "/browse", "/characters", "/lorebooks"):
        raise TavernError("TAVERN_IMPORT_PAGE_URL", "主页或列表不能导入，请使用下载链接或下载文件导入。")
    return parsed


def import_json(content):
    if len(content) > IMPORT_JSON_BYTES:
        raise TavernError("TAVERN_IMPORT_TOO_LARGE", "JSON 文件最多 1 MB，请下载较小的文件后导入。", 413)
    try:
        value = json.loads(content.decode("utf-8-sig"))
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise TavernError("TAVERN_IMPORT_FORMAT", "链接未返回有效的 JSON 资料，请使用下载链接或下载文件导入。") from None


def fetch_import_bytes(url, maximum, deadline):
    """A bounded public GET. Incoming cookies/auth/provider keys never enter it."""
    parsed = validate_import_url(url)
    connection = watchdog = None
    def remaining():
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            raise TimeoutError()
        return seconds
    try:
        host = parsed.hostname.encode("idna").decode("ascii")
        addresses = resolve_public_host(host, timeout=min(8, remaining()))
        # TCP connect and TLS handshake each use the socket timeout.
        connection = PinnedConnection(host, addresses[0], min(8, remaining() / 2))
        connection.connect()
        transport = connection.sock
        def close_at_deadline():
            try:
                transport.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        watchdog = threading.Timer(remaining(), close_at_deadline)
        watchdog.daemon = True
        watchdog.start()
        transport.settimeout(remaining())
        target = quote(parsed.path, safe="/%:@!$&'()*+,;=-._~")
        if parsed.query:
            target += "?" + quote(parsed.query, safe="=&%/:?@!$'()*+,;~-._")
        connection.request("GET", target, headers={"Accept": "application/json, image/png;q=0.9",
                                                   "Accept-Encoding": "identity", "User-Agent": "PosterFlow-Resource-Import/1.0"})
        transport.settimeout(remaining())
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise TavernError("TAVERN_IMPORT_REDIRECT", "链接返回了跳转，请复制最终下载链接或下载文件导入。")
        if response.status != 200:
            raise TavernError("TAVERN_IMPORT_UNAVAILABLE", "未能取得公开文件；请确认链接有效且无需登录，或下载文件导入。", 502)
        declared = response.getheader("Content-Length", "")
        if declared and (not declared.isdigit() or int(declared) > maximum):
            raise TavernError("TAVERN_IMPORT_TOO_LARGE", "文件过大：PNG 最多 8 MB，JSON 最多 1 MB。", 413)
        declared_size = int(declared) if declared else 0
        chunks, length, prefix, actual_limit = [], 0, b"", maximum
        while not response.isclosed():
            transport.settimeout(remaining())
            chunk = response.read1(min(65536, actual_limit + 1 - length))
            if not chunk:
                break
            length += len(chunk)
            prefix = (prefix + chunk)[:512]
            stripped = prefix.removeprefix(b"\xef\xbb\xbf").lstrip()
            if stripped.startswith(b"<"):
                raise TavernError("TAVERN_IMPORT_HTML", "该链接返回的是网页，请使用下载链接或下载文件导入。")
            if len(prefix) >= 8 and not prefix.startswith(PNG_SIGNATURE):
                actual_limit = min(actual_limit, IMPORT_JSON_BYTES)
            if length > actual_limit or declared_size > actual_limit:
                raise TavernError("TAVERN_IMPORT_TOO_LARGE", "文件过大：PNG 最多 8 MB，JSON 最多 1 MB。", 413)
            chunks.append(chunk)
        remaining()
        content = b"".join(chunks)
        if not content or declared_size and len(content) != declared_size:
            raise TavernError("TAVERN_IMPORT_INCOMPLETE", "文件下载不完整，请重新取得下载链接或下载文件导入。", 502)
        return content
    except TavernError as error:
        if error.code.startswith("TAVERN_IMPORT_"):
            raise
        raise TavernError("TAVERN_IMPORT_SOURCE_UNAVAILABLE", "无法访问该公开文件，请检查链接或下载文件导入。", 502) from None
    except (OSError, http.client.HTTPException, ValueError, TypeError, RecursionError):
        raise TavernError("TAVERN_IMPORT_DOWNLOAD_FAILED", "文件下载失败或超时，请检查链接或下载文件导入。", 502) from None
    finally:
        if watchdog:
            watchdog.cancel()
        if connection:
            connection.close()


def chub_detail(parsed, kind):
    """Recognize exact detail paths, never a host substring or a user profile."""
    if parsed.hostname.lower() not in CHUB_HOSTS:
        return None
    segments = parsed.path.strip("/").split("/")
    expected = "characters" if kind == "character" else "lorebooks"
    if len(segments) != 3 or segments[0] != expected:
        raise TavernError("TAVERN_IMPORT_PAGE_URL", "请使用对应类型的 Chub 详情页或文件下载链接，主页和列表不能导入。")
    names = [unquote(part) for part in segments[1:]]
    if any(not name or len(name) > 200 or name in (".", "..") or any(char in name for char in "/\\?#")
           or any(ord(char) < 32 for char in name) for name in names):
        raise TavernError("TAVERN_IMPORT_URL_INVALID", "Chub 详情页地址格式无效，请复制完整的角色或世界书详情链接。")
    return tuple(quote(name, safe="") for name in names)


def download_tavern_resource(url, kind):
    if kind not in ("character", "lorebook"):
        raise TavernError("TAVERN_IMPORT_KIND", "请选择角色卡或世界书。")
    parsed = validate_import_url(url)
    detail = chub_detail(parsed, kind)
    deadline = time.monotonic() + IMPORT_SECONDS
    if detail:
        author, name = detail
        # Interoperability paths checked against SillyTavern's content-manager:
        # metadata GETs and the public lorebook repository file GET, no login.
        category = "characters" if kind == "character" else "lorebooks"
        metadata_url = f"https://api.chub.ai/api/{category}/{author}/{name}" + ("?full=true" if kind == "character" else "")
        metadata = import_json(fetch_import_bytes(metadata_url, IMPORT_JSON_BYTES, deadline))
        node = metadata.get("node")
        if not isinstance(node, dict):
            raise TavernError("TAVERN_IMPORT_CHUB_FORMAT", "Chub 未返回可导入的公开资料，请下载 JSON/PNG 文件后导入。")
        if kind == "character":
            definition = node.get("definition")
            if not isinstance(definition, dict) or not isinstance(definition.get("name"), str) or not definition["name"].strip():
                raise TavernError("TAVERN_IMPORT_CHUB_FORMAT", "Chub 角色资料格式暂不支持，请下载角色卡文件后导入。")
            fields = {"name": "name", "description": "personality", "personality": "tavern_personality",
                      "scenario": "scenario", "first_mes": "first_message", "mes_example": "example_dialogs"}
            data = {target: definition.get(source, "") for target, source in fields.items()}
            if isinstance(node.get("topics"), list):
                data["tags"] = node["topics"]
            if isinstance(definition.get("embedded_lorebook"), dict):
                data["character_book"] = definition["embedded_lorebook"]
            # Avatars and extensions are deliberately not fetched or executed.
            content = json.dumps({"spec": "chara_card_v2", "spec_version": "2.0", "data": data}, ensure_ascii=False).encode("utf-8")
        else:
            project_id = node.get("id")
            if isinstance(project_id, bool) or not re.fullmatch(r"[1-9][0-9]{0,17}", str(project_id)):
                raise TavernError("TAVERN_IMPORT_CHUB_FORMAT", "Chub 世界书编号无效，请下载世界书文件后导入。")
            target = f"https://api.chub.ai/api/v4/projects/{project_id}/repository/files/raw%252Fsillytavern_raw.json/raw"
            content = fetch_import_bytes(target, IMPORT_JSON_BYTES, deadline)
    else:
        content = fetch_import_bytes(url, IMPORT_PNG_BYTES, deadline)
    if content.startswith(PNG_SIGNATURE):
        if len(content) > IMPORT_PNG_BYTES:
            raise TavernError("TAVERN_IMPORT_TOO_LARGE", "PNG 角色卡最多 8 MB。", 413)
        return content, "image/png", "character.png" if kind == "character" else "lorebook.png"
    import_json(content)
    return content, "application/json", "character.json" if kind == "character" else "lorebook.json"


def create_tavern_blueprint(server):
    bp = Blueprint("tavern", __name__, url_prefix="/api/tavern")

    @bp.after_request
    def private_response(response):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @bp.errorhandler(TavernError)
    def error_response(error):
        return jsonify(success=False, error=error.message, code=error.code,
                       submission_unknown=error.uncertain, charged_credits=0), error.status

    @bp.errorhandler(TavernPlatformError)
    def platform_error_response(error):
        payload = {"success": False, "error": error.message, "code": error.code,
                   "submission_unknown": error.uncertain,
                   "charged_credits": error.billing.get("charged_credits") if error.billing else 0}
        if error.billing:
            payload.update(billing=error.billing, request_id=error.billing["request_id"], billing_mode="platform")
        return jsonify(payload), error.status

    @bp.errorhandler(SupabaseError)
    def platform_database_error(_error):
        return jsonify(success=False, error="对话账务服务暂不可用，请保留请求编号后查询。",
                       code="TAVERN_DATABASE_UNAVAILABLE", submission_unknown=True, charged_credits=None), 503

    @bp.get("/config")
    def config():
        enabled = platform_available(validate_endpoint)
        return jsonify(platform_configured=enabled, own_key_supported=True, model=DEFAULT_MODEL,
                       streaming=False, pricing=get_tavern_pricing(enabled))

    @bp.post("/import")
    def import_resource():
        origin = request.headers.get("Origin")
        if (origin and origin.rstrip("/") not in {request.host_url.rstrip("/"), *server.ALLOWED_ORIGINS}
                or request.headers.get("Sec-Fetch-Site") == "cross-site"):
            raise TavernError("TAVERN_ORIGIN_FORBIDDEN", "请求来源不受支持。", 403)
        if request.content_length and request.content_length > 8192:
            raise TavernError("TAVERN_IMPORT_INVALID", "导入请求过大，请只填写一个下载链接。", 413)
        try:
            data = request.get_json(silent=True)
        except (ValueError, RecursionError):
            data = None
        if not isinstance(data, dict) or set(data) != {"url", "kind"}:
            raise TavernError("TAVERN_IMPORT_INVALID", "请填写资源链接并选择导入类型。")
        try:
            server.enforce_rate_limit("tavern-import-ip", request.remote_addr or "unknown", 12, 60)
        except server.ProviderError:
            raise TavernError("TAVERN_IMPORT_RATE_LIMITED", "导入过于频繁，请稍后再试。", 429) from None
        content, mime, filename = download_tavern_resource(data["url"], data["kind"])
        return Response(content, mimetype=mime, headers={"Content-Disposition": f'attachment; filename="{filename}"'})

    @bp.post("/chat")
    def chat():
        origin = request.headers.get("Origin")
        if (origin and origin.rstrip("/") not in {request.host_url.rstrip("/"), *server.ALLOWED_ORIGINS}
                or request.headers.get("Sec-Fetch-Site") == "cross-site"):
            raise TavernError("TAVERN_ORIGIN_FORBIDDEN", "请求来源不受支持。", 403)
        if request.content_length and request.content_length > 1024 * 1024:
            raise TavernError("TAVERN_CONTEXT_LIMIT", "对话请求过大，请缩短上下文后发送。", 413)
        try:
            data = request.get_json(silent=True)
        except (ValueError, RecursionError):
            raise TavernError("TAVERN_INVALID_INPUT", "对话请求格式无效。") from None
        if not isinstance(data, dict):
            raise TavernError("TAVERN_INVALID_INPUT", "对话请求格式无效。")
        mode = data.get("billing_mode", "platform")
        if mode == "platform":
            return jsonify(platform_chat(data, server, submit_chat, build_chat_request, validate_endpoint))
        if mode != "own_key":
            raise TavernError("TAVERN_INVALID_INPUT", "请选择平台积分或自带 API Key 模式。")
        body = build_chat_request(data)
        key = request.headers.get("X-Tavern-Api-Key", "").strip()
        if not key or len(key) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in key):
            raise TavernError("TAVERN_KEY_REQUIRED", "请在对话服务设置中填写有效的 API Key。")
        endpoint = request.headers.get("X-Tavern-Endpoint", "").strip() or DEFAULT_ENDPOINT
        validate_endpoint(endpoint)
        try:
            server.enforce_rate_limit("tavern-chat-ip", request.remote_addr or "unknown", 20, 60)
            server.enforce_rate_limit("tavern-chat-key", hashlib.sha256(key.encode()).hexdigest(), 12, 60)
        except server.ProviderError:
            raise TavernError("TAVERN_RATE_LIMITED", "发送过于频繁，请稍后再试。", 429) from None
        result = submit_chat(endpoint, key, body)
        return jsonify(success=True, content=result["content"], usage=result["usage"],
                       streaming=False, billing_mode="own_key", charged_credits=0)

    register_platform_routes(bp, server)
    return bp
