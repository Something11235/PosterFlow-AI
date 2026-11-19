import test from 'node:test';
import assert from 'node:assert/strict';
import {SEEDANCE20_FAST,defaultSeedance20} from '../src/lib/seedance20.js';
import {buildVideoParameters,videoQuote,restoreVideoHistory,videoReferenceInput,defaultVideo} from '../src/lib/video.js';
import {defaultSeedance25} from '../src/lib/seedance25.js';
import {VIDEO_MODELS} from '../src/lib/studioCatalog.js';
import {usageBillingLabel} from '../src/lib/adminUsage.js';

test('Fast has its own ID, two resolutions, all shared controls and 4000-character bound',()=>{
 for(const resolution of ['480p','720p']){
  const body=buildVideoParameters({...defaultSeedance20(SEEDANCE20_FAST),resolution,prompt:'词'.repeat(4000),seed:'0',generate_audio:false,return_last_frame:true,web_search:true,nsfw_check:true});
  assert.equal(body.model,SEEDANCE20_FAST);assert.equal(body.seed,0);assert.equal(body.generate_audio,false);assert.deepEqual(body.tools,[{type:'web_search'}]);assert.equal(restoreVideoHistory({parameters:body}).model,SEEDANCE20_FAST);
 }
 for(const bad of [{resolution:'1080p'},{resolution:'4k'},{duration:3},{duration:16},{duration:-1},{prompt:'x'.repeat(4001)}])assert.throws(()=>buildVideoParameters({...defaultSeedance20(SEEDANCE20_FAST),...bad}));
});

test('Fast and standard quotes use 1.2; old Mini and 2.5 prices and model order persist',()=>{
 for(const [resolution,price,reserve] of [['480p','4.5','7.5'],['720p','9.5','15.5']]){const q=videoQuote({...defaultSeedance20(SEEDANCE20_FAST),resolution});assert.equal(q.text,price);assert.equal(q.reservedText,reserve);}
 const q=videoQuote({...defaultSeedance20(SEEDANCE20_FAST),resolution:'480p'},[{kind:'video',duration_ms:3000},{kind:'audio',duration_ms:3000}]);assert.equal(q.text,'4.5');assert.equal(q.reservedText,'7');
 assert.equal(videoQuote({...defaultSeedance20(),resolution:'480p'}).text,'7.5');assert.equal(videoQuote(defaultVideo()).text,'2.5');assert.equal(videoQuote(defaultSeedance25()).text,'11');
 assert.deepEqual(VIDEO_MODELS.filter(m=>m.available).map(m=>m.id),['seedance-2.5','seedance-2-5-flash','seedance-2.0','seedance-2.0-fast','seedance-2.0-mini','gemini-omni-1.1-flash','MiniMax-H3','MiniMax-H3-Max','wan3.0-video','flux-3-video']);assert.equal(VIDEO_MODELS.find(m=>m.id==='flux-3-video').available,true);
 assert.equal(usageBillingLabel({kind:'video',model:SEEDANCE20_FAST,billing_mode:'platform'}),'实际用量结算');
});

test('Fast blocks invalid receipts and incompatible roles without dropping references',()=>{
 const image={id:'i',kind:'image',role:'first_frame',state:'ready',reference:{id:'i',kind:'image',receipt:'proof-i',width:512,height:512}};
 const video={id:'v',kind:'video',state:'ready',reference:{id:'v',kind:'video',receipt:'proof-v',duration_ms:3000}};
 const refs=[image,video];assert.throws(()=>videoReferenceInput(refs,'unified',SEEDANCE20_FAST),/首尾帧/);assert.equal(refs.length,2);
});
