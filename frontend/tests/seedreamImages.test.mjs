import test from 'node:test';
import assert from 'node:assert/strict';
import {APIMART_IMAGE_MODELS,apimartImageModel,imageCreditCost} from '../src/lib/provider.js';
import {canvasEditCapability,canvasReferenceError,interactiveEditInstructions} from '../src/lib/canvasImageEditing.js';

test('Seedream order and fixed output pricing stay independent of reference count and resolution',()=>{
  assert.deepEqual(APIMART_IMAGE_MODELS.slice(-3).map(m=>m.value),['seedream-5-0-pro','seedream-5-0-lite','seedream-5-0-flash']);
  for(const [model,price] of [['seedream-5-0-pro',2],['seedream-5-0-lite',1],['seedream-5-0-flash',0.5]])for(const refs of [0,1,8])for(const res of apimartImageModel(model).resolutions)assert.equal(imageCreditCost(model,refs,res),price + (model==='seedream-5-0-pro' && res==='2K' ? 0.5 : 0));
  assert.equal(apimartImageModel('gemini-nano-banana-2.1').maxCount,1);
});
test('Lite retains references but disables canvas editing; Pro and Flash use interactive marking',()=>{
  assert.equal(apimartImageModel('seedream-5-0-lite').maxReferences,8);
  assert.deepEqual(apimartImageModel('seedream-5-0-lite').resolutions,['2K','3K','4K']);
  assert.equal(canvasEditCapability('seedream-5-0-lite').kind,'disabled');
  assert.ok(canvasReferenceError('seedream-5-0-lite',1,0));
  for(const model of ['seedream-5-0-pro','seedream-5-0-flash'])assert.equal(canvasEditCapability(model).kind,'interactive');
});
test('interactive edit coordinates refer to the main picture and clip outside marks',()=>{
 const target={getBoundingRect:()=>({left:100,top:50,width:400,height:200})};
 const mark={posterflowType:'annotation-shape',getBoundingRect:()=>({left:50,top:100,width:250,height:200})};
 assert.equal(interactiveEditInstructions(target,[mark]),'<bbox>0 250 500 1000</bbox>');
 assert.equal(interactiveEditInstructions(target,[{...mark,posterflowType:'annotation-text'}]),'');
});
