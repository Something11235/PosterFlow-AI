import base64
import io
import unittest
from unittest.mock import Mock, patch
from PIL import Image
from backend import apimart_image_provider as provider
from backend.apimart_image_routes import ImageStore
from backend import apimart_image_routes as routes, server


class SeedreamImageTests(unittest.TestCase):
    def test_non_string_models_return_validation_errors(self):
        for model in (None, [], {}, 7):
            with self.subTest(model=model), self.assertRaises(provider.ImageTaskError) as error:
                provider.build_request(model, {"prompt":"fixture"})
            self.assertEqual(error.exception.code, "MODEL_NOT_ALLOWED")

    def test_nano_uses_official_model_without_ext_or_fallback(self):
        for resolution in ("1K", "2K", "4K"):
            body = provider.build_request("gemini-nano-banana-2.1", {"prompt":"fixture", "resolution":resolution, "model":"gemini-nano-banana-2.1-ext", "official_fallback":True})
            self.assertEqual(body["model"],"gemini-nano-banana-2.1")
            self.assertNotIn("official_fallback",body)
            self.assertEqual(body["resolution"],resolution)
            self.assertEqual(body["n"],1)
        with self.assertRaises(provider.ImageTaskError):
            provider.build_request("gemini-nano-banana-2.1",{"prompt":"fixture","count":2})

    def test_seedream_models_do_not_share_resolution_or_count_contracts(self):
        for model,resolutions in [("seedream-5-0-pro",["1K","1.5K","2K"]),("seedream-5-0-flash",["1K","1.5K","2K"])]:
            for resolution in resolutions:
                body=provider.build_request(model,{"prompt":"fixture","resolution":resolution,"size":"landscape_4_3"},["one"])
                self.assertEqual(body["model"],model)
                self.assertEqual(body["size"],"4:3")
                self.assertEqual(body["image_urls"],["one"])
                self.assertEqual(body["output_format"],"png")
                self.assertNotIn("official_fallback",body)
            with self.assertRaises(provider.ImageTaskError):provider.build_request(model,{"prompt":"fixture","resolution":"8K"})
        for model in ("seedream-5-0-pro","seedream-5-0-flash"):
            with self.assertRaises(provider.ImageTaskError):provider.build_request(model,{"prompt":"fixture","count":2})
        with self.assertRaises(provider.ImageTaskError) as error:
            provider.build_request("seedream-5-0-lite",{"prompt":"fixture","count":4})
        self.assertEqual(error.exception.code,"MODEL_RETIRED")

    def test_canvas_and_unimplemented_special_operations_fail_before_upstream(self):
        for model in ("seedream-5-0-pro","seedream-5-0-lite","seedream-5-0-flash"):
            for extra in ({"mask_b64":"fixture"},{"layer_decomposition":True},{"tools":["search"]},{"background":"transparent"}):
                with self.subTest(model=model,extra=extra),self.assertRaises(provider.ImageTaskError):provider.build_request(model,{"prompt":"fixture",**extra})
        with self.assertRaises(provider.ImageTaskError):provider.build_request("seedream-5-0-lite",{"prompt":"fixture","canvas_workflow":"frame"})

    def test_custom_pixels_only_supported_for_pro_flash_and_validated(self):
        for model in ("seedream-5-0-pro","seedream-5-0-flash"):
            body=provider.build_request(model,{"prompt":"fixture","size":"custom","custom_width":1600,"custom_height":1600,"resolution":"1K"})
            self.assertEqual(body["size"],"1600x1600")
            self.assertNotIn("resolution",body)
            with self.assertRaises(provider.ImageTaskError):provider.build_request(model,{"prompt":"fixture","size":"custom","custom_width":256,"custom_height":256})

    def test_lite_converts_webp_to_png_and_rejects_unsupported_aspect(self):
        output=io.BytesIO();Image.new("RGB",(64,48)).save(output,format="WEBP")
        reference=base64.b64encode(output.getvalue()).decode()
        normalized=provider.normalize_model_references("seedream-5-0-lite",[reference])
        self.assertTrue(base64.b64decode(normalized[0]).startswith(b"\x89PNG"))
        output=io.BytesIO();Image.new("RGB",(600,40)).save(output,format="PNG")
        reference=base64.b64encode(output.getvalue()).decode()
        with self.assertRaises(provider.ImageTaskError):provider.normalize_model_references("seedream-5-0-lite",[reference])
        self.assertEqual(provider.normalize_model_references("seedream-5-0-pro",[reference]),[reference])

    def test_documented_unwrapped_success_response_is_completed(self):
        with patch.object(provider,"api_request",return_value={"id":"task_fixture_1234","status":"success","result":{"images":[{"url":["https://example.invalid/image.png"]}]}}):
            result=provider.query("synthetic","task_fixture_1234")
        self.assertEqual(result["status"],"completed")
        self.assertEqual(len(result["urls"]),1)

    def test_new_rpc_uses_model_and_validated_parameters_not_browser_price(self):
        store=object.__new__(ImageStore);store.rpc=Mock()
        body=provider.build_request("seedream-5-0-flash",{"prompt":"fixture","unit_credit_cost":0})
        store.begin("owner",None,"fixture-request","own_key","seedream-5-0-flash",body,"fixture")
        name,params=store.rpc.call_args.args
        self.assertEqual(name,"begin_seedream_image_job")
        self.assertEqual(params["p_model"],"seedream-5-0-flash")
        self.assertNotIn("unit_credit_cost",params)

    def test_retired_lite_platform_and_own_key_requests_never_reserve_or_submit(self):
        modes = [{'X-Billing-Mode':'platform'}, {'X-Billing-Mode':'own_key', 'X-Provider-Model':'seedream-5-0-lite',
                  'X-Provider-Api-Key':'synthetic', 'X-Provider-Endpoint':provider.BASE+'/images/generations'}]
        for headers in modes:
            with self.subTest(headers=headers), patch.dict("os.environ",{"APIMART_IMAGE_API_KEY":"synthetic"}), patch.object(server,"require_authenticated_user",return_value=Mock(id="user-fixture")), patch.object(server,"set_optional_storage_scope",return_value=Mock(id="user-fixture")), patch.object(server,"enforce_rate_limit"), patch.object(routes,"ImageStore") as store, patch.object(provider,"submit") as submit, patch.object(server,"stored_reference_to_base64") as read_reference:
                response=server.app.test_client().post('/api/apimart-images/generations',headers=headers,json={'platform_model':'seedream-5-0-lite','request_id':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','prompt':'fixture','reference_storage_paths':['invalid-not-read']})
            self.assertEqual(response.status_code,400)
            self.assertEqual(response.json['code'],'MODEL_RETIRED')
            self.assertFalse(response.json['generation_submitted'])
            store.assert_not_called();submit.assert_not_called();read_reference.assert_not_called()

    def test_retired_lite_is_not_advertised_and_generic_route_cannot_bypass_retirement(self):
        response = server.app.test_client().get('/api/apimart-images/config')
        self.assertNotIn('seedream-5-0-lite', [item['model'] for item in response.json['models']])
        with server.app.test_request_context(headers={'X-Provider-Model':'seedream-5-0-lite',
             'X-Provider-Api-Key':'synthetic', 'X-Provider-Endpoint':'https://example.invalid/v1/images/generations'}), patch.object(server,'validate_provider_endpoint') as validate:
            with self.assertRaises(server.ProviderError) as error:
                server.resolve_provider_config('own_key')
            self.assertEqual(error.exception.code,'MODEL_RETIRED')
            validate.assert_not_called()

    def test_retired_lite_completed_and_pending_original_tasks_remain_queryable(self):
        rid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        for status in ('completed','submitted'):
            store=Mock()
            job={'id':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','request_id':rid,'model':'seedream-5-0-lite',
                 'billing_mode':'platform','status':status,'image_keys':['original.png'] if status=='completed' else [],
                 'provider_task_id':'task_synthetic_12345','requested_count':1}
            store.jobs.return_value=[job]
            store.apply.return_value={'job':{**job,'status':'processing'}}
            with self.subTest(status=status),patch.dict('os.environ',{'APIMART_IMAGE_API_KEY':'synthetic'}),patch.object(server,'require_authenticated_user',return_value=Mock(id='user-fixture')),patch.object(server,'enforce_rate_limit'),patch.object(routes,'ImageStore',return_value=store),patch.object(provider,'query',return_value={'status':'processing'}) as query,patch.object(provider,'submit') as submit:
                response=server.app.test_client().get('/api/apimart-images/tasks/'+rid,headers={'X-Billing-Mode':'platform'})
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.json['job']['model'],'seedream-5-0-lite')
            if status=='completed':
                self.assertEqual(response.json['images'][0]['filename'],'original.png');query.assert_not_called()
            else:
                query.assert_called_once_with('synthetic','task_synthetic_12345')
            store.begin.assert_not_called();submit.assert_not_called()

    def test_nano_logical_price_model_stays_stable_while_official_is_submitted(self):
        store=Mock();job={'id':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','status':'submitting','request_id':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}
        store.begin.return_value={'existing':False,'job':job};store.apply.return_value={'job':{**job,'status':'submitted'}}
        with patch.dict('os.environ',{'APIMART_IMAGE_API_KEY':'synthetic'}),patch.object(server,'require_authenticated_user',return_value=Mock(id='user-fixture')),patch.object(server,'enforce_rate_limit'),patch.object(routes,'ImageStore',return_value=store),patch.object(provider,'submit',return_value='task_synthetic_12345') as submit:
            response=server.app.test_client().post('/api/apimart-images/generations',headers={'X-Billing-Mode':'platform'},json={'platform_model':'gemini-nano-banana-2.1','request_id':job['request_id'],'prompt':'fixture','resolution':'4K'})
        self.assertEqual(response.status_code,202)
        self.assertEqual(store.begin.call_args.args[4],'gemini-nano-banana-2.1')
        submit.assert_called_once()
        self.assertEqual(submit.call_args.args[1]['model'],'gemini-nano-banana-2.1')
        self.assertNotIn('official_fallback',submit.call_args.args[1])
