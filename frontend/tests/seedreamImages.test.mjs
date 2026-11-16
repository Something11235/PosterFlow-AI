import test from 'node:test';
import assert from 'node:assert/strict';
import {APIMART_IMAGE_MODELS,IMAGE_MODEL_OPTIONS,apimartImageModel,imageCreditCost,loadProviderConfig,buildImageTaskProviderHeaders} from '../src/lib/provider.js';
import {imageGenerationFetch,readImageTask} from '../src/lib/apimartImages.js';
import {canvasEditCapability,canvasReferenceError,interactiveEditInstructions} from '../src/lib/canvasImageEditing.js';

test('Seedream order and fixed output pricing stay independent of reference count and resolution',()=>{
  assert.deepEqual(APIMART_IMAGE_MODELS.slice(-3).map(m=>m.value),['seedream-5-5','seedream-5-0-pro','seedream-5-0-flash']);
  for(const [model,price] of [['seedream-5-0-pro',2],['seedream-5-0-flash',0.5]])for(const refs of [0,1,8])for(const res of apimartImageModel(model).resolutions)assert.equal(imageCreditCost(model,refs,res),price + (model==='seedream-5-0-pro' && res==='2K' ? 0.5 : 0));
  assert.equal(apimartImageModel('gemini-nano-banana-2.1').maxCount,1);
});
test('retired Lite has no creation entry; Pro and Flash still use interactive marking',()=>{
  assert.equal(apimartImageModel('seedream-5-0-lite'),undefined);
  assert.equal(IMAGE_MODEL_OPTIONS.some(model=>model.value==='seedream-5-0-lite'),false);
  assert.equal(canvasEditCapability('seedream-5-0-lite').kind,'disabled');
  assert.ok(canvasReferenceError('seedream-5-0-lite',1,0));
  for(const model of ['seedream-5-0-pro','seedream-5-0-flash'])assert.equal(canvasEditCapability(model).kind,'interactive');
});

test('retired Lite saved config requires selection and blocks platform and own-key paid requests',async t=>{
  const previousWindow=global.window, previousFetch=global.fetch;
  t.after(()=>{global.window=previousWindow;global.fetch=previousFetch;});
  global.window={sessionStorage:{getItem:()=>JSON.stringify({model:'seedream-5-0-lite',endpoint:'https://example.invalid',apiKey:'synthetic'})}};
  let calls=0;
  global.fetch=async()=>{calls++;throw new Error('must not submit');};
  const migrated=loadProviderConfig();
  assert.equal(migrated.model,'');assert.equal(migrated.apiKey,'synthetic');
  const queryHeaders=buildImageTaskProviderHeaders(migrated,'seedream-5-0-lite');
  assert.equal(queryHeaders['X-Provider-Model'],'seedream-5-0-lite');
  assert.equal(queryHeaders['X-Provider-Api-Key'],'synthetic');
  assert.equal(migrated.model,'');
  assert.equal(buildImageTaskProviderHeaders({...migrated,apiKey:''},'seedream-5-0-lite'),null);
  assert.equal(buildImageTaskProviderHeaders(migrated,'seedream-5-0-pro'),null);
  for(const headers of [{'X-Billing-Mode':'platform'},{'X-Billing-Mode':'own_key','X-Provider-Model':'seedream-5-0-lite'}]){
    const response=await imageGenerationFetch('/api/generate',{method:'POST',headers,body:JSON.stringify({platform_model:'seedream-5-0-lite'})});
    assert.equal(response.status,400);assert.equal((await response.json()).code,'MODEL_RETIRED');
  }
  assert.equal(calls,0);
});

test('retired Lite history can still query its original task using GET only',async t=>{
  const previous=global.fetch;t.after(()=>{global.fetch=previous;});
  const urls=[];
  global.fetch=async(url,init)=>{urls.push(url);assert.equal(init.method,undefined);return new Response(JSON.stringify({success:true,job:{model:'seedream-5-0-lite',status:'completed'},images:[{filename:'old.png'}]}));};
  const result=await readImageTask('old-task',{'X-Billing-Mode':'platform'},undefined,'seedream-5-0-lite','apimart');
  assert.deepEqual(urls,['/api/apimart-images/tasks/old-task']);
  assert.equal(result.images[0].filename,'old.png');
});
test('interactive edit coordinates refer to the main picture and clip outside marks',()=>{
 const target={getBoundingRect:()=>({left:100,top:50,width:400,height:200})};
 const mark={posterflowType:'annotation-shape',getBoundingRect:()=>({left:50,top:100,width:250,height:200})};
 assert.equal(interactiveEditInstructions(target,[mark]),'<bbox>0 250 500 1000</bbox>');
 assert.equal(interactiveEditInstructions(target,[{...mark,posterflowType:'annotation-text'}]),'');
});
