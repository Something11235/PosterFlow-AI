import assert from 'node:assert/strict';
import test from 'node:test';
import { imageRefundError, accountAfterImageRefund } from '../src/lib/imageRefund.js';
import { imageGenerationFetch, imageJobMetadata, readImageTask } from '../src/lib/apimartImages.js';
import { createImageTaskStore, getCompletedImageTask, getRefundedImageTask, syncImageTaskSelection } from '../src/lib/imageTasks.js';
import { canAutoQueryImageTask, isPendingImageTaskError } from '../src/lib/imageTaskRecovery.js';

const code='IMAGE_UNDELIVERED_REFUNDED';
const job=()=>({request_id:'original',status:'failed',error_code:code,refunded:true,billing_status:'refunded',
  billing_mode:'platform',model:'gpt-image-2.6-sunburst',created_at:new Date().toISOString(),image_keys:[]});
const refunded=()=>({error:'本次未取得图片结果，预留积分已退回。',code,refunded:true,submission_unknown:false,
  generation_submitted:true,credit_balance:30,job:job()});
const memory=()=>{const data=new Map();return {getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const headers={'X-Billing-Mode':'platform'};
const init={method:'POST',headers,body:JSON.stringify({request_id:'original',platform_model:'gpt-image-2.6-sunburst',prompt:'synthetic'})};

test('refund presentation requires confirmation and platform billing, never an error code or a zero charge alone',()=>{
  for(const data of [{code},{code:'IMAGE_SUBMISSION_UNKNOWN',charged_credits:0},{status:'failed'},{submission_unknown:true}])
    assert.equal(imageRefundError(data,'platform'),null);
  assert.equal(imageRefundError(refunded(),'own_key'),null);
  const error=imageRefundError(refunded(),'platform');
  assert.equal(error.refunded,true);
  assert.equal(error.submission_unknown,false);
  assert.match(error.message,/预留积分已退回/);
  assert.doesNotMatch(error.detail+error.recovery.join(''),/审核|提示词|余额不足/);
  assert.equal(isPendingImageTaskError({...error,submission_unknown:true}),false);
});

test('confirmed refund updates the returned balance without manufacturing an account or incrementing credits locally',()=>{
  const account={profile:{id:'owner'},credits:{balance:'27',total_spent:'241.5'}};
  const updated=accountAfterImageRefund(account,refunded(),'platform');
  assert.equal(updated.credits.balance,'30');
  assert.equal(updated.credits.total_spent,'241.5');
  assert.equal(accountAfterImageRefund(updated,refunded(),'platform').credits.balance,'30');
  assert.equal(accountAfterImageRefund(null,refunded(),'platform'),null);
  for(const bad of [null,undefined,'not a balance',-1,'Infinity'])
    assert.equal(accountAfterImageRefund(account,{...refunded(),credit_balance:bad},'platform'),account);
  assert.equal(accountAfterImageRefund(account,refunded(),'own_key'),account);
  assert.equal(accountAfterImageRefund(account,{credit_balance:30},'platform'),account);
});

test('refund survives refresh and terminal metadata cannot be revived by stale pending or successful responses',()=>{
  const storage=memory(),store=createImageTaskStore(3,'owner',{storage});
  store.start('original',{billingMode:'platform',route:'buytoken',model:'gpt-image-2.6-sunburst',prompt:'mine'});
  store.finish('original',{error:{code:'IMAGE_SUBMISSION_UNKNOWN'},pending:true});
  store.importJobs([imageJobMetadata({...job(),api_key:'secret',provider_result_urls:['https://private.invalid']},'buytoken')]);
  assert.equal(store.getSnapshot()[0].status,'failed');
  assert.equal(store.getSnapshot()[0].error.refunded,true);
  assert.equal(canAutoQueryImageTask(store.getSnapshot()[0]),false);
  const restored=createImageTaskStore(3,'owner',{storage});
  assert.equal(restored.getSnapshot()[0].error.refunded,true);
  assert.equal(restored.start('original',{billingMode:'platform'}),false);
  assert.equal(restored.start('new-request',{billingMode:'platform'}),true);
  restored.importJobs([imageJobMetadata({...job(),status:'processing',refunded:false,billing_status:undefined},'buytoken')]);
  restored.importJobs([imageJobMetadata({...job(),status:'completed',image_keys:['late.png'],refunded:false},'buytoken')]);
  restored.finish('original',{images:[{filename:'late-finish.png'}]});
  restored.finish('original',{error:{code:'IMAGE_SUBMISSION_UNKNOWN'},pending:true});
  restored.finish('original',{error:{code:'IMAGE_TASK_FAILED'}});
  assert.equal(getRefundedImageTask(restored,'original').status,'failed');
  assert.equal(restored.getSnapshot().find(x=>x.id==='original').error.refunded,true);
  assert.doesNotMatch(storage.getItem('posterflow.image-tasks.v2:owner'),/secret|private.invalid/);
  assert.deepEqual(createImageTaskStore(3,'other',{storage}).getSnapshot(),[]);
});

test('an existing recovered image is not overwritten by a late refund or failed finish',()=>{
  const store=createImageTaskStore(3,'owner',{storage:null});
  store.start('original',{billingMode:'platform'});
  store.finish('original',{images:[{filename:'recovered.png'}]});
  store.importJobs([imageJobMetadata(job(),'buytoken')]);
  store.finish('original',{error:imageRefundError(refunded(),'platform')});
  assert.equal(getRefundedImageTask(store,'original'),null);
  assert.equal(getCompletedImageTask(store,'original').images[0].filename,'recovered.png');
});

test('owned task synchronization replaces the selected pending view with refund and does not clear it on every refresh',()=>{
  const store=createImageTaskStore(3,'owner',{storage:null});
  store.start('original',{billingMode:'platform',route:'buytoken',prompt:'mine'});
  store.finish('original',{error:{code:'IMAGE_SUBMISSION_UNKNOWN'},pending:true});
  const jobs=[imageJobMetadata(job(),'buytoken')];
  const options={currentStore:store,currentOwner:'owner',selectedId:'original'};
  assert.equal(syncImageTaskSelection(store,jobs,{...options,currentOwner:'other'}),null);
  const selected=syncImageTaskSelection(store,jobs,options);
  assert.equal(selected.error.refunded,true);
  assert.equal(selected.prompt,'mine');
  assert.equal(syncImageTaskSelection(store,jobs,options),null);
});

test('a refunded POST returns once without polling or replay, retaining the refund and balance fields',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,method:options.method||'GET'});return response(refunded(),503);});
  const previous=globalThis.window;globalThis.window={dispatchEvent(){}};t.after(()=>{globalThis.window=previous;});
  const result=await imageGenerationFetch('/api/generate',init,{pollInterval:0});
  const data=await result.json();
  assert.equal(result.status,503);assert.equal(data.refunded,true);assert.equal(data.credit_balance,30);
  assert.equal(data.submission_unknown,false);
  assert.deepEqual(calls,[{url:'/api/buytoken-images/generations',method:'POST'}]);
});

test('GET recovery and an in-flight poll both terminate on a confirmed refund without a new generation',async t=>{
  const calls=[];let polling=false;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url,method:options.method||'GET'});
    if(polling && options.method==='POST')return response({job:{status:'processing',result_available:true}},202);
    const data=refunded();delete data.error;return response(data);
  });
  const data=await readImageTask('original',headers,undefined,'gpt-image-2.6-sunburst','buytoken');
  assert.equal(imageRefundError(data,'platform').refunded,true);
  assert.deepEqual(calls.map(x=>x.method),['GET']);
  polling=true;calls.length=0;
  const previous=globalThis.window;globalThis.window={dispatchEvent(){}};t.after(()=>{globalThis.window=previous;});
  const result=await imageGenerationFetch('/api/generate',init,{pollInterval:0});
  assert.equal((await result.json()).refunded,true);
  assert.deepEqual(calls.map(x=>x.method),['POST','GET']);
});
