import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSeedance20,seedance20Quote} from '../src/lib/seedance20.js';
import {buildVideoParameters,videoQuote,restoreVideoHistory,videoReferenceInput,defaultVideo} from '../src/lib/video.js';
import {defaultSeedance25} from '../src/lib/seedance25.js';
import {VIDEO_MODELS} from '../src/lib/studioCatalog.js';

test('standard model uses four resolutions and 4000 codepoints without exposing 2.5-only operations',()=>{
 for(const resolution of ['480p','720p','1080p','4k']){
  const body=buildVideoParameters({...defaultSeedance20(),resolution,prompt:'创'.repeat(4000),seed:'0',draft:true,api_key:'private',workflow:'draft'});
  assert.equal(body.model,'seedance-2.0');assert.equal(body.resolution,resolution);assert.equal(body.seed,0);
  assert.equal(body.draft,undefined);assert.equal(body.api_key,undefined);assert.equal(body.workflow,undefined);
  assert.equal(restoreVideoHistory({parameters:body}).model,'seedance-2.0');
 }
 assert.throws(()=>buildVideoParameters({...defaultSeedance20(),prompt:'x'.repeat(4001)}),/4000/);
 for(const duration of [-1,3,16])assert.throws(()=>buildVideoParameters({...defaultSeedance20(),duration}),/4–15/);
});

test('standard quotes use twenty percent and video-only duration while previous prices and ordering persist',()=>{
 for(const [resolution,expected,reserved] of [['480p','7.5','12'],['720p','16','25.5'],['1080p','39.5','63'],['4k','80','128']]){
  const q=seedance20Quote({...defaultSeedance20(),resolution});assert.equal(q.text,expected);assert.equal(q.reservedText,reserved);
 }
 const v={...defaultSeedance20(),resolution:'480p'},a={kind:'audio',duration_ms:3000};
 assert.equal(videoQuote(v,[a]).text,'7.5');assert.equal(videoQuote(v,[{kind:'video',duration_ms:3000},a]).reservedText,'11.5');
 assert.equal(videoQuote(defaultVideo()).text,'2.5');assert.equal(videoQuote(defaultSeedance25()).text,'11');
 assert.deepEqual(VIDEO_MODELS.slice(0,5).map(m=>m.id),['seedance-2.5','seedance-2-5-flash','seedance-2.0','seedance-2.0-fast','seedance-2.0-mini']);
 assert.equal(VIDEO_MODELS[1].available,true);assert.equal(VIDEO_MODELS[2].available,true);
});

test('standard rejects invalid old receipts and frame plus audio without dropping selected materials',()=>{
 const ready=(kind,id,extra={})=>({id,kind,state:'ready',reference:{id,kind,receipt:'proof-'+id,width:512,height:512,duration_ms:3000,...extra}});
 const frames=[{...ready('image','i'),role:'first_frame'},ready('audio','a')];
 assert.throws(()=>videoReferenceInput(frames,'unified','seedance-2.0'),/首尾帧/);assert.equal(frames.length,2);
 assert.throws(()=>videoReferenceInput([ready('image','i',{width:299})],'unified','seedance-2.0'),/300–6000/);
 assert.throws(()=>videoReferenceInput([ready('image','i'),ready('audio','a',{duration_ms:1000})],'unified','seedance-2.0'),/2–15/);
});
