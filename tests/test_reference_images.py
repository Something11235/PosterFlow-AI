import base64
import unittest
from unittest.mock import Mock, patch

from backend import server


VALID_PNG = b"\x89PNG\r\n\x1a\n" + (b"\x00" * 24)


class ReferenceImageValidationTests(unittest.TestCase):
    def test_accepts_raw_base64_and_data_url(self):
        encoded = base64.b64encode(VALID_PNG).decode("ascii")

        self.assertEqual(server.validate_reference_image_b64(encoded), encoded)
        self.assertEqual(server.validate_reference_image_b64(f"data:image/png;base64,{encoded}"), encoded)

    def test_rejects_invalid_base64(self):
        with self.assertRaises(server.ProviderError) as context:
            server.validate_reference_image_b64("not-valid-base64")

        self.assertEqual(context.exception.code, "REFERENCE_IMAGE_INVALID")
        self.assertEqual(context.exception.status, 400)

    def test_rejects_unsupported_content(self):
        encoded = base64.b64encode(b"plain text is not an image").decode("ascii")

        with self.assertRaises(server.ProviderError) as context:
            server.validate_reference_image_b64(encoded)

        self.assertEqual(context.exception.code, "REFERENCE_IMAGE_UNSUPPORTED")

    def test_rejects_decoded_image_over_limit(self):
        encoded = base64.b64encode(VALID_PNG).decode("ascii")

        with patch.object(server, "MAX_REFERENCE_IMAGE_BYTES", 8):
            with self.assertRaises(server.ProviderError) as context:
                server.validate_reference_image_b64(encoded)

        self.assertEqual(context.exception.code, "REFERENCE_IMAGE_TOO_LARGE")
        self.assertEqual(context.exception.status, 413)

    def test_accepts_up_to_four_reference_images(self):
        encoded = base64.b64encode(VALID_PNG).decode("ascii")

        self.assertEqual(server.validate_reference_images_b64([encoded, encoded]), [encoded, encoded])

        with self.assertRaises(server.ProviderError) as context:
            server.validate_reference_images_b64([encoded] * 5)

        self.assertEqual(context.exception.code, "REFERENCE_IMAGES_INVALID")


class ProviderEditRequestTests(unittest.TestCase):
    def setUp(self):
        self.provider = server.ProviderConfig(
            api_key="test-key",
            endpoint="https://provider.example/v1/images/generations",
            model="test-model",
            auth_type="bearer",
            source="browser",
        )
        self.encoded = base64.b64encode(VALID_PNG).decode("ascii")

    def provider_response(self):
        response = Mock(status_code=200)
        response.json.return_value = {"data": [{"b64_json": self.encoded}]}
        return response

    def test_reference_image_uses_multipart_edits_endpoint(self):
        with (
            patch.object(server.requests, "post", return_value=self.provider_response()) as post,
            patch.object(server, "store_generated_image"),
        ):
            images = server.generate_images(
                self.provider,
                "只修改指定区域",
                self.encoded,
                custom_size={"width": 1024, "height": 768},
            )

        self.assertEqual(len(images), 1)
        self.assertEqual(post.call_args.args[0], "https://provider.example/v1/images/edits")
        request = post.call_args.kwargs
        self.assertNotIn("json", request)
        self.assertNotIn("Content-Type", request["headers"])
        self.assertEqual(request["headers"]["Authorization"], "Bearer test-key")
        self.assertEqual(request["data"]["response_format"], "b64_json")
        self.assertEqual(request["files"][0][0], "image")
        self.assertEqual(request["files"][0][1][1], VALID_PNG)

    def test_two_reference_images_use_repeated_image_array_parts(self):
        with (
            patch.object(server.requests, "post", return_value=self.provider_response()) as post,
            patch.object(server, "store_generated_image"),
        ):
            server.generate_images(self.provider, "按标注修改", [self.encoded, self.encoded])

        request = post.call_args.kwargs
        self.assertEqual([field for field, _file in request["files"]], ["image[]", "image[]"])

    def test_text_to_image_keeps_json_generations_endpoint(self):
        with (
            patch.object(server.requests, "post", return_value=self.provider_response()) as post,
            patch.object(server, "store_generated_image"),
        ):
            server.generate_images(self.provider, "生成一张新图")

        self.assertEqual(post.call_args.args[0], self.provider.endpoint)
        self.assertIn("json", post.call_args.kwargs)
        self.assertNotIn("files", post.call_args.kwargs)


class CanvasModifyRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.provider = server.ProviderConfig(
            api_key="test-key",
            endpoint="https://provider.example/v1/images/generations",
            model="test-model",
            auth_type="bearer",
            source="browser",
        )

    def test_modify_accepts_direct_canvas_reference(self):
        encoded = base64.b64encode(VALID_PNG).decode("ascii")
        generated = [{"filename": "canvas-result.png", "index": 1}]

        with (
            patch.object(server, "resolve_provider_config", return_value=self.provider),
            patch.object(server, "generate_images", return_value=generated) as generate_images,
            patch.object(server, "save_history_entry") as save_history_entry,
        ):
            response = self.client.post(
                "/api/modify",
                json={
                    "prompt": "只调整箭头指向区域，输出干净图片",
                    "reference_b64": encoded,
                    "size": "custom",
                    "custom_width": 1024,
                    "custom_height": 768,
                    "quality": "high",
                    "strength": 0.72,
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["images"], generated)
        self.assertEqual(generate_images.call_args.args[2], [encoded])
        self.assertEqual(generate_images.call_args.args[3], 0.72)
        self.assertEqual(save_history_entry.call_args.args[0]["style"], "画布标注重绘")

    def test_modify_accepts_clean_and_annotated_canvas_references(self):
        encoded = base64.b64encode(VALID_PNG).decode("ascii")
        generated = [{"filename": "canvas-result.png", "index": 1}]

        with (
            patch.object(server, "resolve_provider_config", return_value=self.provider),
            patch.object(server, "generate_images", return_value=generated) as generate_images,
            patch.object(server, "save_history_entry"),
        ):
            response = self.client.post(
                "/api/modify",
                json={
                    "prompt": "严格保留原图画风，逐条执行标注",
                    "reference_images_b64": [encoded, encoded],
                    "size": "custom",
                    "custom_width": 1024,
                    "custom_height": 768,
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(generate_images.call_args.args[2], [encoded, encoded])


if __name__ == "__main__":
    unittest.main()
