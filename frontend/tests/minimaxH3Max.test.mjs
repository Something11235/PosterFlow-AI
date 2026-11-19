import test from 'node:test';
import assert from 'node:assert/strict';
import {MINIMAX_H3_MAX,defaultMinimaxH3} from '../src/lib/minimaxH3.js';
import {buildVideoParameters,videoQuote,restoreVideoHistory,videoReferenceInput,videoFile} from '../src/lib/video.js';
import {VIDEO_MODELS} from '../src/lib/studioCatalog.js';
import {usageBillingLabel} from '../src/lib/adminUsage.js';

const image=i=>({id:String(i),kind:'image',size:1024,width:256,height:384,receipt:'proof-'+i});
const video={id:'v',kind:'video',size:1024,width:854,height:480,duration_ms:3000,fps:24,codec:'avc1',audio_codecs:[],receipt:'proof-v'};
const base=()=>({...defaultMinimaxH3(MINIMAX_H3_MAX),prompt:'镜头缓缓推进'});

test('Max has exact name/order, three resolutions, five-second minimum and its own prices',()=>{
  assert.equal(VIDEO_MODELS.filter(m=>m.available)[7].id,MINIMAX_H3_MAX);
  assert.equal(VIDEO_MODELS.find(m=>m.id==='flux-3-video').available,true);
  assert.equal(base().resolution,'768p');
  for(const [resolution,estimated,reserved] of [['480p','4.5','7'],['768p','6.5','10.5'],['1080p','14.5','23']]){
    const body=buildVideoParameters({...base(),resolution});
    assert.equal(videoQuote(body).text,estimated);assert.equal(videoQuote(body).reservedText,reserved);
    assert.deepEqual(buildVideoParameters(restoreVideoHistory({parameters:body})),body);
    assert.equal(Object.hasOwn(body,'watermark'),resolution!=='1080p');
  }
  for(const patch of [{duration:4},{duration:16},{duration:5.5},{resolution:'2k'},{resolution:'720p'},{prompt:''},{prompt:'字'.repeat(7001)}])assert.throws(()=>buildVideoParameters({...base(),...patch}));
  assert.equal(usageBillingLabel({kind:'video',model:MINIMAX_H3_MAX,billing_mode:'platform'}),'实际用量结算');
});
test('1080P entirely omits watermark, even when a previous resolution had it enabled',()=>{
  for(const watermark of [true,false]){
    const body=buildVideoParameters({...base(),resolution:'1080p',watermark,nsfw_check:true,seed:10,generate_audio:false,return_last_frame:true});
    assert.deepEqual(Object.keys(body).sort(),['model','prompt','duration','resolution','size'].sort());
  }
  assert.equal(buildVideoParameters({...base(),watermark:true}).watermark,true);
  assert.equal(buildVideoParameters({...base(),resolution:'480p',watermark:true}).watermark,true);
});
test('Max charges reference video at its own rate, first two images free, audio free',()=>{
  const refs=[image(1),image(2),image(3),video];
  assert.equal(videoQuote(base(),refs).text,'15');assert.equal(videoQuote(base(),refs).reservedText,'24');
  assert.equal(videoQuote(base(),refs).extraImages,1);
  assert.equal(videoQuote(base(),refs.concat({id:'a',kind:'audio',size:1024,duration_ms:15000})).text,'15');
  assert.equal(videoQuote(base(),refs.slice(0,2)).text,'6.5');
  const ready=(ref,role)=>({id:ref.id,kind:ref.kind,state:'ready',reference:ref,role});
  assert.deepEqual(videoReferenceInput([ready(image(1),'last_frame')],'unified',MINIMAX_H3_MAX),[{receipt:'proof-1',role:'last_frame'}]);
  assert.throws(()=>videoReferenceInput([ready(image(1),'first_frame'),ready(video)],'unified',MINIMAX_H3_MAX));
  assert.throws(()=>videoReferenceInput([ready({...video,fps:12})],'unified',MINIMAX_H3_MAX));
  assert.equal(videoFile({name:'portrait.heif',size:1024},MINIMAX_H3_MAX),'image');
});
