import base64
import io
import unittest
from contextlib import ExitStack
from unittest.mock import Mock, patch

from PIL import Image
from backend import server, apimart_image_provider as provider, apimart_image_routes as routes
from backend import image_reference_delivery as delivery

USER = "11111111-1111-4111-8111-111111111111"
RID = "22222222-2222-4222-8222-222222222222"


def image(fmt="PNG", color="blue"):
    output = io.BytesIO()
    Image.new("RGB", (32, 32), color).save(output, format=fmt)
    return base64.b64encode(output.getvalue()).decode()


class DeliveryTests(unittest.TestCase):
    def storage(self, stack):
        stack.enter_context(patch.object(server, "SUPABASE_STORAGE_ENABLED", True))
        stack.enter_context(patch.object(server, "SUPABASE_STORAGE_URL", "https://fixture.supabase.co"))
        stack.enter_context(patch.object(server, "SUPABASE_STORAGE_BUCKET", "fixture-private"))
        put = stack.enter_context(patch.object(server, "_supabase_put"))
        delete = stack.enter_context(patch.object(server, "_supabase_delete"))
        sign = stack.enter_context(patch.object(server, "_supabase_create_signed_url", side_effect=lambda path, **_: "https://fixture.supabase.co/storage/v1/object/sign/" + server._supabase_object_path(path) + "?token=synthetic"))
        return put, delete, sign

    def test_inline_keeps_order_bytes_and_mime_without_storage(self):
        for model in delivery.INLINE_MODELS:
            with self.subTest(model=model), patch.object(server, "_supabase_put") as put:
                refs = [image("PNG"), image("JPEG", "red")]
                urls, paths = delivery.prepare_references(server, model, refs, "fixture-owner")
                self.assertEqual(urls, ["data:image/png;base64," + refs[0], "data:image/jpeg;base64," + refs[1]])
                self.assertEqual(paths, [])
                put.assert_not_called()

    def test_grok_independent_copy_is_private_and_not_client_cleanup_path(self):
        with ExitStack() as stack:
            put, delete, sign = self.storage(stack)
            refs = [image(), image("WEBP")]
            urls, paths = delivery.prepare_references(server, "grok-imagine-image-2.0", refs, "user-fixture-keyscope")
            self.assertEqual(len(urls), 2)
            for i, path in enumerate(paths):
                self.assertTrue(delivery.COPY_PATH.fullmatch(path))
                self.assertNotIn("user-fixture", path)
                self.assertEqual(put.call_args_list[i].args[1], base64.b64decode(refs[i]))
                sign.assert_any_call(path, expires_in=3600)
                with patch.object(server, "storage_scope_name", return_value="user-fixture-keyscope"):
                    with self.assertRaises(server.ProviderError):
                        server.validate_reference_storage_paths([path])
            delete.assert_not_called()

    def test_signed_urls_fail_closed_and_cleanup_copy_without_echo(self):
        for bad in ("https://evil.invalid/source?token=private", "http://fixture.supabase.co/x", "https://fixture.supabase.co/wrong?token=private", "https://user:private@fixture.supabase.co/x", None):
            with self.subTest(url=bad), ExitStack() as stack:
                put, delete, sign = self.storage(stack)
                sign.side_effect = None
                sign.return_value = bad
                with self.assertRaises(provider.ImageTaskError) as error:
                    delivery.prepare_references(server, "grok-imagine-image-2.0", [image()], "fixture-owner")
                self.assertEqual(error.exception.code, "REFERENCE_LINK_UNAVAILABLE")
                self.assertFalse(error.exception.uncertain)
                self.assertNotIn("private", str(error.exception))
                delete.assert_called_once()

    def test_partial_preparation_and_interrupted_put_compensate_all_copies(self):
        with ExitStack() as stack:
            put, delete, sign = self.storage(stack)
            put.side_effect = [None, RuntimeError("private-storage-response")]
            with self.assertRaises(provider.ImageTaskError):
                delivery.prepare_references(server, "grok-imagine-image-2.0", [image(), image()], "fixture-owner")
            self.assertEqual(len(delete.call_args.args[0]), 2)
            self.assertEqual(sign.call_count, 1)

    def test_copy_cleanup_rejects_other_namespaces(self):
        with patch.object(server, "_supabase_delete") as delete:
            delivery.cleanup_copies(server, ["posterflow/user-other/images/result.png", "arbitrary"])
            delete.assert_not_called()


class DeliveryRouteTests(unittest.TestCase):
    storage = DeliveryTests.storage
    def route_setup(self, stack, model="grok-imagine-image-2.0"):
        stack.enter_context(patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "synthetic"}))
        stack.enter_context(patch.object(server, "require_authenticated_user", return_value=Mock(id=USER)))
        stack.enter_context(patch.object(server, "enforce_rate_limit"))
        stack.enter_context(patch.object(server, "storage_scope_name", return_value="user-" + USER))
        store = stack.enter_context(patch.object(routes, "ImageStore")).return_value
        stack.enter_context(patch.object(routes, "Seedream55ImageStore", return_value=store))
        job = {"id": RID, "request_id": RID, "model": model, "status": "submitted", "image_keys": [], "requested_count": 1}
        store.begin.return_value = {"job": job, "existing": False}
        store.apply.return_value = {"job": job}
        upload = stack.enter_context(patch.object(provider, "upload_reference"))
        return store, upload, {"request_id": RID, "platform_model": model, "prompt": "synthetic", "reference_images_b64": [image(), image("JPEG")]}

    def test_inline_all_models_submit_once_and_never_upload(self):
        for model in delivery.INLINE_MODELS:
            with self.subTest(model=model), ExitStack() as stack:
                store, upload, body = self.route_setup(stack, model)
                submit = stack.enter_context(patch.object(provider, "submit", return_value="task_fixture_123"))
                result = server.app.test_client().post("/api/apimart-images/generations", json=body, headers={"X-Billing-Mode": "platform"})
                self.assertEqual(result.status_code, 202, result.json)
                submit.assert_called_once()
                self.assertEqual(submit.call_args.args[1]["image_urls"], [server.reference_image_data_url(ref) for ref in body["reference_images_b64"]])
                upload.assert_not_called()
                store.begin.assert_called_once()

    def test_grok_copy_survives_browser_source_cleanup_and_unknown_submit(self):
        for failure in (None, provider.ImageTaskError("APIMART_CONNECTION_FAILED", "unknown", 503, uncertain=True)):
            with self.subTest(failure=bool(failure)), ExitStack() as stack:
                put, delete, sign = self.storage(stack)
                store, upload, body = self.route_setup(stack)
                source = "posterflow/user-" + USER + "/references/" + "a" * 32 + ".png"
                stack.enter_context(patch.object(server, "stored_reference_to_base64", return_value=image()))
                submit = stack.enter_context(patch.object(provider, "submit", return_value="task_fixture_123", side_effect=failure))
                client = server.app.test_client()
                result = client.post("/api/apimart-images/generations", json={**body, "reference_images_b64": [], "reference_storage_paths": [source]}, headers={"X-Billing-Mode": "platform"})
                self.assertEqual(result.status_code, 503 if failure else 202, result.json)
                submit.assert_called_once()
                upload.assert_not_called()
                copies = [call.args[0] for call in put.call_args_list]
                self.assertEqual(len(copies), 1)
                self.assertNotIn("token=", str(result.json))
                # The normal cleanup endpoint deletes only the original path.
                with patch.object(server, "set_optional_storage_scope"):
                    client.post("/api/reference-cleanup", json={"paths": [source]})
                self.assertTrue(delete.called)
                for call in delete.call_args_list:
                    self.assertNotIn(copies[0], call.args[0])

    def test_explicit_rejection_discards_copy_and_refunds_without_retry(self):
        with ExitStack() as stack:
            put, delete, sign = self.storage(stack)
            store, upload, body = self.route_setup(stack)
            submit = stack.enter_context(patch.object(provider, "submit", side_effect=provider.ImageTaskError("APIMART_REQUEST_REJECTED", "rejected", 502)))
            result = server.app.test_client().post("/api/apimart-images/generations", json=body, headers={"X-Billing-Mode": "platform"})
            self.assertEqual(result.status_code, 502)
            submit.assert_called_once()
            self.assertEqual(store.apply.call_args.args[2], "failed")
            self.assertEqual(delete.call_args.args[0], [call.args[0] for call in put.call_args_list])

    def test_link_failure_refunds_and_does_not_submit(self):
        with ExitStack() as stack:
            put, delete, sign = self.storage(stack)
            store, upload, body = self.route_setup(stack)
            sign.side_effect = RuntimeError("private")
            submit = stack.enter_context(patch.object(provider, "submit"))
            result = server.app.test_client().post("/api/apimart-images/generations", json=body, headers={"X-Billing-Mode": "platform"})
            self.assertEqual(result.status_code, 503)
            self.assertFalse(result.json["generation_submitted"])
            self.assertEqual(result.json["phase"], "reference_upload")
            submit.assert_not_called()
            self.assertEqual(store.apply.call_args.args[2], "failed")

    def test_duplicate_does_not_create_copy_or_resubmit(self):
        with ExitStack() as stack:
            put, delete, sign = self.storage(stack)
            store, upload, body = self.route_setup(stack)
            store.begin.return_value["existing"] = True
            submit = stack.enter_context(patch.object(provider, "submit"))
            result = server.app.test_client().post("/api/apimart-images/generations", json=body, headers={"X-Billing-Mode": "platform"})
            self.assertEqual(result.status_code, 200)
            put.assert_not_called()
            submit.assert_not_called()

    def test_quota_errors_refund_and_keep_platform_usage_private(self):
        quota = {"limit": 2000, "used": 2000, "remaining": 0, "window_hours": 72, "reset_at": 1794063600}
        for mode in ("platform", "own_key"):
            for code in ("REFERENCE_UPLOAD_QUOTA_EXCEEDED", "REFERENCE_UPLOAD_RATE_LIMITED"):
                with self.subTest(mode=mode, code=code), ExitStack() as stack:
                    store, upload, body = self.route_setup(stack, "gemini-nano-banana-2.1")
                    stack.enter_context(patch.object(server, "set_optional_storage_scope", return_value=Mock(id=USER)))
                    stack.enter_context(patch.object(delivery, "prepare_references", side_effect=provider.ImageTaskError(code, "上传受限", 429, quota=quota)))
                    submit = stack.enter_context(patch.object(provider, "submit"))
                    headers = {"X-Billing-Mode": mode}
                    if mode == "own_key":
                        headers.update({"X-Provider-Endpoint": provider.BASE + "/images/generations", "X-Provider-Api-Key": "synthetic", "X-Provider-Model": "gemini-nano-banana-2.1"})
                    result = server.app.test_client().post("/api/apimart-images/generations", json=body, headers=headers)
                    self.assertEqual(result.status_code, 429, result.json)
                    self.assertEqual(result.json["code"], code)
                    self.assertFalse(result.json["generation_submitted"])
                    self.assertFalse(result.json["submission_unknown"])
                    self.assertEqual("upload_quota" in result.json, mode == "own_key")
                    if mode == "own_key":
                        self.assertEqual(result.json["upload_quota"], quota)
                    submit.assert_not_called()
                    self.assertEqual(store.apply.call_args.args[2], "failed")

    def test_previous_result_edit_uses_inline_without_upload(self):
        with ExitStack() as stack:
            store, upload, body = self.route_setup(stack, "gemini-nano-banana-2.1")
            encoded = image()
            stack.enter_context(patch.object(server, "stored_image_to_base64", return_value=encoded))
            submit = stack.enter_context(patch.object(provider, "submit", return_value="task_fixture_123"))
            body.pop("reference_images_b64")
            result = server.app.test_client().post("/api/apimart-images/generations", json={**body, "previous_image": "fixture.png"}, headers={"X-Billing-Mode": "platform"})
            self.assertEqual(result.status_code, 202, result.json)
            self.assertEqual(submit.call_args.args[1]["image_urls"], ["data:image/png;base64," + encoded])
            upload.assert_not_called()

    def test_segment_preparation_uses_signed_copy_and_never_uploads(self):
        from backend import grok_region
        with ExitStack() as stack:
            put, delete, sign = self.storage(stack)
            store, upload, body = self.route_setup(stack, grok_region.MODEL)
            source = "posterflow/user-" + USER + "/references/" + "a" * 32 + ".png"
            stack.enter_context(patch.object(server, "stored_reference_to_base64", return_value=image()))
            submit = stack.enter_context(patch.object(provider, "submit", return_value="task_segment_fixture"))
            result = server.app.test_client().post("/api/apimart-images/segments", json={**body, "reference_storage_paths": [source], "selection_regions": [{"outer": {"points": [0, 0, 1, 0, 1, 1]}}]}, headers={"X-Billing-Mode": "platform"})
            self.assertEqual(result.status_code, 200, result.json)
            store.begin.assert_not_called()  # free original preparation
            submit.assert_called_once()
            upload.assert_not_called()
            self.assertTrue(submit.call_args.args[1]["image_urls"][0].startswith("https://fixture.supabase.co/storage/"))
            copy = put.call_args.args[0]
            for call in delete.call_args_list:
                self.assertNotIn(copy, call.args[0])
