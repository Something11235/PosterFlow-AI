"""Synthetic upstream only: provider routing, at-most-once POST and byte preservation."""
import base64
import io
import json
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests
from PIL import Image

from backend import buytoken_image_provider as provider, buytoken_image_routes as routes, server
from backend import apimart_image_routes as legacy_routes, apimart_image_provider as legacy_provider

RID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
MODEL = 'gpt-image-2.6-flare'
URL = 'https://result.example.invalid/output'
CONFIG = SimpleNamespace(endpoint='https://api.buytoken.work/v1/images/generations', api_key='synthetic', auth_type='bearer', model=MODEL, source='platform')
STORE_TYPE = routes.BuyTokenStore


def image_bytes(fmt='PNG', frames=1):
    images = [Image.new('RGBA', (24, 24), color) for color in ('red', 'blue', 'green')]
    stream = io.BytesIO()
    images[0].save(stream, format=fmt, save_all=frames > 1, append_images=images[1:frames], duration=[70, 130, 170][:frames], loop=2)
    return stream.getvalue()


def response(raw=None, status=200, headers=None):
    value = Mock(status_code=status, headers=headers or {})
    value.iter_content.return_value = [raw or json.dumps({'data': [{'url': URL}]}).encode()]
    return value


class BuyTokenImagesTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        for name, value in [('require_authenticated_user', Mock(id=USER)), ('set_optional_storage_scope', Mock(id=USER))]:
            self.stack.enter_context(patch.object(server, name, return_value=value))
        self.stack.enter_context(patch.object(server, 'enforce_rate_limit'))
        self.stack.enter_context(patch.object(server, 'resolve_provider_config', return_value=CONFIG))
        self.stack.enter_context(patch.object(server, 'validate_provider_endpoint'))
        self.job = {'id': USER, 'request_id': RID, 'status': 'submitting', 'model': MODEL, 'billing_mode': 'platform', 'created_at': '2026-11-09T12:00:00Z', 'provider_result_urls': [], 'image_keys': []}
        self.store = Mock()
        self.store.begin.return_value = {'existing': False, 'job': self.job}
        self.store.jobs.side_effect = lambda *_: [dict(self.job)]
        self.events = []

        def apply(_owner, _rid, event, **kwargs):
            self.events.append(event)
            if event == 'sending':
                self.job['status'] = 'processing'
            elif event == 'received':
                self.job['provider_result_urls'] = kwargs['p_urls']
            elif event == 'completed':
                self.job.update(status='completed', image_keys=kwargs['p_images'])
            elif event == 'retry':
                self.job['status'] = 'processing'
            elif event == 'unknown':
                self.job['status'] = 'submission_unknown'
            elif event == 'failed':
                self.job['status'] = 'failed'
            return {'ok': True, 'job': dict(self.job), 'send': event == 'sending', 'claimed': event == 'claim', 'balance': 99}

        self.store.apply.side_effect = apply
        self.stack.enter_context(patch.object(routes, 'BuyTokenStore', return_value=self.store))
        self.saved = self.stack.enter_context(patch.object(server, 'store_generated_image'))
        self.post = self.stack.enter_context(patch.object(provider.requests, 'post', return_value=response()))
        self.get = self.stack.enter_context(patch.object(provider.requests, 'get', return_value=response(image_bytes())))
        self.client = server.app.test_client()

    def generate(self, extra=None, headers=None, complete=True):
        headers = headers or {'X-Billing-Mode': 'platform'}
        result = self.client.post('/api/buytoken-images/generations', headers=headers, json={'request_id': RID, 'platform_model': MODEL, 'prompt': 'synthetic prompt', **(extra or {})})
        if complete and result.status_code == 202:
            result = self.client.get('/api/buytoken-images/tasks/' + RID, headers=headers)
        return result

    def test_both_models_send_one_standard_json_post_and_preserve_prices_count(self):
        for model in provider.MODELS:
            self.job.update(status='submitting', provider_result_urls=[], image_keys=[])
            self.post.reset_mock()
            result = self.generate({'platform_model': model, 'count': 4, 'size': 'landscape_16_9', 'quality': 'high'})
            self.assertEqual(result.status_code, 200, result.json)
            self.post.assert_called_once()
            endpoint, = self.post.call_args.args
            wire = self.post.call_args.kwargs['json']
            self.assertEqual(endpoint, CONFIG.endpoint)
            self.assertEqual(wire, {'model': model, 'prompt': 'synthetic prompt', 'n': 4, 'quality': 'auto', 'size': '1024x576'})
            self.assertNotIn('version', wire)
            self.assertEqual(self.store.begin.call_args.args[5]['references'], [])
            self.assertNotIn('provider_result_urls', result.json['job'])
            self.assertNotIn('synthetic', json.dumps(result.json))
            self.assertLess(self.events.index('received'), self.events.index('claim'))

    def test_reference_mask_multipart_uses_edits_and_mask_does_not_count_as_reference(self):
        reference = base64.b64encode(image_bytes()).decode()
        mask_buffer = io.BytesIO()
        Image.new('RGBA', (24, 24), (0, 0, 0, 0)).save(mask_buffer, format='PNG')
        mask = base64.b64encode(mask_buffer.getvalue()).decode()
        for mode in ('platform', 'own_key'):
            self.job.update(status='submitting', provider_result_urls=[], image_keys=[])
            self.post.reset_mock()
            headers = {'X-Billing-Mode': mode}
            if mode == 'own_key':
                headers.update({'X-Provider-Model': MODEL, 'X-Provider-Api-Key': 'synthetic', 'X-Provider-Endpoint': CONFIG.endpoint})
            with patch.object(legacy_provider, 'upload_reference') as upload:
                result = self.generate({'reference_images_b64': [reference, reference], 'mask_b64': mask, 'pricing_version': 2, 'canvas_workflow': 'redraw'}, headers)
            self.assertEqual(result.status_code, 200, result.json)
            upload.assert_not_called()
            self.assertEqual(self.post.call_args.args[0], 'https://api.buytoken.work/v1/images/edits')
            self.assertEqual([name for name, _ in self.post.call_args.kwargs['files']], ['image[]', 'image[]', 'mask'])
            self.assertEqual(self.post.call_args.kwargs['data']['quality'], 'auto')
            self.assertEqual(len(self.store.begin.call_args.args[5]['references']), 2)
            self.assertEqual(self.store.begin.call_args.args[3], mode)

    def test_timeout_server_failure_rate_limit_redirect_or_malformed_success_hold_without_retry(self):
        for failure in [requests.Timeout(), response(status=500), response(status=429), response(status=302), response(b'{}'), response(b'not json')]:
            self.post.reset_mock()
            self.job.update(status='submitting', provider_result_urls=[])
            self.post.side_effect = failure if isinstance(failure, Exception) else None
            self.post.return_value = failure
            result = self.generate()
            self.assertEqual(result.status_code, 503, result.json)
            self.assertTrue(result.json['submission_unknown'])
            self.assertEqual(self.events[-1], 'unknown')
            self.post.assert_called_once()
            self.client.get('/api/buytoken-images/tasks/' + RID, headers={'X-Billing-Mode': 'platform'})
            self.post.assert_called_once()
            self.assertEqual(self.job['status'], 'submission_unknown')

    def test_clear_rejection_refunds_and_does_not_download(self):
        for status in (400, 401, 403, 404, 405, 413, 415, 422):
            self.job.update(status='submitting', provider_result_urls=[])
            self.post.return_value = response(status=status)
            result = self.generate()
            self.assertEqual(result.status_code, 502)
            self.assertFalse(result.json['submission_unknown'])
            self.assertEqual(self.events[-1], 'failed')
        self.get.assert_not_called()

    def test_failed_save_retains_urls_and_get_only_recovers_without_generation(self):
        self.get.side_effect = requests.Timeout()
        result = self.generate()
        self.assertEqual(result.status_code, 503)
        self.assertEqual(result.json['code'], 'IMAGE_SAVE_PENDING')
        self.assertEqual(self.job['provider_result_urls'], [URL])
        self.get.side_effect = None
        result = self.client.get('/api/buytoken-images/tasks/' + RID, headers={'X-Billing-Mode': 'platform'})
        self.assertEqual(result.json['job']['status'], 'completed')
        self.post.assert_called_once()
        self.saved.assert_called_once()

    def test_successful_post_persists_results_and_defers_download_to_a_fresh_get(self):
        result = self.generate(complete=False)
        self.assertEqual(result.status_code, 202, result.json)
        self.assertEqual(self.job['provider_result_urls'], [URL])
        self.get.assert_not_called()
        self.assertNotIn('provider_result_urls', result.json['job'])

    def test_database_failure_after_paid_post_is_marked_uncertain(self):
        apply = self.store.apply.side_effect

        def fail_received(owner, rid, event, **kwargs):
            if event == 'received':
                raise routes.SupabaseError('synthetic database unavailable')
            return apply(owner, rid, event, **kwargs)

        self.store.apply.side_effect = fail_received
        result = self.generate()
        self.assertEqual(result.status_code, 503, result.json)
        self.assertTrue(result.json['submission_unknown'])
        self.post.assert_called_once()

    def test_duplicate_or_lost_sending_race_cannot_repeat_post(self):
        self.store.begin.return_value = {'existing': True, 'job': self.job}
        self.assertEqual(self.generate().status_code, 200)
        self.store.begin.return_value = {'existing': False, 'job': self.job}
        self.store.apply.side_effect = None
        self.store.apply.return_value = {'send': False, 'job': self.job}
        self.assertEqual(self.generate().status_code, 200)
        self.post.assert_not_called()

    def test_invalid_format_count_revision_and_mask_are_rejected_before_reserve(self):
        ref = base64.b64encode(image_bytes()).decode()
        for body, code in [({'output_format': 'gif'}, 'IMAGE_FEATURE_UNSUPPORTED'), ({'count': 5}, 'INVALID_IMAGE_REQUEST'), ({'reference_images_b64': [ref]}, 'IMAGE_PRICING_CHANGED'), ({'reference_images_b64': [ref], 'mask_b64': ref, 'pricing_version': 2}, 'IMAGE_MASK_INVALID')]:
            result = self.generate(body)
            self.assertIn(result.status_code, (400, 409), result.json)
            if code != 'INVALID_IMAGE_REQUEST':
                self.assertEqual(result.json['code'], code)
        self.store.begin.assert_not_called()
        self.post.assert_not_called()

    def test_platform_cannot_override_key_and_wrong_origin_or_owner_do_not_submit(self):
        result = self.generate(headers={'X-Billing-Mode': 'platform', 'X-Provider-Api-Key': 'synthetic'})
        self.assertEqual(result.json['code'], 'PLATFORM_PROVIDER_OVERRIDE_BLOCKED')
        self.assertEqual(self.generate(headers={'Origin': 'https://wrong.example.invalid'}).status_code, 403)
        self.store.jobs.return_value = []
        self.store.jobs.side_effect = None
        self.assertEqual(self.client.get('/api/buytoken-images/tasks/' + RID, headers={'X-Billing-Mode': 'platform'}).status_code, 404)
        self.post.assert_not_called()

    def test_foreign_private_reference_is_rejected_before_reservation_or_cleanup(self):
        with patch.object(server, 'cleanup_reference_storage_paths') as cleanup:
            result = self.generate({'reference_storage_paths': ['posterflow/user-someone-else/references/source.png']})
        self.assertEqual(result.status_code, 400, result.json)
        self.store.begin.assert_not_called()
        self.post.assert_not_called()
        cleanup.assert_not_called()

    def test_new_platform_generation_needs_no_apimart_key(self):
        with patch.dict('os.environ', {'APIMART_IMAGE_API_KEY': ''}):
            result = self.generate()
        self.assertEqual(result.status_code, 200, result.json)
        self.post.assert_called_once()

    def test_actual_prompt_generated_gif_is_saved_with_original_animation_bytes(self):
        gif = image_bytes('GIF', 3)
        self.get.return_value = response(gif)
        result = self.generate({'prompt': 'a looping GIF'})
        self.assertEqual(result.status_code, 200, result.json)
        filename, content = self.saved.call_args.args
        self.assertTrue(filename.endswith('.gif'))
        self.assertEqual(content, gif)
        with Image.open(io.BytesIO(content)) as animation:
            self.assertEqual(animation.n_frames, 3)
            self.assertEqual(animation.info['loop'], 2)
        self.assertNotIn('output_format', self.post.call_args.kwargs['json'])

    def test_static_output_is_never_renamed_gif_just_because_prompt_requests_gif(self):
        result = self.generate({'prompt': 'a looping GIF'})
        self.assertEqual(result.status_code, 200)
        self.assertTrue(self.saved.call_args.args[0].endswith('.png'))

    def test_redirect_and_private_result_addresses_never_receive_credentials(self):
        self.get.side_effect = [response(status=302, headers={'Location': 'http://127.0.0.1/private'}), response(image_bytes())]
        with self.assertRaises(provider.ImageTaskError):
            provider.download(server, URL)
        self.get.assert_called_once()
        self.assertNotIn('headers', self.get.call_args.kwargs)
        for url in ('http://example.invalid/x', 'https://user:secret@example.invalid/x', 'https://example.invalid/x#fragment'):
            with self.assertRaises(provider.ImageTaskError):
                provider.validate_result_url(server, url)

    def test_wrong_platform_endpoint_is_not_given_the_existing_key(self):
        for endpoint in ('https://api.apimart.ai/v1/images/generations', 'https://api.buytoken.work.evil.invalid/v1/images/generations', 'https://api.buytoken.work:444/v1/images/generations'):
            with patch.object(server, 'resolve_provider_config', return_value=SimpleNamespace(endpoint=endpoint)):
                with self.assertRaises(provider.ImageTaskError):
                    provider.resolve_config(server, 'platform', MODEL)
        self.post.assert_not_called()

    def test_old_platform_post_is_rejected_but_old_pending_task_uses_original_query(self):
        old = {**self.job, 'status': 'processing', 'provider_task_id': 'task_old_fixture', 'submission_provider': 'apimart'}
        with patch.dict('os.environ', {'APIMART_IMAGE_API_KEY': 'synthetic-old'}), patch.object(legacy_routes, 'ImageStore', return_value=self.store), patch.object(legacy_provider, 'query', return_value={'status': 'processing'}) as query:
            result = self.client.post('/api/apimart-images/generations', headers={'X-Billing-Mode': 'platform'}, json={'platform_model': MODEL})
            self.assertEqual(result.status_code, 409)
            self.assertEqual(result.json['code'], 'IMAGE_PROVIDER_CHANGED')
            self.store.jobs.side_effect = None
            self.store.jobs.return_value = [old]
            result = self.client.get('/api/apimart-images/tasks/' + RID, headers={'X-Billing-Mode': 'platform'})
            self.assertEqual(result.status_code, 200, result.json)
            query.assert_called_once_with('synthetic-old', 'task_old_fixture')
        self.post.assert_not_called()

    def test_new_rpc_names_and_owned_provider_filter_are_explicit(self):
        store = object.__new__(STORE_TYPE)
        store.rpc, store.gateway = Mock(), Mock()
        body = provider.build_request(server, MODEL, {'prompt': 'fixture', 'count': 4}, ['reference'])
        store.begin('owner', USER, RID, 'platform', MODEL, body, 'fixture')
        name, values = store.rpc.call_args.args
        self.assertEqual(name, 'begin_buytoken_gpt26_image_job')
        self.assertEqual(values['p_count'], 4)
        self.assertEqual(values['p_reference_count'], 1)
        self.assertNotIn('p_price', values)
        store.jobs('owner', RID)
        self.assertEqual(store.gateway._request.call_args.kwargs['params']['submission_provider'], 'eq.buytoken')
