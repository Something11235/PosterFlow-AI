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
            self.assertGreater(self.model.call_args.args[3]-time.monotonic(), 230)
            self.assertIs(self.model.call_args.kwargs["usage_reader"],ppt_routes.ppt_usage)
            self.assertEqual(r.json["deck"]["slides"][0]["title"], "预算")
        self.assertEqual([m["credits_per_million"].get("cache_write") for m in config["models"]],[60,15,None])

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
