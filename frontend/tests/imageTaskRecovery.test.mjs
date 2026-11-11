import assert from 'node:assert/strict';
import test from 'node:test';
import { createImageTaskStore, getCompletedImageTask, syncImageTaskSelection } from '../src/lib/imageTasks.js';
import { canAutoQueryImageTask, startImageTaskRecovery, IMAGE_RECOVERY_INTERVAL_MS, IMAGE_RECOVERY_WINDOW_MS } from '../src/lib/imageTaskRecovery.js';
import { imageJobMetadata } from '../src/lib/apimartImages.js';

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

test('only confirmed APIMart platform waiting tasks qualify within the bounded recovery window', () => {
  const now=Date.now(), task=pending(now);
  assert.equal(canAutoQueryImageTask(task,now),true);
  assert.equal(canAutoQueryImageTask(task,now+IMAGE_RECOVERY_WINDOW_MS-1),true);
  assert.equal(canAutoQueryImageTask(task,now+IMAGE_RECOVERY_WINDOW_MS),false);
  for (const change of [{route:'buytoken'},{billingMode:'own_key'},{active:true},{status:'completed'},
    {error:{code:'IMAGE_SUBMISSION_UNKNOWN'}},{createdAt:now+1},{createdAt:NaN}]) {
    assert.equal(canAutoQueryImageTask({...task,...change},now),false);
  }
  for (const status of ['submitting','submission_unknown']) {
    const metadata = imageJobMetadata({request_id:'original',status,created_at:new Date(now).toISOString(),billing_mode:'platform'},'apimart');
    assert.equal(metadata.error.code,'IMAGE_SUBMISSION_UNKNOWN');
    assert.equal(canAutoQueryImageTask(metadata,now),false);
  }
  for (const status of ['submitted','processing']) {
    const metadata = imageJobMetadata({request_id:'original',status,created_at:new Date(now).toISOString(),billing_mode:'platform'},'apimart');
    assert.equal(canAutoQueryImageTask(metadata,now),true);
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

test('switching the selected task, losing ownership, reaching the time limit or becoming unknown stops recovery', async () => {
  for(const reason of ['selection','owner','deadline','unknown']){
    const time=clock();let task=pending(time.now()),queries=0;
    const stop=startImageTaskRecovery({...time,readTask:()=>task,query:async()=>{queries++;}});
    if(reason==='selection'||reason==='owner')task=null;
    else if(reason==='unknown')task={...task,error:{code:'IMAGE_SUBMISSION_UNKNOWN'}};
    await time.advance(reason==='deadline'?IMAGE_RECOVERY_WINDOW_MS:IMAGE_RECOVERY_INTERVAL_MS);
    assert.equal(queries,0);assert.equal(time.timers.size,0);stop();
  }
});
