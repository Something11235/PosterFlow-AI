import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask
from backend import canvas_ai as ai, tavern_routes as transport


RID = "6118c271-ce6e-458e-b012-82930fd6ee85"
SHOT = {
    "title": "门前",
    "description": "主角打开门",
    "camera": "固定近景",
    "duration": 5,
    "imagePrompt": "主角站在木门前",
    "videoPrompt": "主角伸手缓慢推门，镜头保持固定。",
}
USAGE = {"status": "confirmed", "input_tokens": 120, "output_tokens": 30, "total_tokens": 150}


class CanvasTextTests(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        self.user = "alice"
        server = SimpleNamespace(
            ALLOWED_ORIGINS=[],
            ProviderError=RuntimeError,
            enforce_rate_limit=lambda *args: None,
            require_authenticated_user=lambda: SimpleNamespace(id=self.user),
        )
        app.register_blueprint(ai.create_canvas_ai_blueprint(server))
        self.client = app.test_client()
        self.records = {}
        self.content = json.dumps({"shots": [SHOT]}, ensure_ascii=False)
        self.usage = USAGE
        self.model = patch.object(ai, "provider_reply", side_effect=self.reply).start()
        self.db = patch.object(ai, "rpc", side_effect=self.rpc).start()
        patch.dict(
            "os.environ",
            {"PLATFORM_PPT_API_KEY": "fixture-only", "PLATFORM_PPT_API_ENDPOINT": ai.DEFAULT_ENDPOINT},
        ).start()
        self.addCleanup(patch.stopall)

    def reply(self, *args, **kwargs):
        yield from ()
        return {"content": self.content, "usage": self.usage}

    def rpc(self, name, params):
        key = params["p_user_id"], params["p_request_id"]
        if name == "begin_canvas_text_request" and key not in self.records:
            self.records[key] = {"status": "processing", "request_id": key[1]}
            return {"leader": True, "request": self.records[key]}
        if name == "finish_canvas_text_request":
            self.records[key] = {
                "status": "failed" if params["p_error_code"] else "succeeded",
                "request_id": key[1],
                "error_code": params["p_error_code"],
                "model": params["p_model"],
                "attempts": params["p_attempts"],
                **(params["p_result"] or {}),
            }
        if key not in self.records:
            raise ai.CanvasError("CANVAS_AI_NOT_FOUND")
        return {"leader": False, "request": self.records[key]}

    def post(self, path, **fields):
        return self.client.post("/api/canvas-ai/" + path, json={"request_id": RID, **fields})

    def test_breakdown_replay_recovery_and_account_scope(self):
        for _ in range(2):
            response = self.post("storyboard", script="主角打开木门。", shot_count=1)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json["shots"], [SHOT])
        self.model.assert_called_once()
        self.assertIn(ai.guide("storyboard"), self.model.call_args.args[2]["messages"][0]["content"])
        self.assertEqual(self.model.call_args.args[2]["model"], ai.MODEL_ORDER[0])
        self.assertEqual(self.client.get("/api/canvas-ai/requests/" + RID).json["shots"], [SHOT])
        self.user = "bob"
        response = self.client.get("/api/canvas-ai/requests/" + RID)
        self.assertEqual((response.status_code, response.json["code"]), (404, "CANVAS_AI_NOT_FOUND"))

    def test_prompt_modes_and_skill_dispatch(self):
        for mode, target in (("draft", "image"), ("polish", "video"), ("complete", "video")):
            with self.subTest(mode=mode):
                self.records.clear()
                self.content = '{"prompt":"窗外明亮。"}'
                response = self.post(
                    "prompt",
                    mode=mode,
                    target=target,
                    text="" if mode == "draft" else "客厅",
                    context="客厅镜头",
                    target_model="fixture-target",
                )
                self.assertEqual(
                    response.json["prompt"], "客厅\n窗外明亮。" if mode == "complete" else "窗外明亮。"
                )
                body = self.model.call_args.args[2]
                self.assertIn(ai.guide(target), body["messages"][0]["content"])
                self.assertEqual(body["response_format"], {"type": "json_object"})
                self.assertEqual(self.db.call_args.args[1]["p_usage"], USAGE)

    def test_provider_receives_only_the_matching_pinned_skill_excerpts_and_web_contract(self):
        cases = (
            (
                "storyboard",
                {"script": "🎬" * ai.MAX_SCRIPT, "shot_count": ai.MAX_SHOTS},
                "排定戏剧落点与悬念时机",
                "按双方攻守转换与听者反应节点切开",
            ),
            (
                "prompt",
                {"target": "image", "mode": "polish", "text": "🎬" * ai.MAX_PROMPT},
                "核心特征优先落笔",
                "普通尺寸参照物",
            ),
            (
                "prompt",
                {"target": "video", "mode": "draft", "text": "🎬" * ai.MAX_PROMPT},
                "组织动作、运镜与声音正文",
                "点明谁递谁接与松手时机",
            ),
        )
        for kind, payload, main_rule, reference_rule in cases:
            with self.subTest(rule=main_rule):
                self.records.clear()
                self.db.reset_mock()
                self.content = json.dumps({"shots": [SHOT] * ai.MAX_SHOTS, "prompt": "镜头清晨转向窗前。"})
                self.assertEqual(self.post(kind, **payload).json["status"], "succeeded")
                body = self.model.call_args.args[2]
                messages = body["messages"]
                self.assertIn(main_rule, messages[0]["content"])
                self.assertIn(reference_rule, messages[0]["content"])
                for _, _, other_rule, _ in cases:
                    if other_rule != main_rule:
                        self.assertNotIn(other_rule, messages[0]["content"])
                self.assertIn(
                    '"shots"' if kind == "storyboard" else ai.MODES[payload["mode"]], messages[0]["content"]
                )
                self.assertNotIn("tools", body)
                self.assertEqual(body["response_format"], {"type": "json_object"})
                reserve = self.db.call_args_list[0].args[1]
                self.assertEqual(reserve["p_output_bound"], body["max_completion_tokens"])
                self.assertLessEqual(body["max_completion_tokens"], 8192)
                self.assertGreater(
                    reserve["p_input_bound"], sum(len(m["content"].encode()) for m in messages)
                )
                self.assertLessEqual(reserve["p_input_bound"], 125000)

    def test_invalid_model_output_and_provider_failure_finalize_with_refund(self):
        response = self.post("storyboard", script="一张桌子", shot_count=2)
        self.assertEqual(response.json["error"]["code"], "CANVAS_AI_RESULT_INVALID")
        self.assertIsNone(self.db.call_args.args[1]["p_result"])
        self.assertEqual(self.db.call_args.args[1]["p_usage"], USAGE)
        self.records.clear()
        self.model.side_effect = ai.TavernError("TAVERN_RESPONSE_UNKNOWN", "unknown", 502, True)
        response = self.post("prompt", mode="polish", target="video", text="月下")
        self.assertEqual(
            (response.json["status"], response.json["error"]["code"]),
            ("failed", "CANVAS_AI_RESULT_UNAVAILABLE"),
        )

    def test_reject_inputs_cross_origin_missing_key_before_reserving(self):
        for request in (
            ("prompt", {"mode": "polish", "text": "", "target": "image"}),
            ("prompt", {"mode": "draft", "context": "地图", "target": {"kind": "video"}}),
            ("storyboard", {"script": "x" * 16001}),
            ("storyboard", {"script": "x", "shot_count": True}),
        ):
            resp = self.post(request[0], **request[1])
            self.assertEqual((resp.status_code, resp.json["submission"]), (400, "not_submitted"))
        self.assertEqual(
            self.client.post(
                "/api/canvas-ai/prompt", headers={"Origin": "https://example.invalid"}
            ).status_code,
            403,
        )
        with patch.dict(
            "os.environ",
            {
                "PLATFORM_CANVAS_API_KEY": "fixture",
                "PLATFORM_PPT_API_KEY": "",
                "PLATFORM_PPT_GPT_API_KEY": "fixture",
                "PLATFORM_PPT_DEEPSEEK_API_KEY": "fixture",
                "PLATFORM_TAVERN_API_KEY": "fixture",
            },
        ):
            self.assertIs(self.client.get("/api/canvas-ai/config").json["configured"], False)
            self.assertEqual(self.post("storyboard", script="x").json["code"], "CANVAS_AI_MODEL_UNAVAILABLE")
        self.db.assert_not_called()
        self.model.assert_not_called()

    def test_timeout_and_unavailable_switch_model_with_one_hold_and_one_settlement(self):
        self.model.side_effect = [
            ai.TavernError("TAVERN_MODEL_TIMEOUT", "timeout", 504, True),
            ai.TavernError("TAVERN_MODEL_UNAVAILABLE", "capacity", 503),
            self.reply(),
        ]
        config = self.client.get("/api/canvas-ai/config").json
        self.assertEqual([m["id"] for m in config["models"]], list(ai.MODEL_ORDER))
        self.assertEqual(config["fallback_models"], list(ai.MODEL_ORDER[1:]))
        response = self.post("storyboard", script="打开门。", shot_count=1)
        self.assertEqual(response.json["status"], "succeeded")
        self.assertEqual(response.json["model"], "deepseek-v4.1-flash")
        self.assertEqual(
            response.json["attempts"],
            [
                {"model": model, "outcome": outcome}
                for model, outcome in zip(ai.MODEL_ORDER, ("timeout", "unavailable", "succeeded"))
            ],
        )
        calls = self.model.call_args_list
        for n, (call, expected) in enumerate(zip(calls, ai.MODEL_ORDER)):
            endpoint, key, outgoing, deadline = call.args
            self.assertEqual(
                (endpoint, key, outgoing["model"]), (ai.DEFAULT_ENDPOINT, "fixture-only", expected)
            )
            self.assertIn("max_completion_tokens" if n < 2 else "max_tokens", outgoing)
            self.assertNotIn("max_tokens" if n < 2 else "max_completion_tokens", outgoing)
            self.assertEqual(call.kwargs, {"usage_reader": ai.ppt_usage, "model_fallback": True})
            if n:
                self.assertGreater(deadline, calls[n - 1].args[3])
        self.assertEqual(
            [call.args[0] for call in self.db.call_args_list],
            ["begin_canvas_text_request", "finish_canvas_text_request"],
        )
        self.assertEqual(self.db.call_args_list[0].args[1]["p_model"], ai.DEFAULT_MODEL)
        self.assertEqual(self.db.call_args.args[1]["p_usage"], USAGE)
        self.assertEqual(self.client.get("/api/canvas-ai/requests/" + RID).json, response.json)
        self.assertEqual(self.post("storyboard", script="打开门。", shot_count=1).json, response.json)
        self.assertEqual(self.model.call_count, 3)

    def test_gateway_routes_only_timeouts_and_model_unavailability(self):
        self.model.side_effect = transport.provider_reply
        cases = (
            (400, {"code": "model_not_found", "type": "invalid_request_error"}, True),
            (500, {"type": "server_error", "code": "internal_server_error"}, True),
            (502, {}, True),
            (503, {}, True),
            (504, {}, True),
            (408, {}, True),
            (429, {"code": "model_overloaded"}, True),
            (400, {"code": "content_policy_violation"}, False),
            (503, {"code": "content_filter"}, False),
            (403, {"code": "model_not_found"}, True),
            (403, {"code": "model_not_enabled", "type": "invalid_request_error"}, True),
            (403, {"code": "model_not_available"}, True),
            (403, {"type": "permission_denied", "code": "model_not_enabled"}, False),
            (403, {"type": "model_not_enabled", "code": "content_policy_violation"}, False),
            (403, {}, False),
            (401, {"code": "invalid_api_key"}, False),
            (401, {"code": "model_unavailable"}, False),
            (429, {"code": "insufficient_quota"}, False),
            (429, {"code": "insufficient_quota", "type": "rate_limit_exceeded"}, False),
            (429, {"code": "rate_limit_exceeded"}, True),
            (429, {}, False),
            (400, {"code": "context_length_exceeded"}, False),
            (502, {"code": "content_filter_blocked", "type": "server_error"}, False),
            (503, {"code": "billing_hard_limit_reached", "type": "gateway_timeout"}, False),
            (404, {}, False),
            (413, {}, False),
        )
        for status, error, should_fallback in cases:
            with self.subTest(status=status, error=error):
                self.records.clear()
                self.model.reset_mock()
                connection, success = Mock(), Mock()
                fail = connection.getresponse.return_value
                fail.status = status
                fail.read.return_value = json.dumps({"error": error}).encode()
                reply = success.getresponse.return_value
                reply.status = 200
                reply.isclosed.side_effect = [False, True]
                reply.read1.return_value = json.dumps(
                    {
                        "choices": [{"message": {"content": self.content}}],
                        "usage": {
                            "prompt_tokens": 120,
                            "completion_tokens": 30,
                            "prompt_tokens_details": {"cached_tokens": 1, "cache_write_tokens": 3},
                        },
                    }
                ).encode()
                with (
                    patch.object(transport, "resolve_public_host", return_value=["8.8.8.8"]),
                    patch.object(transport, "PinnedConnection", side_effect=[connection, success]),
                ):
                    result = self.post("storyboard", script="开门")
                self.assertEqual(result.json["status"], "succeeded" if should_fallback else "failed")
                self.assertEqual(self.model.call_count, 2 if should_fallback else 1)
                if should_fallback:
                    self.assertEqual(self.db.call_args.args[1]["p_usage"]["cache_write_tokens"], 3)

    def test_expired_deadline_and_all_models_unavailable(self):
        with patch.object(ai.time, "monotonic", side_effect=[0, 251]):
            result = self.post("storyboard", script="开门")
        self.assertEqual(result.json["status"], "failed")
        self.assertEqual(result.json["attempts"], [])
        self.model.assert_not_called()
        self.records.clear()
        self.model.side_effect = ai.TavernError("TAVERN_MODEL_UNAVAILABLE", "capacity", 503)
        result = self.post("storyboard", script="开门")
        self.assertEqual(result.json["status"], "failed")
        self.assertEqual([a["outcome"] for a in result.json["attempts"]], ["unavailable"] * 3)
        self.assertIsNone(self.db.call_args.args[1]["p_usage"])

    def test_socket_timeout_switches_once_but_ambiguous_disconnect_and_refusal_stop(self):
        self.model.side_effect = transport.provider_reply
        for failure, outcomes in (
            (TimeoutError(), ["timeout", "failed"]),
            (ConnectionResetError(), ["failed"]),
            (None, ["failed"]),
        ):
            with self.subTest(failure=failure):
                self.records.clear()
                self.model.reset_mock()
                refused = Mock()
                response = refused.getresponse.return_value
                response.status = 200
                response.isclosed.side_effect = [False, True]
                response.read1.return_value = json.dumps(
                    {
                        "choices": [
                            {"finish_reason": "content_filter", "message": {"content": self.content}}
                        ],
                        "usage": {"prompt_tokens": 30, "completion_tokens": 4},
                    }
                ).encode()
                connections = [refused]
                if failure is not None:
                    broken = Mock()
                    broken.getresponse.side_effect = failure
                    connections.insert(0, broken)
                with (
                    patch.object(transport, "resolve_public_host", return_value=["8.8.8.8"]),
                    patch.object(transport, "PinnedConnection", side_effect=connections),
                ):
                    result = self.post("storyboard", script="开门")
                self.assertEqual(result.json["status"], "failed")
                self.assertEqual([attempt["outcome"] for attempt in result.json["attempts"]], outcomes)
                self.assertEqual(self.model.call_count, len(outcomes))

    def test_lost_settlement_retries_database_only(self):
        lost = True

        def lose_reply(name, params):
            nonlocal lost
            result = self.rpc(name, params)
            if lost and name == "finish_canvas_text_request":
                lost = False
                raise ai.CanvasError("CANVAS_AI_DATABASE_UNAVAILABLE")
            return result

        self.db.side_effect = lose_reply
        self.assertEqual(self.post("storyboard", script="推门").json["status"], "succeeded")
        self.model.assert_called_once()
