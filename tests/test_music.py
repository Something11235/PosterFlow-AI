import os
import unittest
from unittest.mock import Mock, patch

import requests

from backend import music_provider as provider, music_routes as routes, server

REQUEST_ID = "11111111-1111-4111-8111-111111111111"
USER_ID = "22222222-2222-4222-8222-222222222222"
TASK_ID = "task_test_0123456789"


class MusicProtocolTests(unittest.TestCase):
    def test_music_history_snapshot_keeps_only_text_and_base_parameters(self):
        snapshot = routes.music_prompt_snapshot({"model": "flowmusic", "sound_prompt": "爵士", "lyrics": "歌词", "api_key": "private-secret", "endpoint": "https://private.invalid", "audio_url": "https://private.invalid/track"})
        self.assertEqual(snapshot["parameters"], {"model": "flowmusic", "sound_prompt": "爵士", "lyrics": "歌词"})
        self.assertIn("爵士", snapshot["prompt"]); self.assertIn("歌词", snapshot["prompt"])
        self.assertNotIn("private", str(snapshot))

    def test_music_store_creates_history_atomically_with_reservation(self):
        store = object.__new__(routes.MusicStore)
        with patch.object(store, "rpc", return_value={"ok": True}) as rpc:
            store.begin("user-test", USER_ID, REQUEST_ID, "platform", {"model": "suno", "prompt": "钢琴"}, "v6")
        self.assertEqual(rpc.call_args.args[0], "begin_music_job_with_history")
        body = rpc.call_args.args[1]
        self.assertEqual(body["p_parameters"], {"model": "suno", "prompt": "钢琴"})
        self.assertEqual(body["p_user_id"], USER_ID)
        self.assertNotIn("credits_per_song", body)

    def test_all_selected_versions_use_verified_fields(self):
        for version in provider.SUNO_VERSIONS:
            with self.subTest(version=version):
                self.assertEqual(provider.build_music_request({"model": "suno", "version": version, "prompt": "钢琴"})["version"], version)
        pro = provider.build_music_request({"model": "flowmusic", "version": "lyria-3-pro", "sound_prompt": "钢琴"})
        self.assertNotIn("version", pro)
        lyria = provider.build_music_request({"model": "flowmusic", "version": "lyria-3.5", "lyrics": "歌词"})
        self.assertEqual(lyria["version"], "lyria-3.5")

    def test_invalid_models_versions_and_privileged_fields_are_rejected(self):
        for parameters in ({"model": "tts"}, {"model": []}, {"model": "suno", "version": "v5", "prompt": "hi"}, {"prompt": "hi", "max_mode": True}, {"prompt": "hi", "endpoint": "https://evil.invalid"}, {"prompt": "hi", "price": 0}):
            with self.subTest(parameters=parameters), self.assertRaises(provider.MusicError):
                provider.build_music_request(parameters)

    def test_custom_fields_are_omitted_in_inspiration_mode(self):
        body = provider.build_music_request({"prompt": "钢琴", "custom": False, "title": "private", "style": "jazz", "auto_lyrics": True})
        self.assertNotIn("title", body)
        self.assertNotIn("style", body)
        self.assertNotIn("auto_lyrics", body)

    def test_unicode_limits_and_zero_weights(self):
        self.assertEqual(len(provider.build_music_request({"prompt": "🎵" * 3000, "style_weight": 0})["prompt"]), 3000)
        self.assertEqual(provider.build_music_request({"prompt": "钢琴", "weirdness_constraint": 0})["weirdness_constraint"], 0)
        with self.assertRaises(provider.MusicError):
            provider.build_music_request({"prompt": "🎵" * 3001})

    def test_invalid_numeric_and_boolean_inputs(self):
        for patch_body in ({"style_weight": True}, {"style_weight": float("nan")}, {"audio_weight": 1.1}, {"custom": "true"}, {"custom": True, "instrumental": True, "duration": 10.5}):
            with self.subTest(body=patch_body), self.assertRaises(provider.MusicError):
                provider.build_music_request({"prompt": "钢琴", **patch_body})

    def test_flow_inputs_and_site_limits(self):
        body = provider.build_music_request({"model": "flowmusic", "lyrics": "歌词", "bpm": "120", "length": 240})
        self.assertEqual(body["bpm"], "120")
        for values in ({"sound_prompt": ""}, {"lyrics": "歌", "length": 241}, {"lyrics": "歌", "length": True}, {"lyrics": "歌", "bpm": "0"}, {"lyrics": "歌", "bpm": 120}):
            with self.subTest(values=values), self.assertRaises(provider.MusicError):
                provider.build_music_request({"model": "flowmusic", **values})

    def test_flow_outbound_json_matches_documented_field_types_for_both_versions(self):
        # Contract from the two official generation pages: bpm and seed are
        # strings, length is an integer; default/auto fields must be omitted.
        import json
        for version in provider.FLOW_VERSIONS:
            values = {"model": "flowmusic", "version": version, "sound_prompt": "piano", "lyrics": "original lyrics", "title": "My Song", "bpm": "120", "length": 60, "seed": "42"}
            body = provider.build_music_request(values)
            response = self.response(200, {"code": 200, "data": [{"task_id": TASK_ID}]})
            with patch.object(provider.requests, "request", return_value=response) as outgoing:
                self.assertEqual(provider.submit_music("test-key", body), TASK_ID)
            actual = json.loads(json.dumps(outgoing.call_args.kwargs["json"]))
            for field in ("model", "sound_prompt", "lyrics", "title", "bpm", "seed"):
                self.assertIs(type(actual[field]), str)
            self.assertIs(type(actual["length"]), int)
            self.assertEqual(actual["bpm"], "120")
            self.assertEqual(actual["length"], 60)
            self.assertEqual(actual.get("version"), "lyria-3.5" if version == "lyria-3.5" else None)

    def test_custom_vocals_need_lyrics_but_instrumental_may_omit_them(self):
        with self.assertRaises(provider.MusicError):
            provider.build_music_request({"custom": True})
        self.assertNotIn("prompt", provider.build_music_request({"custom": True, "instrumental": True}))

    def test_results_keep_original_indexes_and_variable_song_counts(self):
        result = provider.normalize_task({"data": {"id": TASK_ID, "status": "completed", "progress": 100, "result": {"music": [{"audio_url": "https://cdn.apimart.ai/1", "duration_seconds": "181.7"}, {"audio_url": "http://127.0.0.1/private"}, {"audio_url": "https://cdn.apimart.ai/3", "lyrics": "<script>text</script>"}]}}}, TASK_ID)
        self.assertEqual([track["audio_index"] for track in result["tracks"]], [1, 3])
        self.assertEqual(result["tracks"][0]["duration"], 181.7)
        self.assertEqual(result["tracks"][1]["lyrics"], "<script>text</script>")

    def test_media_urls_reject_private_or_unsafe_targets(self):
        for url in ("javascript:alert(1)", "http://example.com/1", "https://user:pass@example.com/1", "https://127.0.0.1/a", "https://169.254.169.254/a", "https://localhost/a", "https://host.internal/a", "https://example.com:123/a"):
            with self.subTest(url=url): self.assertEqual(provider.safe_media_url(url), "")

    def test_unknown_status_does_not_become_success_at_100_percent(self):
        result = provider.normalize_task({"data": {"id": TASK_ID, "status": "new_unknown_status", "progress": 100}}, TASK_ID)
        self.assertEqual(result["status"], "unknown")

    def test_wrong_task_or_malformed_result_is_not_accepted(self):
        for data in ({"id": "someone_else", "status": "completed"}, {"id": TASK_ID, "result": {"music": {}}}):
            with self.assertRaises(provider.MusicError): provider.normalize_task({"data": data}, TASK_ID)

    def test_network_timeout_has_unknown_submission_outcome(self):
        with patch.object(provider.requests, "request", side_effect=requests.Timeout):
            with self.assertRaises(provider.MusicError) as caught: provider.submit_music("secret-test", {"model": "suno"})
        self.assertTrue(caught.exception.uncertain)
        self.assertNotIn("secret-test", str(caught.exception))

    def response(self, status, payload):
        response = Mock(status_code=status)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        import json
        response.iter_content.return_value = [json.dumps(payload).encode()]
        return response

    def test_submission_uses_only_apimart_and_never_follows_redirects(self):
        with patch.object(provider.requests, "request", return_value=self.response(200, {"code": 200, "data": [{"status": "submitted", "task_id": TASK_ID}]})) as call:
            self.assertEqual(provider.submit_music("test-secret", {"model": "suno"}), TASK_ID)
        self.assertEqual(call.call_args.args[1], "https://api.apimart.ai/v1/music/generations")
        self.assertFalse(call.call_args.kwargs["allow_redirects"])
        self.assertEqual(call.call_args.kwargs["headers"]["Authorization"], "Bearer test-secret")

    def test_explicit_rejection_is_safe_but_server_errors_are_uncertain(self):
        for status, uncertain in ((400, False), (401, False), (429, False), (500, True), (502, True)):
            with self.subTest(status=status), patch.object(provider.requests, "request", return_value=self.response(status, {"error": {"message": "secret data"}})):
                with self.assertRaises(provider.MusicError) as caught: provider.submit_music("test-key", {})
                self.assertEqual(caught.exception.uncertain, uncertain)
                self.assertNotIn("secret data", str(caught.exception))

    def test_query_rejection_is_not_reported_as_generation_rejection(self):
        secret = "private-provider-text"
        for status in (401, 403, 404, 429, 500):
            response = self.response(status, {"error": {"message": secret, "code": "task_not_found"}})
            with self.subTest(status=status), patch.object(provider.requests, "request", return_value=response) as call, self.assertLogs(provider.logger, level="WARNING") as logs:
                with self.assertRaises(provider.MusicError) as caught:
                    provider.query_music("private-test-key", TASK_ID)
            self.assertIn(caught.exception.code, {"MUSIC_QUERY_REJECTED", "MUSIC_QUERY_UNAVAILABLE"})
            self.assertEqual(caught.exception.provider_status, status)
            self.assertEqual(caught.exception.provider_code, "task_not_found")
            self.assertIn("不表示生成失败", caught.exception.message)
            self.assertFalse(caught.exception.uncertain)
            self.assertNotIn(secret, " ".join(logs.output))
            self.assertNotIn("private-test-key", " ".join(logs.output))
            call.assert_called_once()
            self.assertEqual(call.call_args.args[0], "GET")

    def test_arbitrary_provider_error_codes_are_not_exposed(self):
        with patch.object(provider.requests, "request", return_value=self.response(404, {"error": {"code": "secret-provider-key"}})), self.assertLogs(provider.logger, level="WARNING") as logs:
            with self.assertRaises(provider.MusicError) as caught:
                provider.query_music("test-key", TASK_ID)
        self.assertEqual(caught.exception.provider_code, "other")
        self.assertNotIn("secret-provider-key", " ".join(logs.output))


    def test_custom_model_and_version_are_allowed_only_for_own_key(self):
        values = {"model": "provider/music-new", "version": "new-version", "parameter_format": "suno", "prompt": "钢琴"}
        with self.assertRaises(provider.MusicError): provider.build_music_request(values)
        body = provider.build_music_request(values, allow_custom=True)
        self.assertEqual(body["model"], "provider/music-new")
        self.assertEqual(body["version"], "new-version")
        self.assertNotIn("parameter_format", body)

    def test_empty_duration_is_represented_by_omitting_the_field(self):
        self.assertNotIn("length", provider.build_music_request({"model": "flowmusic", "lyrics": "歌词"}))
        self.assertNotIn("duration", provider.build_music_request({"model": "suno", "prompt": "钢琴"}))

    def test_custom_query_template_and_generation_host_must_match(self):
        endpoint, query = provider.custom_endpoints("https://music.example.invalid/v1/generations")
        self.assertEqual(query, "https://music.example.invalid/v1/tasks/{task_id}")
        for template in ("https://evil.invalid/task/{task_id}", "https://music.example.invalid/task/no-id", "https://music.example.invalid/task/{task_id}?key=secret"):
            with self.assertRaises(provider.MusicError): provider.custom_endpoints(endpoint, template)

    def test_dns_private_targets_are_blocked_before_connecting(self):
        with patch.object(provider.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 443))]), patch.object(provider.urllib3, "HTTPSConnectionPool") as pool:
            with self.assertRaises(provider.MusicError): provider.pinned_custom_response("POST", "https://music.example.invalid/generate", {}, {})
            pool.assert_not_called()

    def test_custom_transport_pins_public_ip_preserving_tls_hostname(self):
        pool = Mock()
        pool.urlopen.return_value = Mock(status=200)
        with patch.object(provider.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("8.8.8.8", 443))]), patch.object(provider.urllib3, "HTTPSConnectionPool", return_value=pool) as connection:
            response = provider.pinned_custom_response("POST", "https://music.example.invalid/generate", {"x-api-key": "test"}, {})
            self.assertEqual(connection.call_args.args[0], "8.8.8.8")
            self.assertEqual(connection.call_args.kwargs["server_hostname"], "music.example.invalid")
            self.assertFalse(pool.urlopen.call_args.kwargs["redirect"])
            self.assertFalse(pool.urlopen.call_args.kwargs["retries"])
            self.assertEqual(pool.urlopen.call_args.kwargs["headers"]["Host"], "music.example.invalid")
            response.close()
            pool.close.assert_called_once()

    def test_apimart_own_key_generation_uses_standard_transport_once(self):
        payload = {"code": 200, "data": [{"task_id": TASK_ID}]}
        endpoint = "https://api.apimart.ai/v1/music/generations"
        with patch.object(provider.requests, "request", return_value=self.response(200, payload)) as standard, patch.object(provider, "pinned_custom_response") as pinned:
            self.assertEqual(provider.submit_music("test-secret", {"model": "suno"}, endpoint), TASK_ID)
        pinned.assert_not_called()
        standard.assert_called_once()
        self.assertEqual(standard.call_args.args[:2], ("POST", endpoint))
        self.assertFalse(standard.call_args.kwargs["allow_redirects"])
        self.assertEqual(standard.call_args.kwargs["headers"]["Authorization"], "Bearer test-secret")

    def test_apimart_own_key_queries_use_the_same_standard_transport(self):
        endpoint = "https://api.apimart.ai/v1/music/tasks/{task_id}"
        payload = {"code": 200, "data": {"id": TASK_ID, "status": "processing"}}
        with patch.object(provider.requests, "request", return_value=self.response(200, payload)) as standard, patch.object(provider, "pinned_custom_response") as pinned:
            self.assertEqual(provider.query_music("test-secret", TASK_ID, endpoint)["status"], "processing")
        pinned.assert_not_called()
        self.assertEqual(standard.call_args.args[1], f"https://api.apimart.ai/v1/tasks/{TASK_ID}")

    def test_platform_music_queries_use_verified_unified_task_endpoint(self):
        payload = {"code": 200, "data": {"id": TASK_ID, "status": "completed", "progress": 100, "result": {"music": [{"audio_url": "https://cdn.apimart.ai/one.mp3"}, {"audio_url": "https://cdn.apimart.ai/two.mp3"}]}}}
        with patch.object(provider.requests, "request", return_value=self.response(200, payload)) as standard:
            result = provider.query_music("test-key", TASK_ID)
        self.assertEqual(standard.call_args.args[:2], ("GET", f"https://api.apimart.ai/v1/tasks/{TASK_ID}?language=zh"))
        self.assertEqual(len(result["tracks"]), 2)
        standard.assert_called_once()

    def test_only_exact_apimart_query_templates_are_canonicalized(self):
        for prefix in ("/v1/music/tasks/", "/v1/tasks/"):
            self.assertEqual(provider.trusted_apimart_url("GET", "https://api.apimart.ai" + prefix + TASK_ID), provider.TASKS_BASE + "/" + TASK_ID)
        for endpoint in (f"https://api.apimart.ai.evil.invalid/v1/tasks/{TASK_ID}", f"https://api.apimart.ai/v1/tasks/{TASK_ID}?token=private", "https://api.apimart.ai/v1/tasks/../generations"):
            self.assertIsNone(provider.trusted_apimart_url("GET", endpoint))

    def test_lookalike_hosts_and_unrecognized_paths_cannot_use_trusted_transport(self):
        for endpoint in ("https://api.apimart.ai.evil.invalid/v1/music/generations", "https://api.apimart.ai/private/path", "https://api.apimart.ai/v1/music/generations?token=value", "https://user:pass@api.apimart.ai/v1/music/generations", "https://api.apimart.ai/v1/music/tasks/../generations"):
            with self.subTest(endpoint=endpoint):
                self.assertIsNone(provider.trusted_apimart_url("POST", endpoint))
        endpoint = "https://music.example.invalid/v1/music/generations"
        with patch.object(provider, "pinned_custom_response", return_value=self.response(200, {"code": 200, "data": [{"task_id": TASK_ID}]})) as pinned, patch.object(provider.requests, "request") as standard:
            provider.submit_music("test-secret", {"model": "suno"}, endpoint)
        pinned.assert_called_once()
        standard.assert_not_called()

    def test_transport_failure_logs_only_types_and_never_replays_submission(self):
        secret = "secret-that-must-not-appear"
        with patch.object(provider.requests, "request", side_effect=requests.ConnectTimeout(secret)) as standard, self.assertLogs(provider.logger, level="WARNING") as logs:
            with self.assertRaises(provider.MusicError) as caught:
                provider.submit_music(secret, {"model": "suno"}, "https://api.apimart.ai/v1/music/generations")
        standard.assert_called_once()
        self.assertTrue(caught.exception.uncertain)
        self.assertNotIn(secret, " ".join(logs.output))
        self.assertIn("ConnectTimeout", " ".join(logs.output))


class MusicRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.headers = {"X-Billing-Mode": "own_key", "X-Music-Api-Key": "test-key", "X-Music-Endpoint": "https://music.example.invalid/v1/music/generations"}
        self.job = {"request_id": REQUEST_ID, "billing_mode": "own_key", "model": "suno", "version": "v6", "status": "submitted", "billing_status": "not_applicable", "provider_task_id": TASK_ID}
        self.store = Mock()
        self.store.begin.return_value = {"ok": True, "job": self.job, "existing": False}
        self.store.get.return_value = self.job
        self.store.apply.return_value = {"ok": True, "job": self.job}
        self.stack = __import__("contextlib").ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(routes, "MusicStore", return_value=self.store))
        self.stack.enter_context(patch.object(server, "optional_authenticated_user", return_value=None))
        server.REQUEST_RATE_WINDOWS.clear()

    def post(self, parameters=None):
        return self.client.post("/api/music/generations", headers=self.headers, json={"request_id": REQUEST_ID, "parameters": parameters or {"model": "suno", "prompt": "钢琴"}})

    def test_duplicate_intent_does_not_call_paid_provider_again(self):
        self.store.begin.return_value["existing"] = True
        with patch.object(routes, "submit_music") as paid:
            response = self.post()
        self.assertEqual(response.status_code, 200)
        paid.assert_not_called()

    def test_submission_does_not_charge_own_key_or_use_image_configuration(self):
        with patch.object(routes, "submit_music", return_value=TASK_ID) as paid:
            response = self.post()
        self.assertEqual(response.status_code, 202)
        self.assertEqual(paid.call_args.args[0], "test-key")
        self.assertEqual(self.store.begin.call_args.args[3], "own_key")
        self.assertNotIn("test-key", str(self.store.begin.call_args))
        self.assertNotIn("test-key", response.get_data(as_text=True))

    def test_bad_input_is_rejected_before_database_or_paid_request(self):
        with patch.object(routes, "submit_music") as paid:
            response = self.post({"model": "tts", "prompt": "hi"})
        self.assertEqual(response.status_code, 400)
        self.store.begin.assert_not_called(); paid.assert_not_called()

    def test_unknown_submission_is_recorded_without_refund(self):
        with patch.object(routes, "submit_music", side_effect=provider.MusicError("MUSIC_SUBMISSION_UNKNOWN", "unknown", 503, True)):
            response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.store.apply.call_args.args[2], "submission_unknown")

    def test_explicit_rejection_marks_failure(self):
        with patch.object(routes, "submit_music", side_effect=provider.MusicError("MUSIC_PROVIDER_REJECTED", "rejected", 502)):
            self.post()
        self.assertEqual(self.store.apply.call_args.args[2], "rejected")

    def test_platform_requires_login(self):
        with patch.dict(os.environ, {"APIMART_MUSIC_API_KEY": "platform-test"}):
            response = self.client.post("/api/music/generations", headers={"X-Billing-Mode": "platform"}, json={"request_id": REQUEST_ID, "parameters": {"prompt": "hi"}})
        self.assertEqual(response.status_code, 401)
        self.store.begin.assert_not_called()

    def test_guest_owner_scope_depends_on_key_and_not_browser_user_id(self):
        with patch.object(routes, "submit_music", return_value=TASK_ID): self.post()
        first = self.store.begin.call_args.args[0]
        self.headers["X-Music-Api-Key"] = "another-test-key"
        with patch.object(routes, "submit_music", return_value=TASK_ID): self.post()
        self.assertNotEqual(first, self.store.begin.call_args.args[0])

    def test_query_is_owner_scoped_and_settles_trusted_count(self):
        with patch.object(routes, "query_music", return_value={"status": "completed", "tracks": [{"audio_index": 1}, {"audio_index": 2}], "progress": 100, "error_code": None}):
            self.client.get(f"/api/music/tasks/{REQUEST_ID}", headers=self.headers)
        self.assertTrue(self.store.get.call_args.args[0].startswith("guest-"))
        self.assertEqual(self.store.apply.call_args.kwargs["count"], 2)

    def test_insufficient_settlement_balance_does_not_release_tracks(self):
        self.store.apply.return_value = {"job": {**self.job, "billing_mode": "platform", "billing_status": "awaiting_balance", "generated_count": 2}}
        with patch.object(routes, "query_music", return_value={"status": "completed", "tracks": [{"audio_index": 1}], "progress": 100, "error_code": None}):
            response = self.client.get(f"/api/music/tasks/{REQUEST_ID}", headers=self.headers)
        self.assertEqual(response.json["tracks"], [])

    def test_missing_media_is_not_an_automatic_refund(self):
        with patch.object(routes, "query_music", return_value={"status": "completed", "tracks": [], "progress": 100}):
            response = self.client.get(f"/api/music/tasks/{REQUEST_ID}", headers=self.headers)
        self.assertIn("warning", response.json); self.store.apply.assert_not_called()

    def test_query_rejection_keeps_the_original_intent_and_reservation(self):
        failure = provider.MusicError("MUSIC_QUERY_REJECTED", "查询被拒绝", 502, provider_status=404, provider_code="task_not_found")
        with patch.object(routes, "query_music", side_effect=failure), patch.object(routes, "submit_music") as paid:
            response = self.client.get(f"/api/music/tasks/{REQUEST_ID}", headers=self.headers)
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json["code"], "MUSIC_QUERY_REJECTED")
        self.assertEqual(response.json["provider_status"], 404)
        self.assertEqual(response.json["provider_code"], "task_not_found")
        self.store.apply.assert_not_called(); paid.assert_not_called()

    def test_old_refunded_task_can_show_newly_queried_chinese_reason(self):
        self.store.get.return_value = {"request_id": REQUEST_ID, "provider_task_id": TASK_ID, "status": "failed", "billing_status": "refunded", "error_code": "MUSIC_TASK_FAILED"}
        self.store.apply.return_value = {"ok": True, "job": self.store.get.return_value, "balance": 10}
        with patch.object(routes, "query_music", return_value={"status": "failed", "tracks": [], "progress": 0, "error_code": "MUSIC_LYRICS_COPYRIGHT"}):
            response = self.client.get("/api/music/tasks/" + REQUEST_ID, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertIn("歌词包含受版权保护", response.json["job"]["failure_reason"])
        self.assertEqual(response.json["job"]["error_code"], "MUSIC_LYRICS_COPYRIGHT")
        self.assertEqual(response.json["job"]["billing_status"], "refunded")

    def test_flow_failed_task_refresh_translates_cause_without_resubmit_or_changing_refund(self):
        self.store.get.return_value = {"request_id": REQUEST_ID, "provider_task_id": TASK_ID, "model": "flowmusic", "status": "failed", "billing_status": "refunded", "charged_credits": 0, "error_code": "MUSIC_TASK_FAILED"}
        self.store.apply.return_value = {"ok": True, "job": self.store.get.return_value, "balance": 10}
        raw = {"data": {"id": TASK_ID, "status": "failed", "error": {"message": "flowmusic submit failed: Request parameter type mismatch"}}}
        with patch.object(provider, "apimart_request", return_value=raw) as http, patch.object(routes, "submit_music") as paid:
            response = self.client.get("/api/music/tasks/" + REQUEST_ID, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertIn("请求参数类型不匹配", response.json["job"]["failure_reason"])
        self.assertNotIn("版权", response.json["job"]["failure_reason"])
        self.assertEqual(response.json["job"]["charged_credits"], 0)
        self.assertEqual(response.json["job"]["billing_status"], "refunded")
        self.assertEqual(self.store.apply.call_args.kwargs["error_code"], "MUSIC_PARAMETER_TYPE_MISMATCH")
        paid.assert_not_called()
        self.assertEqual(http.call_args.args[0], "GET")

    def test_cross_origin_submission_is_rejected(self):
        self.headers["Origin"] = "https://evil.invalid"
        self.assertEqual(self.post().status_code, 403)
        self.store.begin.assert_not_called()

    def test_private_no_store_and_no_sensitive_database_fields(self):
        self.store.jobs.return_value = [{**self.job, "request_fingerprint": "not-public", "owner_scope": "not-public"}]
        response = self.client.get("/api/music/tasks", headers=self.headers)
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")
        self.assertNotIn("not-public", response.get_data(as_text=True))

    def test_scheduler_rejects_missing_credentials(self):
        self.assertEqual(self.client.post("/api/music/reconcile").status_code, 401)

    def test_platform_ignores_browser_provider_address_and_key(self):
        self.headers["X-Billing-Mode"] = "platform"
        with patch.dict(os.environ, {"APIMART_MUSIC_API_KEY": "platform-synthetic"}), patch.object(server, "optional_authenticated_user", return_value=Mock(id=USER_ID)), patch.object(routes, "submit_music", return_value=TASK_ID) as paid:
            response = self.post()
        self.assertEqual(response.status_code, 202)
        self.assertEqual(len(paid.call_args.args), 2)
        self.assertEqual(paid.call_args.args[0], "platform-synthetic")
        self.assertEqual(self.store.begin.call_args.args[0], f"user-{USER_ID}")

    def test_changing_provider_address_isolates_own_key_task_scope(self):
        with patch.object(routes, "submit_music", return_value=TASK_ID): self.post()
        first = self.store.begin.call_args.args[0]
        self.headers["X-Music-Endpoint"] = "https://another.example.invalid/generate"
        with patch.object(routes, "submit_music", return_value=TASK_ID): self.post()
        self.assertNotEqual(first, self.store.begin.call_args.args[0])


if __name__ == "__main__":
    unittest.main()


class MusicFailureReasonTests(unittest.TestCase):
    def test_explicit_audio_policy_and_general_moderation_are_distinct(self):
        from backend.admin_multimedia import explanation
        examples = {
            "This audio might violate our prohibited use policy and can't be uploaded.": "MUSIC_AUDIO_POLICY_REJECTED",
            "你的请求未通过内容安全审核，请调整提示词或输入素材后重试。": "MUSIC_CONTENT_REJECTED",
            "This audio can't be uploaded.": "MUSIC_TASK_FAILED",
        }
        for message, code in examples.items():
            with self.subTest(code=code):
                data = {"id": TASK_ID, "status": "failed", "error": {"message": message}}
                self.assertEqual(provider.normalize_task({"data": data}, TASK_ID)["error_code"], code)
        label, reason = explanation("music", "MUSIC_AUDIO_POLICY_REJECTED")
        self.assertEqual(label, "参考音频上传审核")
        self.assertIn("未说明", reason)
        self.assertNotIn("版权", reason)

    def test_cover_generic_service_failure_is_neutral_but_specific_copyright_wins(self):
        result = provider.normalize_task({"data": {"id": TASK_ID, "status": "failed", "error": "Job failed,Please try again later."}}, TASK_ID)
        self.assertEqual(result["error_code"], "MUSIC_PROVIDER_JOB_FAILED")
        reason = provider.failure_reason(result["error_code"])
        self.assertIn("未提供具体失败原因", reason)
        self.assertNotIn("版权", reason)
        result = provider.normalize_task({"data": {"id": TASK_ID, "status": "failed", "error": "Job failed,Please try again later. Your lyrics contain copyrighted material."}}, TASK_ID)
        self.assertEqual(result["error_code"], "MUSIC_LYRICS_COPYRIGHT")

    def test_flow_parameter_type_failure_is_not_misclassified_as_copyright(self):
        from backend.admin_multimedia import explanation
        raw = 'flowmusic submit failed: Request parameter type mismatch (raw: {"status":"FAILED","message":"Request parameter type mismatch","data":null})'
        for fields in ({"error": {"message": raw}}, {"message": raw}, {"error_message": raw}, {"failure_reason": raw}, {"result": {"error": {"message": raw}}}):
            with self.subTest(fields=list(fields)):
                result = provider.normalize_task({"data": {"id": TASK_ID, "status": "failed", **fields}}, TASK_ID)
                self.assertEqual(result["error_code"], "MUSIC_PARAMETER_TYPE_MISMATCH")
                visible = routes.public_job({"status": "failed", "error_code": result["error_code"], "billing_status": "refunded", "charged_credits": 0})
                self.assertIn("请求参数类型不匹配", visible["failure_reason"])
                self.assertNotIn("版权", visible["failure_reason"])
                self.assertNotIn("flowmusic submit", str(visible))
                self.assertEqual(explanation("music", result["error_code"])[0], "请求参数类型")

    def test_type_rejection_is_not_a_new_submission_or_a_raw_log_disclosure(self):
        raw = 'Request parameter type mismatch key=private-test-key https://private.invalid/?token=private'
        response = MusicProtocolTests.response(self, 400, {"error": {"message": raw}})
        with patch.object(provider.requests, "request", return_value=response) as request:
            with self.assertRaises(provider.MusicError) as caught:
                provider.submit_music("private-test-key", {"model": "flowmusic", "sound_prompt": "piano"})
        request.assert_called_once()
        self.assertFalse(caught.exception.uncertain)
        self.assertEqual(caught.exception.reason_code, "MUSIC_PARAMETER_TYPE_MISMATCH")
        self.assertNotIn("private", caught.exception.message)

    def test_response_song_content_cannot_be_used_as_a_failure_explanation(self):
        result = provider.normalize_task({"data": {"id": TASK_ID, "status": "failed", "title": "copyright artist name", "result": {"music": [{"lyrics": "Request parameter type mismatch", "title": "copyright"}]}}}, TASK_ID)
        self.assertEqual(result["error_code"], "MUSIC_TASK_FAILED")

    def test_log_reason_is_translated_to_safe_persistent_category(self):
        result = provider.normalize_task({"data": {"id": TASK_ID, "status": "failed", "error": {"message": "Your lyrics contain copyrighted material. Please change it and try again."}}}, TASK_ID)
        self.assertEqual(result["error_code"], "MUSIC_LYRICS_COPYRIGHT")
        visible = routes.public_job({"status": "failed", "error_code": result["error_code"]})
        self.assertIn("歌词包含受版权保护", visible["failure_reason"])
        self.assertNotIn("copyrighted", str(visible))

    def test_unknown_error_never_echoes_keys_urls_or_raw_prompt(self):
        raw = "private prompt with https://private.invalid/token?key=hidden bearer-secret-material"
        result = provider.normalize_task({"data": {"id": TASK_ID, "status": "failed", "error": {"message": raw}}}, TASK_ID)
        self.assertEqual(result["error_code"], "MUSIC_TASK_FAILED")
        self.assertNotIn(raw, str(result))
        self.assertNotIn("private.invalid", routes.public_job({"status": "failed", "error_code": raw})["failure_reason"])

    def test_rejected_submission_shows_reason_without_raw_error(self):
        raw = "Your lyrics contain copyrighted material. key=private-test-key"
        response = MusicProtocolTests.response(self, 400, {"error": {"message": raw}})
        with patch.object(provider.requests, "request", return_value=response):
            with self.assertRaises(provider.MusicError) as caught:
                provider.submit_music("private-test-key", {})
        self.assertFalse(caught.exception.uncertain)
        self.assertEqual(caught.exception.reason_code, "MUSIC_LYRICS_COPYRIGHT")
        self.assertIn("受版权保护", caught.exception.message)
        self.assertNotIn("private-test-key", caught.exception.message)
