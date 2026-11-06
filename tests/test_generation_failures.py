import io
import json
import unittest
import wave
from unittest.mock import patch

from PIL import Image
from backend import apimart_image_provider as images
from backend.admin_multimedia import enrich_overview
from backend.music_failure_reasons import failure_code, failure_reason
from backend.video_provider import video_failure, validate_video_references, VideoError
from backend.video_references import reference_metadata


MATCH = '[Suno AI response error message] This audio matches an existing recording in our catalog.'
TIMEOUT = 'all channels failed. Last error: HTTP 504: '+json.dumps({
    'title':'Error 504: Gateway time-out','detail':'The origin is overloaded or taking too long.',
    'zone':'synthetic-private.invalid','ray_id':'synthetic-private-id','retry_after':120,
})


class FailureClassificationTests(unittest.TestCase):
    def test_generic_video_parameter_errors_do_not_prescribe_seedance_edit_rules(self):
        for raw in ['duration is invalid', '请求中指定的参数 `duration` 无效。已扣额度已自动退还。', 'InvalidParameter.Resolution', 'invalid_aspect_ratio']:
            code,message=video_failure(raw)
            self.assertEqual(code,'VIDEO_PARAMETER_INVALID')
            self.assertNotIn('自动时长',message)
            self.assertNotIn('4–30',message)
            self.assertNotIn('额度不足',message)
            self.assertEqual(video_failure(code)[1],message)
        code,message=video_failure('InvalidParameter.TaskTypeMismatch')
        self.assertEqual(code,'VIDEO_TASK_CONSTRAINT')
        self.assertNotIn('自动时长',message)

    def test_unknown_music_failures_do_not_invent_copyright_or_balance_reasons(self):
        for error in [None,{},'Unknown failure','生成失败。已扣额度已自动退还。']:
            code=failure_code(error)
            self.assertEqual(code,'MUSIC_TASK_FAILED')
            self.assertNotIn('版权',failure_reason(code))
            self.assertNotIn('额度不足',failure_reason(code))
            self.assertIn('具体原因',failure_reason(code))
        self.assertEqual(failure_code('lyrics contain copyrighted material'),'MUSIC_LYRICS_COPYRIGHT')
        self.assertEqual(failure_code('insufficient_quota'),'MUSIC_PROVIDER_BALANCE')

    def test_catalog_match_is_not_claimed_to_be_lyrics_copyright(self):
        for error in (MATCH, {'error':{'message':MATCH}}, {'message':json.dumps({'error':{'detail':MATCH}})}):
            code=failure_code(error)
            self.assertEqual(code,'MUSIC_AUDIO_MATCH')
            self.assertIn('查重',failure_reason(code))
            self.assertNotIn('歌词',failure_reason(code))
        self.assertEqual(failure_code({'message':'Unknown failure','request':{'prompt':MATCH}}),'MUSIC_TASK_FAILED')

    def test_timeout_priority_over_busy_and_no_raw_details(self):
        self.assertEqual(failure_code({'error':{'message':TIMEOUT}}),'MUSIC_PROVIDER_TIMEOUT')
        self.assertEqual(video_failure({'error':{'message':TIMEOUT}})[0],'VIDEO_PROVIDER_TIMEOUT')
        self.assertEqual(images.image_failure_code(TIMEOUT),'IMAGE_PROVIDER_TIMEOUT')
        self.assertNotIn('synthetic-private',failure_reason(failure_code(TIMEOUT)))

    def test_image_query_timeout_is_not_a_terminal_failure_or_automatic_resubmit(self):
        class Response:
            status_code=504
            def iter_content(self,_size):yield TIMEOUT.encode()
            def close(self):pass
        for method in ['POST','GET']:
            with patch.object(images.requests,'request',return_value=Response()) as call:
                with self.assertRaises(images.ImageTaskError) as error:images.api_request(method,'/tasks/task_fixture', 'offline-fixture')
                self.assertEqual(error.exception.code,'IMAGE_PROVIDER_TIMEOUT')
                self.assertEqual(error.exception.uncertain,method=='POST')
                self.assertNotIn('synthetic-private',str(error.exception))
                call.assert_called_once()

    def test_confirmed_failed_image_retains_recognized_reason(self):
        with patch.object(images,'api_request',return_value={'data':{'id':'task_offline_fixture','status':'failed','error':{'message':TIMEOUT}}}):
            result=images.query('offline','task_offline_fixture')
        self.assertEqual(result['error_code'],'IMAGE_PROVIDER_TIMEOUT')

    def test_mini_dimensions_checked_in_actual_bytes_and_again_for_old_receipts(self):
        for width,height in [(299,600),(600,299),(6001,600),(600,6001),(300,751)]:
            with self.subTest(size=(width,height)):
                data=io.BytesIO();Image.new('RGB',(width,height)).save(data,'PNG')
                with self.assertRaises(VideoError) as caught:reference_metadata(data.getvalue(),'png')
                self.assertEqual(caught.exception.code,'VIDEO_REFERENCE_RESOLUTION')
                with self.assertRaises(VideoError):validate_video_references([{'id':'old','kind':'image','width':width,'height':height}])
        for width,height in [(300,300),(300,750),(750,300),(6000,2400)]:
            self.assertEqual(validate_video_references([{'id':'valid','kind':'image','width':width,'height':height}]),0)

    def test_video_log_dimension_rejection_and_reload_are_chinese(self):
        raw='create private asset failed: InvalidParameter.WidthTooSmall, message=Width must be between 300px and 6000px.'
        code,message=video_failure({'error':{'message':raw}})
        self.assertEqual(code,'VIDEO_REFERENCE_RESOLUTION');self.assertIn('300–6000',message)
        self.assertEqual(video_failure(code)[1],message)

    def test_too_short_audio_rejected_before_generation_and_log_reason_persists(self):
        data=io.BytesIO()
        with wave.open(data,'wb') as audio:
            audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(8000);audio.writeframes(b'\0\0'*8000)
        for model in ['seedance-2.0-mini','seedance-2.5']:
            with self.assertRaises(VideoError) as error:reference_metadata(data.getvalue(),'wav',model)
            self.assertEqual(error.exception.code,'VIDEO_REFERENCE_DURATION')
        code,message=video_failure('InvalidParameter.DurationTooShort, message=Duration must be between 1.8s and 30.2s.')
        self.assertEqual(code,'VIDEO_REFERENCE_DURATION');self.assertIn('2–15',message)
        self.assertEqual(video_failure(code)[1],message)
        with self.assertRaises(VideoError):validate_video_references([{'kind':'image','id':'i','width':512,'height':512},{'kind':'audio','id':'a','duration_ms':1000}])

    def test_admin_enrichment_is_read_only_and_diagnostics_are_safe(self):
        source={'metrics':{'credits':2.5},'jobs':[{'status':'failed','error_code':'MUSIC_AUDIO_MATCH'}],
                'video_jobs':[{'status':'failed','error_code':'VIDEO_REFERENCE_RESOLUTION'}],
                'failure_counts':[{'kind':'music','error_code':'MUSIC_AUDIO_MATCH','count':3},
                                  {'kind':'image','error_code':'https://synthetic-private.invalid/?key=fixture','count':2}]}
        before=json.dumps(source,sort_keys=True)
        result=enrich_overview(source)
        self.assertEqual(json.dumps(source,sort_keys=True),before)
        self.assertEqual(result['jobs'][0]['failure_label'],'参考音频查重')
        self.assertIn('300–6000',result['video_jobs'][0]['failure_reason'])
        self.assertNotIn('synthetic-private',json.dumps(result['failure_counts']))
        self.assertEqual(result['metrics']['credits'],2.5)
