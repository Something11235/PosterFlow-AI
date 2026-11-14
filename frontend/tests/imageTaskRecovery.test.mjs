import assert from 'node:assert/strict';
import test from 'node:test';
import { createImageTaskStore, getCompletedImageTask, syncImageTaskSelection } from '../src/lib/imageTasks.js';
import { canAutoQueryImageTask, isPendingImageTaskError, startImageTaskRecovery, IMAGE_RECOVERY_INTERVAL_MS, IMAGE_RECOVERY_WINDOW_MS } from '../src/lib/imageTaskRecovery.js';
import { imageJobMetadata, imageTaskPendingState } from '../src/lib/apimartImages.js';

const pending = (now = Date.now()) => ({id:'original',route:'apimart',billingMode:'platform',createdAt:now,status:'pending',active:false,error:{code:'IMAGE_TASK_PENDING'}});
const completed = () => ({...pending(),status:'completed',images:[{filename:'saved.png'}]});
const storeFor = owner => createImageTaskStore(3,owner,{storage:null});

test('late completion updates the selected result after an initial waiting error, and wins over a delayed failure', () => {
  const store = storeFor('owner');
  store.start('original',{prompt:'original prompt',route:'apimart',billingMode:'platform'});
  store.finish('original',{error:{code:'IMAGE_TASK_PENDING'},pending:true});
  const result = syncImageTaskSelection(store,[completed()],{currentStore:store,currentOwner:'owner',selectedId:'original'});
  assert.equal(result.prompt,'original prompt');
  assert.deepEqual(result.images,[{filename:'saved.png'}]);
  assert.equal(result.error,undefined);
  store.finish('original',{error:{code:'IMAGE_TASK_QUERY_FAILED'},pending:true});
  assert.equal(getCompletedImageTask(store,'original'),result);
});

test('synchronizing another request or an unfinished task cannot replace the selected result', () => {
  const store = storeFor('owner');
  const options = {currentStore:store,currentOwner:'owner',selectedId:'selected'};
  assert.equal(syncImageTaskSelection(store,[completed()],options),null);
  assert.equal(syncImageTaskSelection(store,[{...pending(),id:'selected'}],options),null);
  assert.equal(syncImageTaskSelection(store,[{...completed(),id:'selected',images:[]}],options),null);
});

test('unchanged or absent selected results do not reset the gallery while unrelated tasks synchronize', () => {
  const store = storeFor('owner'), options={currentStore:store,currentOwner:'owner',selectedId:'original'};
  assert.ok(syncImageTaskSelection(store,[completed()],options));
  assert.equal(syncImageTaskSelection(store,[],options),null);
  assert.equal(syncImageTaskSelection(store,[{...completed(),id:'other'}],options),null);
  assert.equal(syncImageTaskSelection(store,[completed()],options),null);
  assert.ok(syncImageTaskSelection(store,[{...completed(),images:[{filename:'second.png'}]}],options));
});

test('a late response from another account or a discarded store cannot import or display images', () => {
  const oldStore = storeFor('owner'), newStore = storeFor('owner'), otherStore = storeFor('other');
  for (const [currentStore,currentOwner] of [[otherStore,'other'],[newStore,'owner'],[oldStore,'other']]) {
    assert.equal(syncImageTaskSelection(oldStore,[completed()],{currentStore,currentOwner,selectedId:'original'}),null);
  }
  assert.deepEqual(oldStore.getSnapshot(),[]);
  assert.deepEqual(newStore.getSnapshot(),[]);
  assert.deepEqual(otherStore.getSnapshot(),[]);
});

test('owned platform processing and uncertain tasks qualify only within the bounded recovery window', () => {
  const now=Date.now(), task=pending(now);
  assert.equal(canAutoQueryImageTask(task,now),true);
  assert.equal(canAutoQueryImageTask(task,now+IMAGE_RECOVERY_WINDOW_MS-1),true);
  assert.equal(canAutoQueryImageTask(task,now+IMAGE_RECOVERY_WINDOW_MS),false);
  for (const change of [{route:'legacy'},{billingMode:'own_key'},{active:true},{status:'completed'},
    {error:{code:'AUTH_REQUIRED'}},{error:{code:'IMAGE_QUERY_CANCELLED',submission_unknown:true}},{error:{code:'IMAGE_TASK_REVIEW_REQUIRED'}},{status:'failed'},
    {error:{code:'IMAGE_SUBMISSION_UNKNOWN',refunded:true}},{createdAt:now+1},{createdAt:NaN}]) {
    assert.equal(canAutoQueryImageTask({...task,...change},now),false);
  }
  for (const route of ['apimart','buytoken']) {
    for (const status of ['submitting','submission_unknown','unknown']) {
      const metadata = imageJobMetadata({request_id:'original',status,result_available:true,error_code:'IMAGE_SAVE_PENDING',created_at:new Date(now).toISOString(),billing_mode:'platform'},route);
      assert.equal(metadata.error.code,status==='submitting'?'IMAGE_TASK_PENDING':'IMAGE_SUBMISSION_UNKNOWN');
      assert.equal(canAutoQueryImageTask(metadata,now),true);
    }
    for(const status of ['processing','saving']) for(const code of ['IMAGE_TASK_QUERY_FAILED','IMAGE_SAVE_PENDING']) {
      const metadata=imageJobMetadata({request_id:'original',status,result_available:true,error_code:code,created_at:new Date(now).toISOString(),billing_mode:'platform'},route);
      assert.equal(canAutoQueryImageTask(metadata,now),true);
    }
  }
  for (const status of ['submitted','processing']) {
    const metadata = imageJobMetadata({request_id:'original',status,created_at:new Date(now).toISOString(),billing_mode:'platform'},'apimart');
    assert.equal(canAutoQueryImageTask(metadata,now),true);
  }
});

test('known saving remains a query-only gallery action even when submission is confirmed', () => {
  const saving=imageTaskPendingState({status:'saving'},'buytoken');
  assert.equal(saving.code,'IMAGE_SAVE_PENDING');
  assert.equal(saving.submission_unknown,false);
  assert.equal(isPendingImageTaskError(saving),true);
  assert.equal(isPendingImageTaskError({code:'IMAGE_TASK_CLOSED',submission_unknown:false}),false);
});

test('GET confirming processing replaces an earlier unknown state without losing query eligibility', () => {
  for (const route of ['apimart','buytoken']) {
    const store=storeFor('owner');
    store.start('original',{prompt:'fixture',route,billingMode:'platform'});
    store.finish('original',{error:{code:'IMAGE_SUBMISSION_UNKNOWN'},pending:true});
    assert.equal(canAutoQueryImageTask(store.getSnapshot()[0]),true);
    store.finish('original',{error:imageTaskPendingState({status:'processing',result_available:true},route),pending:true});
    assert.equal(canAutoQueryImageTask(store.getSnapshot()[0]),true);
    store.finish('original',{error:imageTaskPendingState({status:'submission_unknown',error_code:'IMAGE_SAVE_PENDING'},route),pending:true});
    assert.equal(canAutoQueryImageTask(store.getSnapshot()[0]),true);
  }
  assert.equal(imageTaskPendingState({status:'submitted'},'buytoken'),null);
});

test('BuyToken processing without result URLs stays generating, while unknown status names stay manual', () => {
  const base={request_id:'original',created_at:new Date().toISOString(),billing_mode:'platform',error_code:'IMAGE_SAVE_PENDING'};
  for(const result_available of [false,undefined]) {
    const metadata=imageJobMetadata({...base,status:'processing',result_available},'buytoken');
    assert.equal(metadata.error.code,'IMAGE_TASK_PENDING');
    assert.equal(metadata.error.submission_unknown,false);
    assert.equal(metadata.error.recovery_confirmed,false);
    assert.equal(canAutoQueryImageTask(metadata),true);
  }
  for(const route of ['apimart','buytoken']) {
    const metadata=imageJobMetadata({...base,status:'unrecognized',result_available:true},route);
    assert.equal(metadata.error.code,'IMAGE_TASK_REVIEW_REQUIRED');
    assert.equal(canAutoQueryImageTask(metadata),false);
  }
});

test('refresh of unfinished local BuyToken archives resumes GET recovery without asserting provider acceptance', () => {
  const archive=new Map(),storage={getItem:key=>archive.get(key),setItem:(key,value)=>archive.set(key,value)};
  const first=createImageTaskStore(3,'owner',{storage});
  first.start('original',{prompt:'fixture',route:'buytoken',billingMode:'platform'});
  let restored=createImageTaskStore(3,'owner',{storage});
  assert.equal(restored.getSnapshot()[0].error.code,'IMAGE_SUBMISSION_UNKNOWN');
  assert.equal(restored.getSnapshot()[0].error.recovery_confirmed,false);
  assert.equal(canAutoQueryImageTask(restored.getSnapshot()[0]),true);
  restored.finish('original',{pending:true,error:imageTaskPendingState({status:'processing',result_available:true},'buytoken')});
  restored=createImageTaskStore(3,'owner',{storage});
  assert.equal(canAutoQueryImageTask(restored.getSnapshot()[0]),true);
  restored.finish('original',{pending:true,error:imageTaskPendingState({status:'submission_unknown',result_available:true},'buytoken')});
  assert.equal(canAutoQueryImageTask(createImageTaskStore(3,'owner',{storage}).getSnapshot()[0]),true);
});

test('a stale failed snapshot or an empty completion cannot erase an already recovered image', () => {
  const store=storeFor('owner'), options={currentStore:store,currentOwner:'owner',selectedId:'original'};
  syncImageTaskSelection(store,[completed()],options);
  const saved=getCompletedImageTask(store,'original');
  for (const status of ['failed','pending','completed']) {
    assert.equal(syncImageTaskSelection(store,[{...completed(),status,images:[]}],options),null);
    assert.equal(getCompletedImageTask(store,'original'),saved);
  }
});

function clock() {
  let now=100000,seq=0;
  const timers=new Map(),visibility=new EventTarget();visibility.visibilityState='visible';
  return {
    visibility,timers,now:()=>now,
    schedule:(fn,delay)=>{const id=++seq;timers.set(id,{fn,at:now+delay});return id;},
    cancel:id=>timers.delete(id),
    async advance(ms){now+=ms;const due=[...timers].filter(([,timer])=>timer.at<=now);for(const [id] of due)timers.delete(id);await Promise.all(due.map(([,timer])=>timer.fn()));},
    setVisibility(state){visibility.visibilityState=state;visibility.dispatchEvent(new Event('visibilitychange'));},
  };
}

test('background recovery waits fifteen seconds, pauses when hidden, and stops on completion', async () => {
  const time=clock();let task=pending(time.now()),queries=0;
  const stop=startImageTaskRecovery({...time,readTask:()=>task,query:async()=>{queries++;if(queries===2)task={...task,status:'completed'};}});
  await time.advance(IMAGE_RECOVERY_INTERVAL_MS-1);assert.equal(queries,0);
  time.setVisibility('hidden');await time.advance(60000);assert.equal(queries,0);assert.equal(time.timers.size,0);
  time.setVisibility('visible');await time.advance(IMAGE_RECOVERY_INTERVAL_MS);assert.equal(queries,1);
  await time.advance(IMAGE_RECOVERY_INTERVAL_MS);assert.equal(queries,2);assert.equal(time.timers.size,0);
  await time.advance(60000);assert.equal(queries,2);stop();
});

test('a slow original-task query never overlaps another scheduled query, and disposal cancels rescheduling', async () => {
  const time=clock();const task=pending(time.now());let queries=0,release;
  const stop=startImageTaskRecovery({...time,readTask:()=>task,query:()=>{queries++;return new Promise(resolve=>{release=resolve;});}});
  const running=time.advance(IMAGE_RECOVERY_INTERVAL_MS);
  assert.equal(queries,1);assert.equal(time.timers.size,0);
  time.setVisibility('hidden');time.setVisibility('visible');await time.advance(60000);
  assert.equal(queries,1);assert.equal(time.timers.size,0);
  stop();release();await running;assert.equal(time.timers.size,0);
  time.setVisibility('visible');await time.advance(60000);assert.equal(queries,1);
});

test('switching task or owner, reaching the time limit, authentication failure or refund stops recovery', async () => {
  for(const reason of ['selection','owner','deadline','auth','refund']){
    const time=clock();let task=pending(time.now()),queries=0;
    const stop=startImageTaskRecovery({...time,readTask:()=>task,query:async()=>{queries++;}});
    if(reason==='selection'||reason==='owner')task=null;
    else if(reason==='auth')task={...task,error:{code:'AUTH_REQUIRED'}};
    else if(reason==='refund')task={...task,status:'failed',error:{code:'IMAGE_UNDELIVERED_REFUNDED',refunded:true}};
    await time.advance(reason==='deadline'?IMAGE_RECOVERY_WINDOW_MS:IMAGE_RECOVERY_INTERVAL_MS);
    assert.equal(queries,0);assert.equal(time.timers.size,0);stop();
  }
});

test('uncertain tasks pause while offline and resume on reconnect without overlapping or extending their original recovery deadline',async()=>{
  const time=clock(),connectivity=new EventTarget();let online=false,queries=0;
  const task={...pending(time.now()),route:'buytoken',error:{code:'IMAGE_SUBMISSION_UNKNOWN',recovery_confirmed:false}};
  const stop=startImageTaskRecovery({...time,connectivity,isOnline:()=>online,readTask:()=>task,query:async()=>{queries++;}});
  await time.advance(IMAGE_RECOVERY_INTERVAL_MS);assert.equal(queries,0);assert.equal(time.timers.size,0);
  online=true;connectivity.dispatchEvent(new Event('online'));
  await time.advance(IMAGE_RECOVERY_INTERVAL_MS);assert.equal(queries,1);
  online=false;connectivity.dispatchEvent(new Event('offline'));
  await time.advance(IMAGE_RECOVERY_INTERVAL_MS);assert.equal(queries,1);assert.equal(time.timers.size,0);
  await time.advance(IMAGE_RECOVERY_WINDOW_MS);
  online=true;connectivity.dispatchEvent(new Event('online'));
  await time.advance(IMAGE_RECOVERY_INTERVAL_MS);assert.equal(queries,1);assert.equal(time.timers.size,0);
  stop();
});

test('disposing an offline recovery prevents online events from restarting it',async()=>{
  const time=clock(),connectivity=new EventTarget();let online=false,queries=0;
  const task={...pending(time.now()),error:{code:'IMAGE_SUBMISSION_UNKNOWN'}};
  const stop=startImageTaskRecovery({...time,connectivity,isOnline:()=>online,readTask:()=>task,query:async()=>{queries++;}});
  stop();online=true;connectivity.dispatchEvent(new Event('online'));
  await time.advance(IMAGE_RECOVERY_INTERVAL_MS);assert.equal(queries,0);assert.equal(time.timers.size,0);
});
