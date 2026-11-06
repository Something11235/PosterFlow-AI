import copy
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from flask import Flask

from backend import video_routes as r
from backend.video_provider import VideoError

UID='22222222-2222-4222-8222-222222222222'
RID='11111111-1111-4111-8111-111111111111'
TASK='task_video_offline_001'


class Store:
    def __init__(self):self.rows={};self.events=[];self.approved=[];self.begin_calls=[]
    def jobs(self,owner,rid=None):return [copy.deepcopy(j) for (o,id),j in self.rows.items() if o==owner and (not rid or rid==id)]
    def assets(self,owner):return self.approved if owner=='user-'+UID else []
    def rpc(self,name,args):
        self.begin_calls.append(args);key=(args['p_owner'],args['p_request_id'])
        if key in self.rows:return {'ok':True,'existing':True,'job':copy.deepcopy(self.rows[key])}
        row={'request_id':key[1],'status':'submitting','operation':args['p_operation'],'billing_mode':args['p_mode'],
            'request_fingerprint':args['p_fingerprint'],'reference_metadata':args['p_references'],'billing_status':'reserved',
            'created_at':'2026-10-25T00:00:00Z'}
        self.rows[key]=row;return {'ok':True,'job':copy.deepcopy(row)}
    def apply(self,owner,rid,event,task_id=None,error_code=None,assets=None):
        self.events.append(event);row=self.rows[(owner,rid)]
        row.update(status='failed' if event=='rejected' else event,provider_task_id=task_id or row.get('provider_task_id'))
        if assets:row['asset_results']=assets
        return {'ok':True,'job':copy.deepcopy(row),'balance':97.5}


class VideoRouteTests(unittest.TestCase):
    def setUp(self):
        self.store=Store();self.refs=Mock(available=True)
        self.ref={'id':'source','kind':'image','width':512,'height':512,'sha256':'a'*64,'issued':int(time.time()),'expires':int(time.time())+43200}
        self.refs.verify.return_value=self.ref;self.refs.urls.return_value=['https://fixture.invalid/image.png']
        app=Flask(__name__)
        app.register_blueprint(r.create_video_blueprint(lambda:SimpleNamespace(id=UID),lambda *a:None,[],self.refs))
        self.client=app.test_client();self.input={'request_id':RID,'parameters':{'prompt':'fixture','duration':5,'resolution':'480p'},'references':[]}
        self.stack=[]
        for patcher in [patch.dict(r.os.environ,{'APIMART_VIDEO_API_KEY':'offline-key'}),patch.object(r,'VideoStore',return_value=self.store),patch.object(r,'SupabaseGateway')]:
            self.stack.append(patcher);value=patcher.start()
        value.return_value.rpc.return_value={'email_verified':True,'profile':{'status':'active'}}
    def tearDown(self):
        for p in reversed(self.stack):p.stop()

    def test_seedance25_legacy_fixed_duration_auto_is_rejected_before_reservation_and_provider_post(self):
        self.ref.update(kind='video',width=854,height=480,duration_ms=8000,fps=30,codec='avc1',audio_codecs=[])
        self.input['parameters'].update(model='seedance-2.5',duration=8,omni_reference_task_type='auto')
        self.input['references']=[{'receipt':'synthetic-proof'}]
        with patch.object(r,'submit_video') as submit:
            with self.assertLogs(level='WARNING') as logs:
                response=self.client.post('/api/video/generations',json=self.input)
            self.assertEqual(response.json['code'],'VIDEO_TASK_CONSTRAINT')
            self.assertEqual(response.json['submission_phase'],'validation')
            self.assertFalse(response.json['submission_unknown'])
            self.assertEqual(self.store.begin_calls,[])
            self.assertEqual(self.store.rows,{})
            submit.assert_not_called()
            diagnostic='\n'.join(logs.output)
            self.assertIn('request_id='+RID,diagnostic)
            self.assertIn('code=VIDEO_TASK_CONSTRAINT phase=validation status=400',diagnostic)
            for private in ['synthetic-proof','fixture','offline-key',UID]:self.assertNotIn(private,diagnostic)

    def test_seedance25_native_auto_video_submits_once_with_matching_reserved_and_provider_parameters(self):
        self.ref.update(kind='video',width=854,height=480,duration_ms=8000,fps=30,codec='avc1',audio_codecs=[])
        self.input['parameters'].update(model='seedance-2.5',duration=-1,size='adaptive',omni_reference_task_type='auto')
        self.input['references']=[{'receipt':'synthetic-proof'}]
        self.store.apply25=lambda owner,rid,event,**kw:self.store.apply(owner,rid,event,**kw)
        with patch.object(r,'submit_video',return_value=TASK) as submit:
            response=self.client.post('/api/video/generations',json=self.input)
            self.assertEqual(response.status_code,202,response.json)
            reserve=self.store.begin_calls[0]['p_parameters'];upstream=submit.call_args.args[1]
            for body in [reserve,upstream]:
                self.assertEqual(body['omni_reference_task_type'],'auto')
                self.assertEqual(body['duration'],-1);self.assertEqual(body['size'],'adaptive')
                self.assertEqual(body['prompt'],'fixture')
            self.assertEqual(self.client.post('/api/video/generations',json=self.input).status_code,200)
            submit.assert_called_once()

    def test_reservation_database_error_keeps_uncertainty_and_never_posts_upstream(self):
        self.store.rpc=Mock(side_effect=r.SupabaseError('SUPABASE_UNAVAILABLE','private database detail',503))
        with patch.object(r,'submit_video') as submit,self.assertLogs(level='WARNING'):
            response=self.client.post('/api/video/generations',json=self.input)
        self.assertEqual(response.status_code,503)
        self.assertEqual(response.json['submission_phase'],'reservation')
        self.assertNotIn('submission_unknown',response.json)
        self.assertNotIn('private database detail',response.get_data(as_text=True))
        submit.assert_not_called()

    def test_reservation_and_single_post_are_idempotent_across_refresh_and_expiry(self):
        self.input['references']=[{'receipt':'proof'}]
        with patch.object(r,'submit_video',return_value=TASK) as submit:
            response=self.client.post('/api/video/generations',json=self.input);self.assertEqual(response.status_code,202,response.json)
            self.ref['expires']=1
            response=self.client.post('/api/video/generations',json=self.input);self.assertEqual(response.status_code,200,response.json)
            self.assertTrue(response.json['idempotent']);submit.assert_called_once();self.refs.urls.assert_called_once()
        self.assertNotIn('request_fingerprint',response.json['job']);self.assertEqual(response.headers['Cache-Control'],'private, no-store')
        self.input['parameters']['prompt']='changed'
        self.assertEqual(self.client.post('/api/video/generations',json=self.input).status_code,409)

    def test_expired_reference_new_intent_is_rejected_before_reservation(self):
        self.ref['expires']=1;self.input['references']=[{'receipt':'proof'}]
        with patch.object(r,'submit_video') as submit:
            response=self.client.post('/api/video/generations',json=self.input)
            self.assertEqual(response.json['code'],'VIDEO_REFERENCE_EXPIRED');submit.assert_not_called();self.assertEqual(self.store.begin_calls,[])

    def test_unknown_submission_holds_and_does_not_replay(self):
        with patch.object(r,'submit_video',side_effect=VideoError('VIDEO_SUBMISSION_UNKNOWN','fixture',503,True)) as submit:
            with self.assertLogs(level='WARNING'):
                response=self.client.post('/api/video/generations',json=self.input)
            self.assertEqual(response.status_code,503)
            self.assertEqual(response.json['submission_phase'],'provider_submission')
            self.assertTrue(response.json['submission_unknown'])
            response=self.client.post('/api/video/generations',json=self.input)
            self.assertTrue(response.json['idempotent']);self.assertEqual(self.store.events,['submission_unknown']);submit.assert_called_once()

    def test_query_failure_is_not_a_failed_generation_and_never_submits(self):
        with patch.object(r,'submit_video',return_value=TASK):self.client.post('/api/video/generations',json=self.input)
        with patch.object(r,'video_request',side_effect=VideoError('VIDEO_QUERY_UNAVAILABLE','fixture',502)),patch.object(r,'submit_video') as submit:
            response=self.client.get('/api/video/tasks/'+RID);self.assertEqual(response.status_code,502);submit.assert_not_called()
        self.assertEqual(self.store.events,['submitted'])

    def test_invalid_legacy_image_or_short_audio_receipts_never_reserve_or_submit(self):
        for reference in [{**self.ref,'width':299}, {'id':'short-audio','kind':'audio','duration_ms':1000,'issued':int(time.time()),'expires':int(time.time())+43200}]:
            self.refs.verify.return_value=reference
            self.input['references']=[{'receipt':'proof'}]
            # Include a valid image with short audio to exercise duration rather
            # than the unrelated audio-only restriction.
            if reference['kind']=='audio':
                self.input['references']=[{'receipt':'image-proof'},{'receipt':'audio-proof'}]
                self.refs.verify.side_effect=[self.ref,reference]
            with patch.object(r,'submit_video') as submit:
                response=self.client.post('/api/video/generations',json=self.input)
                self.assertEqual(response.status_code,400,response.json)
                self.assertEqual(response.json['code'],'VIDEO_REFERENCE_RESOLUTION' if reference['kind']=='image' else 'VIDEO_REFERENCE_DURATION')
                self.assertEqual(self.store.begin_calls,[]);submit.assert_not_called()
            self.refs.verify.side_effect=None

    def test_arbitrary_asset_ids_and_other_key_scope_cannot_be_used(self):
        self.store.approved=[{'id':'owned','kind':'image','asset_url':'asset://owned_001','sha256':'b'*64}]
        self.input['references']=[{'asset_url':'asset://other_user_001'}]
        response=self.client.post('/api/video/generations',json=self.input);self.assertEqual(response.status_code,403)
        self.assertEqual(self.store.begin_calls,[])
        self.input['references']=[{'asset_url':'asset://owned_001'}]
        with patch.object(r,'submit_video',return_value=TASK) as submit:
            response=self.client.post('/api/video/generations',json=self.input);self.assertEqual(response.status_code,202)
            self.assertEqual(submit.call_args.args[1]['image_urls'],['asset://owned_001'])
        response=self.client.get('/api/video/tasks/'+RID,headers={'X-Billing-Mode':'own_key','X-Video-Api-Key':'another-key'})
        self.assertEqual(response.status_code,404)

    def test_custom_endpoint_is_used_only_for_own_key_and_is_part_of_the_owner_scope(self):
        headers={'X-Billing-Mode':'own_key','X-Video-Api-Key':'offline-user-key',
                 'X-Video-Endpoint':'https://video.example.invalid/v1/videos/generations',
                 'X-Video-Query-Template':'https://video.example.invalid/v1/tasks/{task_id}'}
        with patch.object(r,'submit_video',return_value=TASK) as submit:
            response=self.client.post('/api/video/generations',json=self.input,headers=headers)
            self.assertEqual(response.status_code,202,response.json)
            self.assertEqual(submit.call_args.args[0],'offline-user-key')
            self.assertEqual(submit.call_args.kwargs['endpoint'],headers['X-Video-Endpoint'])
        other={**headers,'X-Video-Endpoint':'https://other.example.invalid/v1/videos/generations','X-Video-Query-Template':''}
        self.assertEqual(self.client.get('/api/video/tasks/'+RID,headers=other).status_code,404)
        # Headers from the browser can never redirect the platform secret.
        self.input['request_id']='33333333-3333-4333-8333-333333333333'
        with patch.object(r,'submit_video',return_value=TASK) as submit:
            response=self.client.post('/api/video/generations',json=self.input,headers={**headers,'X-Billing-Mode':'platform'})
            self.assertEqual(response.status_code,202,response.json)
            self.assertEqual(submit.call_args.args[0],'offline-key');self.assertEqual(submit.call_args.kwargs,{})

    def test_asset_review_uses_single_file_and_documented_task_id_then_binds_owner_metadata(self):
        self.input.update(parameters={},references=[{'receipt':'proof'}])
        with patch.object(r,'video_request',return_value={'code':200,'data':{'id':TASK}}) as submit:
            response=self.client.post('/api/video/assets/reviews',json=self.input);self.assertEqual(response.status_code,202,response.json)
            self.assertEqual(submit.call_args.args[1],'/seedance2/private-avatar')
            self.assertEqual(submit.call_args.args[3]['asset_type'],'Image')
        result={'code':200,'data':{'id':TASK,'status':'completed','progress':100,'result':{'usable_assets':[{'asset_id':{'secret':'not-accepted'},'asset_url':'asset://approved_001','status':'Active'}]}}}
        with patch.object(r,'video_request',return_value=result):
            response=self.client.get('/api/video/tasks/'+RID);self.assertEqual(response.status_code,200,response.json)
        asset=response.json['job']['asset_results'][0]
        self.assertEqual(asset['sha256'],self.ref['sha256']);self.assertEqual(asset['asset_id'],'approved_001')
        self.assertNotIn('secret',str(response.json));self.assertNotIn('raw_result',response.json)
