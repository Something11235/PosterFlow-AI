import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVideoParameters,videoQuote,videoReferenceInput,restoreVideoHistory,setVideoFrameRole} from '../src/lib/video.js';
import {defaultSeedance25} from '../src/lib/seedance25.js';
import {VIDEO_MODELS} from '../src/lib/studioCatalog.js';

test('2.5 uploaded videos require explicit intent before submission and editing preserves source constraints',()=>{
 const values={...defaultSeedance25(),prompt:'fixture',duration:8};
 const items=[{id:'v',kind:'video',state:'ready',reference:{id:'v',kind:'video',duration_ms:8000,receipt:'proof-v'}}];
 assert.throws(()=>videoReferenceInput(items,'unified','seedance-2.5',values),/明确选择/);
 assert.equal(values.duration,8);
 assert.equal(videoReferenceInput(items,'unified','seedance-2.5',{...values,omni_reference_task_type:'reference'}).length,1);
 assert.throws(()=>videoReferenceInput(items,'unified','seedance-2.5',{...values,omni_reference_task_type:'edit'}),/自动时长/);
 const edit={...values,omni_reference_task_type:'edit',duration:-1};
 assert.equal(buildVideoParameters(edit).duration,-1);
 assert.equal(videoReferenceInput(items,'unified','seedance-2.5',edit).length,1);
 assert.throws(()=>videoReferenceInput([{...items[0],reference:{...items[0].reference,duration_ms:3000}}],'unified','seedance-2.5',edit),/4–30/);
 assert.throws(()=>videoReferenceInput([],'unified','seedance-2.5',edit),/至少需要/);
 assert.deepEqual(videoReferenceInput([],'unified','seedance-2.5',values),[]);
});

test('model order matches the roadmap and Mini, standard and 2.5 are available',()=>{
 assert.deepEqual(VIDEO_MODELS.map(m=>m.name),['Seedance 2.5','Seedance 2.0','Seedance 2.0 Fast','Seedance 2.0 Mini','Gemini Omni 1.1 Flash','MiniMax H3','MiniMax H3 Max','Wan 3.0','FLUX 3 Video']);
 assert.deepEqual(VIDEO_MODELS.filter(m=>m.available).map(m=>m.id),['seedance-2.5','seedance-2.0','seedance-2.0-fast','seedance-2.0-mini','gemini-omni-1.1-flash','MiniMax-H3','MiniMax-H3-Max','wan3.0-video','flux-3-video']);
});
test('2.5 quote uses half-credit units with a separate reservation and excludes audio duration',()=>{
 const v={...defaultSeedance25(),prompt:'clip'};
 assert.equal(videoQuote(v).text,'11');assert.equal(videoQuote(v).reservedText,'17');
 assert.equal(videoQuote(v,[{kind:'audio',duration_ms:3000}]).text,'11');
 assert.equal(videoQuote(v,[{kind:'video',duration_ms:3000}]).reservedText,'16.5');
 assert.equal(videoQuote({...v,workflow:'final',draft_request_id:'11111111-1111-4111-8111-111111111111'},[{kind:'video',duration_ms:3000}],{requested_duration:5}).reservedText,'95');
});
test('draft final inherits fields and restores safely without resending the prompt or files',()=>{
 const values={...defaultSeedance25(),prompt:'clip',workflow:'final',resolution:'1080p',seed:'0',draft_request_id:'11111111-1111-4111-8111-111111111111',watermark:true,output_format:'mov',api_key:'secret'};
 const body=buildVideoParameters(values);
 assert.deepEqual(Object.keys(body).sort(),['draft_request_id','model','output_format','resolution','return_last_frame','watermark']);
 assert.equal(body.output_format,'mov');assert.ok(!JSON.stringify(body).includes('secret'));
 const restored=restoreVideoHistory({parameters:{...defaultSeedance25(),prompt:'clip',draft:true}});
 assert.equal(restored.workflow,'draft');assert.equal(buildVideoParameters({...restored,workflow:'generate'}).draft,false);
});
test('2.5 audio-only and ordinary role images work while Mini keeps its existing stricter rules',()=>{
 const ready=(kind,id,extra={})=>({id,kind,state:'ready',reference:{id,kind,width:512,height:512,receipt:'proof-'+id,duration_ms:3000,...extra}});
 assert.deepEqual(videoReferenceInput([ready('audio','a')],'reference','seedance-2.5'),[{receipt:'proof-a'}]);
 assert.throws(()=>videoReferenceInput([ready('audio','a')],'reference'),/搭配/);
 const images=[ready('image','1'),ready('image','2'),ready('image','3')];images[0].role='first_frame';images[1].role='last_frame';
 assert.deepEqual(videoReferenceInput(images,'frames','seedance-2.5').map(r=>r.role),['first_frame','last_frame','reference_image']);
 assert.throws(()=>videoReferenceInput(images,'frames'),/首尾帧/);
});
test('choosing an extra reference as the first frame keeps the last frame and demotes the former first frame',()=>{
 const items=[{id:'a',kind:'image',role:'first_frame'},{id:'b',kind:'image',role:'last_frame'},{id:'c',kind:'image'}];
 const changed=setVideoFrameRole(items,'c','first_frame');
 assert.deepEqual(changed.map(i=>i.role),['','last_frame','first_frame']);
});

test('unified references preserve individual image roles and prevent incompatible Mini requests without dropping files',()=>{
 const image=(id,role,extra={})=>({id,kind:'image',role,state:'ready',reference:{id,kind:'image',width:512,height:512,receipt:'proof-'+id,...extra}});
 const items=[image('a','first_frame'),image('b','last_frame')];
 assert.deepEqual(videoReferenceInput(items,'unified').map(r=>r.role),['first_frame','last_frame']);
 const mixed=[...items,{id:'v',kind:'video',state:'ready',reference:{id:'v',kind:'video',receipt:'proof-v',duration_ms:5000}}];
 assert.throws(()=>videoReferenceInput(mixed,'unified'),/2.0 系列/);
 assert.equal(mixed.length,3);
 assert.deepEqual(videoReferenceInput(mixed,'unified','seedance-2.5',{omni_reference_task_type:'reference'}).map(r=>r.role),['first_frame','last_frame',undefined]);
 assert.throws(()=>videoReferenceInput([image('a','reference_image')],'unified'),/审核/);
 assert.equal(videoReferenceInput([image('a','reference_image',{asset_url:'asset://owned'})],'unified')[0].asset_url,'asset://owned');
 assert.throws(()=>videoReferenceInput([image('a','reference_image',{asset_url:'asset://owned'}),image('b','')],'unified'),/不能与普通/);
 assert.equal(videoReferenceInput([image('a','')],'unified')[0].role,undefined);
});
