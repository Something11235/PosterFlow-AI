"""No real network, credentials, storage or server .env imports."""
import http.client
import io
import json
import socket
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask

from backend import tavern_routes as tavern


class ProviderError(Exception):
    pass


class TavernTests(unittest.TestCase):
    def setUp(self):
        self.server = SimpleNamespace(ALLOWED_ORIGINS=["https://posterflow.example"],
                                      ProviderError=ProviderError, enforce_rate_limit=Mock())
        self.app = Flask(__name__)
        self.app.register_blueprint(tavern.create_tavern_blueprint(self.server))
        self.client = self.app.test_client()
        self.headers = {"X-Tavern-Api-Key": "synthetic-session-secret", "X-Tavern-Endpoint": tavern.DEFAULT_ENDPOINT,
                        "Origin": "https://posterflow.example"}
        self.body = {"billing_mode": "own_key", "model": tavern.DEFAULT_MODEL,
                     "messages": [{"role": "system", "content": "角色设定"}, {"role": "user", "content": "你好"}],
                     "temperature": 0.8, "max_tokens": 1024}

    def test_config_and_platform_fail_closed_without_outbound_or_billing(self):
        config = self.client.get("/api/tavern/config")
        self.assertFalse(config.json["platform_configured"])
        self.assertFalse(config.json["streaming"])
        self.assertTrue(config.json["own_key_supported"])
        self.assertFalse(config.json["pricing"]["billing_enabled"])
        self.assertEqual(config.json["pricing"]["precision"], "0.0001")
        self.assertEqual(config.json["pricing"]["rates"], {"input_uncached": "6", "output": "24", "cache_read": "0.12"})
        self.assertEqual([example["credits"] for example in config.json["pricing"]["examples"]], ["0.0840", "0.0370"])
        with patch.object(tavern, "submit_chat") as submit:
            for mode in ({"billing_mode": "platform"}, {}):
                response = self.client.post("/api/tavern/chat", json=mode, headers=self.headers)
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json["charged_credits"], 0)
            submit.assert_not_called()

    def test_own_key_single_call_without_site_auth_or_storage(self):
        usage = tavern.normalize_usage({"prompt_tokens": 10, "completion_tokens": 3})
        with patch.object(tavern, "submit_chat", return_value={"content": "角色回答", "usage": usage}) as submit:
            response = self.client.post("/api/tavern/chat", json=self.body, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["content"], "角色回答")
        self.assertEqual(response.json["usage"], usage)
        self.assertEqual(response.json["charged_credits"], 0)
        self.assertFalse(response.json["streaming"])
        self.assertEqual(submit.call_count, 1)
        endpoint, key, outgoing = submit.call_args.args
        self.assertEqual(endpoint, tavern.DEFAULT_ENDPOINT)
        self.assertEqual(key, self.headers["X-Tavern-Api-Key"])
        self.assertFalse(outgoing["stream"])
        self.assertNotIn("billing_mode", outgoing)
        self.assertNotIn(key, response.get_data(as_text=True))
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")

    def test_invalid_origin_key_and_input_never_reach_provider(self):
        cases = [
            (self.body, {**self.headers, "Origin": "https://other.example"}, 403),
            (self.body, {**self.headers, "Sec-Fetch-Site": "cross-site"}, 403),
            (self.body, {"Origin": "https://posterflow.example"}, 400),
            ({**self.body, "messages": []}, self.headers, 400),
            ({**self.body, "messages": [{"role": "tool", "content": "bad"}]}, self.headers, 400),
            ({**self.body, "messages": [{"role": "user", "content": "x", "tool_calls": []}]}, self.headers, 400),
            ({**self.body, "messages": [{"role": "assistant", "content": "x"}]}, self.headers, 400),
            ({**self.body, "messages": [{"role": "user", "content": "x"}] * 65}, self.headers, 400),
            ({**self.body, "messages": [{"role": "user", "content": "x" * 65537}]}, self.headers, 400),
            ({**self.body, "max_tokens": True}, self.headers, 400),
            ({**self.body, "max_tokens": 4097}, self.headers, 400),
            ({**self.body, "temperature": -1}, self.headers, 400),
            ({**self.body, "temperature": 10 ** 1000}, self.headers, 400),
            ({**self.body, "model": "bad model"}, self.headers, 400),
            ({**self.body, "api_key": "must-not-enter-body"}, self.headers, 400),
        ]
        with patch.object(tavern, "submit_chat") as submit:
            for body, headers, expected in cases:
                with self.subTest(body=str(body)[:100], headers=list(headers)):
                    self.assertEqual(self.client.post("/api/tavern/chat", json=body, headers=headers).status_code, expected)
            submit.assert_not_called()

    def test_rate_limit_rejection_does_not_send(self):
        self.server.enforce_rate_limit.side_effect = ProviderError()
        with patch.object(tavern, "submit_chat") as submit:
            response = self.client.post("/api/tavern/chat", json=self.body, headers=self.headers)
        self.assertEqual(response.status_code, 429)
        submit.assert_not_called()

    def test_safe_endpoint_rejects_credentials_private_and_other_paths(self):
        for endpoint in ("http://public.example/v1/chat/completions", "https://127.0.0.1/v1/chat/completions",
                         "https://user:password@public.example/v1/chat/completions", "https://public.example/v1/images/generations",
                         "https://public.example:8080/v1/chat/completions", "https://public.example/v1/chat/completions?key=x",
                         "https://public.example\\@127.0.0.1/v1/chat/completions"):
            with self.subTest(endpoint=endpoint), self.assertRaises(tavern.TavernError):
                tavern.validate_endpoint(endpoint)

    def test_private_or_mixed_dns_rejected_before_connection(self):
        for addresses in (("127.0.0.1",), ("8.8.8.8", "10.0.0.1"), ("169.254.169.254",), ("::1",), ("224.0.0.1",)):
            with self.subTest(addresses=addresses), patch.object(tavern.socket, "getaddrinfo", return_value=[(0, 0, 0, "", (ip, 443)) for ip in addresses]), patch.object(tavern, "PinnedConnection") as connection:
                with self.assertRaises(tavern.TavernError) as caught:
                    tavern.submit_chat(tavern.DEFAULT_ENDPOINT, "secret", tavern.build_chat_request(self.body))
                self.assertEqual(caught.exception.code, "TAVERN_ENDPOINT_PRIVATE")
                connection.assert_not_called()

    def transport(self, status=200, payload=None, raw=None):
        body = raw if raw is not None else json.dumps(payload if payload is not None else {"choices": [{"message": {"content": "你好", "reasoning_content": "private"}}]}).encode()
        response = Mock(status=status)
        response.getheader.return_value = ""
        response.isclosed.side_effect = [False, True]
        response.read1.return_value = body
        connection = Mock()
        connection.getresponse.return_value = response
        return connection

    def call_transport(self, connection):
        dns = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        with patch.object(tavern.socket, "getaddrinfo", return_value=dns) as resolve, patch.object(tavern, "PinnedConnection", return_value=connection) as factory:
            result = tavern.submit_chat(tavern.DEFAULT_ENDPOINT, "synthetic-secret", tavern.build_chat_request(self.body))
        return result, resolve, factory

    def test_ip_pinning_single_post_tls_host_and_filtered_response(self):
        connection = self.transport()
        result, resolve, factory = self.call_transport(connection)
        self.assertEqual(result["content"], "你好")
        self.assertEqual(result["usage"]["status"], "missing")
        self.assertTrue(all(value is None for key, value in result["usage"].items() if key != "status"))
        self.assertEqual(resolve.call_count, 1)
        self.assertEqual(factory.call_args.args[:2], ("api.buytoken.work", "8.8.8.8"))
        self.assertEqual(connection.request.call_count, 1)
        self.assertEqual(connection.request.call_args.args, ("POST", "/v1/chat/completions"))
        outgoing = json.loads(connection.request.call_args.kwargs["body"])
        self.assertFalse(outgoing["stream"])
        connection.close.assert_called_once()
        context, raw = Mock(), Mock()
        with patch.object(tavern.ssl, "create_default_context", return_value=context), patch.object(tavern.socket, "create_connection", return_value=raw) as connect:
            client = tavern.PinnedConnection("api.buytoken.work", "8.8.8.8", 8)
            client.connect()
        self.assertEqual(connect.call_args.args[0], ("8.8.8.8", 443))
        context.wrap_socket.assert_called_once_with(raw, server_hostname="api.buytoken.work")

    def test_redirect_error_empty_and_timeout_do_not_retry_or_expose_details(self):
        cases = [self.transport(status=302), self.transport(status=503, raw=b"synthetic-secret private-url"),
                 self.transport(payload={"choices": []}), self.transport(raw=b"not json synthetic-secret"),
                 self.transport(raw=b"x" * (tavern.MAX_RESPONSE_BYTES + 1))]
        timeout = self.transport()
        timeout.getresponse.side_effect = TimeoutError("synthetic-secret https://private.invalid")
        cases.append(timeout)
        for connection in cases:
            with self.subTest(status=connection.getresponse.return_value.status), self.assertRaises(tavern.TavernError) as caught:
                self.call_transport(connection)
            self.assertTrue(caught.exception.uncertain)
            self.assertNotIn("synthetic-secret", str(caught.exception))
            self.assertNotIn("private.invalid", str(caught.exception))
            self.assertEqual(connection.request.call_count, 1)
            connection.close.assert_called_once()

    def test_explicit_rejection_is_distinct_from_unknown(self):
        with self.assertRaises(tavern.TavernError) as caught:
            self.call_transport(self.transport(status=401))
        self.assertFalse(caught.exception.uncertain)
        self.assertEqual(caught.exception.code, "TAVERN_REQUEST_REJECTED")

    def test_deadline_stops_slow_body_without_retry(self):
        connection = self.transport()
        with patch.object(tavern.time, "monotonic", side_effect=[0, 1, 2, 3, 121]), self.assertRaises(tavern.TavernError) as caught:
            self.call_transport(connection)
        self.assertTrue(caught.exception.uncertain)
        self.assertEqual(connection.request.call_count, 1)

    def test_dns_wait_is_bounded_and_does_not_submit(self):
        future = Mock()
        future.result.side_effect = tavern.FutureTimeout()
        slots = Mock()
        slots.acquire.return_value = True
        with patch.object(tavern, "_DNS_SLOTS", slots), patch.object(tavern._DNS_WORKERS, "submit", return_value=future), patch.object(tavern, "PinnedConnection") as connection:
            with self.assertRaises(tavern.TavernError) as caught:
                tavern.submit_chat(tavern.DEFAULT_ENDPOINT, "synthetic", tavern.build_chat_request(self.body))
        self.assertFalse(caught.exception.uncertain)
        self.assertEqual(caught.exception.code, "TAVERN_DNS_UNAVAILABLE")
        future.result.assert_called_once_with(timeout=8)
        future.cancel.assert_called_once()
        connection.assert_not_called()

    def test_watchdog_interrupts_header_reads_and_is_cancelled(self):
        connection = self.transport()
        timer = Mock()
        callback = []
        def timer_factory(seconds, function):
            self.assertGreater(seconds, 0)
            self.assertLessEqual(seconds, 120)
            callback.append(function)
            return timer
        def blocked_header_read():
            callback[0]()
            raise OSError("synthetic transport closed")
        connection.getresponse.side_effect = blocked_header_read
        with patch.object(tavern.threading, "Timer", side_effect=timer_factory), self.assertRaises(tavern.TavernError) as caught:
            self.call_transport(connection)
        self.assertTrue(caught.exception.uncertain)
        connection.sock.shutdown.assert_called_once_with(socket.SHUT_RDWR)
        timer.start.assert_called_once()
        timer.cancel.assert_called_once()
        self.assertEqual(connection.request.call_count, 1)

    def test_real_http_body_parser_handles_connection_close(self):
        payload = json.dumps({"choices": [{"message": {"content": "完成"}}]}).encode()
        socket_stub = Mock()
        socket_stub.makefile.return_value = io.BytesIO(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: " + str(len(payload)).encode() + b"\r\n\r\n" + payload)
        response = http.client.HTTPResponse(socket_stub)
        response.begin()
        connection = self.transport()
        connection.getresponse.return_value = response
        self.assertEqual(self.call_transport(connection)[0]["content"], "完成")

    def test_deeply_nested_response_is_safe_unknown_not_server_error(self):
        connection = self.transport(raw=b"[" * 2000 + b"0" + b"]" * 2000)
        with self.assertRaises(tavern.TavernError) as caught:
            self.call_transport(connection)
        self.assertTrue(caught.exception.uncertain)
        self.assertEqual(connection.request.call_count, 1)

    def test_usage_preserves_real_openai_counts_without_double_counting(self):
        usage = tavern.normalize_usage({"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
                                        "prompt_tokens_details": {"cached_tokens": 80, "audio_tokens": 1},
                                        "completion_tokens_details": {"reasoning_tokens": 12}, "private": "discard"})
        self.assertEqual(usage, {"status": "confirmed", "input_tokens": 100, "output_tokens": 20,
                                 "total_tokens": 120, "cache_read_tokens": 80, "cache_miss_tokens": None,
                                 "reasoning_tokens": 12})

    def test_usage_deepseek_cache_subsets_and_missing_total(self):
        usage = tavern.normalize_usage({"prompt_tokens": 100, "completion_tokens": 20,
                                        "prompt_cache_hit_tokens": 80, "prompt_cache_miss_tokens": 20})
        self.assertEqual(usage, {"status": "confirmed", "input_tokens": 100, "output_tokens": 20,
                                 "total_tokens": 120, "cache_read_tokens": 80, "cache_miss_tokens": 20,
                                 "reasoning_tokens": None})
        usage = tavern.normalize_usage({"prompt_tokens": 100, "completion_tokens": 20, "prompt_cache_hit_tokens": 80})
        self.assertIsNone(usage["cache_miss_tokens"])

    def test_usage_absent_empty_and_null_fields_stay_unknown_never_zero(self):
        for raw in (None, {}, {"unrecognized": 100}, {"prompt_tokens": None, "prompt_tokens_details": None}):
            with self.subTest(raw=raw):
                usage = tavern.normalize_usage(raw)
                self.assertEqual(usage["status"], "missing")
                self.assertTrue(all(value is None for name, value in usage.items() if name != "status"))
        zeros = tavern.normalize_usage({"prompt_tokens": 0, "completion_tokens": 0})
        self.assertEqual(zeros["status"], "confirmed")
        self.assertEqual(zeros["total_tokens"], 0)

    def test_usage_malformed_values_do_not_coerce_to_valid_counters(self):
        for bad in (True, False, "10", -1, 1.2, float("nan"), float("inf"), 2 ** 53, [], {}):
            with self.subTest(bad=bad):
                usage = tavern.normalize_usage({"prompt_tokens": bad})
                self.assertEqual(usage["status"], "invalid")
                self.assertTrue(all(value is None for name, value in usage.items() if name != "status"))
        for raw in ([], "private-provider-detail", 42, True):
            self.assertEqual(tavern.normalize_usage(raw)["status"], "invalid")
        integral = tavern.normalize_usage({"prompt_tokens": 10.0, "completion_tokens": 2})
        self.assertEqual(integral["input_tokens"], 10)
        self.assertEqual(integral["status"], "confirmed")

    def test_usage_total_conflicts_and_overflow_remove_only_untrusted_total(self):
        for total in (999, 3, "120", False):
            usage = tavern.normalize_usage({"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": total})
            self.assertEqual(usage["status"], "partial")
            self.assertEqual((usage["input_tokens"], usage["output_tokens"]), (100, 20))
            self.assertIsNone(usage["total_tokens"])
        overflow = tavern.normalize_usage({"prompt_tokens": tavern.MAX_SAFE_TOKENS, "completion_tokens": 1})
        self.assertEqual(overflow["status"], "partial")
        self.assertIsNone(overflow["total_tokens"])
        single = tavern.normalize_usage({"prompt_tokens": 100, "total_tokens": 20})
        self.assertEqual(single["input_tokens"], 100)
        self.assertIsNone(single["output_tokens"])
        self.assertIsNone(single["total_tokens"])

    def test_usage_cache_alias_conflicts_and_subset_limits(self):
        core = {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}
        cases = [
            ({"prompt_cache_hit_tokens": 80, "prompt_tokens_details": {"cached_tokens": 70}}, (None, None)),
            ({"prompt_cache_hit_tokens": 80, "prompt_cache_miss_tokens": 30}, (None, None)),
            ({"prompt_cache_hit_tokens": 101, "prompt_cache_miss_tokens": 20}, (None, 20)),
            ({"prompt_cache_hit_tokens": 80, "prompt_cache_miss_tokens": 101}, (80, None)),
            ({"prompt_cache_hit_tokens": "80", "prompt_tokens_details": {"cached_tokens": 80}}, (80, None)),
            ({"prompt_tokens_details": "bad"}, (None, None)),
        ]
        for details, expected in cases:
            with self.subTest(details=details):
                usage = tavern.normalize_usage({**core, **details})
                self.assertEqual(usage["status"], "partial")
                self.assertEqual((usage["cache_read_tokens"], usage["cache_miss_tokens"]), expected)
                self.assertEqual(usage["total_tokens"], 120)
        agreement = tavern.normalize_usage({**core, "prompt_cache_hit_tokens": 80, "prompt_tokens_details": {"cached_tokens": 80}})
        self.assertEqual(agreement["status"], "confirmed")
        self.assertEqual(agreement["cache_read_tokens"], 80)

    def test_usage_reasoning_is_output_subset_and_partial_counts_remain_partial(self):
        for details in ({"reasoning_tokens": 21}, {"reasoning_tokens": "12"}, []):
            usage = tavern.normalize_usage({"prompt_tokens": 100, "completion_tokens": 20,
                                            "completion_tokens_details": details})
            self.assertEqual(usage["status"], "partial")
            self.assertIsNone(usage["reasoning_tokens"])
            self.assertEqual(usage["total_tokens"], 120)
        for raw, field in (({"total_tokens": 120}, "total_tokens"), ({"prompt_tokens": 100}, "input_tokens"),
                           ({"prompt_cache_hit_tokens": 80}, "cache_read_tokens"),
                           ({"completion_tokens_details": {"reasoning_tokens": 12}}, "reasoning_tokens")):
            usage = tavern.normalize_usage(raw)
            self.assertEqual(usage["status"], "partial")
            self.assertIsNotNone(usage[field])

    def test_usage_invalid_or_conflicting_never_loses_successful_reply_or_retries(self):
        for raw in (None, "malformed", {"prompt_tokens": True}, {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 5}):
            connection = self.transport(payload={"choices": [{"message": {"content": "保留成功正文"}}], "usage": raw})
            response, _, _ = self.call_transport(connection)
            self.assertEqual(response["content"], "保留成功正文")
            self.assertEqual(response["usage"], tavern.normalize_usage(raw))
            self.assertEqual(connection.request.call_count, 1)

    def import_transport(self, connection, kind="character", url="https://public.example/download?id=42"):
        dns = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        with patch.object(tavern.socket, "getaddrinfo", return_value=dns) as resolve, patch.object(tavern, "PinnedConnection", return_value=connection) as factory:
            response = self.client.post("/api/tavern/import", json={"url": url, "kind": kind},
                                        headers={**self.headers, "Authorization": "Bearer synthetic-site-token"})
        return response, resolve, factory

    def test_import_public_json_without_suffix_pins_ip_and_forwards_no_credentials(self):
        content = b'{"name":"Synthetic character"}'
        connection = self.transport(raw=content)
        response, resolve, factory = self.import_transport(connection)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, content)
        self.assertEqual(response.mimetype, "application/json")
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")
        self.assertIn('filename="character.json"', response.headers["Content-Disposition"])
        self.assertEqual(resolve.call_count, 1)
        self.assertEqual(factory.call_args.args[:2], ("public.example", "8.8.8.8"))
        connection.request.assert_called_once()
        self.assertEqual(connection.request.call_args.args, ("GET", "/download?id=42"))
        outgoing = connection.request.call_args.kwargs
        self.assertNotIn("body", outgoing)
        self.assertEqual(set(outgoing["headers"]), {"Accept", "Accept-Encoding", "User-Agent"})
        self.assertNotIn("synthetic", str(outgoing))
        connection.close.assert_called_once()

    def test_import_png_binary_allowed_for_both_character_and_embedded_lorebook(self):
        # Synthetic signature suffices at the transport boundary; the frontend
        # validates PNG chunks and whether a card/embedded worldbook exists.
        content = tavern.PNG_SIGNATURE + b"synthetic bytes" * 100000
        for kind in ("character", "lorebook"):
            with self.subTest(kind=kind):
                response, _, _ = self.import_transport(self.transport(raw=content), kind=kind)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data, content)
                self.assertEqual(response.mimetype, "image/png")

    def test_import_invalid_origin_input_and_rate_limit_never_download(self):
        body = {"url": "https://public.example/file", "kind": "character"}
        with patch.object(tavern, "fetch_import_bytes") as fetch:
            for headers in ({"Origin": "https://other.example"}, {"Sec-Fetch-Site": "cross-site"}):
                self.assertEqual(self.client.post("/api/tavern/import", json=body, headers=headers).status_code, 403)
            for data in ({**body, "api_key": "synthetic"}, {**body, "kind": "invalid"}, {**body, "url": 12}, {}):
                self.assertEqual(self.client.post("/api/tavern/import", json=data).status_code, 400)
            self.server.enforce_rate_limit.side_effect = ProviderError()
            self.assertEqual(self.client.post("/api/tavern/import", json=body).status_code, 429)
            fetch.assert_not_called()

    def test_import_private_dns_unsafe_urls_and_pages_never_connect(self):
        urls = ("http://public.example/file", "https://127.0.0.1/file", "https://public.example:8443/file",
                "https://user:secret@public.example/file", "https://@public.example/file", "https://public.example/file#page",
                "https://public.example/", "https://public.example/search", "https://chub.ai/characters",
                "https://chub.ai/lorebooks/author/name", "https://chub.ai/characters/author/%2e%2e",
                "https://chub.ai/characters/author/name%2Fextra")
        with patch.object(tavern, "PinnedConnection") as connection, patch.object(tavern.socket, "getaddrinfo") as dns:
            for url in urls:
                with self.subTest(url=url), self.assertRaises(tavern.TavernError):
                    tavern.download_tavern_resource(url, "character")
            dns.assert_not_called()
            connection.assert_not_called()
        for ips in (("10.0.0.1",), ("8.8.8.8", "169.254.169.254"), ("::1",), ("224.0.0.1",)):
            with self.subTest(ips=ips), patch.object(tavern.socket, "getaddrinfo", return_value=[(0, 0, 0, "", (ip, 443)) for ip in ips]), patch.object(tavern, "PinnedConnection") as connection:
                with self.assertRaises(tavern.TavernError) as caught:
                    tavern.download_tavern_resource("https://public.example/file", "lorebook")
                self.assertEqual(caught.exception.code, "TAVERN_IMPORT_SOURCE_UNAVAILABLE")
                connection.assert_not_called()

    def test_import_html_redirect_errors_bad_json_and_truncation_are_safe(self):
        cases = [
            (self.transport(raw=b" <!doctype html><html>synthetic-secret</html>"), "TAVERN_IMPORT_HTML"),
            (self.transport(status=302), "TAVERN_IMPORT_REDIRECT"),
            (self.transport(status=403, raw=b"synthetic-secret"), "TAVERN_IMPORT_UNAVAILABLE"),
            (self.transport(raw=b"[]"), "TAVERN_IMPORT_FORMAT"),
            (self.transport(raw=b"not json synthetic-secret"), "TAVERN_IMPORT_FORMAT"),
            (self.transport(raw=b"[" * 2000 + b"0" + b"]" * 2000), "TAVERN_IMPORT_FORMAT"),
        ]
        incomplete = self.transport(raw=b"{}")
        incomplete.getresponse.return_value.getheader.return_value = "20"
        cases.append((incomplete, "TAVERN_IMPORT_INCOMPLETE"))
        timeout = self.transport()
        timeout.getresponse.side_effect = TimeoutError("synthetic-secret https://private.invalid")
        cases.append((timeout, "TAVERN_IMPORT_DOWNLOAD_FAILED"))
        for connection, code in cases:
            with self.subTest(code=code):
                response, _, _ = self.import_transport(connection)
                self.assertEqual(response.json["code"], code)
                self.assertEqual(response.json["charged_credits"], 0)
                self.assertNotIn("synthetic-secret", response.get_data(as_text=True))
                self.assertNotIn("private.invalid", response.get_data(as_text=True))
                self.assertEqual(connection.request.call_count, 1)
                connection.close.assert_called_once()

    def test_import_size_limits_apply_to_headers_and_detected_body_type(self):
        declared_png = self.transport(raw=tavern.PNG_SIGNATURE)
        declared_png.getresponse.return_value.getheader.return_value = str(tavern.IMPORT_PNG_BYTES + 1)
        declared_json = self.transport(raw=b'{"name":"test"}')
        declared_json.getresponse.return_value.getheader.return_value = str(tavern.IMPORT_JSON_BYTES + 1)
        for connection in (declared_png, declared_json,
                           self.transport(raw=b" " * (tavern.IMPORT_JSON_BYTES + 1)),
                           self.transport(raw=tavern.PNG_SIGNATURE + b"x" * tavern.IMPORT_PNG_BYTES)):
            response, _, _ = self.import_transport(connection)
            self.assertEqual(response.status_code, 413)
            self.assertEqual(response.json["code"], "TAVERN_IMPORT_TOO_LARGE")
            self.assertEqual(connection.request.call_count, 1)

    def test_chub_detail_protocol_maps_plain_card_and_never_downloads_avatar(self):
        definition = {"name": "Synthetic", "personality": "Description", "tavern_personality": "Traits",
                      "scenario": "Place", "first_message": "Hello", "example_dialogs": "Example",
                      "embedded_lorebook": {"entries": []}, "extensions": {"script": "never execute"}}
        metadata = {"node": {"definition": definition, "topics": ["synthetic"], "avatar_url": "https://private.invalid/avatar"}}
        with patch.object(tavern, "fetch_import_bytes", return_value=json.dumps(metadata).encode()) as fetch:
            raw, mime, filename = tavern.download_tavern_resource("https://chub.ai/characters/author/name", "character")
        data = json.loads(raw)
        self.assertEqual((mime, filename), ("application/json", "character.json"))
        self.assertEqual(data["spec"], "chara_card_v2")
        self.assertEqual(data["data"]["description"], "Description")
        self.assertEqual(data["data"]["first_mes"], "Hello")
        self.assertEqual(data["data"]["character_book"], {"entries": []})
        self.assertNotIn("extensions", data["data"])
        self.assertNotIn("avatar", data["data"])
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(fetch.call_args.args[:2], ("https://api.chub.ai/api/characters/author/name?full=true", tavern.IMPORT_JSON_BYTES))

    def test_chub_lorebook_protocol_uses_validated_id_and_shared_budget(self):
        with patch.object(tavern, "fetch_import_bytes", side_effect=[b'{"node":{"id":123}}', b'{"entries":{}}']) as fetch:
            content, mime, filename = tavern.download_tavern_resource("https://www.chub.ai/lorebooks/author/name", "lorebook")
        self.assertEqual(content, b'{"entries":{}}')
        self.assertEqual((mime, filename), ("application/json", "lorebook.json"))
        self.assertEqual(fetch.call_args_list[0].args[0], "https://api.chub.ai/api/lorebooks/author/name")
        self.assertEqual(fetch.call_args_list[1].args[0], "https://api.chub.ai/api/v4/projects/123/repository/files/raw%252Fsillytavern_raw.json/raw")
        self.assertEqual(fetch.call_args_list[0].args[2], fetch.call_args_list[1].args[2])
        for project_id in (True, "../../private", -1, "123/456", None):
            with patch.object(tavern, "fetch_import_bytes", return_value=json.dumps({"node": {"id": project_id}}).encode()) as fetch, self.assertRaises(tavern.TavernError):
                tavern.download_tavern_resource("https://chub.ai/lorebooks/author/name", "lorebook")
            self.assertEqual(fetch.call_count, 1)

    def test_chub_lookalike_host_is_only_treated_as_direct_file(self):
        url = "https://chub.ai.other.example/characters/author/name"
        with patch.object(tavern, "fetch_import_bytes", return_value=b"{}") as fetch:
            tavern.download_tavern_resource(url, "character")
        self.assertEqual(fetch.call_args.args[0], url)

    def test_import_watchdog_cleans_up_header_timeout(self):
        connection, timer, callback = self.transport(), Mock(), []
        def timer_factory(seconds, function):
            self.assertGreater(seconds, 0)
            self.assertLessEqual(seconds, tavern.IMPORT_SECONDS)
            callback.append(function)
            return timer
        def blocked_header_read():
            callback[0]()
            raise OSError("synthetic transport closed")
        connection.getresponse.side_effect = blocked_header_read
        with patch.object(tavern.threading, "Timer", side_effect=timer_factory):
            response, _, _ = self.import_transport(connection)
        self.assertEqual(response.json["code"], "TAVERN_IMPORT_DOWNLOAD_FAILED")
        connection.sock.shutdown.assert_called_once_with(socket.SHUT_RDWR)
        timer.cancel.assert_called_once()
        self.assertEqual(connection.request.call_count, 1)

    def test_import_real_http_parser_reads_multiple_bounded_chunks(self):
        content = tavern.PNG_SIGNATURE + b"x" * 150000
        socket_stub = Mock()
        socket_stub.makefile.return_value = io.BytesIO(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: " + str(len(content)).encode() + b"\r\n\r\n" + content)
        response = http.client.HTTPResponse(socket_stub)
        response.begin()
        connection = self.transport()
        connection.getresponse.return_value = response
        result, _, _ = self.import_transport(connection, kind="lorebook")
        self.assertEqual(result.data, content)


if __name__ == "__main__":
    unittest.main()
