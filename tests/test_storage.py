import unittest
from unittest.mock import Mock, patch

from backend import server


class StorageBackendTests(unittest.TestCase):
    def setUp(self):
        self.response = Mock(status_code=200, content=b"image-bytes", headers={"content-type": "image/png"})

    def test_supabase_upload_is_used_when_selected(self):
        with (
            patch.object(server, "IMAGE_STORAGE_BACKEND", "supabase"),
            patch.object(server, "SUPABASE_STORAGE_ENABLED", True),
            patch.object(server, "_image_blob_path", return_value="posterflow/user-1/images/test.png"),
            patch.object(server, "_supabase_put") as supabase_put,
            patch.object(server, "_blob_put") as blob_put,
        ):
            server.store_generated_image("test.png", b"png")

        supabase_put.assert_called_once_with("posterflow/user-1/images/test.png", b"png", "image/png")
        blob_put.assert_not_called()

    def test_supabase_404_does_not_fall_back_to_legacy_blob(self):
        missing = server.ProviderError("STORAGE_FILE_MISSING", "missing", 404)
        with (
            patch.object(server, "IMAGE_STORAGE_BACKEND", "supabase"),
            patch.object(server, "SUPABASE_STORAGE_ENABLED", True),
            patch.object(server, "BLOB_STORAGE_ENABLED", True),
            patch.object(server, "_supabase_download", side_effect=missing),
            patch.object(server, "_blob_download") as blob_download,
        ):
            with self.assertRaises(server.ProviderError) as context:
                server._storage_download("posterflow/user-1/images/test.png")

        self.assertEqual(context.exception.code, "STORAGE_FILE_MISSING")
        blob_download.assert_not_called()

    def test_supabase_network_error_does_not_fall_back_to_blob(self):
        unavailable = server.ProviderError("STORAGE_UNAVAILABLE", "unavailable", 503)
        with (
            patch.object(server, "IMAGE_STORAGE_BACKEND", "supabase"),
            patch.object(server, "SUPABASE_STORAGE_ENABLED", True),
            patch.object(server, "BLOB_STORAGE_ENABLED", True),
            patch.object(server, "_supabase_download", side_effect=unavailable),
            patch.object(server, "_blob_download") as blob_download,
        ):
            with self.assertRaises(server.ProviderError) as context:
                server._storage_download("posterflow/user-1/images/test.png")

        self.assertEqual(context.exception.code, "STORAGE_UNAVAILABLE")
        blob_download.assert_not_called()

    def test_supabase_delete_only_removes_supabase_object(self):
        with (
            patch.object(server, "IMAGE_STORAGE_BACKEND", "supabase"),
            patch.object(server, "SUPABASE_STORAGE_ENABLED", True),
            patch.object(server, "BLOB_STORAGE_ENABLED", True),
            patch.object(server, "_image_blob_path", return_value="posterflow/user-1/images/test.png"),
            patch.object(server, "_supabase_delete") as supabase_delete,
            patch.object(server, "_blob_delete") as blob_delete,
        ):
            server.remove_stored_images(["test.png"])

        paths = ["posterflow/user-1/images/test.png"]
        supabase_delete.assert_called_once_with(paths)
        blob_delete.assert_not_called()

    def test_local_backend_still_writes_to_filesystem(self):
        import tempfile

        with tempfile.TemporaryDirectory(prefix="posterflow-storage-") as folder:
            with (
                patch.object(server, "IMAGE_STORAGE_BACKEND", "local"),
                patch.object(server, "SAVE_FOLDER", folder),
                patch.object(server, "storage_scope_name", return_value="local-user"),
            ):
                with server.app.app_context():
                    server.store_generated_image("test.png", b"png")
                with open(server.os.path.join(server.SAVE_FOLDER, "test.png"), "rb") as image_file:
                    self.assertEqual(image_file.read(), b"png")

    def test_health_reports_selected_supabase_backend(self):
        with (
            patch.object(server, "IMAGE_STORAGE_BACKEND", "supabase"),
            patch.object(server, "SUPABASE_STORAGE_ENABLED", True),
        ):
            response = server.app.test_client().get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["storage_backend"], "supabase-storage")


if __name__ == "__main__":
    unittest.main()
