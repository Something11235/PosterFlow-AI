import json
import unittest

from backend.ppt_document import InvalidDocument, MAX_INPUT_BYTES, MAX_PAGES, prepare, result_document


PLAN = {"title": "重建方法", "slides": [
    {"title": "研究目标", "brief": "介绍研究的动机与文献。"},
    {"title": "轨迹误差", "brief": "引用 HaWoR 的 MPJPE 及相关实验结果。"},
]}
PAGE = {"id": "model_chose_id", "title": "轨迹误差", "elements": [
    {"id": "title", "type": "text", "x": 72, "y": 65, "w": 480, "h": 70, "text": "轨迹误差"},
]}


class StagedDocumentTests(unittest.TestCase):
    def test_optional_visual_note_round_trips_without_a_character_limit(self):
        for length in (241, 263, 265, 313, 329, 359, 1024):
            with self.subTest(length=length):
                note = "字" * (length - 7) + "末页沿用首色。"
                plan = {**PLAN, "design": {"visual": note}}
                receipt = result_document("outline", json.dumps(plan), 2, None, [])
                self.assertEqual(receipt["outline"], plan)
                messages, _, _, _ = prepare("page", {"topic": "测试", "page_count": 2,
                    "page_index": 1, **json.loads(json.dumps(receipt))})
                self.assertEqual(json.loads(messages[-1]["content"])["design"]["visual"], note)

        for blank in (None, "", " \n"):
            plan = {**PLAN, "design": {"accent": "#334455", "visual": blank}}
            result = result_document("outline", json.dumps(plan), 2, None, [])
            self.assertEqual(result["outline"]["design"], {"accent": "#334455"})

        with self.assertRaisesRegex(InvalidDocument, "200 KB"):
            prepare("page", {"topic": "测试", "page_count": 2, "page_index": 0,
                "outline": {**PLAN, "design": {"visual": "字" * (MAX_INPUT_BYTES // 3 + 1)}}})

    def test_empty_optional_outline_notes_do_not_discard_a_complete_plan(self):
        for blank in ("", " \n", None):
            raw = {**PLAN, "design": None, "slides": [
                {**page, "evidence": blank, "composition": blank} for page in PLAN["slides"]]}
            result = result_document("outline", json.dumps(raw), 2, None, [])
            self.assertEqual(result["outline"], PLAN)
            prepare("page", {"topic": "研究方法", "page_count": 2, "page_index": 0, **result})
            raw["slides"][0]["brief"] = blank
            with self.assertRaises(InvalidDocument):
                result_document("outline", json.dumps(raw), 2, None, [])

    def test_generated_motion_references_final_elements_and_survives_text_edits(self):
        request = {"page_count": 2, "page_index": 0, "outline": PLAN, "topic": "研究方法"}
        group = {"ids": ["title"], "effect": "fade", "trigger": "after-previous"}
        motion = {"transition": "wipe", "groups": [group]}
        response = {**PAGE, "motion": motion}
        static_messages, _, static, selected = prepare("page", request)
        messages, _, animated, _ = prepare("page", {**request, "motion_enabled": True})
        self.assertIn("groups", messages[0]["content"])
        self.assertNotIn("after-previous", static_messages[0]["content"])
        self.assertNotIn("motion", result_document("page", json.dumps(response), 2, static, selected)["slide"])
        page = result_document("page", json.dumps(response), 2, animated, selected)["slide"]
        self.assertEqual(page["motion"], motion)
        for bad in (None, {"groups": []}, {"transition": "none", "groups": []},
                    {**motion, "transition": "rotate"}, {**motion, "groups": [{**group, "ids": ["unknown"]}]},
                    {**motion, "groups": [{**group, "ids": []}]}, {**motion, "groups": [group, group]},
                    {**motion, "groups": [{**group, "trigger": "on-hover"}]},
                    {**motion, "groups": [{**group, "effect": "spin"}]}, {**motion, "script": ""}):
            with self.subTest(bad=bad), self.assertRaises(InvalidDocument):
                result_document("page", json.dumps({**PAGE, "motion": bad}), 2, animated, selected)
        with self.assertRaises(InvalidDocument):
            result_document("page", json.dumps(PAGE), 2, animated, selected)
        _, _, original, selection = prepare("edit", {"slide": page, "element_ids": ["title"], "instruction": "缩短标题"})
        content = {"elements": [{**PAGE["elements"][0], "text": "误差"}]}
        edited = result_document("edit", json.dumps(content), 2, original, selection)["slide"]
        self.assertEqual(edited["elements"][0]["text"], "误差")
        self.assertEqual(edited["motion"], motion)

    def test_outline_sees_all_materials_and_enforces_selected_count(self):
        ref = {"name": "论文", "text": "x" * 6000 + "实际报告见表 7。"}
        data = {"topic": "论文解读", "page_count": 2, "references": [ref], "template_source": ref}
        messages, bound, _, _ = prepare("outline", data)
        self.assertEqual(json.loads(messages[-1]["content"])["references"], [ref])
        self.assertEqual(json.loads(messages[-1]["content"])["template_source"], ref)
        self.assertIn("json", messages[0]["content"].lower())
        self.assertIn("Roster", messages[0]["content"])
        self.assertNotIn("元素格式为", messages[0]["content"])
        self.assertLess(bound, prepare("generate", data)[1])
        self.assertEqual(result_document("outline", json.dumps(PLAN), "auto", None, []), {"outline": PLAN})
        for invalid in ([PLAN["slides"][0]], [{"title": "标题"}] * 2, [1, 2], [PLAN["slides"][0]] * (MAX_PAGES+1)):
            with self.subTest(invalid=invalid), self.assertRaises(InvalidDocument):
                result_document("outline", json.dumps({**PLAN, "slides": invalid}), 2, None, [])

    def test_single_page_keeps_evidence_and_template_and_validates_before_billing(self):
        ref = {"name": "HaWoR.pdf", "text": "无关上下文。" * 1200 + " MPJPE 42.3 mm"}
        data = {"topic": "论文解读", "page_count": 2, "outline": PLAN, "page_index": 1, "references": [ref],
                "template": {"accent": "#9AB445"}, "template_source": ref}
        messages, bound, original, selected = prepare("page", data)
        context = json.loads(messages[-1]["content"])
        self.assertLessEqual(bound, 3500)
        self.assertEqual(context["current_page"], PLAN["slides"][1])
        self.assertEqual(context["slide_titles"], ["研究目标", "轨迹误差"])
        self.assertEqual(context["template"], data["template"])
        self.assertIn("42.3 mm", context["references"][0]["text"])
        self.assertIn("42.3 mm", context["template_source"]["text"])
        self.assertLess(len(context["references"][0]["text"]), 2200)
        slide = result_document("page", json.dumps(PAGE), 2, original, selected)["slide"]
        self.assertEqual(slide["id"], "s2")
        self.assertEqual(slide["elements"][0]["text"], "轨迹误差")
        for invalid in [{"page_index": idx} for idx in (True, "1", -1, 2, None)] + [{"page_count": 1}, {"outline": None}]:
            with self.subTest(invalid=invalid), self.assertRaises(InvalidDocument):
                prepare("page", {**data, **invalid})
        invalid_elements = [
            [{**PAGE["elements"][0], "type": "rect", "fill": "#FFFFFF"}],
            [{**PAGE["elements"][0], "x": 1200}],
            [{**PAGE["elements"][0], "type": "image", "src": "https://example.com/photo.jpg"}],
        ]
        for elements in invalid_elements:
            with self.subTest(elements=elements), self.assertRaises(InvalidDocument):
                result_document("page", json.dumps({**PAGE, "elements": elements}), 2, original, selected)

    def test_writer_reuses_saved_design_and_page_specific_evidence(self):
        design = {"background": "#142834", "text": "#FFFFFF", "accent": "#FAAC20",
                  "title_size": 51, "body_size": 32, "visual": "沿左边距对齐，以细线分隔两列。"}
        plan = {**PLAN, "design": design, "slides": [
            {**PLAN["slides"][0], "composition": "一列研究问题，一列评估方法。"},
            {"title": "结果", "brief": "比较实验组", "composition": "两组并列",
             "evidence": "论文附录 Table S5，ABLATION_MEAN 降至 17。"},
        ]}
        saved = result_document("outline", json.dumps(plan), 2, None, [])["outline"]
        # Round-trip the exact outline that IndexedDB/server recovery will return.
        template = {"accent": "#99AB11"}
        for idx in range(2):
            messages, _, _, _ = prepare("page", {"topic": "强调色用橙色", "page_count": 2,
                "outline": json.loads(json.dumps(saved)), "page_index": idx, "template": template,
                "references": [{"name": "研究论文", "text": "普通材料。" * 1900 + "ABLATION_MEAN 17"}]})
            ctx = json.loads(messages[1]["content"])
            self.assertEqual(ctx["design"], design)
            self.assertEqual(ctx["current_page"], plan["slides"][idx])
            self.assertEqual(ctx["template"], template)
            self.assertIn("用户明确要求、模板对应版式及 design", messages[0]["content"])
            if idx == 1:
                self.assertIn("ABLATION_MEAN 17", ctx["references"][0]["text"])
        legacy = json.loads(prepare("page", {"topic": "复盘", "page_count": 2, "outline": PLAN,
                                           "page_index": 0})[0][1]["content"])
        self.assertNotIn("design", legacy)
        for bad in ({"design": []}, {"design": {"text": "blue"}}, {"design": {"title_size": "52"}},
                    {"design": {"body_size": 200}}, {"design": {"visual": ["bad"]}},
                    {"design": {"visual": "bad\x00data"}},
                    {"slides": [{**PLAN["slides"][0], "evidence": ["bad"]}, PLAN["slides"][1]]}):
            with self.subTest(bad=bad), self.assertRaises(InvalidDocument):
                result_document("outline", json.dumps({**plan, **bad}), 2, None, [])

    def test_regenerating_last_page_keeps_deck_position_and_local_image_identity(self):
        pages = [{"title": f"课题 {i+1}", "brief": f"其他页的私有正文 {i+1}"} for i in range(MAX_PAGES)]
        pages[-1] = {"title": "最后一组实验", "brief": "介绍消融实验结果。"}
        image = {"type": "image", "id": "ablation-plot", "x": 240, "y": 65, "w": 400, "h": 90}
        existing = {**PAGE, "id": "manual-9ab", "title": pages[-1]["title"],
                    "elements": [{**PAGE["elements"][0], "text": "ABLATION_MEAN 由 31 降至 17。"}, image]}
        data = {"page_count": MAX_PAGES, "page_index": MAX_PAGES-1, "topic": "实验汇报",
                "outline": {"title": "实验复盘", "slides": pages},
                "references": [{"name": "论文", "text": "普通章节。" * 1900 + "ABLATION_MEAN 17 mm"}],
                "regenerate": {"slide": existing, "instruction": "把主要数据放在左侧。"}}
        messages, bound, original, selected = prepare("page", data)
        ctx = json.loads(messages[1]["content"])
        self.assertEqual(ctx["page_id"], existing["id"])
        self.assertEqual(ctx["page_number"], MAX_PAGES)
        self.assertEqual(ctx["slide_titles"], [p["title"] for p in pages])
        self.assertEqual(ctx["current_page"], pages[-1])
        self.assertEqual(ctx["deck_title"], "实验复盘")
        self.assertEqual(ctx["regenerate"]["instruction"], "把主要数据放在左侧。")
        self.assertEqual(ctx["regenerate"]["slide"]["elements"][-1], image)
        self.assertNotIn("其他页的私有正文", messages[1]["content"])
        self.assertIn("ABLATION_MEAN 17 mm", ctx["references"][0]["text"])
        self.assertIn("不要仅因页码自动生成封面", messages[0]["content"])
        self.assertEqual(bound, 3000)
        for instruction in ({}, {"instruction": ""}):
            optional = prepare("page", {**data, "regenerate": {"slide": existing, **instruction}})
            self.assertNotIn("instruction", json.loads(optional[0][1]["content"])["regenerate"])
        fresh = {**PAGE, "id": "model-invented-slide-id", "elements": [*PAGE["elements"],
                 {**image, "x": 600}, {"type": "rect", "id": "new-layout", "x": 32,"y": 48,"w": 8,"h": 100,"fill": "#000000"}]}
        result = result_document("page", json.dumps(fresh), MAX_PAGES, original, selected)["slide"]
        self.assertEqual(result["id"], existing["id"])
        self.assertEqual(result["elements"][1], {**image, "x": 600})
        self.assertEqual(result["elements"][2]["id"], "new-layout")
        with self.assertRaises(InvalidDocument):
            result_document("page", json.dumps({**fresh, "elements": [*PAGE["elements"],
                            {**image, "id": "image-from-another-slide"}]}), MAX_PAGES, original, selected)
