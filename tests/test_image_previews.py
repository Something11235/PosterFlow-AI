import io
import re
import unittest
from unittest.mock import Mock, patch

from PIL import Image

from backend import image_preview, server


def png_image(size=(1200, 800)):
    image = Image.effect_noise(size, 70).convert("RGB")
    content = io.BytesIO()
    image.save(content, "PNG")
    return content.getvalue()


class ImagePreviewTests(unittest.TestCase):
    def test_preview_is_a_small_real_png_and_original_is_unchanged(self):
        original = png_image()
        before = original[:]
        preview = image_preview.create_image_preview(original)
        with Image.open(io.BytesIO(preview)) as image:
            self.assertEqual(image.format, "PNG")
            self.assertEqual(image.width, 512)
            self.assertLessEqual(image.height, 512)
        self.assertLess(len(preview), len(original) // 3)
        self.assertEqual(original, before)

    def test_preview_preserves_transparency_and_does_not_upscale(self):
        source = io.BytesIO()
        Image.new("RGBA", (80, 40), (255, 0, 0, 0)).save(source, "PNG")
        with Image.open(io.BytesIO(image_preview.create_image_preview(source.getvalue()))) as image:
            self.assertEqual(image.size, (80, 40))
            self.assertEqual(image.convert("RGBA").getextrema()[3], (0, 0))

    def test_excessive_pixel_count_is_rejected(self):
        with patch.object(image_preview, "PREVIEW_MAX_PIXELS", 100):
            with self.assertRaises(ValueError):
                image_preview.create_image_preview(png_image((11, 11)))

    def test_preview_is_stored_from_existing_bytes_without_remote_read(self):
        original = png_image((300, 200))
        with (
            server.app.test_request_context(),
            patch.object(server, "_storage_backend", return_value="supabase"),
            patch.object(server, "storage_scope_name", return_value="user-test"),
            patch.object(server, "_supabase_put") as upload,
            patch.object(server, "_storage_download") as download,
        ):
            server.store_generated_image("result.png", original)
        self.assertEqual(upload.call_count, 2)
        self.assertEqual(upload.call_args_list[0].args, ("posterflow/user-test/images/result.png", original, "image/png"))
        self.assertEqual(upload.call_args_list[1].args[0], "posterflow/user-test/images/_thumb_result.png")
        self.assertTrue(upload.call_args_list[1].args[1].startswith(b"\x89PNG"))
        download.assert_not_called()

    def test_preview_failure_cannot_fail_a_successful_original_upload(self):
        with (
            patch.object(server, "_storage_backend", return_value="supabase"),
            patch.object(server, "_image_blob_path", return_value="scoped/result.png"),
            patch.object(server, "_supabase_put") as upload,
            patch.object(server, "create_image_preview", side_effect=ValueError("invalid image")),
            self.assertLogs(server.app.logger, level="WARNING"),
        ):
            server.store_generated_image("result.png", b"original")
        upload.assert_called_once_with("scoped/result.png", b"original", "image/png")

    def test_deletion_covers_original_and_preview_within_owner_scope(self):
        with (
            patch.object(server, "_storage_backend", return_value="supabase"),
            patch.object(server, "storage_scope_name", return_value="user-test"),
            patch.object(server, "_supabase_delete") as delete,
        ):
            server.remove_stored_images(["result.png"])
        delete.assert_called_once_with([
            "posterflow/user-test/images/result.png", "posterflow/user-test/images/_thumb_result.png",
        ])

    def test_preview_name_is_already_covered_by_current_retention_pattern(self):
        name = "posterflow/user-test/images/" + image_preview.preview_filename("result.png")
        self.assertIsNotNone(re.fullmatch(r"posterflow/[A-Za-z0-9_-]+/images/[A-Za-z0-9_.-]+[.]png", name))


class PreviewSigningTests(unittest.TestCase):
    def test_thumbnail_signing_is_owner_scoped_and_never_reads_image(self):
        with (
            patch.object(server, "authenticate_access_token", return_value=Mock(id="owner")),
            patch.object(server, "_storage_backend", return_value="supabase"),
            patch.object(server, "_supabase_create_signed_url", return_value="https://storage.example/thumbnail") as sign,
            patch.object(server, "_storage_download") as download,
        ):
            response = server.app.test_client().get("/api/images/result.png/url?variant=thumbnail", headers={"Authorization": "Bearer test"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["variant"], "thumbnail")
        sign.assert_called_once_with("posterflow/user-owner/images/_thumb_result.png")
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")
        download.assert_not_called()

    def test_older_images_fall_back_without_backfill_or_download(self):
        with (
            patch.object(server, "set_optional_storage_scope"),
            patch.object(server, "storage_scope_name", return_value="user-test"),
            patch.object(server, "_storage_backend", return_value="supabase"),
            patch.object(server, "_supabase_create_signed_url", side_effect=[server.ProviderError("STORAGE_UNAVAILABLE", "missing", 503), "https://storage.example/original"]) as sign,
            patch.object(server, "_storage_download") as download,
            patch.object(server, "_supabase_put") as upload,
        ):
            response = server.app.test_client().get("/api/images/result.png/url?variant=thumbnail")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["variant"], "original")
        self.assertEqual(sign.call_count, 2)
        download.assert_not_called()
        upload.assert_not_called()

    def test_invalid_variant_and_unauthorized_requests_cannot_sign(self):
        with (
            patch.object(server, "set_optional_storage_scope"),
            patch.object(server, "_supabase_create_signed_url") as sign,
        ):
            response = server.app.test_client().get("/api/images/result.png/url?variant=other")
        self.assertEqual(response.status_code, 400)
        sign.assert_not_called()
        with (
            patch.object(server, "authenticate_access_token", side_effect=server.SupabaseError("AUTH_INVALID", "invalid", 401)),
            patch.object(server, "_supabase_create_signed_url") as sign,
        ):
            response = server.app.test_client().get("/api/images/result.png/url?variant=thumbnail", headers={"Authorization": "Bearer invalid"})
        self.assertEqual(response.status_code, 401)
        sign.assert_not_called()


if __name__ == "__main__":
    unittest.main()
