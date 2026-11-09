import base64
import io
import unittest
from PIL import Image
from unittest.mock import Mock, patch
from backend import apimart_image_provider as provider, apimart_image_routes as routes, server


class Gpt26ImageTests(unittest.TestCase):
    @staticmethod
    def image(mode='RGB', size=(24, 24)):
        stream = io.BytesIO()
        Image.new(mode, size, (0, 0, 0, 0) if mode == 'RGBA' else 'blue').save(stream, format='PNG')
        return base64.b64encode(stream.getvalue()).decode()

    def test_canvas_frame_uses_official_auto_and_no_image_input(self):
        for version in ('flare', 'sunburst'):
            body = provider.build_request('gpt-image-2.6-' + version, {'prompt': 'fixture', 'canvas_workflow': 'frame', 'quality': 'max'})
            self.assertEqual(body['model'], 'gpt-image-2.6-' + version)
            self.assertEqual(body['quality'], 'auto')
            self.assertNotIn('image_urls', body)

    def test_official_png_and_gif_batches_preserve_count_and_single_submission(self):
        for version in ('flare', 'sunburst'):
            for output_format in ('png', 'gif'):
                for count in (1, 2, 3, 4):
                    model = 'gpt-image-2.6-' + version
                    body = provider.build_request(model, {'prompt': 'fixture', 'count': count, 'output_format': output_format}, ['reference'])
                    self.assertEqual(body['n'], count)
                    self.assertEqual(body['model'], model)
                    self.assertEqual(body['quality'], 'auto')
                    with patch.object(provider, 'api_request', return_value={'data': [{'task_id': 'task_batch_fixture'}]}) as call:
                        self.assertEqual(provider.submit('synthetic', body, 'fixture'), 'task_batch_fixture')
                    call.assert_called_once()


    def test_stale_reference_price_is_rejected_before_any_reservation_or_upstream_call(self):
        for revision in (None, 1, True, '2'):
            with self.subTest(revision=revision), patch.dict('os.environ', {'APIMART_IMAGE_API_KEY': 'synthetic'}), patch.object(server, 'require_authenticated_user', return_value=Mock(id='fixture')), patch.object(server, 'enforce_rate_limit'), patch.object(routes, 'ImageStore') as store, patch.object(provider, 'upload_reference') as upload, patch.object(provider, 'submit') as submit:
                response = server.app.test_client().post('/api/apimart-images/generations', headers={'X-Billing-Mode': 'platform'}, json={'platform_model': 'gpt-image-2.6-flare', 'prompt': 'fixture', 'request_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'reference_images_b64': [self.image()], 'pricing_version': revision, 'unit_credit_cost': 0})
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json['code'], 'IMAGE_PRICING_CHANGED')
            self.assertFalse(response.json['generation_submitted'])
            self.assertIn('1.5', response.json['detail'])
            store.assert_not_called(); upload.assert_not_called(); submit.assert_not_called()

    def test_validated_canvas_masks_use_data_url_and_never_count_as_references(self):
        reference, mask = self.image(), self.image('RGBA')
        for version in ('flare', 'sunburst'):
            for mode in ('platform', 'own_key'):
                model = 'gpt-image-2.6-' + version
                job = {'id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'request_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'status': 'submitting'}
                store = Mock()
                store.begin.return_value = {'existing': False, 'job': job}
                store.apply.return_value = {'job': {**job, 'status': 'submitted'}}
                headers = {'X-Billing-Mode': 'platform'} if mode == 'platform' else {'X-Provider-Api-Key': 'synthetic', 'X-Provider-Model': model, 'X-Provider-Endpoint': provider.BASE + '/images/generations'}
                data = {'platform_model': model, 'prompt': 'fixture', 'request_id': job['request_id'], 'reference_storage_paths': ['synthetic-source'], 'mask_storage_path': 'synthetic-mask', 'canvas_workflow': 'redraw', 'unit_credit_cost': 0, 'quality': 'high', 'pricing_version': 2}
                with self.subTest(version=version, mode=mode), patch.dict('os.environ', {'APIMART_IMAGE_API_KEY': 'synthetic'}), patch.object(server, 'require_authenticated_user', return_value=Mock(id='fixture')), patch.object(server, 'set_optional_storage_scope', return_value=Mock(id='fixture')), patch.object(server, 'enforce_rate_limit'), patch.object(routes, 'ImageStore', return_value=store), patch.object(server, 'validate_reference_storage_paths', return_value=['synthetic-source']), patch.object(server, 'validate_reference_storage_path', return_value='synthetic-mask'), patch.object(server, 'stored_reference_to_base64', side_effect=lambda path: mask if path == 'synthetic-mask' else reference), patch.object(server, 'cleanup_reference_storage_paths') as cleanup, patch.object(provider, 'upload_reference', return_value='https://getapib.org/synthetic.png') as upload, patch.object(provider, 'submit', return_value='task_gpt26_fixture') as submit:
                    response = server.app.test_client().post('/api/apimart-images/generations', headers=headers, json=data)
                self.assertEqual(response.status_code, 202)
                upload.assert_called_once()
                self.assertEqual(upload.call_args.args[1], reference)
                submitted = submit.call_args.args[1]
                self.assertEqual(submitted['model'], model)
                self.assertEqual(submitted['quality'], 'auto')
                self.assertEqual(submitted['mask_url'], 'data:image/png;base64,' + mask)
                self.assertEqual(submitted['image_urls'], ['https://getapib.org/synthetic.png'])
                cleanup.assert_called_once_with(['synthetic-source', 'synthetic-mask'])
                reserved_body = store.begin.call_args.args[5]
                self.assertEqual(len(reserved_body['image_urls']), 1)

    def test_invalid_masks_never_reserve_upload_or_submit_and_temp_files_are_cleaned(self):
        for mask in (self.image('RGBA', (16, 24)), self.image('RGB'), 'not-base64'):
            with self.subTest(mask=mask[:8]), patch.dict('os.environ', {'APIMART_IMAGE_API_KEY': 'synthetic'}), patch.object(server, 'require_authenticated_user', return_value=Mock(id='fixture')), patch.object(server, 'enforce_rate_limit'), patch.object(routes, 'ImageStore') as store, patch.object(server, 'validate_reference_storage_paths', return_value=['synthetic-source']), patch.object(server, 'validate_reference_storage_path', return_value='synthetic-mask'), patch.object(server, 'stored_reference_to_base64', side_effect=[self.image(), mask]), patch.object(server, 'cleanup_reference_storage_paths') as cleanup, patch.object(provider, 'upload_reference') as upload, patch.object(provider, 'submit') as submit:
                response = server.app.test_client().post('/api/apimart-images/generations', headers={'X-Billing-Mode': 'platform'}, json={'platform_model': 'gpt-image-2.6-flare', 'prompt': 'fixture', 'request_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'canvas_workflow': 'redraw', 'reference_storage_paths': ['synthetic-source'], 'mask_storage_path': 'synthetic-mask', 'pricing_version': 2})
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['code'], 'IMAGE_MASK_INVALID')
            self.assertFalse(response.json['generation_submitted'])
            self.assertEqual(response.json['phase'], 'validation')
            store.assert_not_called(); upload.assert_not_called(); submit.assert_not_called()
            cleanup.assert_called_once_with(['synthetic-source', 'synthetic-mask'])

    def test_duplicate_request_returns_original_job_without_upload_or_resubmission(self):
        store = Mock()
        store.begin.return_value = {'existing': True, 'job': {'status': 'submitted'}}
        with patch.dict('os.environ', {'APIMART_IMAGE_API_KEY': 'synthetic'}), patch.object(server, 'require_authenticated_user', return_value=Mock(id='fixture')), patch.object(server, 'enforce_rate_limit'), patch.object(routes, 'ImageStore', return_value=store), patch.object(provider, 'upload_reference') as upload, patch.object(provider, 'submit') as submit:
            response = server.app.test_client().post('/api/apimart-images/generations', headers={'X-Billing-Mode': 'platform'}, json={'platform_model': 'gpt-image-2.6-flare', 'prompt': 'fixture', 'request_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'reference_images_b64': [self.image()], 'pricing_version': 2})
        self.assertEqual(response.status_code, 200)
        upload.assert_not_called(); submit.assert_not_called()

    def test_two_versions_use_official_models_with_server_fixed_auto_quality(self):
        for version in ('flare', 'sunburst'):
            model = 'gpt-image-2.6-' + version
            body = provider.build_request(model, {'prompt': 'fixture', 'quality': 'high', 'size': 'landscape_16_9'}, ['reference'])
            self.assertEqual(body, {'model': model, 'prompt': 'fixture', 'resolution': '1k', 'size': '16:9', 'quality': 'auto', 'output_format': 'png', 'n': 1, 'image_urls': ['reference']})
            self.assertNotIn('version', body)
            self.assertNotIn('official_fallback', body)

    def test_unsupported_count_resolution_unvalidated_masks_and_formats_are_rejected(self):
        for version in ('flare', 'sunburst'):
            model = 'gpt-image-2.6-' + version
            for extra in ({'count': 0}, {'count': 5}, {'count': 1.5}, {'count': True}, {'resolution': '2K'}, {'resolution': '4K'}, {'mask_b64': 'fixture'}, {'mask_url': 'https://example.invalid/mask.png'}, {'markup': 'fixture'}, {'canvas_workflow': 'invalid'}, {'canvas_workflow': 'iterative'}, {'size': 'custom', 'custom_width': 1024, 'custom_height': 1024}, {'output_format': 'svg'}, {'version': 'sunburst' if version == 'flare' else 'flare'}):
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
            self.assertEqual(name, 'begin_gpt26_image_job_v2')
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
                response = server.app.test_client().post('/api/apimart-images/generations', headers={'X-Billing-Mode': 'platform'}, json={'platform_model': model, 'prompt': 'fixture', 'request_id': job['request_id'], 'unit_credit_cost': 0, 'count': 4})
            self.assertEqual(response.status_code, 202)
            self.assertEqual(store.begin.call_args.args[4], model)
            submit.assert_called_once()
            self.assertEqual(submit.call_args.args[1]['model'], model)
            self.assertEqual(submit.call_args.args[1]['quality'], 'auto')
            self.assertEqual(submit.call_args.args[1]['n'], 4)
            self.assertEqual(store.begin.call_args.args[5]['n'], 4)
            self.assertNotIn('version', submit.call_args.args[1])

    def test_redraw_without_source_never_reserves_or_submits(self):
        with patch.dict('os.environ', {'APIMART_IMAGE_API_KEY': 'synthetic'}), patch.object(server, 'require_authenticated_user', return_value=Mock(id='fixture')), patch.object(server, 'enforce_rate_limit'), patch.object(routes, 'ImageStore') as store, patch.object(provider, 'submit') as submit:
            response = server.app.test_client().post('/api/apimart-images/generations', headers={'X-Billing-Mode': 'platform'}, json={'platform_model': 'gpt-image-2.6-flare', 'prompt': 'fixture', 'request_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'canvas_workflow': 'redraw'})
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
