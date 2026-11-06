import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeVideoJobs,videoJobTitle,videoSubmissionFailure} from '../src/lib/videoJobs.js';
import {videoApi} from '../src/lib/video.js';

const placeholder={request_id:'synthetic-request',local_attempt:true,model:'seedance-2.5',resolution:'480p',status:'submitting',created_at:'2026-11-06T15:23:10Z'};
test('validation refusal retains its model and actionable error without becoming a generated task',()=>{
  const error={status:400,code:'VIDEO_TASK_CONSTRAINT',message:'请选择视频创作方式。',submission_phase:'validation',submission_unknown:false};
  const job=videoSubmissionFailure(placeholder,error);
  assert.equal(job.status,'not_submitted');assert.equal(job.failure_reason,error.message);
  assert.equal(job.error_code,error.code);assert.equal(videoJobTitle(job,[{id:'seedance-2.5',name:'Seedance 2.5'}]),'Seedance 2.5 · 480P');
  assert.equal(videoJobTitle({}),'视频任务');assert.equal(videoJobTitle({operation:'asset_review'}),'素材审核');
});
test('network and reservation uncertainty never becomes a safe-to-retry validation refusal',()=>{
  for(const error of [{message:'网络中断'},{status:503,message:'数据库暂未确认',submission_phase:'reservation'},{status:502,message:'提交待确认',submission_unknown:true,submission_phase:'provider_submission'}]){
    assert.equal(videoSubmissionFailure(placeholder,error).status,'submission_unknown');
  }
  assert.equal(videoSubmissionFailure(placeholder,{status:400,message:'服务拒绝',submission_phase:'provider_submission',submission_unknown:false}).status,'failed');
});
test('a recovered server job wins over a late local POST failure, including a server job without task ID',()=>{
  const failed=videoSubmissionFailure(placeholder,{status:400,message:'late rejection'});
  for(const job of [{...placeholder,local_attempt:undefined,status:'submitting'},{...placeholder,local_attempt:undefined,status:'processing',provider_task_id:'task_synthetic'}]){
    assert.deepEqual(mergeVideoJobs([job],[failed]),[job]);
    assert.deepEqual(mergeVideoJobs([failed],[job]),[job]);
  }
});
test('API preserves the validation stage and sends only one POST',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({code:'VIDEO_TASK_CONSTRAINT',error:'请选择创作方式',submission_phase:'validation',submission_unknown:false}),{status:400});};
  try{await assert.rejects(videoApi('/generations',{body:{request_id:'synthetic-request'}}),e=>e.submission_phase==='validation' && e.submission_unknown===false);assert.equal(calls,1);}
  finally{globalThis.fetch=original;}
});
