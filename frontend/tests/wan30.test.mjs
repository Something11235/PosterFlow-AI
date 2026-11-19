import test from 'node:test';
import assert from 'node:assert/strict';
import {WAN30,defaultWan30} from '../src/lib/wan30.js';
import {buildVideoParameters,videoQuote,videoReferenceInput,videoFile,restoreVideoHistory,validateVideoReferenceDuration} from '../src/lib/video.js';
import {VIDEO_MODELS} from '../src/lib/studioCatalog.js';
const base=()=>({...defaultWan30(),prompt:'镜头推进'});
const ref=(kind,id,extra={})=>({id,kind,size:1024,width:240,height:240,duration_ms:1000,receipt:'proof-'+id,...extra});
const ready=(reference,role)=>({id:reference.id,kind:reference.kind,state:'ready',reference,role});
test('Wan uses its own parameters, exact half-credit quotes and model order',()=>{
 for(const [resolution,estimated,reserved] of [['480p','4','6'],['720p','7.5','12'],['1080p','15','23.5']]){
  const body=buildVideoParameters({...base(),resolution,audio:false,seed:0,generate_audio:true,return_last_frame:true});
  assert.equal(videoQuote(body).text,estimated);assert.equal(videoQuote(body).reservedText,reserved);
  assert.equal(body.audio,false);assert.equal(body.seed,0);assert.equal(Object.hasOwn(body,'generate_audio'),false);assert.equal(Object.hasOwn(body,'return_last_frame'),false);
  assert.deepEqual(buildVideoParameters(restoreVideoHistory({parameters:body})),body);
 }
 assert.equal(VIDEO_MODELS.filter(m=>m.available)[8].id,WAN30);assert.equal(VIDEO_MODELS.find(m=>m.id==='flux-3-video').available,true);
 for(const patch of [{duration:1},{duration:31},{duration:3.5},{size:'21:9'},{seed:-1},{resolution:'2k'}])assert.throws(()=>buildVideoParameters({...base(),...patch}));
 assert.equal(videoQuote({...base(),resolution:'720p',duration:-1},[ref('video','v',{duration_ms:15000})]).text,'44');
});
test('Wan supports one-second audio alone and enforces the combined thirty-second budget',()=>{
 assert.deepEqual(videoReferenceInput([ready(ref('audio','a'))],'unified',WAN30,{...base(),prompt:''}),[{receipt:'proof-a'}]);
 validateVideoReferenceDuration(1,WAN30);assert.throws(()=>validateVideoReferenceDuration(.999,WAN30));
 assert.throws(()=>videoReferenceInput([ready(ref('video','v',{duration_ms:15000}))],'unified',WAN30,{...base(),duration:16}));
 assert.throws(()=>videoReferenceInput([ready(ref('image','i'),'last_frame')],'unified',WAN30,base()));
 assert.throws(()=>videoReferenceInput([ready(ref('image','i'),'first_frame'),ready(ref('audio','a'))],'unified',WAN30,base()));
 assert.throws(()=>videoReferenceInput([ready(ref('image','i',{has_alpha:true}))],'unified',WAN30,base()));
});
test('documents are Wan-only, 100MB, up to fifty pages, exclusive with webpages and frames',()=>{
 assert.equal(videoFile({name:'slides.pptx',size:100*1024*1024},WAN30),'document');
 assert.throws(()=>videoFile({name:'slides.pptx',size:1024},'MiniMax-H3'));
 assert.throws(()=>videoFile({name:'slides.pptx',size:100*1024*1024+1},WAN30));
 assert.equal(videoFile({name:'photo.bmp',size:20*1024*1024},WAN30),'image');
 const doc=ready(ref('document','d',{pages:50}));
 assert.deepEqual(videoReferenceInput([doc],'unified',WAN30,{...base(),prompt:''}),[{receipt:'proof-d'}]);
 assert.throws(()=>videoReferenceInput([doc],'unified',WAN30,{...base(),link_url:'https://fixture.invalid/article'}));
 assert.throws(()=>videoReferenceInput([ready(ref('document','d',{pages:51}))],'unified',WAN30,base()));
 assert.equal(buildVideoParameters({...base(),link_url:'https://fixture.invalid/article'}).link_url,'https://fixture.invalid/article');
 assert.throws(()=>buildVideoParameters({...base(),link_url:'http://localhost/a'}));
});
