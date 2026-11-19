import io
import time
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from PIL import Image

from backend.video_references import VideoReferences, reference_metadata, mp4_metadata
from backend.video_provider import VideoError


def response(value=None, data=b''):
    r=Mock(status_code=200);r.__enter__=Mock(return_value=r);r.__exit__=Mock(return_value=False)
    r.json.return_value=value;r.iter_content.return_value=[data];return r


def wav(seconds):
    data=io.BytesIO()
    with wave.open(data,'wb') as f:
        f.setnchannels(1);f.setsampwidth(2);f.setframerate(8000);f.writeframes(b'\0\0'*int(seconds*8000))
    return data.getvalue()


class VideoReferenceTests(unittest.TestCase):
    def setUp(self):
        self.server=SimpleNamespace(SUPABASE_STORAGE_ENABLED=True,SUPABASE_STORAGE_SERVICE_KEY='offline-secret',
            SUPABASE_STORAGE_URL='https://fixture.supabase.co',_supabase_storage_url=lambda p:'https://fixture.supabase.co/storage/v1'+p,
            _supabase_object_path=lambda p:'private-bucket/'+p,_supabase_storage_request=Mock())
        self.refs=VideoReferences(self.server);self.owner='user-offline-fixture'

    def test_actual_video_headers_and_malformed_atom_sizes(self):
        data=(Path(__file__).parent/'fixtures/seedance-reference.mp4').read_bytes()
        info=reference_metadata(data,'mp4')
        self.assertEqual((info['duration_ms'],info['width'],info['height']),(3000,854,480))
        for bad in (b'not a video',data[:-10],b'\0\0\0\x01moov'+b'\xff'*8,data.replace(b'mdat',b'xxxx')):
            with self.subTest(bad=bad[:12]),self.assertRaises(VideoError):reference_metadata(bad,'mp4')

    def test_flash_image_formats_and_cross_model_ticket_reuse(self):
        import hashlib
        flash='seedance-2-5-flash'
        for ext,fmt in [('gif','GIF'),('tiff','TIFF'),('bmp','BMP'),('png','PNG')]:
            stream=io.BytesIO();Image.new('RGB',(320,320)).save(stream,fmt)
            data=stream.getvalue()
            ref={'id':'1700000000-'+'a'*32+'.'+ext,'owner':'a'*64,'model':flash,
                 'sha256':hashlib.sha256(data).hexdigest(),**reference_metadata(data,ext,flash)}
            self.server._supabase_storage_request.reset_mock()
            self.server._supabase_storage_request.return_value=response(data=data)
            if ext=='png':
                self.assertEqual(self.refs.revalidate(ref,'seedance-2.5')['width'],320)
            else:
                with self.assertRaises(VideoError) as error:self.refs.revalidate(ref,'seedance-2.5')
                self.assertEqual(error.exception.code,'VIDEO_REFERENCE_TYPE')
                self.server._supabase_storage_request.assert_not_called()
        with self.assertRaises(VideoError) as error:
            self.refs.revalidate({'kind':'video','size':100*1024*1024},'seedance-2.0-mini')
        self.assertEqual(error.exception.code,'VIDEO_REFERENCE_SIZE')

    def test_image_decoding_and_audio_duration_cannot_be_forged_by_names(self):
        data=io.BytesIO();Image.new('RGB',(300,450)).save(data,'PNG')
        self.assertEqual(reference_metadata(data.getvalue(),'png')['height'],450)
        for content,ext in [(data.getvalue(),'jpg'),(wav(2),'png'),(b'ID3bad','mp3'),(wav(2)[:-2],'wav'),(wav(16),'wav')]:
            with self.subTest(ext=ext),self.assertRaises(VideoError):reference_metadata(content,ext)
        self.assertEqual(reference_metadata(wav(3),'wav')['duration_ms'],3000)

    def test_private_signed_upload_binds_actual_duration_owner_and_expiry(self):
        content=wav(3)
        self.server._supabase_storage_request.return_value=response({'url':'/object/upload/sign/private-bucket/file.wav?token=fixture'})
        issued=self.refs.issue(self.owner,'file.wav',len(content),'audio/wav')
        with self.assertRaises(VideoError):self.refs.verify(issued['upload_ticket'],'someone-else','upload')
        with self.assertRaises(VideoError):self.refs.verify(issued['upload_ticket'],self.owner)
        self.server._supabase_storage_request.return_value=response(data=content)
        reference=self.refs.complete(self.owner,issued['upload_ticket']);value=self.refs.verify(reference['receipt'],self.owner)
        self.assertEqual(value['duration_ms'],3000);self.assertEqual(value['expires']-value['issued'],43200)
        self.assertIn('/references/',self.server._supabase_storage_request.call_args.args[1])
        with patch('backend.video_references.time.time',return_value=time.time()+43200):
            with self.assertRaises(VideoError):self.refs.verify(reference['receipt'],self.owner)
            self.refs.verify(reference['receipt'],self.owner,allow_expired=True)

    def test_overflow_and_changed_file_never_issue_verified_receipt(self):
        self.server._supabase_storage_request.return_value=response({'url':'/object/upload/sign/private-bucket/file.wav?token=fixture'})
        issued=self.refs.issue(self.owner,'file.wav',len(wav(3)),'audio/wav')
        self.server._supabase_storage_request.return_value=response(data=wav(3)+b'x')
        with self.assertRaises(VideoError):self.refs.complete(self.owner,issued['upload_ticket'])
        with self.assertRaises(VideoError):self.refs.issue(self.owner,'file.mp4',50*1024*1024+1,'video/mp4')

    def test_link_import_uses_pinned_no_auth_transport_and_verifies_before_storage(self):
        content=wav(3);self.server._supabase_storage_request.return_value=response()
        with patch('backend.video_references.pinned_custom_response',return_value=response(data=content)) as transport:
            ref=self.refs.import_url(self.owner,'https://fixture.invalid/file.wav','file.wav')
            self.assertEqual(ref['duration_ms'],3000)
            transport.assert_called_once_with('GET','https://fixture.invalid/file.wav',{},None)
        self.server._supabase_storage_request.reset_mock()
        with patch('backend.video_references.pinned_custom_response',return_value=response(data=b'not media')),self.assertRaises(VideoError):
            self.refs.import_url(self.owner,'https://fixture.invalid/file.wav','file.wav')
        self.server._supabase_storage_request.assert_not_called()
        with patch('backend.video_references.pinned_custom_response') as transport,self.assertRaises(VideoError):
            self.refs.import_url(self.owner,'http://127.0.0.1/secret','file.wav')
        transport.assert_not_called()

    def test_tail_frame_import_uses_actual_jpeg_even_for_suffixless_urls(self):
        data=io.BytesIO();Image.new('RGB',(300,450)).save(data,'JPEG')
        self.server._supabase_storage_request.return_value=response()
        with patch('backend.video_references.pinned_custom_response',return_value=response(data=data.getvalue())):
            ref=self.refs.import_url(self.owner,'https://fixture.invalid/last-frame','last-frame.png')
        self.assertEqual(ref['content_type'],'image/jpeg');self.assertEqual(ref['name'],'last-frame.jpg')
        self.assertTrue(self.refs.verify(ref['receipt'],self.owner)['id'].endswith('.jpg'))
