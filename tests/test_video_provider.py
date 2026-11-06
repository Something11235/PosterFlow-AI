import json
import unittest
from decimal import Decimal
from unittest.mock import Mock,patch
import requests
from backend import video_provider as p

TASK='task_video_fixture_00001'
def image(id='image-fixture',**extra):return {'id':id,'kind':'image','width':512,'height':512,'sha256':'a'*64,**extra}
def video(id='video-fixture',duration_ms=5000,**extra):return {'id':id,'kind':'video','duration_ms':duration_ms,'width':1280,'height':720,'sha256':'b'*64,**extra}
def audio(id='audio-fixture',duration_ms=3000):return {'id':id,'kind':'audio','duration_ms':duration_ms,'sha256':'c'*64}

class SeedanceProtocolTests(unittest.TestCase):
    def test_duration_failure_refund_note_is_not_insufficient_balance(self):
        message="请求中指定的参数 `duration` 无效。系统已将您的任务识别为视频编辑，输出比例和持续时间遵循输入视频；问题：[0] `duration` 必须为 -1。已扣额度已自动退还。"
        self.assertEqual(p.video_failure({'code':'InvalidParameter','message':message})[0],'VIDEO_TASK_CONSTRAINT')
        self.assertEqual(p.video_failure('任务生成失败。已扣额度已自动退还。')[0],'VIDEO_TASK_FAILED')
        for message in ['insufficient_quota','quota exceeded','balance is insufficient','视频服务额度不足','余额已耗尽']:
            self.assertEqual(p.video_failure(message)[0],'VIDEO_PROVIDER_BALANCE')

    def test_prices_include_only_video_reference_duration(self):
        body=p.normalized_video_parameters({'duration':10,'resolution':'480p'})
        self.assertEqual(p.video_price(body,[video(),audio()]),Decimal('7.5'))
        self.assertEqual(p.video_price(body,[image(),audio()]),Decimal('5'))
        body['resolution']='720p';self.assertEqual(p.video_price(body,[video(),audio()]),Decimal('15'))
        body['resolution']='480p';self.assertEqual(p.video_price(body,[video(duration_ms=5123)]),Decimal('7.5615'))
        self.assertEqual(p.video_price({**body,'duration':5},[]),Decimal('2.5'))

    def test_mini_uses_only_documented_controls_and_does_not_mix_suno_parameters(self):
        body=p.normalized_video_parameters({'model':p.MODEL,'duration':15,'resolution':'720p','size':'9:16','seed':0,'generate_audio':False,'return_last_frame':True,'nsfw_check':True,'tools':[{'type':'web_search'}]})
        self.assertEqual(body['seed'],0);self.assertFalse(body['generate_audio']);self.assertTrue(body['return_last_frame'])
        for bad in [{'resolution':'1080p'},{'resolution':'4k'},{'duration':3},{'duration':16},{'duration':True},{'generate_audio':'false'},{'seed':True},{'tools':[{'type':'other'}]},{'audio_urls':['https://arbitrary.invalid']},{'model':'minimax-h3'}]:
            with self.subTest(bad=bad),self.assertRaises(p.VideoError):p.normalized_video_parameters(bad)

    def test_reference_limits_roles_and_duration_boundaries_are_enforced_before_payment(self):
        for refs in [[image(str(i)) for i in range(10)],[video(str(i),2000) for i in range(4)], [audio()],
                     [image(),audio(duration_ms=15001)],[video(duration_ms=1800)],[video(duration_ms=15200)],
                     [video(width=1920,height=1080)],[image(role='first_frame'),audio()],
                     [image(role='first_frame'),image('last')],[image(role='reference_image')],[image(),image()]]:
            with self.subTest(refs=refs),self.assertRaises(p.VideoError):p.validate_video_references(refs)
        self.assertEqual(p.validate_video_references([video(duration_ms=2000)]),2000)
        self.assertEqual(p.validate_video_references([image(),audio(duration_ms=15000)]),0)

    def test_first_last_frames_and_multi_reference_body_are_distinct(self):
        body=p.normalized_video_parameters({'prompt':'camera moves'})
        frames=p.video_payload(body,[image('a',role='first_frame'),image('b',role='last_frame')],['https://fixture.invalid/a.jpg','https://fixture.invalid/b.jpg'])
        self.assertNotIn('image_urls',frames);self.assertEqual([x['role'] for x in frames['image_with_roles']],['first_frame','last_frame'])
        mixed=p.video_payload(body,[image(),video(),audio()],['https://fixture.invalid/a.jpg','https://fixture.invalid/a.mp4','https://fixture.invalid/a.mp3'])
        self.assertEqual(len(mixed['image_urls']),1);self.assertEqual(len(mixed['video_urls']),1);self.assertEqual(len(mixed['audio_urls']),1)
        with self.assertRaises(p.VideoError):p.video_payload(p.normalized_video_parameters({}),[],[])

    def test_fingerprint_excludes_rotating_signatures_but_preserves_mode_and_files(self):
        body=p.normalized_video_parameters({'prompt':'camera moves'})
        source=image(url='https://fixture.invalid/a?token=secret',expires=1)
        fingerprint=p.video_fingerprint(body,[source]);source['url']='https://fixture.invalid/a?token=changed';source['expires']=2
        self.assertEqual(p.video_fingerprint(body,[source]),fingerprint)
        self.assertNotEqual(p.video_fingerprint(body,[{**source,'role':'first_frame'}]),fingerprint)

    def test_provider_submission_is_once_and_network_or_5xx_are_uncertain(self):
        for status,payload,unknown in [(200,{'code':200,'data':[{'task_id':TASK}]},False),
                                       (400,{'error':{'code':'nsfw_content_detected','message':'content rejected'}},False),
                                       (502,{'error':{'message':'gateway unavailable'}},True)]:
            response=Mock(status_code=status);response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
            response.iter_content.return_value=[json.dumps(payload).encode()]
            with patch.object(p.requests,'request',return_value=response) as call:
                if status==200:self.assertEqual(p.submit_video('fixture',{'model':p.MODEL}),TASK)
                else:
                    with self.assertRaises(p.VideoError) as caught:p.submit_video('fixture',{'model':p.MODEL})
                    self.assertEqual(caught.exception.uncertain,unknown)
                call.assert_called_once();self.assertEqual(call.call_args.args[1],'https://api.apimart.ai/v1/videos/generations');self.assertFalse(call.call_args.kwargs['allow_redirects'])
        with patch.object(p.requests,'request',side_effect=requests.Timeout()),self.assertRaises(p.VideoError) as caught:p.submit_video('fixture',{})
        self.assertTrue(caught.exception.uncertain)

    def test_task_result_never_uses_wall_clock_actual_time_as_video_duration(self):
        task={'data':{'id':TASK,'status':'completed','progress':100,'actual_time':130,'result':{'videos':[{'url':['https://fixture.invalid/video.mp4'],'last_frame_url':'https://fixture.invalid/last.png'}]}}}
        got=p.normalize_video_task(task,TASK);self.assertEqual(got['videos'][0]['last_frame_url'],'https://fixture.invalid/last.png');self.assertNotIn('duration',got)
        task['data']['result']['videos'][0]['url']=['http://127.0.0.1/private','javascript:alert(1)'];self.assertEqual(p.normalize_video_task(task,TASK)['videos'],[])
        task['data']['id']='wrong';
        with self.assertRaises(p.VideoError):p.normalize_video_task(task,TASK)
