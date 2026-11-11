"""Resolution price/wire contracts; all provider and database calls are synthetic."""
import unittest
from contextlib import ExitStack
from decimal import Decimal
from unittest.mock import Mock, patch

from backend import image_tier_pricing as tiers, apimart_image_provider as provider
from backend import apimart_image_routes as routes, buytoken_image_provider as buytoken, server

RID = '88888888-8888-4888-8888-888888888888'


class ImageTierTests(unittest.TestCase):
    def test_price_matrix_and_reference_base_are_independent_of_reference_count(self):
        matrix = {
            'gpt-image-2.5-flare': ([1, 1.5, 2], [1, 1.5, 2]),
            'gpt-image-2.5-sunburst': ([1, 1.5, 2], [1, 1.5, 2]),
            'gpt-image-2.6-flare': ([1, 1.5, 2], [1.5, 2, 2.5]),
            'gpt-image-2.6-sunburst': ([1, 1.5, 2], [1.5, 2, 2.5]),
            'gemini-nano-banana-2.1': ([1, 1.5, 2], [1, 1.5, 2]),
            'grok-imagine-image-2.0': ([1, 1.5], [2, 2.5]),
            'seedream-5-5': ([1, 1, 1.5], [1, 1, 1.5]),
            'seedream-5-0-pro': ([2, 2, 2.5], [2, 2, 2.5]),
        }
        for model, (text, reference) in matrix.items():
            for index, tier in enumerate(tiers.TIERS[model]):
                for count, expected in [(0, text[index]), (1, reference[index]), (3, reference[index])]:
                    with self.subTest(model=model, tier=tier, references=count):
                        self.assertEqual(tiers.unit_cost(model, tier, count), Decimal(str(expected)))
            self.assertEqual(tiers.resolution(model, {}), tiers.TIERS[model][0])

    def test_seedream_size_normalization_cannot_lose_high_resolution_price(self):
        store = object.__new__(routes.ImageTierStore)
        store.rpc = Mock(return_value={'ok': True})
        for tier in tiers.TIERS['seedream-5-5']:
            wire = provider.build_request('seedream-5-5', {'prompt': 'fixture', 'resolution': tier})
            store.begin('owner', None, RID, 'own_key', 'seedream-5-5', wire, 'fixture')
            name, args = store.rpc.call_args.args
            self.assertEqual(name, 'begin_image_tier_job')
            self.assertEqual(args['p_resolution'], tier)
        for model in ('seedream-5-5', 'seedream-5-0-pro'):
            for width, height, expected in [(1024, 1024, '1K'), (2048, 2048, '2K')]:
                wire = provider.build_request(model, {'prompt': 'fixture', 'size': 'custom', 'custom_width': width, 'custom_height': height, 'resolution': '1K'})
                store.begin('owner', None, RID, 'own_key', model, wire, 'fixture')
                self.assertEqual(store.rpc.call_args.args[1]['p_resolution'], expected)

    def test_buytoken_high_resolution_uses_pixels_not_undocumented_wire_field(self):
        for model in tiers.GPT26:
            for tier, side in [('1K', 1024), ('2K', 2048), ('4K', 4096)]:
                wire = buytoken.build_request(server, model, {'prompt': 'fixture', 'count': 4, 'resolution': tier, 'pricing_version': 3, 'size': 'landscape_16_9'}, [])
                width, height = map(int, wire['payload']['size'].split('x'))
                self.assertEqual(max(width, height), side)
                self.assertAlmostEqual(width / height, 16 / 9, delta=.015)
                self.assertEqual(wire['pricing_resolution'], tier)
                self.assertEqual(wire['payload']['n'], 4)
                self.assertEqual(wire['payload']['quality'], 'auto')
                self.assertNotIn('resolution', wire['payload'])
                self.assertNotIn('pricing_version', wire['payload'])

    def test_old_page_new_price_rejected_before_reserve_or_submission(self):
        for model, tier in [('gemini-nano-banana-2.1', '2K'), ('grok-imagine-image-2.0', '2K'), ('seedream-5-5', '2K'), ('seedream-5-0-pro', '2K')]:
            with self.subTest(model=model), ExitStack() as stack:
                stack.enter_context(patch.dict('os.environ', {'APIMART_IMAGE_API_KEY': 'synthetic'}))
                stack.enter_context(patch.object(server, 'require_authenticated_user', return_value=Mock(id='fixture')))
                store = stack.enter_context(patch.object(routes, 'ImageTierStore'))
                submit = stack.enter_context(patch.object(provider, 'submit'))
                response = server.app.test_client().post('/api/apimart-images/generations', headers={'X-Billing-Mode': 'platform'}, json={'platform_model': model, 'resolution': tier, 'request_id': RID, 'prompt': 'fixture'})
                self.assertEqual(response.status_code, 409, response.json)
                self.assertEqual(response.json['code'], 'IMAGE_PRICING_CHANGED')
                self.assertFalse(response.json['generation_submitted'])
                store.assert_not_called()
                submit.assert_not_called()

    def test_legacy_gpt25_reserves_and_settles_new_snapshot_once(self):
        gateway, callback = Mock(), Mock(return_value=[{'filename': 'fixture.png'}])
        gateway.rpc.side_effect = [{'ok': True, 'existing': False, 'job_id': RID}, {'ok': True, 'balance': 8.5}]
        config = server.ProviderConfig(api_key='synthetic', endpoint='https://provider.invalid/v1/images/generations', model='gpt-image-2.5-flare', auth_type='bearer', source='platform')
        with server.app.test_request_context(), patch.object(server, 'platform_provider_configured', return_value=True), patch.object(server, 'require_authenticated_user', return_value=Mock(id='fixture')), patch.object(server, 'SupabaseGateway', return_value=gateway), patch.object(server, 'resolve_provider_config', return_value=config), patch.object(server, 'enforce_rate_limit'):
            result = server.execute_generation({'billing_mode': 'platform', 'platform_model': config.model, 'request_id': RID, 'resolution': '2K', 'pricing_version': 3}, requested_count=1, prompt='fixture', generate_callback=callback)
        self.assertEqual(result['credit_balance'], 8.5)
        self.assertEqual(gateway.rpc.call_args_list[0].args[0], 'reserve_legacy_image_tier_credits')
        self.assertEqual(gateway.rpc.call_args_list[0].args[1]['p_resolution'], '2K')
        self.assertEqual(gateway.rpc.call_args_list[1].args[0], 'settle_image_tier_generation')
        gateway.reserve_credits.assert_not_called()
        callback.assert_called_once()

    def test_recovery_routes_by_saved_policy_not_current_price_or_model_defaults(self):
        for version in (1, 3):
            job = {'request_id': RID, 'model': 'gemini-nano-banana-2.1', 'status': 'submitted', 'provider_task_id': 'task_fixture', 'pricing_policy_version': version}
            old, current = Mock(), Mock()
            old.jobs.return_value = [job]
            old.apply.return_value = current.apply.return_value = {'job': {**job, 'status': 'failed'}}
            with patch.dict('os.environ', {'APIMART_IMAGE_API_KEY': 'synthetic'}), patch.object(server, 'require_authenticated_user', return_value=Mock(id='fixture')), patch.object(routes, 'ImageStore', return_value=old), patch.object(routes, 'ImageTierStore', return_value=current), patch.object(provider, 'query', return_value={'status': 'failed', 'error_code': 'APIMART_TASK_FAILED'}) as query, patch.object(provider, 'submit') as submit:
                response = server.app.test_client().get('/api/apimart-images/tasks/' + RID, headers={'X-Billing-Mode': 'platform'})
            self.assertEqual(response.status_code, 200, response.json)
            (current if version == 3 else old).apply.assert_called_once()
            (old if version == 3 else current).apply.assert_not_called()
            query.assert_called_once()
            submit.assert_not_called()
