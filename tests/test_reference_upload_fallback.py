import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

from backend import server


USER = '10000000-0000-4000-8000-000000000001'
OTHER = '10000000-0000-4000-8000-000000000002'
PATH = f'posterflow/user-{USER}/references/{"b" * 32}.png'
TOKEN = 'eyJhbGciOiJIUzI1NiJ9.fixture-payload.fixture-signature'
STORAGE = 'https://storage.example.test'
SERVICE_KEY = 'fixture-service-key'


def png_bytes(color):
    with io.BytesIO() as stream:
        Image.new('RGB', (2, 2), color).save(stream, 'PNG')
        return stream.getvalue()


PNG = png_bytes('blue')


class ReferenceUploadFallbackTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.user = self.start_patch(server, 'optional_authenticated_user', return_value=SimpleNamespace(id=USER))
        self.start_patch(server, 'enforce_rate_limit')
        self.start_patch(server, '_storage_backend', return_value='supabase')
        self.start_patch(server, 'SUPABASE_STORAGE_URL', STORAGE)
        self.start_patch(server, 'SUPABASE_STORAGE_BUCKET', 'private-test-bucket')
        self.start_patch(server, 'SUPABASE_STORAGE_SERVICE_KEY', SERVICE_KEY)
        self.put = self.start_patch(server.requests, 'put')
        self.upstream = self.put.return_value.__enter__.return_value
        self.upstream.status_code = 200
        self.download = self.start_patch(server, '_supabase_download')
        self.generation = self.start_patch(server, 'generate_images')
        self.ledger = self.start_patch(server, 'SupabaseGateway')

    def start_patch(self, target, name, *arguments, **options):
        patcher = patch.object(target, name, *arguments, **options)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def tearDown(self):
        self.generation.assert_not_called()
        self.ledger.assert_not_called()

    def upload(self, *, path=PATH, token=TOKEN, blob=PNG, mime='image/png'):
        response = self.client.post('/api/reference-upload-fallback', headers={'X-Billing-Mode': 'platform'},
                                    data={'path': path, 'token': token,
                                          'file': (io.BytesIO(blob), 'image.png', mime)})
        self.addCleanup(response.request.input_stream.close)
        return response

    def test_success_uploads_only_to_the_owned_signed_storage_path(self):
        response = self.upload()
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.json['path'], PATH)
        self.put.assert_called_once()
        args, options = self.put.call_args
        self.assertEqual(args[0], f'{STORAGE}/storage/v1/object/upload/sign/private-test-bucket/{PATH}')
        self.assertEqual(options['params']['token'], TOKEN)
        self.assertEqual(options['files'][''][1:], (PNG, 'image/png'))
        self.assertEqual(options['headers']['x-upsert'], 'false')
        self.assertFalse(options['allow_redirects'])
        self.assertNotIn(SERVICE_KEY, str(options))
        self.assertNotIn(TOKEN, response.get_data(as_text=True))
        self.download.assert_not_called()

    def test_missing_session_and_other_accounts_path_are_refused_before_storage(self):
        response = self.upload(path=PATH.replace(USER, OTHER))
        self.assertIn(response.status_code, (400, 403))
        self.user.return_value = None
        self.assertEqual(self.upload().status_code, 401)
        self.put.assert_not_called()
        self.download.assert_not_called()

    def test_large_files_and_mismatched_reference_formats_do_not_reach_storage(self):
        for blob, mime, path, status in (
            (PNG + bytes(4 * 1024 * 1024), 'image/png', PATH, 413),
            (PNG, 'image/png', PATH[:-3] + 'jpg', 400),
            (b'invalid-image', 'image/png', PATH, 400),
        ):
            with self.subTest(size=len(blob), mime=mime, path=path):
                self.assertEqual(self.upload(blob=blob, mime=mime, path=path).status_code, status)
        self.put.assert_not_called()
        self.download.assert_not_called()

    def test_upstream_signature_rejection_does_not_expose_details(self):
        marker = 'private-storage-response-marker'
        self.upstream.status_code = 403
        self.upstream.json.return_value = {'message': marker, 'error': 'InvalidSignature'}
        response = self.upload()
        self.assertEqual(response.status_code, 403)
        self.assertNotIn(marker, response.get_data(as_text=True))
        self.assertNotIn(TOKEN, response.get_data(as_text=True))
        self.download.assert_not_called()

    def test_duplicate_upload_is_success_only_for_the_identical_stored_bytes(self):
        self.upstream.json.return_value = {'error': 'Duplicate'}
        existing = self.download.return_value.__enter__.return_value
        for code, stored, expected in ((400, PNG, 200), (409, png_bytes('red'), 409),
                                       (409, PNG[:-1], 409), (409, PNG + b'x', 409)):
            with self.subTest(upstream_status=code, expected=expected, size=len(stored)):
                self.upstream.status_code = code
                existing.iter_content.return_value = [stored[:16], stored[16:]]
                response = self.upload()
                self.assertEqual(response.status_code, expected)
                self.download.assert_called_once_with(PATH, stream=True)
                self.download.reset_mock()

    def test_network_interruption_reports_upload_failure(self):
        self.put.side_effect = server.requests.ConnectionError('fixture connecting to private-storage-host')
        result = self.upload()
        self.assertEqual(result.status_code, 503)
        self.assertEqual(result.json['code'], 'REFERENCE_UPLOAD_FAILED')
        self.assertNotIn('private-storage-host', result.get_data(as_text=True))
        self.download.assert_not_called()
