import unittest
from unittest.mock import Mock, patch
from backend import apimart_image_provider as provider, apimart_image_routes as routes, server


class Gpt26ImageTests(unittest.TestCase):
    def test_two_logical_versions_share_ext_wire_model_and_keep_version(self):
        for version in ('flare', 'sunburst'):
            model = 'gpt-image-2.6-' + version
            body = provider.build_request(model, {'prompt': 'fixture', 'quality': 'high', 'size': 'landscape_16_9'}, ['reference'])
            self.assertEqual(body, {'model': 'gpt-image-2.6-ext', 'version': version, 'prompt': 'fixture', 'resolution': '1k', 'size': '16:9', 'quality': 'high', 'output_format': 'png', 'n': 1, 'image_urls': ['reference']})
            self.assertNotIn('official_fallback', body)

    def test_unsupported_count_resolution_canvas_and_formats_never_reach_provider(self):
        for version in ('flare', 'sunburst'):
            model = 'gpt-image-2.6-' + version
            for extra in ({'count': 2}, {'count': True}, {'resolution': '2K'}, {'resolution': '4K'}, {'mask_b64': 'fixture'}, {'markup': 'fixture'}, {'canvas_workflow': 'frame'}, {'canvas_workflow': 'iterative'}, {'size': 'custom', 'custom_width': 1024, 'custom_height': 1024}, {'output_format': 'svg'}, {'quality': 'ultra'}, {'version': 'sunburst' if version == 'flare' else 'flare'}):
                with self.subTest(model=model, extra=extra), self.assertRaises(provider.ImageTaskError):
                    provider.build_request(model, {'prompt': 'fixture', **extra})
            with self.assertRaises(provider.ImageTaskError):
                provider.build_request(model, {'prompt': 'fixture'}, ['reference'] * 9)

    def test_logical_models_reserve_separately_at_normalized_1k(self):
        store = object.__new__(routes.ImageStore)
        store.rpc = Mock()
        for version in ('flare', 'sunburst'):
            model = 'gpt-image-2.6-' + version
            store.begin('owner', None, 'fixture', 'own_key', model, provider.build_request(model, {'prompt': 'fixture'}), 'fixture')
            name, params = store.rpc.call_args.args
            self.assertEqual(name, 'begin_gpt26_image_job')
            self.assertEqual(params['p_model'], model)
            self.assertEqual(params['p_resolution'], '1K')
            self.assertNotIn('p_price', params)

    def test_each_version_sends_exactly_one_paid_submission_with_correct_wire_version(self):
        for version in ('flare', 'sunburst'):
            model = 'gpt-image-2.6-' + version
            job = {'id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'status': 'submitting', 'request_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}
            store = Mock()
            store.begin.return_value = {'existing': False, 'job': job}
            store.apply.return_value = {'job': {**job, 'status': 'submitted'}}
            with patch.dict('os.environ', {'APIMART_IMAGE_API_KEY': 'synthetic'}), patch.object(server, 'require_authenticated_user', return_value=Mock(id='fixture')), patch.object(server, 'enforce_rate_limit'), patch.object(routes, 'ImageStore', return_value=store), patch.object(provider, 'submit', return_value='task_gpt26_fixture') as submit:
                response = server.app.test_client().post('/api/apimart-images/generations', headers={'X-Billing-Mode': 'platform'}, json={'platform_model': model, 'prompt': 'fixture', 'request_id': job['request_id'], 'unit_credit_cost': 0})
            self.assertEqual(response.status_code, 202)
            self.assertEqual(store.begin.call_args.args[4], model)
            submit.assert_called_once()
            self.assertEqual(submit.call_args.args[1]['model'], 'gpt-image-2.6-ext')
            self.assertEqual(submit.call_args.args[1]['version'], version)

    def test_rejected_canvas_never_reserves_or_submits(self):
        with patch.dict('os.environ', {'APIMART_IMAGE_API_KEY': 'synthetic'}), patch.object(server, 'require_authenticated_user', return_value=Mock(id='fixture')), patch.object(server, 'enforce_rate_limit'), patch.object(routes, 'ImageStore') as store, patch.object(provider, 'submit') as submit:
            response = server.app.test_client().post('/api/apimart-images/generations', headers={'X-Billing-Mode': 'platform'}, json={'platform_model': 'gpt-image-2.6-flare', 'prompt': 'fixture', 'request_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'canvas_workflow': 'frame'})
        self.assertEqual(response.status_code, 400)
        store.assert_not_called()
        submit.assert_not_called()

    def test_retired_model_rejected_for_new_own_key_requests_before_dns_or_provider(self):
        headers = {'X-Provider-Api-Key': 'synthetic', 'X-Provider-Model': 'gpt-image-2', 'X-Provider-Endpoint': 'https://example.invalid/v1/images/generations', 'X-Provider-Auth-Type': 'bearer'}
        with patch.object(server, 'validate_provider_endpoint') as validate:
            response = server.app.test_client().post('/api/provider/validate', headers=headers)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json['code'], 'MODEL_RETIRED')
        validate.assert_not_called()
