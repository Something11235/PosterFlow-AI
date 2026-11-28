import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask

from backend import ppt_routes
from backend.ppt_document import InvalidDocument, prepare, result_document


RID = "17d6b51f-2243-4624-9177-68086fb47ef0"
USAGE = {"status": "confirmed", "input_tokens": 200, "output_tokens": 50, "total_tokens": 250}
SLIDE = {"id": "s1", "title": "预算", "background": "#FFFFFF", "elements": [
    {"id": "e1", "type": "text", "x": 60, "y": 30, "w": 600, "h": 100, "text": "预算"},
    {"id": "e2", "type": "rect", "x": 60, "y": 300, "w": 240, "h": 60, "fill": "#AACCEE"}]}


class PptGenerationTests(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        class ProviderError(Exception):
            pass
        self.server = SimpleNamespace(ALLOWED_ORIGINS=[], require_authenticated_user=Mock(return_value=SimpleNamespace(id="owner")),
                                      enforce_rate_limit=Mock(), ProviderError=ProviderError)
        app.register_blueprint(ppt_routes.create_ppt_blueprint(self.server))
        self.client = app.test_client()
        self.payload = {"topic": "年度预算", "page_count": 1, "request_id": RID}
        self.answer = Mock(return_value={"content": json.dumps({"title": "预算", "slides": [SLIDE]}), "usage": USAGE})
        def reply(*args, **kwargs):
            yield from ()
            return self.answer()
        self.model = patch.object(ppt_routes, "provider_reply", side_effect=reply).start()
        self.store = patch.object(ppt_routes, "rpc").start()
        self.record = {}
        def rpc(name, params):
            if name == "begin_ppt_request" and not self.record:
                self.record = {"request_id": RID, "status": "processing"}
                return {"ok": True, "request": self.record, "leader": True}
            if name == "finish_ppt_request":
                self.record = {"request_id": RID, "status": "succeeded" if params["p_result"] else "failed",
                               **(params["p_result"] or {}), "error_code": params["p_error_code"]}
            return {"ok": True, "request": self.record, "leader": False}
        self.store.side_effect = rpc
        patch.dict("os.environ", {"PLATFORM_PPT_API_KEY": "test-only", "PLATFORM_PPT_API_ENDPOINT": ppt_routes.DEFAULT_ENDPOINT}).start()
        self.addCleanup(patch.stopall)

    def test_failed_outline_preserves_safe_diagnostic_and_usage(self):
        for content, reason in [
            ('{"sensitive_text":', 'JSON 解析失败'),
            (json.dumps({"slides": [{}, {}]}), "要求 1 页，实际返回 2 页"),
            (json.dumps({"slides": [{"title": "sensitive_text"}]}), "大纲第 1 页的内容提要缺失"),
        ]:
            with self.subTest(reason=reason):
                self.record = {}
                self.answer.return_value = {"content": content, "usage": USAGE}
                with self.assertLogs(ppt_routes.__name__, level="WARNING") as log:
                    response = self.client.post("/api/ppt/outline", json=self.payload)
                self.assertEqual(response.json["error"]["code"], "PPT_RESULT_INVALID")
                finish = self.store.call_args.args[1]
                self.assertIsNone(finish["p_result"])
                self.assertEqual(finish["p_usage"], USAGE)
                self.assertIn(reason, finish["p_diagnostic"])
                self.assertNotIn("sensitive_text", finish["p_diagnostic"] + str(log.output))

    def test_all_model_rates_and_request_caps(self):
        config = self.client.get("/api/ppt/config").json
        self.assertEqual(config["default_model"], "gpt-6.2-astra")
        self.assertEqual([[m["id"], m["credits_per_million"]["input"], m["credits_per_million"]["output"],
                           m["credits_per_million"]["cache_read"]] for m in config["models"]],
                         [["gpt-6.2-astra",48,240,2.4], ["gpt-6.2-sol",12,60,0.6], ["deepseek-v4.1-flash",12,48,0.24]])
        for model in ppt_routes.MODELS:
            self.record = {}
            r = self.client.post("/api/ppt/generate", json={**self.payload, "model": model})
            self.assertEqual(r.status_code, 200)
            body = self.model.call_args.args[2]
            self.assertEqual(body["model"], model)
            self.assertEqual(body["response_format"], {"type": "json_object"})
            self.assertGreater(body["max_tokens" if model.startswith("deepseek") else "max_completion_tokens"], 0)
            self.assertIn("Roster", body["messages"][0]["content"])
            remaining = self.model.call_args.args[3] - time.monotonic()
            self.assertGreater(remaining, 0)
            self.assertLessEqual(remaining, 120)
            self.assertIs(self.model.call_args.kwargs["usage_reader"],ppt_routes.ppt_usage)
            self.assertEqual(r.json["deck"]["slides"][0]["title"], "预算")
        self.assertEqual([m["credits_per_million"].get("cache_write") for m in config["models"]],[60,15,None])

    def test_ppt_credentials_are_isolated_from_tavern_and_shared_across_models(self):
        env = {"PLATFORM_TAVERN_API_KEY": "tavern-only",
               "PLATFORM_TAVERN_API_ENDPOINT": "https://tavern.example/v1/chat/completions"}
        with patch.dict("os.environ", env, clear=True):
            for model in ppt_routes.MODELS:
                response = self.client.post("/api/ppt/generate", json={**self.payload, "model": model})
                self.assertEqual(response.json["code"], "PPT_MODEL_UNAVAILABLE")
            self.model.assert_not_called()
            self.store.assert_not_called()
        group_keys = {"PLATFORM_PPT_GPT_API_KEY": "ppt-gpt", "PLATFORM_PPT_DEEPSEEK_API_KEY": "ppt-ds"}
        with patch.dict("os.environ", {**env, **group_keys}, clear=True):
            for model in ppt_routes.MODELS:
                expected = "ppt-ds" if model == "deepseek-v4.1-flash" else "ppt-gpt"
                self.assertEqual(ppt_routes.model_settings(model), (ppt_routes.DEFAULT_ENDPOINT, expected))
            with patch.dict("os.environ", {"PLATFORM_PPT_API_KEY": "ppt-shared"}):
                for model in ppt_routes.MODELS:
                    self.assertEqual(ppt_routes.model_settings(model), (ppt_routes.DEFAULT_ENDPOINT, "ppt-shared"))

    def test_cache_write_is_an_input_subset(self):
        raw = {"prompt_tokens":1000,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":150,"cache_write_tokens":650}}
        self.assertEqual(ppt_routes.ppt_usage(raw)["cache_write_tokens"],650)
        self.assertEqual(ppt_routes.ppt_usage(raw)["total_tokens"],1010)
        raw["prompt_tokens_details"]["cache_write_tokens"] = 860
        self.assertEqual(ppt_routes.ppt_usage(raw)["status"],"invalid")
        del raw["prompt_tokens_details"]["cache_write_tokens"]
        self.assertNotIn("cache_write_tokens",ppt_routes.ppt_usage(raw))

    def test_replay_and_read_never_trigger_provider(self):
        seen = self.client.post("/api/ppt/generate", json=self.payload).json
        self.assertEqual(self.client.post("/api/ppt/generate", json=self.payload).json, seen)
        self.assertEqual(self.client.get("/api/ppt/requests/"+RID).json, seen)
        self.model.assert_called_once()
        self.assertEqual(self.store.call_args.args[1], {"p_user_id":"owner", "p_request_id":RID})

    def test_real_sse_yields_preview_then_validated_result_and_usage(self):
        from backend.tavern_stream import completion_deltas
        content = json.dumps(SLIDE, ensure_ascii=False)
        def upstream(endpoint, key, body, deadline, *, usage_reader, **kwargs):
            self.assertTrue(body["stream_options"]["include_usage"])
            self.assertLessEqual(deadline - time.monotonic(), 120)
            def wire(choices, **data):
                return ("data: " + json.dumps({"choices": choices, **data}) + "\n\n").encode()
            chunks = [wire([{"delta": {"content": content[i:i+4]}}]) for i in range(0, len(content), 4)]
            chunks += [wire([{"delta": {}, "finish_reason": "stop"}]),
                       wire([], usage={"prompt_tokens": 200, "completion_tokens": 50})]
            return (yield from completion_deltas(chunks, usage_reader, 65000, lambda _: ValueError()))
        self.model.side_effect = upstream
        payload = {**self.payload, "page_index": 0, "outline": {"title":"预算", "slides":[{"title":"预算","brief":"比较本季预算"}]}}
        response = self.client.post("/api/ppt/page", json=payload, headers={"Accept":"application/x-ndjson"}, buffered=False)
        self.assertEqual(response.mimetype, "application/x-ndjson")
        frames = map(json.loads, response.response)
        self.assertEqual(next(frames)["type"], "start")
        self.assertEqual(self.record["status"], "processing")
        visible = []
        for frame in frames:
            visible.append(frame)
            if frame["type"] == "element":
                break
        self.assertEqual(visible[-1]["element"]["id"], "e1")
        self.assertTrue(any(frame["type"] == "progress" for frame in visible))
        self.assertEqual(self.record["status"], "processing")
        terminal = list(frames)[-1]
        self.assertEqual(terminal["data"]["slide"]["id"], "s1")
        self.assertEqual(self.store.call_args.args[1]["p_usage"]["total_tokens"], 250)
        response.close()
        self.assertEqual(self.client.get("/api/ppt/requests/"+RID).json["slide"], terminal["data"]["slide"])
        self.assertEqual(self.client.post("/api/ppt/page", json=payload, headers={"Accept":"application/x-ndjson"}).json,
                         terminal["data"])
        self.model.assert_called_once()

    def test_structured_stop_reasons_preserve_actual_usage_on_json_and_sse(self):
        from backend import tavern_routes as transport

        self.model.side_effect = transport.provider_reply
        outline = json.dumps({"title": "预算", "slides": [{"title": "收入", "brief": "分析收入"}]})
        raw_usage = {"prompt_tokens": 200, "completion_tokens": 50, "prompt_tokens_details": {"cache_write_tokens": 7}}
        for streamed in (False, True):
            for stop, message, expected in [
                ("length", {"content": '{"slides": ['}, "输出 Token 上限"),
                ("length", {"content": ""}, "输出 Token 上限"),
                ("content_filter", {"content": outline}, "拒绝输出"),
                ("stop", {"content": None, "refusal": "private response"}, "拒绝输出"),
                ("length", {"content": outline}, None),
            ]:
                with self.subTest(streamed=streamed, stop=stop, expected=expected):
                    self.record = {}
                    self.store.reset_mock()
                    connection = Mock()
                    response = connection.getresponse.return_value
                    response.status = 200
                    response.isclosed.return_value = False
                    if streamed:
                        response.getheader.return_value = "text/event-stream"
                        frames = [{"choices": [{"delta": message}]}, {"choices": [{"finish_reason": stop}]},
                                  {"choices": [], "usage": raw_usage}]
                        wire = b"".join(("data: " + json.dumps(frame) + "\n\n").encode() for frame in frames)
                    else:
                        wire = json.dumps({"choices": [{"message": message, "finish_reason": stop}], "usage": raw_usage}).encode()
                    response.read1.side_effect = [wire, b""]
                    with patch.object(transport, "resolve_public_host", return_value=["8.8.8.8"]), patch.object(transport, "PinnedConnection", return_value=connection):
                        result = self.client.post("/api/ppt/outline", json=self.payload,
                                                  headers={"Accept": "application/x-ndjson"} if streamed else {})
                        if streamed:
                            record = json.loads(result.get_data().splitlines()[-1])["data"]
                        else:
                            record = result.json
                    finish = self.store.call_args.args[1]
                    self.assertEqual(self.store.call_count, 2)
                    connection.request.assert_called_once()
                    self.assertEqual(finish["p_usage"]["cache_write_tokens"], 7)
                    self.assertEqual(finish["p_usage"]["total_tokens"], 250)
                    if expected:
                        self.assertEqual(record["error"]["code"], "PPT_RESULT_INVALID")
                        self.assertIn(expected, finish["p_diagnostic"])
                        self.assertIsNone(finish["p_result"])
                    else:
                        self.assertEqual(record["outline"]["title"], "预算")

    def test_disconnect_drains_original_response_and_settles_once(self):
        out = '{"title":"预算","slides":[{"title":"一季度","brief":"分析收支"}]}'
        def upstream(*args, **kwargs):
            yield out[:12]
            yield out[12:]
            return {"content":out, "usage":USAGE}
        self.model.side_effect = upstream
        response = self.client.post("/api/ppt/outline", json=self.payload, headers={"Accept":"application/x-ndjson"}, buffered=False)
        frames = iter(response.response)
        self.assertEqual(json.loads(next(frames))["type"], "start")
        self.assertEqual(json.loads(next(frames))["type"], "progress")
        response.close()
        self.assertEqual(self.record["outline"]["title"], "预算")
        self.assertEqual(self.store.call_args.args[1]["p_usage"], USAGE)
        self.assertEqual(self.store.call_count, 2)
        self.model.assert_called_once()

    def test_generation_budget_starts_after_reservation(self):
        # Simulate a slow authentication/DB round trip before either stage.
        original_rpc = self.store.side_effect
        with patch.object(ppt_routes.time, "monotonic", return_value=1000) as clock:
            def slow_begin(name, params):
                if name == "begin_ppt_request":
                    clock.return_value += 15
                return original_rpc(name, params)
            self.store.side_effect = slow_begin
            for kind in ("outline", "page"):
                self.record = {}
                payload = {**self.payload, "page_index": 0, "outline": {
                    "title":"预算", "slides":[{"title":"预算","brief":"收支"}]}}
                self.answer.return_value = {"content": json.dumps(payload["outline"] if kind == "outline" else SLIDE),
                                            "usage": USAGE}
                self.assertEqual(self.client.post("/api/ppt/" + kind, json=payload).json["status"], "succeeded")
                self.assertEqual(self.model.call_args.args[3] - clock.return_value, 120)

    def test_regenerate_page_validates_before_billing_and_replays_same_page(self):
        raw_slide = {**SLIDE, "id": "manually-added-page"}
        outline = {"title": "年度预算", "slides": [{"title": "预算", "brief": "分析支出"}]}
        payload = {**self.payload, "outline": outline, "page_index": 0, "regenerate": {"slide": raw_slide}}
        bad = [None, {}, {"slide": []}, {"slide": {**raw_slide, "title": "其他页"}},
               {"slide": {**raw_slide, "id": []}}, {"slide": raw_slide, "instruction": "a" * 6001},
               {"slide": raw_slide, "instruction": "data:image/png;base64,AAA"},
               {"slide": {**raw_slide, "elements": [{**SLIDE["elements"][0], "type": "image",
                                                        "src": "data:image/png;base64,AAA"}]}}]
        for regenerate in bad:
            with self.subTest(regenerate=regenerate):
                response = self.client.post("/api/ppt/page", json={**payload, "regenerate": regenerate})
                self.assertEqual(response.json["code"], "PPT_INPUT_INVALID")
        self.assertEqual(self.client.post("/api/ppt/outline", json=payload).json["code"], "PPT_INPUT_INVALID")
        self.model.assert_not_called()
        self.store.assert_not_called()
        self.answer.return_value = {"content": json.dumps(SLIDE), "usage": USAGE}
        first = self.client.post("/api/ppt/page", json=payload).json
        self.assertEqual(first["slide"]["id"], raw_slide["id"])
        self.assertEqual(self.store.call_args_list[0].args[1]["p_kind"], "page")
        self.assertEqual(self.store.call_args_list[1].args[1]["p_usage"], USAGE)
        self.assertEqual(self.client.post("/api/ppt/page", json=payload).json, first)
        self.assertEqual(self.client.get("/api/ppt/requests/"+RID).json, first)
        self.model.assert_called_once()

    def test_stream_rejection_can_negotiate_but_timeout_never_replays(self):
        calls = []
        def upstream(endpoint, key, body, deadline, **kw):
            yield from ()
            calls.append((body["stream"], deadline))
            if body["stream"]:
                raise ppt_routes.TavernError("TAVERN_STREAM_UNSUPPORTED", "", 400)
            return {"content":'{"title":"预算","slides":[{"title":"一季度","brief":"分析收支"}]}', "usage":USAGE}
        self.model.side_effect = upstream
        req = lambda: self.client.post("/api/ppt/outline", json=self.payload, headers={"Accept":"application/x-ndjson"})
        self.assertEqual(json.loads(req().data.splitlines()[-1])["data"]["status"], "succeeded")
        self.assertEqual([v[0] for v in calls], [True, False])
        self.assertEqual(calls[0][1], calls[1][1])
        self.record = {}
        self.model.reset_mock()
        self.model.side_effect = ppt_routes.TavernError("TAVERN_MODEL_TIMEOUT", "", 504, True)
        self.assertEqual(json.loads(req().data.splitlines()[-1])["data"]["error"]["code"], "PPT_PROVIDER_TIMEOUT")
        self.model.assert_called_once()
        self.assertIsNone(self.store.call_args.args[1]["p_result"])

    def test_original_text_edits_stream_recover_and_settle_as_one_page(self):
        edit = {"page_id": "import-25", "deck_title": "课题汇报", "title": "实验结果",
                "blocks": [{"id": "b1", "text": "  轨迹误差\n"},
                           {"id": "table_4_2", "text": ""}], "instruction": "根据论文补充实验数据。",
                "nearby_titles": ["方法"]}
        ref = {"name": "论文", "text": "背景。" * 1500 + "\n轨迹误差降低 12%。"}
        data = {**self.payload, "page_count": 28, "page_index": 24, "original_edit": edit,
                "references": [ref], "template_source": {"name": "参考汇报.pptx", "text": "保留百分号。"}}
        changes = [{"id": "table_4_2", "text": "  12%\n"}]
        content = json.dumps({"page_id": edit["page_id"], "edits": changes}, ensure_ascii=False)
        def provider(*args, **kwargs):
            yield content[:30]
            yield content[30:]
            return {"content": content, "usage": USAGE}
        self.model.side_effect = provider
        response = self.client.post("/api/ppt/page", json=data, headers={"Accept": "application/x-ndjson"})
        frames = [json.loads(line) for line in response.data.splitlines()]
        record = frames[-1]["data"]
        self.assertEqual("".join(frame["text"] for frame in frames if frame["type"] == "progress"), "  12%\n")
        self.assertFalse(any(frame["type"] == "element" for frame in frames))
        self.assertEqual(record["slide"]["original_edits"], changes)
        self.assertEqual(record["slide"]["id"], edit["page_id"])
        self.assertEqual(self.store.call_args_list[0].args[1]["p_kind"], "page")
        self.assertEqual(self.store.call_args_list[1].args[1]["p_usage"], USAGE)
        messages = self.model.call_args.args[2]["messages"]
        ctx = json.loads(messages[1]["content"])
        self.assertEqual([ctx["page_number"], ctx["page_count"]], [25, 28])
        self.assertEqual(ctx["blocks"], edit["blocks"])
        self.assertIn("12%", ctx["references"][0]["text"])
        self.assertIn("保留百分号", ctx["template_source"]["text"])
        self.assertNotIn("1280×720", messages[0]["content"])
        self.assertEqual(self.client.get("/api/ppt/requests/"+RID).json, record)
        self.assertEqual(self.client.post("/api/ppt/page", json=data).json, record)
        self.model.assert_called_once()

    def test_original_text_edit_rejects_bad_selection_before_reserving_and_invalid_results_release(self):
        edit = {"page_id": "src1", "title": "标题", "deck_title": "原稿",
                "blocks": [{"id": "a", "text": "正文"}, {"id": "b", "text": ""}]}
        payload = {**self.payload, "page_index": 0, "original_edit": edit}
        for invalid in ({"page_index": True}, {"page_index": 1}, {"page_count": "auto"}, {"outline": {}},
                        {"original_edit": {**edit, "blocks": []}},
                        {"original_edit": {**edit, "blocks": [edit["blocks"][0]]*2}},
                        {"original_edit": {**edit, "blocks": [{"id": "a", "text": "x", "src": "pic"}]}},
                        {"original_edit": {**edit, "blocks": [{"id": "a", "text": "X"*12001}]}}):
            with self.subTest(invalid=invalid):
                response = self.client.post("/api/ppt/page", json={**payload, **invalid})
                self.assertEqual(response.json["code"], "PPT_INPUT_INVALID")
        for kind in ("outline", "generate", "edit", "chat"):
            self.assertEqual(self.client.post("/api/ppt/"+kind, json=payload).json["code"], "PPT_INPUT_INVALID")
        self.store.assert_not_called()
        self.model.assert_not_called()
        for result in ({"page_id": "src1", "edits": [{"id": "chart", "text": "9%"}]},
                       {"page_id": "wrong", "edits": []}, {"page_id": "src1", "edits": [edit["blocks"][0]]*2},
                       {"page_id": "src1", "edits": [{"id": "a", "text": "ok", "fill": "#FFFFFF"}]},
                       {"page_id": "src1", "edits": [{"id": "a", "text": "x"*12001}]}):
            with self.subTest(result=result):
                self.record = {}
                self.answer.return_value = {"content": json.dumps(result), "usage": USAGE}
                response = self.client.post("/api/ppt/page", json=payload)
                self.assertEqual(response.json["error"]["code"], "PPT_RESULT_INVALID")
                self.assertIsNone(self.store.call_args.args[1]["p_result"])
        # A no-op or intentional deletion must also satisfy finish_ppt_request's
        # visible-text constraint and preserve an explicit empty replacement.
        for edits, expected in (([], []), ([edit["blocks"][0]], []),
                                ([{"id": "a", "text": ""}], [{"id": "a", "text": ""}])):
            self.record = {}
            self.answer.return_value = {"content": json.dumps({"page_id": "src1", "edits": edits}), "usage": USAGE}
            saved = self.client.post("/api/ppt/page", json=payload).json["slide"]
            self.assertEqual(saved["original_edits"], expected)
            self.assertTrue(any(e["type"] == "text" and e["text"].strip() for e in saved["elements"]))

    def test_existing_slide_motion_replays_the_validated_plan_and_settles_once(self):
        source = {"page_id": "import-24", "title": "实验结果", "deck_title": "研究汇报",
                  "targets": [{"id": "label", "type": "text", "text": "误差"},
                              {"id": "chart", "type": "chart"}, {"id": "conclusion", "type": "shape"}],
                  "native_timing": False, "native_transition": True}
        payload = {"request_id": RID, "model": "deepseek-v4.1-flash", "page_count": 30, "page_index": 23, "motion_only": source}
        motion = {"transition": "none", "groups": [
            {"ids": ["label", "chart"], "effect": "wipe", "trigger": "on-click"},
            {"ids": ["conclusion"], "effect": "fade", "trigger": "after-previous"}]}
        self.answer.return_value = {"content": json.dumps({"page_id": source["page_id"], "motion": motion}), "usage": USAGE}
        response = self.client.post("/api/ppt/page", json=payload, headers={"Accept": "application/x-ndjson"})
        events = [json.loads(line) for line in response.data.splitlines()]
        self.assertEqual([event["type"] for event in events], ["start", "result"])
        record = events[-1]["data"]
        self.assertEqual(record["slide"]["id"], source["page_id"])
        self.assertEqual(record["slide"]["motion"], motion)
        self.assertEqual(record["status"], "succeeded")
        begin, finish = [call.args[1] for call in self.store.call_args_list]
        self.assertEqual([begin["p_kind"], begin["p_model"]], ["page", payload["model"]])
        self.assertEqual(finish["p_usage"], USAGE)
        self.assertEqual(finish["p_result"]["slide"], record["slide"])
        body = self.model.call_args.args[2]
        self.assertIn("PPT Master", body["messages"][0]["content"])
        ctx = json.loads(body["messages"][1]["content"])
        self.assertEqual([ctx["page_number"], ctx["page_count"]], [24, 30])
        self.assertEqual(ctx["targets"], source["targets"])
        self.assertEqual(self.client.get("/api/ppt/requests/"+RID).json, record)
        self.assertEqual(self.client.post("/api/ppt/page", json=payload).json, record)
        self.model.assert_called_once()

    def test_motion_protects_native_layers_and_rejects_invalid_plans_without_settling(self):
        target = {"id": "icon", "type": "image"}
        source = {"page_id": "src1", "title": "导论", "deck_title": "研究汇报", "targets": [target]}
        payload = {"request_id": RID, "page_count": 1, "page_index": 0, "motion_only": source}
        for fields in ({"outline": {}}, {"page_index": 1}, {"motion_enabled": True},
                       {"motion_only": {**source, "native_timing": True, "native_transition": True}},
                       {"motion_only": {**source, "targets": [], "native_transition": True}},
                       {"motion_only": {**source, "targets": [target, target]}},
                       {"motion_only": {**source, "targets": [{**target, "src": "binary"}]}}):
            with self.subTest(fields=fields):
                self.assertEqual(self.client.post("/api/ppt/page", json={**payload, **fields}).json["code"], "PPT_INPUT_INVALID")
        self.store.assert_not_called()
        self.model.assert_not_called()
        group = {"ids": ["icon"], "effect": "fly", "trigger": "on-click"}
        both = {"transition": "push", "groups": [group]}
        for flags, reply in (
                ({}, {"page_id": "another", "motion": both}),
                ({}, {"page_id": "src1", "motion": both, "elements": [SLIDE["elements"][0]]}),
                ({"native_timing": True}, {"page_id": "src1", "motion": both}),
                ({"native_transition": True}, {"page_id": "src1", "motion": both})):
            with self.subTest(flags=flags, reply=reply):
                self.record = {}
                self.answer.return_value = {"content": json.dumps(reply), "usage": USAGE}
                result = self.client.post("/api/ppt/page", json={**payload, "motion_only": {**source, **flags}}).json
                self.assertEqual(result["error"]["code"], "PPT_RESULT_INVALID")
                self.assertIsNone(self.store.call_args.args[1]["p_result"])
        self.record = {}
        locked = {**source, "targets": [], "native_timing": True}
        transition_only = {"transition": "fade", "groups": []}
        self.answer.return_value = {"content": json.dumps({"page_id": "src1", "motion": transition_only}), "usage": USAGE}
        self.assertEqual(self.client.post("/api/ppt/page", json={**payload, "motion_only": locked}).json["slide"]["motion"],
                         transition_only)

    def test_chat_preserves_turns_and_uses_the_original_metered_request(self):
        history = [{"role": "user", "content": "请推荐一个主题"}, {"role": "assistant", "content": "城市公园"}]
        payload = {"request_id": RID, "model": "deepseek-v4.1-flash", "message": "同一个主题怎样开场？",
                   "history": history, "references": [{"name": "游览记录", "text": "这座公园有三处湿地。"}],
                   "topic": "城市公园", "deck_title": "从湿地出发", "slide_titles": ["开场"], "slide_text": "清晨的公园",
                   "system": "CLIENT_SUPPLIED_INSTRUCTION"}
        self.answer.return_value = {"content": "可以从清晨的鸟鸣展开。", "usage": USAGE}
        response = self.client.post("/api/ppt/chat", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["reply"], "可以从清晨的鸟鸣展开。")
        body = self.model.call_args.args[2]
        self.assertNotIn("response_format", body)
        self.assertEqual(body["messages"][1:-1], history)
        self.assertEqual(body["messages"][-1]["role"], "user")
        for expected in ("同一个主题怎样开场？", "三处湿地", "从湿地出发", "清晨的公园"):
            self.assertIn(expected, body["messages"][-1]["content"])
        self.assertNotIn("CLIENT_SUPPLIED_INSTRUCTION", str(body))
        begin, finish = [call.args for call in self.store.call_args_list]
        self.assertEqual(begin[1]["p_kind"], "chat")
        self.assertEqual(begin[1]["p_output_bound"], body["max_tokens"])
        self.assertEqual(finish[1]["p_usage"], USAGE)
        self.assertEqual(finish[1]["p_result"], {"reply": response.json["reply"]})
        self.assertEqual(self.client.post("/api/ppt/chat", json=payload).json, response.json)
        self.assertEqual(self.client.get("/api/ppt/requests/"+RID).json, response.json)
        self.model.assert_called_once()

    def test_chat_without_a_deck_accepts_plain_text_and_refunds_an_empty_answer(self):
        self.answer.return_value = {"content": "  ", "usage": USAGE}
        response = self.client.post("/api/ppt/chat", json={"request_id": RID, "message": "你好"})
        self.assertEqual(self.model.call_args.args[2]["messages"][-1], {"role": "user", "content": "你好"})
        self.assertEqual(response.json["error"]["code"], "PPT_RESULT_INVALID")
        finish = self.store.call_args.args[1]
        self.assertIsNone(finish["p_result"])
        self.assertEqual(finish["p_usage"], USAGE)

    def test_chat_invalid_roles_or_oversized_context_are_rejected_before_reservation(self):
        long_turn = {"role": "assistant", "content": "甲" * 24000}
        for fields in ({"message": ""}, {"history": [{"role": "system", "content": "x"}]},
                       {"history": [{"role": "user", "content": 5}]}, {"slide_titles": "bad"},
                       {"history": [long_turn] * 3}, {"references": [{"name": "x", "text": "y" * 30001}]}):
            with self.subTest(keys=list(fields)):
                response = self.client.post("/api/ppt/chat", json={"request_id": RID, "message": "你好", **fields})
                self.assertEqual(response.json["code"], "PPT_INPUT_INVALID")
        self.model.assert_not_called()
        self.store.assert_not_called()

    def test_patch_only_selected_elements(self):
        proposal = {**SLIDE["elements"][1], "fill": "#4488FF"}
        self.answer.return_value = {"content": json.dumps({"elements": [proposal]}), "usage": USAGE}
        r = self.client.post("/api/ppt/edit", json={"slide":SLIDE, "request_id":RID,
            "element_ids":["e2"], "instruction":"变蓝"})
        self.assertEqual(r.json["slide"]["elements"][1]["fill"], "#4488FF")
        self.assertEqual(r.json["slide"]["elements"][0]["text"], "预算")
        with self.assertRaises(InvalidDocument):
            result_document("edit", json.dumps({"elements":[SLIDE["elements"][0]]}), 1, SLIDE, ["e2"])

    def test_rejected_or_malformed_results_never_charge_guessed_usage(self):
        self.answer.return_value = {"content":"no json", "usage":USAGE}
        r = self.client.post("/api/ppt/generate", json=self.payload)
        self.assertEqual(r.json["error"]["code"], "PPT_RESULT_INVALID")
        self.assertIsNone(self.store.call_args.args[1]["p_result"])
        self.assertEqual(self.store.call_args.args[1]["p_usage"], USAGE)
        self.record = {}
        self.model.side_effect = ppt_routes.TavernError("TAVERN_RESULT_UNKNOWN", "timeout", 502, True)
        self.assertEqual(self.client.post("/api/ppt/generate", json=self.payload).json["error"]["code"], "PPT_RESULT_UNAVAILABLE")

    def test_unsupported_inputs_and_origins_never_reach_provider(self):
        for extra in ({"model":"attacker"}, {"page_count":0}, {"references":[{"name":"x","text":"a"*30001}]},
                      {"template":{"slides":[{"src":"data:image/png;base64,abcd"}]}}):
            self.assertEqual(self.client.post("/api/ppt/generate", json={**self.payload, **extra}).status_code, 400)
        self.assertEqual(self.client.post("/api/ppt/generate", json=self.payload,
                                          headers={"Origin":"https://other.invalid"}).status_code, 403)
        self.model.assert_not_called()
        self.store.assert_not_called()

    def test_model_markup_or_bad_geometry_is_rejected(self):
        for item in ({**SLIDE["elements"][1],"fill":"url(evil)"}, {**SLIDE["elements"][0],"x":900},
                     {"id":"img","type":"image","x":0,"y":0,"w":10,"h":10,"src":"https://evil.invalid/image"}):
            doc = {"title":"预算","slides":[{**SLIDE,"elements":[item]}]}
            with self.assertRaises(InvalidDocument):
                result_document("generate",json.dumps(doc),1,None,[])
        with self.assertRaises(InvalidDocument):
            prepare("edit", {"slide":SLIDE, "element_ids":["missing"], "instruction":"修改"})
