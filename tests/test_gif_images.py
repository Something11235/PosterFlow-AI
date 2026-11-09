import io
import unittest
from unittest.mock import Mock, patch
from PIL import Image
from backend import apimart_image_provider as provider, server
from backend.image_preview import create_image_preview, preview_filename


def animated_fixture():
    output = io.BytesIO()
    Image.new('RGB', (24, 24), 'red').save(output, format='GIF', save_all=True,
        append_images=[Image.new('RGB', (24, 24), 'blue')], duration=[90, 210], loop=0, disposal=2)
    return output.getvalue()


class GifImagesTests(unittest.TestCase):
    def test_both_official_versions_accept_text_or_reference_gif_without_masks(self):
        for version in ('flare', 'sunburst'):
            model = 'gpt-image-2.6-' + version
            body = provider.build_request(model, {'prompt': 'A waving cat, seamless loop', 'output_format': 'gif'})
            self.assertEqual((body['model'], body['output_format'], body['size'], body['n']), (model, 'gif', 'auto', 1))
            self.assertEqual(provider.build_request(model, {'prompt': 'fixture', 'output_format': 'gif'}, ['reference'])['image_urls'], ['reference'])
            for extra, refs in [({'size': 'square_1_1'}, []), ({'count': 5}, []), ({'canvas_workflow': 'redraw'}, ['reference'])]:
                with self.assertRaises(provider.ImageTaskError):
                    provider.build_request(model, {'prompt': 'fixture', 'output_format': 'gif', **extra}, refs)

    def test_download_preserves_original_frames_duration_loop_and_bytes(self):
        original = animated_fixture()
        response = Mock(status=200)
        response.stream.return_value = [original]
        pool = Mock()
        pool.urlopen.return_value = response
        with patch.object(provider.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]), patch.object(provider.urllib3, 'HTTPSConnectionPool', return_value=pool):
            result = provider.download_image('https://example.invalid/generated.gif')
        self.assertEqual(result, original)
        with Image.open(io.BytesIO(result)) as image:
            self.assertEqual(image.n_frames, 2)
            self.assertEqual(image.info['loop'], 0)
            self.assertEqual(image.info['duration'], 90)
            image.seek(1)
            self.assertEqual(image.info['duration'], 210)

    def test_gif_storage_keeps_animation_and_uses_png_sidecar(self):
        original = animated_fixture()
        with patch.object(server, '_storage_backend', return_value='supabase'), patch.object(server, '_supabase_put') as put, patch.object(server, 'storage_scope_name', return_value='user-fixture'):
            server.store_generated_image('fixture.gif', original)
        self.assertEqual(put.call_args_list[0].args, ('posterflow/user-fixture/images/fixture.gif', original, 'image/gif'))
        self.assertEqual(put.call_args_list[1].args[0], 'posterflow/user-fixture/images/_thumb_fixture.png')
        self.assertEqual(put.call_args_list[1].args[2], 'image/png')
        self.assertEqual(preview_filename('fixture.gif'), '_thumb_fixture.png')
        with Image.open(io.BytesIO(create_image_preview(original))) as preview:
            self.assertEqual(preview.format, 'PNG')
