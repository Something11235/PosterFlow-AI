import json
import unittest

from backend.ppt_document import InvalidDocument, prepare, result_document


class PptLocalEditTests(unittest.TestCase):
    def setUp(self):
        page = {
            "id": "page1", "title": "结果", "elements": [
                {"id": "summary", "type": "text", "x": 18, "y": 15, "w": 600, "h": 220,
                 "text": "结果" * 3000, "bold": True, "fontSize": 33, "color": "#334455", "align": "center"},
                {"id": "marker", "type": "rect", "x": 25, "y": 350, "w": 80, "h": 4, "fill": "#446688"},
            ],
        }
        _, _, self.page, self.selected = prepare("edit", {
            "slide": page, "element_ids": ["summary", "marker"], "instruction": "调整选中元素",
        })

    def edit(self, elements):
        return result_document("edit", json.dumps({"elements": elements}), 1, self.page, self.selected)["slide"]

    def test_style_edit_does_not_require_repeating_6000_characters(self):
        result = self.edit([{"id": "marker"}, {"id": "summary", "color": "#112233"}])
        self.assertEqual(result["elements"], [
            {**self.page["elements"][0], "color": "#112233"}, self.page["elements"][1],
        ])

    def test_editing_text_preserves_optional_styles_and_existing_full_replacements(self):
        marker = {**self.page["elements"][1], "fill": "#112233"}
        result = self.edit([{"id": "summary", "text": "修订结果"}, marker])
        self.assertEqual(result["elements"], [{**self.page["elements"][0], "text": "修订结果"}, marker])

    def test_invalid_patches_never_apply_even_if_another_patch_is_valid(self):
        for invalid in ({"id": "summary"}, {"id": "unknown"}, {"id": "marker", "x": 1279},
                        {"id": "marker", "text": "不可写的字段"}, {"id": "marker", "fill": "blue"}):
            with self.subTest(invalid=invalid), self.assertRaises(InvalidDocument):
                self.edit([{"id": "summary", "text": "有效修改"}, invalid])
        self.assertEqual(len(self.page["elements"][0]["text"]), 6000)
