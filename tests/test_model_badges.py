import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from backend import server, model_badges as badges


class ModelBadgeTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.gateway = Mock()
        self.gateway.rpc.return_value = {'revision': 1, 'badges': badges.DEFAULTS}
        self.user = SimpleNamespace(id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')

    def test_defaults_have_only_requested_five_badges(self):
        self.assertEqual(sum(v == 'hot' for v in badges.DEFAULTS.values()), 2)
        self.assertEqual(sum(v == 'new' for v in badges.DEFAULTS.values()), 3)
        with patch.object(badges, 'is_supabase_configured', return_value=False), patch.object(badges, 'SupabaseGateway') as gateway:
            response = self.client.get('/api/model-badges')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['badges'], badges.DEFAULTS)
        gateway.assert_not_called()

    def test_public_read_sanitizes_metadata_and_cannot_write(self):
        self.gateway.rpc.return_value.update(updated_by='private-identifier', updated_at='private-date')
        with patch.object(badges, 'is_supabase_configured', return_value=True), patch.object(badges, 'SupabaseGateway', return_value=self.gateway):
            response = self.client.get('/api/model-badges')
        self.assertEqual(set(response.json), {'success', 'revision', 'badges'})
        self.assertEqual(response.headers['Cache-Control'], 'public, max-age=30')
        self.assertEqual(self.client.post('/api/model-badges', json={}).status_code, 405)

    def test_admin_authentication_is_required_for_read_and_write(self):
        for method in ('get', 'post'):
            with patch.object(server, 'require_admin_user', side_effect=server.ProviderError('ADMIN_REQUIRED', 'Forbidden', 403)), patch.object(badges, 'SupabaseGateway') as gateway:
                response = getattr(self.client, method)('/api/admin/model-badges', json={})
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.headers['Cache-Control'], 'private, no-store')
            gateway.assert_not_called()

    def test_normal_user_rejected_by_existing_admin_gate(self):
        self.gateway.account_snapshot.return_value = {'profile': {'role': 'user'}}
        with patch.object(server, 'require_authenticated_user', return_value=self.user), patch.object(server, 'SupabaseGateway', return_value=self.gateway), patch.object(server, 'ADMIN_USER_IDS', set()):
            response = self.client.post('/api/admin/model-badges', json={'revision': 1, 'badges': badges.DEFAULTS})
        self.assertEqual(response.status_code, 403)
        self.gateway.rpc.assert_not_called()

    def post(self, body, **kwargs):
        with patch.object(server, 'require_admin_user', return_value=(self.user, self.gateway)), patch.object(server, 'enforce_rate_limit'):
            return self.client.post('/api/admin/model-badges', json=body, **kwargs)

    def test_invalid_values_ids_revision_and_extra_fields_never_write(self):
        for body in [None, {}, {'revision': True, 'badges': badges.DEFAULTS}, {'revision': 0, 'badges': badges.DEFAULTS}, {'revision': 1, 'badges': {}}, {'revision': 1, 'badges': {**badges.DEFAULTS, 'unknown': 'hot'}}, {'revision': 1, 'badges': {**badges.DEFAULTS, badges.MODEL_IDS[0]: '<script>'}}, {'revision': 1, 'badges': badges.DEFAULTS, 'price': 0}]:
            with self.subTest(body=body):
                self.assertEqual(self.post(body).status_code, 400)
        self.gateway.rpc.assert_not_called()

    def test_foreign_origin_never_writes(self):
        response = self.post({'revision': 1, 'badges': badges.DEFAULTS}, headers={'Origin': 'https://untrusted.invalid'})
        self.assertEqual(response.status_code, 403)
        self.gateway.rpc.assert_not_called()

    def test_revision_conflict_does_not_report_success(self):
        self.gateway.rpc.return_value = {'ok': False, 'code': 'MODEL_BADGES_CONFLICT'}
        response = self.post({'revision': 1, 'badges': badges.DEFAULTS})
        self.assertEqual(response.status_code, 409)
        self.assertFalse(response.json['success'])

    def test_admin_can_save_complete_map_with_revision(self):
        modified = {**badges.DEFAULTS, 'seedream-5-0-pro': '', 'gemini-nano-banana-2.1': 'hot'}
        self.gateway.rpc.return_value = {'ok': True, 'revision': 2, 'badges': modified}
        response = self.post({'revision': 1, 'badges': modified})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['badges'], modified)
        self.gateway.rpc.assert_called_once_with('update_model_badges', {'p_admin': self.user.id, 'p_revision': 1, 'p_badges': modified})

    def test_read_failure_is_generic_and_not_cached(self):
        self.gateway.rpc.side_effect = RuntimeError('sensitive upstream details')
        with patch.object(badges, 'is_supabase_configured', return_value=True), patch.object(badges, 'SupabaseGateway', return_value=self.gateway):
            response = self.client.get('/api/model-badges')
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('sensitive', response.get_data(as_text=True))
        self.assertEqual(response.headers['Cache-Control'], 'private, no-store')
