import json
import unittest

from backend import tavern_routes as tavern
from backend.tavern_stream import IncompleteStream, completion_deltas


class StreamAccountingTests(unittest.TestCase):
    usage = {"prompt_tokens": 9, "completion_tokens": 2, "total_tokens": 11}

    def read(self, frames):
        chunks = [("data: " + (frame if isinstance(frame, str) else json.dumps(frame)) + "\n\n").encode()
                  for frame in frames]
        work = completion_deltas(chunks, tavern.normalize_usage, 65536, tavern.invalid_reply)
        output = []
        try:
            while True:
                delta = next(work)
                if delta is not None:
                    output.append(delta)
        except StopIteration as completed:
            return "".join(output), completed.value

    def test_terminal_choice_and_final_usage_survive_missing_done(self):
        choice = {"choices": [{"delta": {"content": "完成"}, "finish_reason": "stop"}]}
        for frames in ([choice, {"choices": [], "usage": self.usage}], [{**choice, "usage": self.usage}]):
            text, result = self.read(frames)
            self.assertEqual(text, result["content"])
            self.assertEqual(result["usage"]["total_tokens"], 11)
        with self.assertRaises(IncompleteStream):
            self.read([{"choices": [{"delta": {"content": "部分"}}]}, {"choices": [], "usage": self.usage}])

    def test_interim_usage_is_never_charged_and_missing_reply_keeps_final_usage(self):
        text, result = self.read([
            {"choices": [{"delta": {"content": "a"}}], "usage": self.usage},
            {"choices": [], "usage": self.usage},
            {"choices": [{"delta": {"content": "b"}, "finish_reason": "stop"}]},
            "[DONE]",
        ])
        self.assertEqual(text, "ab")
        self.assertEqual(result["usage"]["status"], "missing")
        with self.assertRaises(tavern.TavernError) as caught:
            self.read([{"choices": [{"delta": {"reasoning_content": "private"}, "finish_reason": "length"}]},
                       {"choices": [], "usage": self.usage}, "[DONE]"])
        self.assertEqual(caught.exception.code, "TAVERN_RESPONSE_INVALID")
        self.assertEqual(caught.exception.usage["total_tokens"], 11)
