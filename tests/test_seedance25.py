from decimal import Decimal
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import json
from backend import seedance25 as s, video_provider as p
from backend.video_references import reference_metadata


def image(id='i',**extra):return {'id':id,'kind':'image','width':854,'height':480,'size':1000,**extra}
def video(id='v',**extra):return {'id':id,'kind':'video','width':854,'height':480,'size':3000,'duration_ms':3000,'fps':30,'codec':'avc1','audio_codecs':[],**extra}
def audio(id='a',**extra):return {'id':id,'kind':'audio','size':1000,'duration_ms':3000,**extra}
def draft_source(**extra):return {'model':s.MODEL,'is_draft':True,'status':'completed','billing_status':'settled','provider_task_id':'task_draft_fixture','created_at':datetime.now(timezone.utc).isoformat(),'requested_duration':5,'reference_duration_ms':0,**extra}


class Seedance25Tests(unittest.TestCase):
    def test_final_quote_inherits_original_inputs_and_uses_input_rate(self):
        body=s.normalized_parameters({'model':s.MODEL,'draft_request_id':'11111111-1111-4111-8111-111111111111'})
        source=draft_source(requested_duration=11,reference_duration_ms=22000)
        quote=s.estimate(body,[],source)
        self.assertEqual((quote['reference_ms'],quote['estimated_usd'],quote['estimated'],quote['reserved']),(22000,Decimal('10.5336'),Decimal('233'),Decimal('373')))
        auto=s.estimate(body,[],draft_source(requested_duration=-1,reference_duration_ms=22000))
        self.assertEqual((auto['estimated'],auto['reserved']),(Decimal('367'),Decimal('587.5')))
        with self.assertRaises(p.VideoError):s.estimate(body,[video()],source)

    def test_draft_three_day_boundary_and_metadata_are_validated(self):
        now=datetime(2026,11,6,12,tzinfo=timezone.utc)
        source=draft_source(created_at=(now-timedelta(days=3)+timedelta(milliseconds=1)).isoformat())
        self.assertEqual(s.validate_draft_source(source,now),(5,0))
        for patch_value in [dict(created_at=(now-timedelta(days=3)).isoformat()),dict(created_at='invalid'),dict(created_at='2026-11-06T00:00:00'),dict(model='flux-3-video'),dict(status='processing'),dict(billing_status='awaiting_balance'),dict(is_draft=False),dict(provider_task_id=None),dict(reference_duration_ms=-1),dict(reference_duration_ms=30001),dict(reference_duration_ms=None),dict(requested_duration=True),dict(requested_duration=31)]:
            with self.subTest(patch_value=patch_value),self.assertRaises(p.VideoError):s.validate_draft_source(source|patch_value,now)

    def test_expired_draft_is_rejected_by_route_before_credit_reservation_or_paid_post(self):
        from test_video_routes import VideoRouteTests,UID
        from backend import video_routes as routes
        fx=VideoRouteTests();fx.setUp()
        try:
            rid='33333333-3333-4333-8333-333333333333'
            fx.store.rows[('user-'+UID,rid)]=draft_source(request_id=rid,created_at=(datetime.now(timezone.utc)-timedelta(days=4)).isoformat())
            fx.input['parameters']={'model':s.MODEL,'resolution':'1080p','draft_request_id':rid}
            with patch.object(routes,'submit_video') as submit:
                response=fx.client.post('/api/video/generations',json=fx.input)
                self.assertEqual(response.json['code'],'VIDEO_DRAFT_INVALID')
                self.assertEqual(fx.store.begin_calls,[]);submit.assert_not_called()
        finally:fx.tearDown()

    def test_final_route_uses_new_reservation_rpc_without_resending_original_inputs(self):
        from test_video_routes import VideoRouteTests,UID,TASK
        from backend import video_routes as routes
        fx=VideoRouteTests();fx.setUp()
        try:
            rid='33333333-3333-4333-8333-333333333333'
            source=draft_source(request_id=rid,requested_duration=11,reference_duration_ms=22000)
            fx.store.rows[('user-'+UID,rid)]=source
            fx.input['parameters']={'model':s.MODEL,'resolution':'1080p','draft_request_id':rid,'output_format':'mp4','watermark':False,'return_last_frame':False}
            with patch.object(fx.store,'rpc',wraps=fx.store.rpc) as rpc,patch.object(fx.store,'apply25',create=True,return_value={'job':{'request_id':fx.input['request_id'],'status':'submitted'}}),patch.object(routes,'submit_video',return_value=TASK) as submit:
                response=fx.client.post('/api/video/generations',json=fx.input)
                self.assertEqual(response.status_code,202,response.json)
                self.assertEqual(rpc.call_args.args[0],'begin_seedance25_job_v2')
                self.assertEqual(rpc.call_args.args[1]['p_references'],[])
                payload=submit.call_args.args[1]
                self.assertEqual(payload['draft_task_id'],source['provider_task_id'])
                for field in ['prompt','duration','size','video_urls','image_urls','audio_urls']:self.assertNotIn(field,payload)
                submit.assert_called_once()
        finally:fx.tearDown()

    def test_video_auto_requires_explicit_intent_without_changing_duration_or_upload_validation(self):
        body=s.normalized_parameters({'model':s.MODEL,'prompt':'fixture','duration':8})
        with self.assertRaises(p.VideoError) as caught:s.validate_references([video(duration_ms=8000)],body)
        self.assertEqual(caught.exception.code,'VIDEO_TASK_TYPE_REQUIRED')
        self.assertEqual(body['duration'],8)
        self.assertEqual(s.validate_references([video()],{'size':'adaptive'}),3000)
        self.assertEqual(s.validate_references([video()],body|{'omni_reference_task_type':'reference'}),3000)
        edit=s.normalized_parameters({'model':s.MODEL,'prompt':'编辑视频','omni_reference_task_type':'edit'})
        self.assertEqual(s.validate_references([video(duration_ms=8000)],edit),8000)
        with self.assertRaises(p.VideoError):s.validate_references([video(duration_ms=3000)],edit)

    def test_mixed_image_roles_keep_one_array_in_prompt_reference_order(self):
        refs=[image('ordinary'),video(),image('first',role='first_frame'),audio(),image('ordinary2')]
        urls=['https://cdn.example.com/one.png','https://cdn.example.com/ref.mp4','https://cdn.example.com/two.png','https://cdn.example.com/ref.wav','https://cdn.example.com/three.png']
        body=p.video_payload(s.normalized_parameters({'model':s.MODEL,'prompt':'@图片1 参考 @图片3','size':'16:9','omni_reference_task_type':'reference'}),refs,urls)
        self.assertNotIn('image_urls',body)
        self.assertEqual(body['image_with_roles'],[{'url':urls[0],'role':'reference_image'},{'url':urls[2],'role':'first_frame'},{'url':urls[4],'role':'reference_image'}])
        self.assertEqual(body['video_urls'],[urls[1]]);self.assertEqual(body['audio_urls'],[urls[3]])

    def test_real_media_header_fps_is_used_for_25_validation(self):
        data=(Path(__file__).parent/'fixtures/seedance-reference.mp4').read_bytes()
        info=reference_metadata(data,'mp4');self.assertEqual(info['fps'],12);self.assertEqual(info['codec'],'avc1')
        with self.assertRaises(p.VideoError):reference_metadata(data,'mp4',s.MODEL)

    def test_normal_modes_all_controls_and_actual_cost_round_up_to_half(self):
        body=s.normalized_parameters({'model':s.MODEL,'prompt':'clip','duration':30,'resolution':'1080p','size':'adaptive','seed':0,'generate_audio':False,'return_last_frame':True,'watermark':True,'output_format':'mov','tools':[{'type':'web_search'}]})
        self.assertEqual(body['seed'],0);self.assertFalse(body['generate_audio']);self.assertEqual(body['duration'],30)
        self.assertEqual(s.cost_credits(Decimal('0.48')),Decimal('11'))
        self.assertEqual(s.cost_credits(Decimal('1.08')),Decimal('24'))
        self.assertEqual(s.cost_credits(Decimal('0.3104')),Decimal('7'))
        for cost in ['0.000001','0.48','1.08','2.67','10','30']:
            charge=s.cost_credits(Decimal(cost));self.assertEqual(charge*2,(charge*2).to_integral_value())
            self.assertGreaterEqual(charge*Decimal('.38'),Decimal(cost)*7*Decimal('1.2'))

    def test_reservations_are_distinct_from_estimates_and_actual_settlement(self):
        body=s.normalized_parameters({'model':s.MODEL,'prompt':'clip','resolution':'480p','duration':5,'omni_reference_task_type':'reference'})
        quote=s.estimate(body,[]);self.assertEqual((quote['estimated'],quote['reserved']),(Decimal('11'),Decimal('17')))
        self.assertEqual(s.estimate(body,[audio()])['estimated'],Decimal('11'))
        self.assertEqual(s.estimate(body,[video(),audio()])['reserved'],Decimal('16.5'))
        final=s.normalized_parameters({'model':s.MODEL,'draft_request_id':'11111111-1111-4111-8111-111111111111'})
        quote=s.estimate(final,[],draft_source());self.assertEqual(quote['reference_ms'],0);self.assertEqual(quote['reserved'],95)

    def test_draft_final_whitelist_and_task_constraints_are_not_mini_rules(self):
        draft=s.normalized_parameters({'model':s.MODEL,'prompt':'clip','draft':True});self.assertEqual(draft['resolution'],'480p')
        edit=s.normalized_parameters({'model':s.MODEL,'prompt':'编辑视频','omni_reference_task_type':'edit'});self.assertEqual(edit['duration'],-1)
        self.assertEqual(s.validate_references([audio()],edit|{'omni_reference_task_type':'auto'}),0)
        for params in [{'model':s.MODEL,'prompt':'clip','draft':True,'resolution':'720p'},
                       {'model':s.MODEL,'prompt':'clip','omni_reference_task_type':'edit','duration':5},
                       {'model':s.MODEL,'prompt':'clip','omni_reference_task_type':'extend','size':'16:9'},
                       {'model':s.MODEL,'draft_request_id':'11111111-1111-4111-8111-111111111111','prompt':'forbidden'},
                       {'model':s.MODEL,'prompt':'clip','resolution':'4k'}]:
            with self.subTest(params=params),self.assertRaises(p.VideoError):s.normalized_parameters(params)

    def test_references_obey_25_size_count_fps_and_audio_only_support(self):
        body=s.normalized_parameters({'model':s.MODEL,'prompt':'clip','omni_reference_task_type':'reference'})
        self.assertEqual(s.validate_references([audio()],body),0)
        self.assertEqual(s.validate_references([image(role='reference_image'),video(),audio()],body),3000)
        for refs in [[image(str(i)) for i in range(31)],[audio(str(i)) for i in range(11)], [audio(duration_ms=1000)],
                     [video(fps=12)],[video(codec='vp09')],[image(width=200)], [audio(size=15*1024*1024+1)]]:
            with self.subTest(refs=refs),self.assertRaises(p.VideoError):s.validate_references(refs,body)
        with self.assertRaises(p.VideoError):s.validate_references([image(role='first_frame')],body|{'size':'16:9'})
        self.assertEqual(s.validate_references([image(role='first_frame'),audio()],body|{'size':'16:9'}),0)
        with self.assertRaises(p.VideoError):p.validate_video_references([audio()])

    def test_missing_or_unsettled_cost_never_becomes_a_free_completed_platform_job(self):
        for raw in [None,{}, {'cost':0},{'cost':True},{'cost':'NaN'},{'cost':'Infinity'}, {'cost':1,'credits_cost':9}]:
            self.assertIsNone(s.actual_cost(raw))
        self.assertEqual(s.actual_cost({'cost':.3104,'credits_cost':3.104}),Decimal('.3104'))

    def test_video_audio_track_codec_is_checked_before_any_paid_generation(self):
        body=s.normalized_parameters({'model':s.MODEL,'prompt':'fixture','omni_reference_task_type':'reference'})
        for codecs in [[],['mp4a'],['.mp3']]:
            self.assertEqual(s.validate_references([video(audio_codecs=codecs)],body),3000)
        for codecs in [None,['Opus'],['unknown']]:
            with self.subTest(codecs=codecs),self.assertRaises(p.VideoError):s.validate_references([video(audio_codecs=codecs)],body)
        # Previously approved material IDs have passed the service's own review.
        self.assertEqual(s.validate_references([video(asset_url='asset://approved_001',audio_codecs=None)],body),3000)

    def test_movie_parser_reports_audio_codec_instead_of_ignoring_the_audio_track(self):
        from backend.video_references import mp4_metadata
        data=(Path(__file__).parent/'fixtures/seedance-reference.mp4').read_bytes()
        def atoms(blob):
            offset=0
            while offset<len(blob):
                length=int.from_bytes(blob[offset:offset+4],'big');yield blob[offset+4:offset+8],blob[offset:offset+length];offset+=length
        rebuilt=[]
        for kind,atom in atoms(data):
            if kind!=b'moov':rebuilt.append(atom);continue
            track=next(a for k,a in atoms(atom[8:]) if k==b'trak')
            audio=track.replace(b'vide',b'soun').replace(b'avc1',b'Opus')
            movie=atom+audio;movie=len(movie).to_bytes(4,'big')+movie[4:];rebuilt.append(movie)
        self.assertEqual(mp4_metadata(b''.join(rebuilt))['audio_codecs'],['Opus'])

    def test_custom_endpoints_are_same_host_https_and_use_pinned_transport_once(self):
        endpoint,query=p.video_endpoints('https://video.example.invalid/v1/videos/generations')
        self.assertEqual(query,'https://video.example.invalid/v1/tasks/{task_id}')
        for endpoint,query in [('http://127.0.0.1/v1/videos/generations',''),('https://example.invalid/v1/videos/generations','https://other.invalid/tasks/{task_id}'),('https://u:key@example.invalid/api','')]:
            with self.subTest(endpoint=endpoint),self.assertRaises(p.VideoError):p.video_endpoints(endpoint,query)
        response=Mock(status_code=200);response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        response.iter_content.return_value=[json.dumps({'code':200,'data':[{'task_id':'task_custom_video_001'}]}).encode()]
        with patch.object(p,'pinned_custom_response',return_value=response) as call,patch.object(p.requests,'request') as fixed:
            self.assertEqual(p.submit_video('user-key',{'model':s.MODEL},'https://video.example.invalid/v1/videos/generations'),'task_custom_video_001')
            fixed.assert_not_called();call.assert_called_once();self.assertEqual(call.call_args.args[2]['Authorization'],'Bearer user-key')
