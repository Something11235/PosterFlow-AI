"""Temporary private chunks for the same-origin image upload fallback."""
import hashlib
import re

import requests
from itsdangerous import BadData, URLSafeTimedSerializer


class ReferenceUploadParts:
    def __init__(self, server):
        self.server = server

    def _signer(self):
        if not self.server.SUPABASE_STORAGE_SERVICE_KEY:
            raise self.server.ProviderError("REFERENCE_STORAGE_UNAVAILABLE", "参考图存储服务尚未配置。", 503)
        return URLSafeTimedSerializer(
            self.server.SUPABASE_STORAGE_SERVICE_KEY, salt="posterflow.reference-upload-parts.v1",
            signer_kwargs={"digest_method": hashlib.sha256},
        )

    def issue(self, path, token, size):
        return self._signer().dumps([path, hashlib.sha256(token.encode()).hexdigest(), size])

    def _verified_size(self, path, token, ticket):
        try:
            if not isinstance(ticket, str) or not 0 < len(ticket) <= 2048:
                raise ValueError()
            expected_path, token_digest, size = self._signer().loads(ticket, max_age=3600)
            if (path != expected_path or hashlib.sha256(token.encode()).hexdigest() != token_digest
                    or type(size) is not int
                    or not self.server.REFERENCE_RELAY_MAX_BYTES < size <= self.server.REFERENCE_UPLOAD_MAX_BYTES):
                raise ValueError()
        except (BadData, ValueError, TypeError):
            raise self.server.ProviderError("REFERENCE_UPLOAD_INVALID", "分块上传凭证无效或已过期，请重新上传。", 403) from None
        return size

    def _part_count(self, size):
        part_size = self.server.REFERENCE_RELAY_MAX_BYTES
        return (size + part_size - 1) // part_size

    @staticmethod
    def _part_path(path, index):
        upload_id = hashlib.sha256(path.encode()).hexdigest()
        return f"posterflow/reference-upload-parts/{upload_id}/{index}.part"

    def cleanup_paths(self, path):
        return [self._part_path(path, index) for index in range(self._part_count(self.server.REFERENCE_UPLOAD_MAX_BYTES))]

    def accept(self, path, token, ticket, part_index, content):
        size = self._verified_size(path, token, ticket)
        count = self._part_count(size)
        if part_index not in {str(index) for index in range(count)}:
            raise self.server.ProviderError("REFERENCE_UPLOAD_INVALID", "参考图分块编号无效。", 400)
        index = int(part_index)
        chunk_size = self.server.REFERENCE_RELAY_MAX_BYTES
        if len(content) != min(chunk_size, size - index * chunk_size):
            raise self.server.ProviderError("REFERENCE_UPLOAD_INVALID", "参考图分块长度不符，请重新上传。", 400)
        if index == 0:
            self._check_type(path, content)
        self.server._supabase_create_reference_part(self._part_path(path, index), content)
        return index

    def _check_type(self, path, content):
        mime = self.server._reference_image_mime(content)
        if not mime or self.server.REFERENCE_UPLOAD_EXTENSIONS[mime] != path.rsplit(".", 1)[1].lower():
            raise self.server.ProviderError("REFERENCE_IMAGE_INVALID", "参考图内容与签名时的图片格式不符。", 400)
        return mime

    def _read_into(self, path, size, target):
        remaining = size
        try:
            with self.server._supabase_download(path, stream=True) as response:
                for chunk in response.iter_content(65536):
                    remaining -= len(chunk)
                    if remaining < 0:
                        break
                    target.extend(chunk)
                if remaining == 0:
                    return
        except requests.RequestException:
            raise self.server.ProviderError("REFERENCE_UPLOAD_FAILED", "读取临时参考图时连接中断，请重试。", 503) from None
        raise self.server.ProviderError("REFERENCE_UPLOAD_INVALID", "参考图长度校验失败，请重新上传。", 409)

    def _confirm_existing(self, path, size, expected_digest):
        # A concurrent completion may already have published the result and removed its chunks.
        stored = bytearray()
        try:
            self._read_into(path, size, stored)
        except self.server.ProviderError as error:
            if error.code != "STORAGE_FILE_MISSING":
                raise
            raise self.server.ProviderError("REFERENCE_UPLOAD_INCOMPLETE", "参考图分块尚未收齐，请重新上传。", 409) from None
        self._check_type(path, stored)
        if hashlib.sha256(stored).hexdigest() != expected_digest:
            raise self.server.ProviderError("REFERENCE_UPLOAD_FAILED", "已上传的参考图与本次文件不一致。", 409)

    def complete(self, path, token, ticket, expected_digest):
        size = self._verified_size(path, token, ticket)
        if not isinstance(expected_digest, str) or not re.fullmatch("[0-9a-f]{64}", expected_digest):
            raise self.server.ProviderError("REFERENCE_UPLOAD_INVALID", "缺少有效的参考图校验值。", 400)
        chunk_size = self.server.REFERENCE_RELAY_MAX_BYTES
        part_paths = [self._part_path(path, index) for index in range(self._part_count(size))]
        content = bytearray()
        try:
            for part_path in part_paths:
                self._read_into(part_path, min(chunk_size, size - len(content)), content)
        except self.server.ProviderError as error:
            if error.code != "STORAGE_FILE_MISSING":
                raise
            content.clear()
            self._confirm_existing(path, size, expected_digest)
        else:
            if hashlib.sha256(content).hexdigest() != expected_digest:
                raise self.server.ProviderError("REFERENCE_UPLOAD_INVALID", "参考图完整性校验失败，请重新上传。", 409)
            mime = self._check_type(path, content)
            self.server._relay_reference_upload(path, token, bytes(content), mime)
        try:
            self.server._supabase_delete(part_paths)
        except self.server.ProviderError:
            # The scheduled reference cleanup also covers interrupted transfers.
            self.server.app.logger.warning("reference_upload_part_cleanup_pending count=%d", len(part_paths))
