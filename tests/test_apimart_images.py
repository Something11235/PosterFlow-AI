import base64
import io
import json
import unittest
from unittest.mock import Mock, patch

import requests
from PIL import Image
from backend import apimart_image_provider as provider, apimart_image_routes as routes, server

USER = "11111111-1111-4111-8111-111111111111"
REQUEST = "22222222-2222-4222-8222-222222222222"
TASK = "task_image_test_0123456789"


def response(payload, status=200):
    result = Mock(status_code=status)
    result.iter_content.return_value = [json.dumps(payload).encode()]
    return result


class ImageProtocolTests(unittest.TestCase):
    def reference_data(self):
        image = io.BytesIO()
        Image.new("RGB", (8, 8), "blue").save(image, format="PNG")
        return "data:image/png;base64," + base64.b64encode(image.getvalue()).decode(), image.getvalue()

    def test_reference_upload_accepts_documented_and_actual_media_hosts(self):
        encoded, raw = self.reference_data()
        for host in ("upload.apimart.ai", "getapib.org"):
            url = "https://" + host + "/image/reference.png"
            with self.subTest(host=host), patch.object(provider.requests, "request", return_value=response({"url": url})) as request:
                self.assertEqual(provider.upload_reference("synthetic-key", encoded), url)
                request.assert_called_once()
                self.assertEqual(request.call_args.args, ("POST", provider.BASE + "/uploads/images"))
                self.assertEqual(request.call_args.kwargs["files"]["file"][1:], (raw, "image/png"))
                self.assertNotIn("Content-Type", request.call_args.kwargs["headers"])

    def test_reference_upload_rejects_untrusted_or_malformed_urls(self):
        encoded, _ = self.reference_data()
        urls = [None, ["https://getapib.org/image.png"], "http://getapib.org/image.png", "https://getapib.org.evil.invalid/image.png", "https://getapib.org@evil.invalid/image.png", "https://user:key@getapib.org/image.png", "https://getapib.org:bad/image.png", "https://getapib.org:444/image.png", "https://getapib.org/image.png#fragment", "https://getapib.org/", "https://getapib.org/image.png\n", "https://127.0.0.1/image.png"]
        for url in urls:
            with self.subTest(url=url), patch.object(provider, "api_request", return_value={"url": url}):
                with self.assertRaises(provider.ImageTaskError) as error:
                    provider.upload_reference("synthetic-key", encoded)
                self.assertEqual(error.exception.code, "REFERENCE_UPLOAD_FAILED")
                self.assertFalse(error.exception.uncertain)

    def test_reference_upload_errors_never_claim_paid_submission_unknown(self):
        encoded, _ = self.reference_data()
        for status in (401, 413, 429, 500):
            with self.subTest(status=status), patch.object(provider.requests, "request", return_value=response({}, status)) as request:
                with self.assertRaises(provider.ImageTaskError) as error:
                    provider.upload_reference("synthetic-key", encoded)
                self.assertEqual(error.exception.code, "REFERENCE_UPLOAD_RATE_LIMITED" if status == 429 else "REFERENCE_UPLOAD_FAILED")
                self.assertFalse(error.exception.uncertain)
                request.assert_called_once()
        with patch.object(provider.requests, "request", side_effect=requests.Timeout("private-url")):
            with self.assertRaises(provider.ImageTaskError) as error:
                provider.upload_reference("synthetic-key", encoded)
            self.assertFalse(error.exception.uncertain)
            self.assertNotIn("private-url", str(error.exception))

    def test_invalid_reference_is_not_uploaded(self):
        with patch.object(provider, "api_request") as upload:
            with self.assertRaises(provider.ImageTaskError) as error:
                provider.upload_reference("synthetic-key", "not-image-data")
            self.assertEqual(error.exception.code, "REFERENCE_IMAGE_INVALID")
            upload.assert_not_called()

    def test_upload_diagnostics_keep_http_status_and_safe_specs_without_private_response(self):
        encoded,raw=self.reference_data()
        for status,kind in [(400,'invalid_request_error'),(401,'authentication_error'),(402,'insufficient_user_quota'),(413,'invalid_request_error'),(429,'rate_limit_exceeded'),(500,'server_error')]:
            payload={'error':{'type':kind,'message':'private-response-and-key'}}
            with self.subTest(status=status),patch.object(provider.requests,'request',return_value=response(payload,status)) as post,self.assertLogs(provider.__name__,level='WARNING') as logs:
                with self.assertRaises(provider.ImageTaskError) as caught:
                    provider.upload_reference('private-api-key',encoded,request_id=REQUEST,reference_index=2)
            self.assertEqual(caught.exception.code,'REFERENCE_UPLOAD_RATE_LIMITED' if status == 429 else 'REFERENCE_UPLOAD_FAILED')
            self.assertFalse(caught.exception.uncertain);post.assert_called_once()
            text='\n'.join(logs.output)
            for value in ['request_id='+REQUEST,'reference_index=2','stage=upstream_http','upstream_status='+str(status),'upstream_type='+kind,'bytes='+str(len(raw)),'width=8 height=8 mime=image/png']:self.assertIn(value,text)
            for value in ['private-response-and-key','private-api-key',encoded]:self.assertNotIn(value,text)

    def test_upload_diagnostics_distinguish_connection_and_bad_response_and_url(self):
        encoded,_=self.reference_data()
        malformed=response({});malformed.iter_content.return_value=[b'private-not-json-response']
        read_failure=response({});read_failure.iter_content.side_effect=requests.ConnectionError('private-body')
        cases=[({'side_effect':requests.Timeout('private-url-and-key')},'connection','unknown'),({'return_value':malformed},'response_format','200'),({'return_value':read_failure},'response_read','200'),({'return_value':response({'error':{'type':'rate_limit_error','message':'private'}})},'upstream_payload','200'),({'return_value':response({'url':'https://user:private@evil.invalid/reference.png'})},'url_validation','unknown')]
        for kwargs,stage,status in cases:
            with self.subTest(stage=stage),patch.object(provider.requests,'request',**kwargs),self.assertLogs(provider.__name__,level='WARNING') as logs:
                with self.assertRaises(provider.ImageTaskError) as caught:provider.upload_reference('private-key',encoded,request_id=REQUEST,reference_index=1)
            self.assertFalse(caught.exception.uncertain)
            text='\n'.join(logs.output);self.assertIn('stage='+stage,text);self.assertIn('upstream_status='+status,text)
            self.assertNotIn('private',text);self.assertNotIn('evil.invalid',text)

    def test_diagnostic_fields_cannot_inject_log_text(self):
        encoded,_=self.reference_data()
        error=provider.ImageTaskError('unsafe-code','private-exception',upstream_status='private',upstream_type='private\nforged',failure_stage='private\nforged')
        with patch.object(provider,'api_request',side_effect=error),self.assertLogs(provider.__name__,level='WARNING') as logs:
            with self.assertRaises(provider.ImageTaskError):provider.upload_reference('private-key',encoded,request_id='private\nforged',reference_index='private')
        text='\n'.join(logs.output);self.assertIn('request_id=unavailable reference_index=0 stage=unknown upstream_status=unknown upstream_type=other',text)
        self.assertNotIn('private',text);self.assertNotIn('forged',text)

    def test_documented_models_and_fields(self):
        for model in provider.MODELS:
            body = provider.build_request(model, {"prompt": "猫", "count": 1, "size": "landscape_16_9"})
            self.assertEqual(body["n"], 1)
            if model.startswith("gpt-image-2.6-"):
                self.assertEqual(body["quality"], "auto")
            else:
                self.assertNotIn("quality", body)
            self.assertNotIn("input_references", body)
            self.assertEqual(body.get("aspect_ratio") or body.get("size"), "16:9")
        self.assertEqual(provider.build_request("gemini-nano-banana-2.1", {"prompt": "@图1"}, ["one"])["image_urls"], ["one"])

    def test_canvas_named_ratios_and_source_aspect_editing(self):
        frames = {"square_1_1": "1:1", "landscape_3_2": "3:2", "portrait_2_3": "2:3", "landscape_4_3": "4:3", "portrait_3_4": "3:4", "landscape_16_9": "16:9", "portrait_9_16": "9:16"}
        for model in provider.MODELS:
            for size, expected in frames.items():
                body = provider.build_request(model, {"prompt": "synthetic canvas", "size": size})
                self.assertEqual(body.get("aspect_ratio") or body.get("size"), expected)
            if provider.MODELS[model]["references"]:
                body = provider.build_request(model, {"prompt": "synthetic edit", "size": ""}, ["reference"])
                self.assertEqual(body.get("aspect_ratio") or body.get("size"), "1K" if model == "seedream-5-5" else "auto")

    def test_model_capabilities_reject_before_paid_calls(self):
        invalid = [
            ("grok-imagine-2.0-ext", {"prompt": "cat"}, ["ref"]),
            ("grok-imagine-image-2.0", {"prompt": "cat"}, ["ref"] * 4),
            ("nano-banana-pro", {"prompt": "cat", "count": 2}, []),
            ("grok-imagine-2.0-ext", {"prompt": "cat", "size": "wide_21_9"}, []),
            ("gemini-nano-banana-2.1", {"prompt": "cat", "resolution": "8K"}, []),
            ("gemini-nano-banana-2.1", {"prompt": "cat", "mask_b64": "mask"}, []),
        ]
        for model, data, references in invalid:
            with self.subTest(model=model, data=data), self.assertRaises(provider.ImageTaskError):
                provider.build_request(model, data, references)

    def test_provider_body_whitelist_omits_secrets_and_callbacks(self):
        body = provider.build_request("gemini-nano-banana-2.1", {"prompt": "cat", "api_key": "sentinel", "webhook": "https://invalid.test", "quality": "high", "provider": "override"})
        self.assertEqual(set(body), {"model", "prompt", "n", "size", "resolution"})
        self.assertNotIn("sentinel", json.dumps(body))

    def test_both_submission_shapes_and_idempotency(self):
        for payload in ({"code": 200, "data": [{"task_id": TASK}]}, {"code": 202, "data": {"id": TASK}}):
            with patch.object(provider.requests, "request", return_value=response(payload)) as request:
                self.assertEqual(provider.submit("synthetic-key", {}, REQUEST), TASK)
                kwargs = request.call_args.kwargs
                self.assertEqual(kwargs["headers"]["Idempotency-Key"], REQUEST)
                self.assertEqual(kwargs["headers"]["X-APIMart-Response-Version"], "2026-07-27")
                self.assertFalse(kwargs["allow_redirects"])
                request.assert_called_once()

    def test_timeout_500_and_409_do_not_claim_rejection_or_resubmit(self):
        for status in (500, 409, 302):
            with patch.object(provider.requests, "request", return_value=response({}, status)) as request:
                with self.assertRaises(provider.ImageTaskError) as error:
                    provider.submit("synthetic-key", {}, REQUEST)
                self.assertTrue(error.exception.uncertain)
                request.assert_called_once()
        with patch.object(provider.requests, "request", side_effect=requests.Timeout("secret-url")):
            with self.assertRaises(provider.ImageTaskError) as error:
                provider.submit("synthetic-key", {}, REQUEST)
            self.assertNotIn("secret-url", str(error.exception))
            self.assertTrue(error.exception.uncertain)

    def test_rejected_post_and_wrong_task_response(self):
        with patch.object(provider.requests, "request", return_value=response({}, 402)):
            with self.assertRaises(provider.ImageTaskError) as error:
                provider.submit("synthetic-key", {}, REQUEST)
            self.assertFalse(error.exception.uncertain)
        with patch.object(provider, "api_request", return_value={"data": {"id": "different-task", "status": "completed"}}):
            with self.assertRaises(provider.ImageTaskError):
                provider.query("synthetic-key", TASK)

    def test_documented_url_array_task_shape(self):
        with patch.object(provider, "api_request", return_value={"data": {"id": TASK, "status": "completed", "result": {"images": [{"url": ["https://upload.apimart.ai/a.png", "https://upload.apimart.ai/b.png"]}]}}}):
            result = provider.query("synthetic-key", TASK)
        self.assertEqual(len(result["urls"]), 2)

    def test_media_fetch_has_no_credentials_and_rejects_private_hosts(self):
        stream = io.BytesIO(); Image.new("RGB", (8, 8), "red").save(stream, format="PNG")
        pool = Mock(); pool.urlopen.return_value = Mock(status=200)
        pool.urlopen.return_value.stream.return_value = [stream.getvalue()]
        with patch.object(provider.socket, "getaddrinfo", return_value=[(None, None, None, None, ("8.8.8.8", 443))]), patch.object(provider.urllib3, "HTTPSConnectionPool", return_value=pool):
            result = provider.download_image("https://upload.apimart.ai/a.png?token=synthetic")
        self.assertTrue(result.startswith(b"\x89PNG"))
        self.assertEqual(pool.urlopen.call_args.kwargs["headers"], {"Host": "upload.apimart.ai"})
        self.assertFalse(pool.urlopen.call_args.kwargs["redirect"])
        for url in ("http://example.test/image.png", "https://user:key@example.test/image.png", "https://example.test:1234/image.png"):
            with self.assertRaises(provider.ImageTaskError):
                provider.download_image(url)
        with patch.object(provider.socket, "getaddrinfo", return_value=[(None, None, None, None, ("127.0.0.1", 443))]):
            with self.assertRaises(provider.ImageTaskError):
                provider.download_image("https://example.test/image.png")


class ImageRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.headers = {"X-Billing-Mode": "platform"}
        self.job = {"id": "33333333-3333-4333-8333-333333333333", "request_id": REQUEST, "model": "gemini-nano-banana-2.1", "billing_mode": "platform", "status": "submitted", "requested_count": 1, "image_keys": [], "provider_task_id": TASK, "created_at": "2026-10-23T00:00:00+00:00"}
        self.body = {"platform_model": "gemini-nano-banana-2.1", "request_id": REQUEST, "prompt": "cat"}

    def test_region_source_receipt_and_one_paid_submission_use_existing_store(self):
        from backend import grok_region
        regions = [{"outer": {"points": [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9]}}]
        body = {**self.body, "platform_model": grok_region.MODEL, "operation": "region_edit", "selection_regions": regions}
        store = Mock()
        store.begin.return_value = {"existing": False, "job": self.job}
        store.apply.return_value = {"job": self.job}
        with patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "synthetic-key"}), patch.object(server, "require_authenticated_user", return_value=Mock(id=USER)), patch.object(server, "enforce_rate_limit"), patch.object(routes, "ImageStore", return_value=store), patch.object(server, "validate_reference_storage_paths", return_value=["synthetic-source"]), patch.object(server, "stored_reference_to_base64", return_value="synthetic-image"), patch.object(server, "cleanup_reference_storage_paths"), patch.object(routes.delivery, "prepare_references", return_value=(["https://fixture.supabase.co/signed"], ["synthetic-copy"])), patch.object(provider, "submit", return_value=TASK) as submit, patch.object(provider, "api_request", return_value={"data": {"status": "completed", "result": {"image_id": "asset_synthetic"}}}):
            result = self.client.post("/api/apimart-images/segments", json=body, headers=self.headers)
            self.assertEqual(result.status_code, 200)
            store.begin.assert_not_called()
            self.assertEqual(submit.call_args.args[1]["operation"], "segment")
            result = self.client.post("/api/apimart-images/segments/status", json={"platform_model": grok_region.MODEL, "receipt": result.json["receipt"]}, headers=self.headers)
            self.assertEqual(result.json["status"], "completed")
            receipt = result.json["segment_receipt"]
            submit.reset_mock()
            with patch.object(server, "validate_reference_storage_paths", return_value=[]):
                result = self.client.post("/api/apimart-images/generations", json={**body, "segment_receipt": receipt}, headers=self.headers)
                self.assertEqual(result.status_code, 202)
                submit.assert_called_once()
                self.assertEqual(submit.call_args.args[1]["image_id"], "asset_synthetic")
                self.assertNotIn("image_urls", submit.call_args.args[1])

    def test_foreign_or_invalid_region_receipt_cannot_reserve_or_submit(self):
        from backend import grok_region
        with patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "synthetic-key"}), patch.object(server, "require_authenticated_user", return_value=Mock(id=USER)), patch.object(server, "enforce_rate_limit"), patch.object(routes, "ImageStore") as store, patch.object(provider, "submit") as submit:
            result = self.client.post("/api/apimart-images/generations", json={**self.body, "platform_model": grok_region.MODEL, "operation": "region_edit", "segment_receipt": grok_region.proof("synthetic-key", "other-owner", "asset", "asset_other"), "selection_regions": [{"outer": {"points": [0,0,1,0,1,1]}}]}, headers=self.headers)
            self.assertEqual(result.status_code, 400)
            store.assert_not_called()
            submit.assert_not_called()

    def test_duplicate_submit_never_calls_provider_twice(self):
        store = Mock()
        store.begin.return_value = {"ok": True, "existing": True, "job": self.job, "balance": 9}
        with patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "synthetic-key"}), patch.object(server, "require_authenticated_user", return_value=Mock(id=USER)), patch.object(server, "enforce_rate_limit"), patch.object(routes, "ImageStore", return_value=store), patch.object(provider, "submit") as submit:
            result = self.client.post("/api/apimart-images/generations", json=self.body, headers=self.headers)
        self.assertEqual(result.status_code, 200)
        submit.assert_not_called()

    def test_model_override_and_reference_limit_do_not_reserve(self):
        with patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "synthetic-key"}), patch.object(server, "require_authenticated_user", return_value=Mock(id=USER)), patch.object(server, "enforce_rate_limit"), patch.object(routes, "ImageStore") as store:
            result = self.client.post("/api/apimart-images/generations", json=self.body, headers={**self.headers, "X-Provider-Api-Key": "synthetic-other"})
            self.assertEqual(result.status_code, 400)
            result = self.client.post("/api/apimart-images/generations", json={**self.body, "count": 5}, headers=self.headers)
            self.assertEqual(result.status_code, 400)
            for model in ("nano-banana-pro",):
                result = self.client.post("/api/apimart-images/generations", json={**self.body, "platform_model": model}, headers=self.headers)
                self.assertEqual(result.status_code, 400)
            store.assert_not_called()

    def test_unknown_submission_is_retained_not_refunded(self):
        store = Mock()
        store.begin.return_value = {"existing": False, "job": self.job, "balance": 9}
        with patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "synthetic-key"}), patch.object(server, "require_authenticated_user", return_value=Mock(id=USER)), patch.object(server, "enforce_rate_limit"), patch.object(routes, "ImageStore", return_value=store), patch.object(provider, "submit", side_effect=provider.ImageTaskError("UNCERTAIN", "uncertain", 503, True)):
            result = self.client.post("/api/apimart-images/generations", json=self.body, headers=self.headers)
        self.assertEqual(result.status_code, 503)
        self.assertEqual(store.apply.call_args.args[2], "submission_unknown")

    def test_read_failure_releases_save_lease_without_refund(self):
        store = Mock(); store.jobs.return_value = [self.job]
        store.apply.return_value = {"claimed": True, "job": self.job}
        with patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "synthetic-key"}), patch.object(server, "require_authenticated_user", return_value=Mock(id=USER)), patch.object(server, "enforce_rate_limit"), patch.object(routes, "ImageStore", return_value=store), patch.object(provider, "query", return_value={"status": "completed", "urls": ["https://upload.apimart.ai/a.png"]}), patch.object(provider, "download_image", side_effect=provider.ImageTaskError("READ_FAILED", "not saved", 503)):
            result = self.client.get("/api/apimart-images/tasks/" + REQUEST, headers=self.headers)
        self.assertEqual(result.status_code, 503)
        self.assertEqual([call.args[2] for call in store.apply.call_args_list], ["claim", "retry"])

    def test_unknown_owner_and_reconcile_auth_do_not_read_media(self):
        store = Mock();store.jobs.return_value = []
        with patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "synthetic-key", "APIMART_IMAGE_RECONCILE_SECRET": ""}), patch.object(server, "require_authenticated_user", return_value=Mock(id=USER)), patch.object(server, "enforce_rate_limit"), patch.object(routes, "ImageStore", return_value=store), patch.object(provider, "query") as query:
            self.assertEqual(self.client.get("/api/apimart-images/tasks/" + REQUEST, headers=self.headers).status_code, 404)
            self.assertEqual(self.client.post("/api/apimart-images/reconcile").status_code, 401)
            query.assert_not_called()

    def test_completed_images_are_saved_before_exact_count_settlement(self):
        store = Mock(); store.jobs.return_value = [{**self.job, "requested_count": 2}]
        saved_job = {**self.job, "status": "completed", "image_keys": ["one.png", "two.png"]}
        store.apply.side_effect = [{"claimed": True, "job": self.job}, {"job": saved_job, "balance": 8}]
        with patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "synthetic-key"}), patch.object(server, "require_authenticated_user", return_value=Mock(id=USER)), patch.object(server, "enforce_rate_limit"), patch.object(routes, "ImageStore", return_value=store), patch.object(provider, "query", return_value={"status": "completed", "urls": ["https://upload.apimart.ai/a.png", "https://upload.apimart.ai/b.png"]}), patch.object(provider, "download_image", return_value=b"image-bytes"), patch.object(server, "store_generated_image") as save:
            result = self.client.get("/api/apimart-images/tasks/" + REQUEST, headers=self.headers)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(save.call_count, 2)
        self.assertEqual(store.apply.call_args.args[2], "completed")
        self.assertEqual(len(store.apply.call_args.kwargs["p_images"]), 2)
        self.assertEqual(result.json["credit_balance"], 8)

    def test_unexpected_output_count_never_overcharges(self):
        store = Mock();store.jobs.return_value = [self.job]
        with patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "synthetic-key"}), patch.object(server, "require_authenticated_user", return_value=Mock(id=USER)), patch.object(server, "enforce_rate_limit"), patch.object(routes, "ImageStore", return_value=store), patch.object(provider, "query", return_value={"status": "completed", "urls": ["a", "b"]}), patch.object(provider, "download_image") as download:
            result = self.client.get("/api/apimart-images/tasks/" + REQUEST, headers=self.headers)
        self.assertEqual(result.status_code, 503)
        store.apply.assert_not_called()
        download.assert_not_called()

    def test_reference_upload_failure_refunds_without_submitting_generation(self):
        store = Mock();store.begin.return_value = {"existing": False, "job": self.job}
        with patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "synthetic-key"}), patch.object(server, "require_authenticated_user", return_value=Mock(id=USER)), patch.object(server, "enforce_rate_limit"), patch.object(routes, "ImageStore", return_value=store), patch.object(server, "validate_reference_images_b64", return_value=[base64.b64encode(b"synthetic").decode()]), patch.object(routes.delivery, "prepare_references", side_effect=provider.ImageTaskError("REFERENCE_LINK_UNAVAILABLE", "link failed", 503)), patch.object(provider, "submit") as submit:
            result = self.client.post("/api/apimart-images/generations", json=self.body, headers=self.headers)
        self.assertEqual(result.status_code, 503)
        self.assertEqual(store.apply.call_args.args[2], "failed")
        self.assertEqual(result.json["phase"], "reference_upload")
        self.assertFalse(result.json["generation_submitted"])
        self.assertFalse(result.json["submission_unknown"])
        self.assertNotIn("提示词", result.json["detail"])
        submit.assert_not_called()

    def test_nano_submits_inline_reference_without_upload(self):
        image = io.BytesIO(); Image.new("RGB", (8, 8), "blue").save(image, format="PNG")
        encoded = base64.b64encode(image.getvalue()).decode()
        for model in ("gemini-nano-banana-2.1",):
            store = Mock(); job = {**self.job, "model": model}
            store.begin.return_value = {"existing": False, "job": job}
            store.apply.return_value = {"job": job}
            media_url = "https://getapib.org/image/reference.png"
            with self.subTest(model=model), patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "synthetic-key"}), patch.object(server, "require_authenticated_user", return_value=Mock(id=USER)), patch.object(server, "enforce_rate_limit"), patch.object(routes, "ImageStore", return_value=store), patch.object(server, "validate_reference_images_b64", return_value=[encoded]), patch.object(provider.requests, "request", return_value=response({"code": 200, "data": [{"task_id": TASK}]})) as request:
                result = self.client.post("/api/apimart-images/generations", json={**self.body, "platform_model": model}, headers=self.headers)
            self.assertEqual(result.status_code, 202)
            self.assertEqual(request.call_count, 1)
            self.assertTrue(request.call_args.args[1].endswith("/images/generations"))
            self.assertEqual(request.call_args.kwargs["json"]["image_urls"], ["data:image/png;base64," + encoded])
            self.assertEqual([call.args[2] for call in store.apply.call_args_list], ["submitted"])

    def test_expired_previous_image_is_rejected_before_reservation(self):
        with patch.dict("os.environ", {"APIMART_IMAGE_API_KEY": "synthetic-key"}), patch.object(server, "require_authenticated_user", return_value=Mock(id=USER)), patch.object(server, "enforce_rate_limit"), patch.object(server, "stored_image_to_base64", return_value=None), patch.object(routes, "ImageStore") as store:
            result = self.client.post("/api/apimart-images/generations", json={**self.body, "previous_image": "expired.png"}, headers=self.headers)
        self.assertEqual(result.status_code, 400)
        self.assertEqual(result.json["code"], "PREVIOUS_IMAGE_MISSING")
        store.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class GrokReferenceTests(unittest.TestCase):
    def test_official_reference_protocol_and_no_text_only_quality(self):
        plain = provider.build_request("grok-imagine-image-2.0", {"prompt": "cat", "resolution": "2K"})
        self.assertEqual(plain["resolution"], "2k")
        self.assertEqual(plain["aspect_ratio"], "auto")
        self.assertNotIn("size", plain)
        edited = provider.build_request("grok-imagine-image-2.0", {"prompt": "cat", "quality": "medium"}, ["one", "two", "three"])
        self.assertEqual(len(edited["image_urls"]), 3)
        self.assertNotIn("quality", edited)
        self.assertEqual(edited["resolution"], "1k")
        for model in ("grok-imagine-2.0-ext",):
            for stale_resolution in ("1K", "2K", "4K", "quality", "auto"):
                self.assertNotIn("resolution", provider.build_request(model, {"prompt": "cat", "resolution": stale_resolution}))
        with self.assertRaises(provider.ImageTaskError):
            provider.build_request("grok-imagine-image-2.0", {"prompt": "cat"}, ["one"] * 4)

    def test_reservation_uses_validated_reference_count_not_client_price(self):
        body = provider.build_request("grok-imagine-image-2.0", {"prompt": "cat", "unit_credit_cost": 0, "reference_count": 0}, ["one", "two"])
        store = routes.ImageStore.__new__(routes.ImageStore)
        store.rpc = Mock(return_value={"ok": True})
        store.begin("user-" + USER, USER, REQUEST, "platform", "grok-imagine-image-2.0", body, "cat")
        name, args = store.rpc.call_args.args
        self.assertEqual(name, "begin_apimart_image_job_v3")
        self.assertEqual(args["p_reference_count"], 2)
        self.assertIsNone(args["p_resolution"])
        self.assertNotIn("unit_credit_cost", args)
        self.assertNotIn("one", args["p_fingerprint"])

    def test_nano_reservation_uses_validated_resolution_and_ignores_client_price(self):
        for resolution in ("1K", "2K", "4K"):
            with self.subTest(resolution=resolution):
                body = provider.build_request("gemini-nano-banana-2.1", {"prompt": "cat", "resolution": resolution, "unit_credit_cost": 0, "credit_cost": 0}, ["one"])
                store = routes.ImageStore.__new__(routes.ImageStore)
                store.rpc = Mock(return_value={"ok": True})
                store.begin("user-" + USER, USER, REQUEST, "platform", "gemini-nano-banana-2.1", body, "cat")
                name, args = store.rpc.call_args.args
                self.assertEqual(name, "begin_apimart_image_job_v3")
                self.assertEqual(args["p_resolution"], resolution)
                self.assertEqual(args["p_reference_count"], 1)
                self.assertNotIn("credit_cost", body)
                self.assertNotIn("unit_credit_cost", args)
        with self.assertRaises(provider.ImageTaskError):
            provider.build_request("gemini-nano-banana-2.1", {"prompt": "cat", "resolution": "8K", "credit_cost": 1})
