import unittest
from unittest.mock import Mock, patch

from backend import server


class GenerationRecoveryTests(unittest.TestCase):
    def test_status_returns_saved_images_for_authenticated_owner(self):
        gateway = Mock()
        gateway.generation_by_request_id.return_value = {
            "status": "succeeded",
            "image_keys": ["20261017_task_1.png"],
            "prompt": "test prompt",
            "error_code": None,
        }
        user = Mock(id="user-1")
        request_id = "11111111-1111-4111-8111-111111111111"
        with (
            patch.object(server, "require_authenticated_user", return_value=user),
            patch.object(server, "SupabaseGateway", return_value=gateway),
        ):
            response = server.app.test_client().get(f"/api/generations/{request_id}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["images"], [{"filename": "20261017_task_1.png", "index": 1}])
        gateway.generation_by_request_id.assert_called_once_with("user-1", request_id)

    def test_status_does_not_expose_images_while_job_is_running(self):
        gateway = Mock()
        gateway.generation_by_request_id.return_value = {
            "status": "running",
            "image_keys": [],
            "prompt": "test prompt",
            "error_code": None,
        }
        with (
            patch.object(server, "require_authenticated_user", return_value=Mock(id="user-1")),
            patch.object(server, "SupabaseGateway", return_value=gateway),
        ):
            response = server.app.test_client().get("/api/generations/11111111-1111-4111-8111-111111111111")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["images"], [])

