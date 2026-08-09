import base64
import io
import ipaddress
import json
import os
import socket
import uuid
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import urlsplit

import requests
from flask import Flask, jsonify, request, send_file, send_from_directory
from flask_cors import CORS


APP_DIR = os.path.dirname(__file__)
DATA_DIR = os.path.abspath(os.getenv("DATA_DIR", APP_DIR))
SAVE_FOLDER = os.path.join(DATA_DIR, "outputs")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")
FRONTEND_BUILD = os.path.join(APP_DIR, "..", "frontend", "dist")

OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/images"
OPENROUTER_MODEL = "openai/gpt-image-2"
DEFAULT_API_KEY = os.getenv("IMAGE_API_KEY", "").strip() or os.getenv("OPENROUTER_API_KEY", "").strip()
DEFAULT_ENDPOINT = os.getenv("IMAGE_API_ENDPOINT", "").strip()
DEFAULT_MODEL = os.getenv("IMAGE_API_MODEL", "").strip()
DEFAULT_AUTH_TYPE = os.getenv("IMAGE_API_AUTH_TYPE", "bearer").strip().lower()

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

app = Flask(__name__, static_folder=None)
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
    ],
)
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


def resolve_provider_config(resolve_dns=True):
    request_key = request.headers.get("X-Provider-Api-Key", "").strip()
    endpoint = request.headers.get("X-Provider-Endpoint", "").strip() or DEFAULT_ENDPOINT
    model = request.headers.get("X-Provider-Model", "").strip() or DEFAULT_MODEL
    auth_type = request.headers.get("X-Provider-Auth-Type", "").strip().lower() or DEFAULT_AUTH_TYPE
    api_key = request_key or DEFAULT_API_KEY
    source = "browser" if request_key else "server"

    if not api_key:
        raise ProviderError(
            "PROVIDER_KEY_MISSING",
            "尚未配置图片服务 API Key",
            400,
            "请在页面的“服务配置”中填写自己的 Key，Key 不会写入服务器历史记录。",
            ["打开服务配置", "填写 API Key", "保存后重新生成"],
        )
    if not endpoint:
        raise ProviderError(
            "PROVIDER_ENDPOINT_MISSING",
            "尚未配置图片服务接口地址",
            400,
            "请选择服务商预设，或填写 OpenAI 兼容图片生成接口地址。",
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
    if auth_type not in {"bearer", "x-api-key"}:
        raise ProviderError(
            "PROVIDER_AUTH_INVALID",
            "鉴权方式不受支持",
            400,
            "当前支持 Bearer Token 和 x-api-key 两种 OpenAI 兼容鉴权方式。",
            ["选择正确鉴权方式", "查看中转站文档", "重新保存配置"],
        )

    validate_provider_endpoint(endpoint, resolve_dns=resolve_dns)
    return ProviderConfig(api_key, endpoint, model, auth_type, source)


def provider_headers(provider):
    headers = {"Content-Type": "application/json"}
    if provider.auth_type == "x-api-key":
        headers["x-api-key"] = provider.api_key
    else:
        headers["Authorization"] = f"Bearer {provider.api_key}"
    return headers


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
QUALITY_OPTIONS = {"auto", "medium", "high"}


def load_history():
    if not os.path.exists(HISTORY_FILE):
        return []
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as file:
            return json.load(file)
    except (OSError, json.JSONDecodeError):
        app.logger.exception("Failed to read generation history")
        return []


def save_history_entry(entry):
    history = load_history()
    history.insert(0, entry)
    with open(HISTORY_FILE, "w", encoding="utf-8") as file:
        json.dump(history[:500], file, ensure_ascii=False, indent=2)


def image_to_base64(file_path):
    try:
        with open(file_path, "rb") as file:
            return base64.b64encode(file.read()).decode("utf-8")
    except OSError:
        return None


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


def generate_images(provider, prompt, ref_b64=None, strength=0.65, size="landscape_16_9", quality="high", count=1):
    size_cfg = SIZE_OPTIONS.get(size, SIZE_OPTIONS["landscape_16_9"])
    payload = {
        "model": provider.model,
        "prompt": prompt,
        "n": count,
        "size": f"{size_cfg['width']}x{size_cfg['height']}",
        "quality": quality,
    }
    if ref_b64:
        payload["image_b64"] = ref_b64
        payload["strength"] = strength

    try:
        response = requests.post(
            provider.endpoint,
            headers=provider_headers(provider),
            json=payload,
            timeout=300,
        )
    except requests.exceptions.Timeout as exc:
        raise ProviderError(
            "PROVIDER_TIMEOUT",
            "图片生成服务响应超时",
            504,
            f"{provider.host} 在 300 秒内没有返回生成结果。",
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
            ["检查 API Key、余额与模型权限", "核对接口地址和模型标识", "降低批量数量后重试"],
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
        with open(os.path.join(SAVE_FOLDER, filename), "wb") as file:
            file.write(image_bytes)
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
    size = data.get("size", "landscape_16_9")
    quality = data.get("quality", "high")
    if size not in SIZE_OPTIONS or quality not in QUALITY_OPTIONS:
        raise ProviderError(
            "PARAMETER_INVALID",
            "生成参数无效",
            400,
            "尺寸或画质不在允许范围内。",
            ["重新选择尺寸", "重新选择画质", "再次生成"],
        )
    try:
        count = max(1, min(int(data.get("count", 1)), 4))
        strength = max(0.0, min(float(data.get("strength", 0.65)), 1.0))
    except (TypeError, ValueError) as exc:
        raise ProviderError(
            "PARAMETER_INVALID",
            "生成参数无效",
            400,
            "批量数量或参考强度格式不正确。",
            ["恢复默认参数", "重新选择参数", "再次生成"],
        ) from exc
    return prompt, size, quality, count, strength


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


@app.route("/api/provider/validate", methods=["POST"])
def validate_provider():
    try:
        provider = resolve_provider_config(resolve_dns=False)
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


@app.route("/api/generate", methods=["POST"])
def generate():
    data = request.get_json(silent=True) or {}
    try:
        provider = resolve_provider_config()
        prompt, size, quality, count, strength = parse_generation_request(data)
        style_name = data.get("style_name", "")
        if style_name in STYLE_TEMPLATES and STYLE_TEMPLATES[style_name] not in prompt:
            prompt = f"{prompt}。{STYLE_TEMPLATES[style_name]}"
        images = generate_images(provider, prompt, data.get("reference_b64"), strength, size, quality, count)
    except ProviderError as error:
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

    history_entry = {
        "id": uuid.uuid4().hex[:12],
        "prompt": prompt,
        "style": style_name,
        "size": size,
        "quality": quality,
        "strength": strength,
        "count": len(images),
        "timestamp": datetime.now().isoformat(),
        "images": [image["filename"] for image in images],
        "provider": provider.host,
        "model": provider.model,
    }
    save_history_entry(history_entry)
    return jsonify({"success": True, "history_id": history_entry["id"], "images": images, "prompt": prompt})


@app.route("/api/modify", methods=["POST"])
def modify():
    data = request.get_json(silent=True) or {}
    try:
        provider = resolve_provider_config()
        prompt, size, quality, _count, strength = parse_generation_request(data)
        previous_image = os.path.basename(str(data.get("previous_image", "")))
        previous_path = os.path.join(SAVE_FOLDER, previous_image)
        ref_b64 = image_to_base64(previous_path) if previous_image and os.path.exists(previous_path) else None
        if not ref_b64:
            raise ProviderError(
                "PREVIOUS_IMAGE_MISSING",
                "找不到上一轮图片",
                400,
                "局部重绘需要一张仍保存在服务端的上一轮图片。",
                ["重新生成一张图片", "确认没有清理输出目录", "再发起局部重绘"],
            )
        images = generate_images(provider, prompt, ref_b64, strength, size, quality, 1)
    except ProviderError as error:
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

    history_entry = {
        "id": uuid.uuid4().hex[:12],
        "prompt": prompt,
        "style": "迭代修改",
        "size": size,
        "quality": quality,
        "strength": strength,
        "count": 1,
        "timestamp": datetime.now().isoformat(),
        "images": [image["filename"] for image in images],
        "parent_id": data.get("parent_id"),
        "provider": provider.host,
        "model": provider.model,
    }
    save_history_entry(history_entry)
    return jsonify({"success": True, "history_id": history_entry["id"], "images": images, "prompt": prompt})


@app.route("/api/history", methods=["GET"])
def get_history():
    page = max(0, request.args.get("page", 0, type=int))
    page_size = max(1, min(request.args.get("page_size", 20, type=int), 100))
    search = request.args.get("search", "").strip().lower()
    history = load_history()
    if search:
        history = [entry for entry in history if search in entry.get("prompt", "").lower()]
    total = len(history)
    start = page * page_size
    end = start + page_size
    return jsonify(
        {
            "history": history[start:end],
            "total": total,
            "page": page,
            "page_size": page_size,
            "has_more": end < total,
        }
    )


@app.route("/api/history/<history_id>", methods=["DELETE"])
def delete_history(history_id):
    history = load_history()
    entry = next((item for item in history if item.get("id") == history_id), None)
    if not entry:
        return jsonify({"error": "记录不存在"}), 404
    for filename in entry.get("images", []):
        path = os.path.join(SAVE_FOLDER, os.path.basename(filename))
        if os.path.exists(path):
            os.remove(path)
    with open(HISTORY_FILE, "w", encoding="utf-8") as file:
        json.dump([item for item in history if item.get("id") != history_id], file, ensure_ascii=False, indent=2)
    return jsonify({"success": True})


@app.route("/api/images/<filename>", methods=["GET"])
def serve_image(filename):
    path = os.path.join(SAVE_FOLDER, os.path.basename(filename))
    if not os.path.exists(path):
        return jsonify({"error": "图片不存在"}), 404
    return send_file(path, mimetype="image/png")


@app.route("/api/download/<filename>", methods=["GET"])
def download_image(filename):
    safe_name = os.path.basename(filename)
    path = os.path.join(SAVE_FOLDER, safe_name)
    if not os.path.exists(path):
        return jsonify({"error": "图片不存在"}), 404
    return send_file(path, mimetype="image/png", as_attachment=True, download_name=safe_name)


@app.route("/api/download-batch", methods=["POST"])
def download_batch():
    import zipfile

    data = request.get_json(silent=True) or {}
    filenames = data.get("filenames", [])
    if not isinstance(filenames, list) or not filenames:
        return jsonify({"error": "请选择要下载的图片"}), 400
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for filename in filenames[:100]:
            safe_name = os.path.basename(str(filename))
            path = os.path.join(SAVE_FOLDER, safe_name)
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
    default_host = urlsplit(DEFAULT_ENDPOINT).hostname if DEFAULT_ENDPOINT else None
    return jsonify(
        {
            "status": "ok",
            "server_provider_configured": bool(DEFAULT_API_KEY and DEFAULT_ENDPOINT and DEFAULT_MODEL),
            "default_provider_host": default_host,
            "timestamp": datetime.now().isoformat(),
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
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=debug, use_reloader=False)
