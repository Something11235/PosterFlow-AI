import hashlib
import io
import json
import struct
import unittest
import zlib
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import unquote, urlsplit

from PIL import Image
from requests import Response

from backend import server


PART_BYTES = 4 * 1024 * 1024
BASE = "https://test-storage.example"
BUCKET = "test-images"
USER = "11111111-0000-4000-8000-000000000001"
OTHER = "11111111-0000-4000-8000-000000000002"
PLATFORM = {"X-Billing-Mode": "platform"}
RELAY = "/api/reference-upload-fallback"


def sized_png(size):
    """A valid 1 x 1 PNG with a checksummed private ancillary chunk."""
    stream = io.BytesIO()
    Image.new("RGB", (1, 1), "blue").save(stream, "PNG")
    image = stream.getvalue()
    length = size - len(image) - 12
    # Give each 4 MiB region different bytes so incorrect merge order is visible.
    payload = b"".join(bytes([i + 1]) * min(PART_BYTES, length - i * PART_BYTES)
                       for i in range((length + PART_BYTES - 1) // PART_BYTES))
    chunk = b"pfTd" + payload
    return image[:-12] + struct.pack(">I", length) + chunk + struct.pack(">I", zlib.crc32(chunk)) + image[-12:]


def response(status, body=None):
    result = Response()
    result.status_code = status
    result._content = body if isinstance(body, bytes) else json.dumps(body or {}).encode()
    result._content_consumed = True
    return result


class ReferenceUploadPartTests(unittest.TestCase):
    """Exercise signing, immutable part writes, assembly and cleanup against one store."""

    def setUp(self):
        self.objects = {}
        self.tokens = {}
        self.signed_writes = 0
        self.user = self.patch("optional_authenticated_user", return_value=SimpleNamespace(id=USER))
        self.patch("SUPABASE_STORAGE_ENABLED", True)
        self.patch("SUPABASE_STORAGE_URL", BASE)
        self.patch("SUPABASE_STORAGE_BUCKET", BUCKET)
        self.patch("SUPABASE_STORAGE_SERVICE_KEY", "synthetic-storage-secret-for-tests")
        self.patch("_storage_backend", return_value="supabase")
        self.transport = self.enterContext(patch.object(server.requests, "request", side_effect=self.storage_request))
        self.signed_put = self.enterContext(patch.object(server.requests, "put", side_effect=self.write_signed))
        self.generation = self.patch("generate_images")
        self.ledger = self.patch("SupabaseGateway")
        self.client = server.app.test_client()

    def patch(self, name, *args, **kwargs):
        return self.enterContext(patch.object(server, name, *args, **kwargs))

    def tearDown(self):
        self.generation.assert_not_called()
        self.ledger.assert_not_called()

    def storage_request(self, method, url, **options):
        self.assertTrue(url.startswith(BASE + "/storage/v1/"))
        route = unquote(urlsplit(url).path).removeprefix("/storage/v1/object/")
        if method == "POST" and route.startswith(f"upload/sign/{BUCKET}/"):
            key = route.removeprefix(f"upload/sign/{BUCKET}/")
            token = "fixture-" + str(len(self.tokens))
            self.tokens[key] = token
            return response(200, {"url": f"/object/upload/sign/{BUCKET}/{key}?token={token}"})
        if method == "POST" and route.startswith(BUCKET + "/"):
            key = route.removeprefix(BUCKET + "/")
            self.assertEqual(options["headers"]["x-upsert"], "false")
            if key in self.objects:
                return response(409, {"code": "ResourceAlreadyExists"})
            self.objects[key] = bytes(options["data"])
            return response(200, {"Key": f"{BUCKET}/{key}"})
        if method == "GET" and route.startswith(f"authenticated/{BUCKET}/"):
            key = route.removeprefix(f"authenticated/{BUCKET}/")
            if key not in self.objects:
                return response(400, {"statusCode": "404", "error": "not_found"})
            return response(200, self.objects[key])
        if method == "DELETE" and route == BUCKET:
            for key in options["json"]["prefixes"]:
                self.objects.pop(key, None)
            return response(200)
        self.fail(f"Unexpected storage operation {method}")

    def write_signed(self, url, **options):
        key = unquote(urlsplit(url).path).removeprefix(f"/storage/v1/object/upload/sign/{BUCKET}/")
        self.assertIn(key, self.tokens)
        self.assertEqual(options["params"]["token"], self.tokens[key])
        self.assertEqual(options["headers"], {"x-upsert": "false"})
        if key in self.objects:
            return response(400, {"error": "Duplicate"})
        self.objects[key] = bytes(options["files"][""][1])
        self.signed_writes += 1
        return response(200)

    def sign(self, size):
        return self.client.post("/api/reference-upload-url", headers=PLATFORM,
                                json={"size": size, "content_type": "image/png"})

    def ticket(self, size):
        signed = self.sign(size)
        self.assertEqual(signed.status_code, 200)
        return {field: signed.json[field] for field in ("path", "token", "relay_ticket")}

    def part(self, ticket, index, data):
        reply = self.client.post(RELAY, headers=PLATFORM, data={
            **ticket, "part_index": str(index), "file": (io.BytesIO(data), "part.bin"),
        })
        reply.request.input_stream.close()
        return reply

    def complete(self, ticket, source):
        return self.client.post(RELAY + "/complete", headers=PLATFORM,
                                json={**ticket, "sha256": hashlib.sha256(source).hexdigest()})

    def cleanup(self, keys):
        return self.client.post("/api/reference-cleanup", headers=PLATFORM,
                                json={"paths": keys, "relay_paths": keys})

    def test_16_mib_four_parts_assemble_in_order_and_lost_completion_receipt_replays(self):
        source = sized_png(4 * PART_BYTES)
        ticket = self.ticket(len(source))
        for index in (2, 0, 3, 1):
            part = source[index * PART_BYTES:(index + 1) * PART_BYTES]
            reply = self.part(ticket, index, part)
            self.assertEqual(reply.status_code, 200, reply.json)
            self.assertEqual(reply.json["part_index"], index)
        result = self.complete(ticket, source)
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(self.objects, {ticket["path"]: source})
        self.assertEqual(self.complete(ticket, source).status_code, 200)
        self.assertEqual(self.complete(ticket, b"wrong digest").status_code, 409)
        self.assertEqual(self.signed_writes, 1)
        self.assertEqual(self.cleanup([ticket["path"]]).status_code, 200)
        self.assertEqual(self.objects, {})

    def test_lost_part_receipt_same_bytes_and_conflicting_bytes(self):
        source = sized_png(PART_BYTES + 23)
        ticket = self.ticket(len(source))
        tail = source[PART_BYTES:]
        for _ in range(2):
            self.assertEqual(self.part(ticket, 1, tail).status_code, 200)
        self.assertEqual(self.part(ticket, 1, b"x" * len(tail)).status_code, 409)
        self.assertEqual(list(self.objects.values()), [tail])
        self.assertIn(self.complete(ticket, source).status_code, (400, 404, 409))
        self.assertEqual(self.signed_writes, 0)
        self.assertEqual(self.part(ticket, 0, source[:PART_BYTES]).status_code, 200)
        self.assertEqual(self.complete(ticket, b"wrong digest").status_code, 409)
        self.assertEqual(self.signed_writes, 0)
        self.assertEqual(self.complete(ticket, source).status_code, 200)
        self.assertEqual(self.objects[ticket["path"]], source)

    def test_invalid_part_size_index_and_signing_limits(self):
        self.assertEqual(self.sign(4 * PART_BYTES + 1).status_code, 413)
        self.assertNotIn("relay_ticket", self.sign(PART_BYTES).json)
        ticket = self.ticket(PART_BYTES + 17)
        for index, length in ((0, PART_BYTES + 1), (0, PART_BYTES - 1), (1, 0),
                              (1, 18), (2, 17), (-1, 17), ("1.5", 17)):
            with self.subTest(index=index, length=length):
                self.assertIn(self.part(ticket, index, bytes(length)).status_code, (400, 413))
        self.assertEqual(self.objects, {})
        self.assertEqual(self.signed_writes, 0)

    def test_request_must_match_owner_path_and_both_tickets(self):
        ticket = self.ticket(PART_BYTES + 3)
        second = self.ticket(PART_BYTES + 3)
        unexpected = [
            {**ticket, "token": second["token"]},
            {**ticket, "relay_ticket": second["relay_ticket"]},
            {**ticket, "path": second["path"]},
            {**ticket, "relay_ticket": ""},
        ]
        self.transport.reset_mock()
        for bad_ticket in unexpected:
            self.assertIn(self.part(bad_ticket, 1, b"abc").status_code, (400, 403))
            self.assertIn(self.complete(bad_ticket, b"abc").status_code, (400, 403))
        self.user.return_value = SimpleNamespace(id=OTHER)
        self.assertIn(self.part(ticket, 1, b"abc").status_code, (400, 403))
        self.assertIn(self.cleanup([ticket["path"]]).status_code, (400, 403))
        self.transport.assert_not_called()
        self.signed_put.assert_not_called()

    def test_expired_ticket_cannot_write_or_complete(self):
        with patch("itsdangerous.timed.TimestampSigner.get_timestamp", return_value=1):
            ticket = self.ticket(PART_BYTES + 1)
        self.transport.reset_mock()
        self.assertEqual(self.part(ticket, 1, b"x").status_code, 403)
        self.assertEqual(self.complete(ticket, b"x").status_code, 403)
        self.transport.assert_not_called()
        self.signed_put.assert_not_called()

    def test_direct_upload_with_lost_receipt_keeps_existing_final_object(self):
        source = sized_png(PART_BYTES + 1)
        for final_data, expected_status in ((source, 200), (source[:-1] + b"x", 409)):
            ticket = self.ticket(len(source))
            self.objects[ticket["path"]] = final_data
            self.assertEqual(self.part(ticket, 0, source[:PART_BYTES]).status_code, 200)
            self.assertEqual(self.part(ticket, 1, source[PART_BYTES:]).status_code, 200)
            self.assertEqual(self.complete(ticket, source).status_code, expected_status)
            self.assertEqual(self.objects[ticket["path"]], final_data)
            self.assertEqual(self.signed_writes, 0)
            self.assertEqual(self.cleanup([ticket["path"]]).status_code, 200)

    def test_partial_cleanup_is_scoped_and_can_be_repeated(self):
        left, right = self.ticket(PART_BYTES + 3), self.ticket(PART_BYTES + 4)
        self.assertEqual(self.part(left, 1, b"abc").status_code, 200)
        self.assertEqual(self.part(right, 1, b"keep").status_code, 200)
        for _ in range(2):
            self.assertEqual(self.cleanup([left["path"]]).status_code, 200)
            self.assertEqual(list(self.objects.values()), [b"keep"])
