import json
import unittest

from backend.ppt_preview import PptPreview


class PptPreviewTests(unittest.TestCase):
    def test_outline_only_displays_reader_text_across_escape_boundaries(self):
        title = '预算中的"特殊"符号\\与😀'
        data = {"title": title, "slides": [{"title": "收入", "brief": "收入同比增加。"}],
                "meta": {"title": "not previewed", "text": "private metadata"}}
        content = json.dumps(data, ensure_ascii=True)
        for size in [1, 2, 3, 8, 17, 1000]:
            with self.subTest(size=size):
                reader = PptPreview("outline")
                frames = [frame for i in range(0, len(content), size) for frame in reader.feed(content[i:i+size])]
                self.assertEqual("".join(f["text"] for f in frames), title + "\n收入\n收入同比增加。")

    def test_previews_only_valid_elements_within_the_elements_array(self):
        text = {"id": "t", "type": "text", "text": "预览", "x": 10, "y": 10, "w": 100, "h": 20}
        data = {"title":"页", "background":"#112233", "elements":[text, text, {**text,"id":"outside","x":2000}],
                "extra":[{**text,"id":"other"}]}
        frames = list(PptPreview("page").feed(json.dumps(data)))
        elements = [frame for frame in frames if frame["type"] == "element"]
        self.assertEqual([f["element"]["id"] for f in elements], ["t"])
        self.assertEqual(elements[0]["background"], "#112233")
