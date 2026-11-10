"""Full product app, isolated local storage, manual own-key BuyToken generation.

Only start-dev.bat --local-own-key loads this entry. No .env or hosted database.
"""
import base64
import os
from pathlib import Path
import secrets
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
if os.environ.get('VERCEL') or os.environ.get('POSTERFLOW_LOCAL_OWN_KEY') != '1':
    raise SystemExit('Use start-dev.bat --local-own-key for loopback development only.')
for name in list(os.environ):
    if name.startswith(('SUPABASE_', 'PLATFORM_IMAGE_', 'APIMART_', 'BLOB_', 'VITE_SUPABASE_', 'PAYMENT_')) or name in ('OPENROUTER_API_KEY', 'IMAGE_API_KEY', 'IMAGE_API_ENDPOINT', 'IMAGE_API_MODEL', 'ADMIN_USER_IDS'):
        os.environ.pop(name, None)
DATA = ROOT / 'artifacts' / 'local-own-key'
DATA.mkdir(parents=True, exist_ok=True)
os.environ.update(DATA_DIR=str(DATA), IMAGE_STORAGE_BACKEND='local', ALLOW_LEGACY_SERVER_PROVIDER='0')


def no_env(event, args):
    if event == 'open' and args and isinstance(args[0], (str, bytes, os.PathLike)):
        name = os.path.basename(os.fsdecode(args[0]))
        if name.startswith('.env') and not name.endswith(('.sample', '.example')):
            raise PermissionError('Real environment files are disabled in local own-key mode')


sys.addaudithook(no_env)
isfile = os.path.isfile
with patch('os.path.isfile', side_effect=lambda name: False if os.path.basename(os.fsdecode(name)).startswith('.env') else isfile(name)):
    from backend import server, buytoken_image_routes
from scripts.local_own_key_store import LocalOwnKeyStore
from flask import jsonify, request

LocalOwnKeyStore.database = DATA / 'jobs.sqlite3'
buytoken_image_routes.BuyTokenStore = LocalOwnKeyStore
server.ALLOWED_ORIGINS += ['http://127.0.0.1:3002', 'http://localhost:3002', 'http://127.0.0.1:5001', 'http://localhost:5001']
REFERENCES = DATA / 'temporary-references'
REFERENCES.mkdir(exist_ok=True)
tickets = {}


def reference_file(path):
    checked = server.validate_reference_storage_path(path)
    target = (REFERENCES / checked).resolve()
    if not target.is_relative_to(REFERENCES.resolve()):
        raise server.ProviderError('REFERENCE_STORAGE_INVALID', '参考图路径无效。', 400)
    return target


def read_reference(path):
    target = reference_file(path)
    if not target.is_file():
        raise server.ProviderError('REFERENCE_IMAGE_MISSING', '本地参考图已过期，请重新选择。', 404)
    return base64.b64encode(server.validate_reference_image_bytes(target.read_bytes())).decode()


def cleanup(paths):
    for path in paths:
        reference_file(path).unlink(missing_ok=True)


server.stored_reference_to_base64 = read_reference
server.cleanup_reference_storage_paths = cleanup


@server.app.before_request
def local_guard():
    if request.remote_addr not in ('127.0.0.1', '::1') or request.host not in ('127.0.0.1:5001', 'localhost:5001'):
        return jsonify(error='此开发入口仅允许本机访问。'), 403
    if request.method in ('POST', 'PUT', 'DELETE') and request.headers.get('Origin') not in server.ALLOWED_ORIGINS:
        return jsonify(error='请求来源不受支持。'), 403
    if request.path == '/api/reference-upload-url' and request.method == 'POST':
        if server.parse_billing_mode({}) != 'own_key':
            return jsonify(error='本地请使用自带 API Key。'), 400
        data = request.get_json(silent=True) or {}
        extension = server.REFERENCE_UPLOAD_EXTENSIONS.get(data.get('content_type'))
        size = data.get('size')
        if not extension or type(size) is not int or not 0 < size <= server.REFERENCE_UPLOAD_MAX_BYTES:
            return jsonify(error='参考图格式或大小无效。'), 400
        for token, entry in list(tickets.items()):
            if entry['expires'] < time.time():
                tickets.pop(token, None)
        if len(tickets) >= 64:
            return jsonify(error='请稍后再上传。'), 429
        token = secrets.token_urlsafe(32)
        path = server._reference_storage_prefix() + secrets.token_hex(16) + '.' + extension
        tickets[token] = {'path': path, 'expires': time.time()+600}
        return jsonify(success=True, path=path, signed_url='/api/local-reference-upload/'+token)
    if request.path == '/api/reference-cleanup' and request.method == 'POST':
        paths = server.validate_reference_storage_paths((request.get_json(silent=True) or {}).get('paths'))
        cleanup(paths)
        return jsonify(success=True, deleted=len(paths))


@server.app.put('/api/local-reference-upload/<token>')
def upload(token):
    entry = tickets.pop(token, None)
    if not entry or entry['expires'] < time.time():
        return jsonify(error='本地上传凭证已过期。'), 403
    file = next(iter(request.files.values()), None)
    if not file:
        return jsonify(error='未收到图片。'), 400
    content = file.stream.read(server.REFERENCE_UPLOAD_MAX_BYTES+1)
    if len(content) > server.REFERENCE_UPLOAD_MAX_BYTES:
        return jsonify(error='参考图不能超过16MB。'), 413
    content = server.validate_reference_image_bytes(content)
    # A one-use random upload capability is bound to the original browser scope.
    target = (REFERENCES / entry['path']).resolve()
    if not target.is_relative_to(REFERENCES.resolve()):
        return jsonify(error='路径无效。'), 400
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    return jsonify(success=True)


if __name__ == '__main__':
    print('Full PosterFlow local own-key mode: backend 5001; frontend 3002. No environment files or hosted database.', flush=True)
    server.app.run(host='127.0.0.1', port=5001, debug=False, use_reloader=False, threaded=True, load_dotenv=False)
