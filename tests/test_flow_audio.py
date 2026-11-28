import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask
from backend import flow_audio as flow, music_routes as routes
from backend.music_provider import MusicError, normalize_task

UID = "55555555-5555-4555-8555-555555555555"
REQ = "55555555-5555-4555-8555-555555555551"
IMPORT = "task_flow_import_12345"
COVER = "task_flow_cover_12345"


class FlowProtocolTests(unittest.TestCase):
    def test_cover_supports_only_its_documented_parameters_and_preserves_zero(self):
        body = flow.flow_cover_request({"model":"flowmusic", "version":"lyria-3-pro", "prompt":" jazz ", "strength":0}, 1)
        self.assertEqual(body, {"model":"flowmusic","instruction":"jazz","strength":0})
        self.assertEqual(flow.flow_cover_request({"model":"flowmusic","version":"lyria-3.5","prompt":"jazz"},1)["version"],"lyria-3.5")
        for data, count in (({"model":"suno","prompt":"jazz"},1), ({"model":"flowmusic","prompt":"jazz"},2),
                            ({"model":"flowmusic","prompt":""},1), ({"model":"flowmusic","prompt":"jazz","audio_url":"https://arbitrary.invalid"},1),
                            ({"model":"flowmusic","prompt":"jazz","instrumental":True},1)):
            with self.subTest(data=data), self.assertRaises(MusicError): flow.flow_cover_request(data,count)
        for value in (True, -1, 1.1, float('nan'), float('inf'), "0.5"):
            with self.subTest(value=value), self.assertRaises(MusicError): flow.flow_cover_request({"model":"flowmusic","prompt":"jazz","strength":value},1)

    def test_fixed_upstream_submission_is_once_and_ambiguous_reply_is_unknown(self):
        with patch.object(flow,"apimart_request",return_value={"data":[{"task_id":IMPORT}]}) as paid:
            self.assertEqual(flow.submit_flow("fixture","uploadAudioFlowMusic",{"model":"flowmusic","audio_url":"https://fixture.invalid/a.wav"}),IMPORT)
        paid.assert_called_once();self.assertEqual(paid.call_args.args[1],"/generations/uploadAudioFlowMusic")
        with patch.object(flow,"apimart_request",return_value={"data":{}}), self.assertRaises(MusicError) as caught:
            flow.submit_flow("fixture","coverFlowMusic",{})
        self.assertTrue(caught.exception.uncertain)

    def test_clip_id_is_preserved_only_from_trusted_query_result(self):
        result=normalize_task({"data":{"id":IMPORT,"status":"completed","result":{"music":[{"clip_id":"clip_12345678","audio_url":"https://fixture.invalid/a.wav"}]}}},IMPORT)
        self.assertEqual(result["tracks"][0]["clip_id"],"clip_12345678")
        clip_only=normalize_task({"data":{"id":IMPORT,"status":"completed","result":{"music":[{"clip_id":"clip_12345678"}]}}},IMPORT)
        self.assertEqual(clip_only["tracks"],[]);self.assertEqual(clip_only["clip_ids"],["clip_12345678"])

    def test_import_completion_claims_once_before_cover_and_never_settles_import_audio(self):
        store=Mock();job={"request_id":REQ,"provider_task_id":IMPORT,"flow_stage":"importing"}
        result={"status":"completed","progress":100,"tracks":[{"clip_id":"clip_12345678","audio_url":"https://fixture.invalid/import.wav"}]}
        parameters={"model":"flowmusic","version":"lyria-3.5","instruction":"jazz","strength":0}
        store.rpc.side_effect=[{"claimed":True,"parameters":parameters,"job":{"flow_stage":"cover_submitting"}}, {"job":{"flow_stage":"generating"}}]
        with patch.object(flow,"submit_flow",return_value=COVER) as paid:
            response=flow.reconcile_flow_import(store,"owner",job,result,"key")
        paid.assert_called_once_with("key","coverFlowMusic",{**parameters,"clip_id":"clip_12345678"},"bearer")
        self.assertEqual(response["tracks"],[]);store.apply.assert_not_called()
        self.assertEqual(store.rpc.call_args_list[0].args[1]["p_event"],"claim_cover")
        self.assertEqual(store.rpc.call_args_list[1].args[1]["p_event"],"cover_submitted")
        store.rpc.side_effect=None;store.rpc.return_value={"claimed":False,"job":{"flow_stage":"generating"}}
        with patch.object(flow,"submit_flow") as paid:
            flow.reconcile_flow_import(store,"owner",job,result,"key")
        paid.assert_not_called()

    def test_missing_clip_never_advances_and_explicit_import_failure_uses_guarded_refund(self):
        store=Mock();job={"request_id":REQ,"provider_task_id":IMPORT}
        response=flow.reconcile_flow_import(store,"owner",job,{"status":"completed","progress":100,"tracks":[]},"key")
        self.assertIn("warning",response);store.rpc.assert_not_called()
        store.rpc.return_value={"job":{"status":"failed"}}
        flow.reconcile_flow_import(store,"owner",job,{"status":"failed","progress":100,"error_code":"MUSIC_AUDIO_INVALID"},"key")
        self.assertEqual(store.rpc.call_args.args[1]["p_event"],"import_failed")

    def test_cover_timeout_holds_reservation_reject_refunds_and_save_failure_never_refunds(self):
        job={"request_id":REQ,"provider_task_id":IMPORT};result={"status":"completed","progress":100,"tracks":[{"clip_id":"clip_12345678"}]}
        for uncertain,event in ((True,"cover_unknown"),(False,"cover_rejected")):
            store=Mock();store.rpc.side_effect=[{"claimed":True,"parameters":{},"job":{}},{"job":{}}]
            with patch.object(flow,"submit_flow",side_effect=MusicError("MUSIC_PROVIDER_REJECTED","failed",502,uncertain)) as paid:
                flow.reconcile_flow_import(store,"owner",job,result,"key")
            paid.assert_called_once();self.assertEqual(store.rpc.call_args.args[1]["p_event"],event)
        store=Mock();store.rpc.side_effect=[{"claimed":True,"parameters":{},"job":{}},RuntimeError("save unavailable")]
        with patch.object(flow,"submit_flow",return_value=COVER) as paid, self.assertRaises(RuntimeError):
            flow.reconcile_flow_import(store,"owner",job,result,"key")
        paid.assert_called_once();self.assertEqual(store.rpc.call_count,2);store.apply.assert_not_called()


class FlowRouteTests(unittest.TestCase):
    def setUp(self):
        self.refs=Mock(available=True);self.refs.verify.return_value={"id":"fixture-source","sha256":"a"*64,"expires":int(time.time())+3600}
        self.refs.urls.return_value=["https://fixture.invalid/a.wav?token=private-reference"]
        user=SimpleNamespace(id=UID);app=Flask(__name__)
        app.register_blueprint(routes.create_music_blueprint(lambda:user,lambda:user,lambda *args:None,[],self.refs));self.client=app.test_client()
        self.headers={"X-Billing-Mode":"own_key","X-Music-Api-Key":"private-key","X-Music-Endpoint":"https://api.apimart.ai/v1/music/generations"}
        self.gateway=Mock();self.gateway.rpc.return_value={"email_verified":True,"profile":{"status":"active"}}
        self.store=Mock();self.store.gateway._request.return_value=[]
        self.job={"request_id":REQ,"operation":"flow_cover","flow_stage":"importing","provider_task_id":IMPORT,"status":"submitted"}
        self.store.rpc.return_value={"ok":True,"existing":False,"job":self.job};self.store.apply.return_value={"ok":True,"job":self.job};self.store.get.return_value=self.job
        self.stack=__import__('contextlib').ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(routes,"MusicStore",return_value=self.store));self.stack.enter_context(patch.object(routes,"SupabaseGateway",return_value=self.gateway))
        self.paid=self.stack.enter_context(patch.object(routes,"submit_flow",return_value=IMPORT))

    def post(self,parameters=None,references=None):
        return self.client.post('/api/music/operations/flow_cover',headers=self.headers,json={"request_id":REQ,"parameters":parameters or {"model":"flowmusic","prompt":"jazz","strength":0},"references":references or ["verified-receipt"]})

    def test_reserves_one_intent_without_credentials_and_imports_before_cover(self):
        r=self.post();self.assertEqual(r.status_code,202)
        self.assertEqual(self.store.rpc.call_args.args[0],"begin_flow_cover_job")
        reservation=self.store.rpc.call_args.args[1]
        self.assertEqual(reservation['p_parameters']['strength'],"0");self.assertEqual(reservation['p_parameters']['version'],"lyria-3-pro")
        for secret in ("private-key","verified-receipt","private-reference","audio_url"):
            self.assertNotIn(secret,__import__('json').dumps(reservation));self.assertNotIn(secret,r.get_data(as_text=True))
        self.paid.assert_called_once_with("private-key","uploadAudioFlowMusic",{"model":"flowmusic","audio_url":self.refs.urls.return_value[0]},"bearer")

    def test_multi_audio_invalid_parameters_and_storage_failure_never_reserve(self):
        self.assertEqual(self.post(references=["a","b"]).status_code,400)
        self.assertEqual(self.post(parameters={"model":"flowmusic","prompt":"jazz","lyrics":"unsupported"}).status_code,400)
        self.refs.urls.side_effect=MusicError("MUSIC_REFERENCE_STORAGE","unavailable",503)
        self.assertEqual(self.post().status_code,503)
        self.paid.assert_not_called();self.store.rpc.assert_not_called()

    def test_upload_policy_rejection_ends_import_without_starting_cover(self):
        raw = "This audio might violate our prohibited use policy and can't be uploaded."
        result = normalize_task({"data": {"id": IMPORT, "status": "failed", "error": {"message": raw}}}, IMPORT)
        rejected = {**self.job, "status": "failed", "error_code": result["error_code"], "billing_status": "refunded"}
        self.store.rpc.return_value = {"job": rejected}
        with patch.object(routes, "query_music", return_value=result), patch.object(flow, "submit_flow") as cover:
            response = self.client.get("/api/music/tasks/" + REQ, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["job"]["error_code"], "MUSIC_AUDIO_POLICY_REJECTED")
        self.assertIn("上传审核", response.json["job"]["failure_reason"])
        self.assertNotIn(raw, str(response.json))
        self.assertEqual(self.store.rpc.call_args.args[1]["p_event"], "import_failed")
        self.assertEqual(self.store.rpc.call_args.args[1]["p_error_code"], "MUSIC_AUDIO_POLICY_REJECTED")
        cover.assert_not_called()

    def test_immediate_rejection_carries_typed_reason_for_the_form(self):
        self.paid.side_effect = MusicError("MUSIC_PROVIDER_REJECTED", "音频未通过审核", 502,
                                           reason_code="MUSIC_AUDIO_POLICY_REJECTED")
        response = self.post()
        self.assertEqual(response.json["code"], "MUSIC_PROVIDER_REJECTED")
        self.assertEqual(response.json["reason_code"], "MUSIC_AUDIO_POLICY_REJECTED")

    def test_generic_moderation_is_audio_specific_only_during_import(self):
        row = {**self.job, "status": "failed", "error_code": "MUSIC_CONTENT_REJECTED"}
        self.assertEqual(routes.public_job(row)["error_code"], "MUSIC_AUDIO_POLICY_REJECTED")
        for stage in (None, "generating", "cover_submitting"):
            self.assertEqual(routes.public_job({**row, "flow_stage": stage})["error_code"], "MUSIC_CONTENT_REJECTED")
        self.store.rpc.return_value = {"job": row}
        response = {"status": "failed", "progress": 0, "tracks": [], "error_code": "MUSIC_CONTENT_REJECTED"}
        with patch.object(routes, "query_music", return_value=response), patch.object(flow, "submit_flow") as cover:
            self.client.get("/api/music/tasks/" + REQ, headers=self.headers)
        self.assertEqual(self.store.rpc.call_args.args[1]["p_error_code"], "MUSIC_AUDIO_POLICY_REJECTED")
        cover.assert_not_called()

    def test_unknown_transition_does_not_query_old_import_or_resubmit(self):
        self.store.get.return_value={**self.job,"flow_stage":"cover_submitting","provider_task_id":None,"status":"submission_unknown"}
        with patch.object(routes,"query_music") as query:
            r=self.client.get('/api/music/tasks/'+REQ,headers=self.headers)
        self.assertEqual(r.status_code,200);query.assert_not_called();self.paid.assert_not_called();self.assertIn('warning',r.json)


if __name__ == '__main__': unittest.main()
