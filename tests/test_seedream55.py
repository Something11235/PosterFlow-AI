import unittest
from unittest.mock import Mock
from backend import apimart_image_provider as provider, apimart_image_routes as routes
from backend.image_reference_delivery import INLINE_MODELS


class Seedream55Tests(unittest.TestCase):
    def test_capabilities_and_tier_size_preserve_resolution(self):
        self.assertIn('seedream-5-5', INLINE_MODELS)
        self.assertEqual(provider.MODELS['seedream-5-5']['credit_cost'], 1)
        self.assertEqual(provider.MODELS['seedream-5-5']['count'], 1)
        for tier in ['1K', '1.5K', '2K']:
            body = provider.build_request('seedream-5-5', {'prompt': 'fixture', 'resolution': tier}, ['a', 'b'])
            self.assertEqual(body['image_urls'], ['a', 'b'])
            self.assertEqual(body['size'], tier)
            self.assertEqual(body['n'], 1)
            self.assertNotIn('resolution', body)

    def test_ratio_and_exact_pixels(self):
        body = provider.build_request('seedream-5-5', {'prompt': 'fixture', 'size': 'landscape_16_9', 'resolution': '1.5K'})
        self.assertEqual((body['size'], body['resolution']), ('16:9', '1.5K'))
        body = provider.build_request('seedream-5-5', {'prompt': 'fixture', 'size': 'custom', 'custom_width': 2048, 'custom_height': 1152})
        self.assertEqual(body['size'], '2048x1152')
        self.assertNotIn('resolution', body)

    def test_unsupported_features_rejected(self):
        for extra in [{'count': 2}, {'resolution': '4K'}, {'mask_b64': 'mask'}, {'output_format': 'gif'}, {'layer_decomposition': True}, {'layer_decomposition_options': {'max_images': 5}}, {'background': 'transparent'}, {'optimize_prompt_options': {'mode': 'off'}}]:
            with self.subTest(extra=extra), self.assertRaises(provider.ImageTaskError):
                provider.build_request('seedream-5-5', {'prompt': 'fixture', **extra}, ['ref'])

    def test_dedicated_billing_rpc_and_no_caller_price(self):
        store = object.__new__(routes.Seedream55ImageStore)
        store.rpc = Mock(return_value={'ok': True})
        store.begin('owner', None, 'request', 'own_key', 'seedream-5-5', {'n': 1, 'image_urls': ['a', 'b'], 'resolution': '2K'}, 'fixture')
        self.assertEqual(store.rpc.call_args.args[0], 'begin_seedream55_image_job')
        self.assertEqual(store.rpc.call_args.args[1]['p_reference_count'], 2)
        self.assertNotIn('unit_credit_cost', store.rpc.call_args.args[1])
        store.apply('owner', 'request', 'completed', p_images=['fixture.png'])
        self.assertEqual(store.rpc.call_args.args[0], 'apply_seedream55_image_job')
