import test from 'node:test';
import assert from 'node:assert/strict';
import {MINIMAX_H3,defaultMinimaxH3} from '../src/lib/minimaxH3.js';
import {buildVideoParameters,videoQuote,videoReferenceInput,restoreVideoHistory,videoFile} from '../src/lib/video.js';
import {VIDEO_MODELS,buildStudioDraft} from '../src/lib/studioCatalog.js';

const image=(id,extra={})=>({id,kind:'image',size:1024,width:256,height:256,receipt:'proof-'+id,...extra});
const video=(extra={})=>({id:'v',kind:'video',size:1024,width:854,height:480,duration_ms:3000,fps:24,codec:'avc1',audio_codecs:['mp4a'],receipt:'proof-v',...extra});
const ready=(ref,role)=>({id:ref.id,kind:ref.kind,state:'ready',reference:ref,role});

test('H3 has independent parameters, exact pricing, named model position and preserved history',()=>{
  const base={...defaultMinimaxH3(),prompt:'镜头推进'};
  for(const [resolution,estimated,reserved] of [['768p','6.5','10.5'],['2k','10.5','16.5']]){
    const values={...base,resolution,seed:1,generate_audio:false,return_last_frame:true,web_search:true,apiKey:'SENTINEL'};
    const body=buildVideoParameters(values);assert.deepEqual(Object.keys(body).sort(),['model','prompt','duration','resolution','size','watermark','nsfw_check'].sort());
    assert.equal(videoQuote(values).text,estimated);assert.equal(videoQuote(values).reservedText,reserved);
    assert.deepEqual(buildVideoParameters(restoreVideoHistory({parameters:body})),body);
    assert.equal(JSON.stringify(buildStudioDraft('video',values)).includes('SENTINEL'),false);
  }
  const refs=[...Array.from({length:9},(_,i)=>image(String(i))),video()];
  assert.equal(videoQuote({...base,resolution:'768p'},refs).text,'12.5');
  assert.equal(videoQuote({...base,resolution:'768p'},refs).extraImages,4);
  assert.equal(VIDEO_MODELS.filter(m=>m.available)[6].id,MINIMAX_H3);
  assert.equal(VIDEO_MODELS.find(m=>m.id==='flux-3-video').available,true);
  for(const patch of [{prompt:''},{prompt:'字'.repeat(7001)},{duration:3},{duration:16},{resolution:'720p'}])assert.throws(()=>buildVideoParameters({...base,...patch}));
});
test('H3 prevents incompatible media before submitting while preserving explicit image roles',()=>{
  const refs=[ready(image('a'),'first_frame'),ready(image('b'),'last_frame')];
  assert.deepEqual(videoReferenceInput(refs,'unified',MINIMAX_H3),[{receipt:'proof-a',role:'first_frame'},{receipt:'proof-b',role:'last_frame'}]);
  assert.deepEqual(videoReferenceInput([ready(image('a')),ready(image('b'))],'unified',MINIMAX_H3),[{receipt:'proof-a'},{receipt:'proof-b'}]);
  for(const bad of [[...refs,ready(video())],[...refs,ready(image('c'))],[ready(video({fps:12}))],
    [ready(video({audio_codecs:['opus']}))],[ready(image('a',{width:255}))],
    [ready({id:'a',kind:'audio',size:1024,duration_ms:3000})],
    [ready(image('a',{asset_url:'asset://owned'}))],[ready(image('a',{size:30*1024*1024+1}))]])assert.throws(()=>videoReferenceInput(bad,'unified',MINIMAX_H3));
  assert.equal(videoFile({name:'picture.heic',size:30*1024*1024},MINIMAX_H3),'image');
  assert.throws(()=>videoFile({name:'picture.heic',size:1024},'seedance-2.5'));
  assert.throws(()=>videoFile({name:'sound.wav',size:15*1024*1024+1},MINIMAX_H3));
});
