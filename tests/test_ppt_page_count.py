import json
import unittest

from backend.ppt_document import InvalidDocument, MAX_PAGES, prepare, result_document


def read_deck(pages, requested):
    text = {"id": "title", "type": "text", "text": "项目复盘", "x": 10, "y": 10, "w": 640, "h": 80}
    slides = [{"id": f"s{i}", "title": "项目复盘", "elements": [text]} for i in range(pages)]
    return result_document("generate", json.dumps({"title": "项目复盘", "slides": slides}), requested, None, [])


class PptPageCountTests(unittest.TestCase):
    def test_auto_allows_a_variable_length_deck_with_a_bounded_budget(self):
        topic = {"topic": "项目复盘"}
        messages, output_budget, _, _ = prepare("generate", {**topic, "page_count": "auto"})
        self.assertEqual(json.loads(messages[1]["content"])["page_count"], "auto")
        self.assertIn(f"1 至 {MAX_PAGES} 页", messages[0]["content"])
        self.assertEqual(output_budget, prepare("generate", {**topic, "page_count": MAX_PAGES})[1])
        for count in (1, 7, MAX_PAGES):
            with self.subTest(count=count):
                self.assertEqual(len(read_deck(count, "auto")["deck"]["slides"]), count)
        for count in (0, MAX_PAGES + 1):
            with self.subTest(count=count), self.assertRaises(InvalidDocument):
                read_deck(count, "auto")

    def test_manual_counts_remain_exact_and_legacy_requests_default_to_six(self):
        topic = {"topic": "项目复盘"}
        default_messages, budget, _, _ = prepare("generate", topic)
        self.assertEqual(json.loads(default_messages[1]["content"])["page_count"], 6)
        self.assertEqual(budget, prepare("generate", {**topic, "page_count": 6})[1])
        with self.assertRaises(InvalidDocument):
            read_deck(7, 6)
        self.assertEqual(len(read_deck(6, 6)["deck"]["slides"]), 6)
        for invalid in (True, None, "6", 0, MAX_PAGES + 1):
            with self.subTest(page_count=invalid), self.assertRaises(InvalidDocument):
                prepare("generate", {**topic, "page_count": invalid})
