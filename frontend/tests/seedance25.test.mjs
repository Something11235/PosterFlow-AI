import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVideoParameters,videoFile,videoQuote,videoReferenceInput,restoreVideoHistory,setVideoFrameRole} from '../src/lib/video.js';
import {defaultSeedance25,seedance25DraftAvailable,SEEDANCE25_DRAFT_TTL_MS,SEEDANCE25_FLASH,seedance25EffectiveValues,seedance25AutoVideo} from '../src/lib/seedance25.js';
import {VIDEO_MODELS} from '../src/lib/studioCatalog.js';
const draftSource=extra=>({model:'seedance-2.5',is_draft:true,status:'completed',billing_status:'settled',provider_task_id:'task_draft_fixture',created_at:new Date().toISOString(),requested_duration:5,reference_duration_ms:0,...extra});

test('Flash preserves its own model, supported options and history without sending draft fields',()=>{
  const values={...defaultSeedance25(SEEDANCE25_FLASH),prompt:'镜头向前移动',output_format:'mov',return_last_frame:true,watermark:true,web_search:true};
  const body=buildVideoParameters(values);
  assert.equal(body.model,'seedance-2-5-flash');
  assert.equal(body.resolution,'720p');
  assert.equal(body.draft,undefined);
  assert.equal(body.draft_request_id,undefined);
  assert.deepEqual(buildVideoParameters(restoreVideoHistory({parameters:body})),body);
  for(const settings of [{workflow:'draft'},{workflow:'final'},{duration:31},{size:'2:1'},{resolution:'1080p'}]){
    assert.throws(()=>buildVideoParameters({...values,...settings}));
  }
});

test('Flash estimates all four price tiers, 30s automatic output and independent reservation rounding',()=>{
  const values=defaultSeedance25(SEEDANCE25_FLASH);
  for(const [resolution,videoMs,expected,reserved] of [
    ['480p',0,'7','11.5'],['480p',4000,'8','12.5'],
    ['720p',0,'16','25.5'],['720p',4000,'17.5','28'],
  ]){
    const refs=[{kind:'audio',duration_ms:10000}];
    if(videoMs)refs.push({kind:'video',duration_ms:videoMs});
    const quote=videoQuote({...values,resolution},refs);
    assert.deepEqual([quote.text,quote.reservedText],[expected,reserved]);
  }
  assert.equal(videoQuote({...values,duration:-1}).generatedSeconds,30);
});

test('Flash enforces reference counts, frame roles, reference duration and file limits',()=>{
  const model=SEEDANCE25_FLASH,values=defaultSeedance25(model);
  const refs=(kind,count,ms=2000)=>Array.from({length:count},(_,i)=>({
    id:String(i),kind,state:'ready',reference:{id:String(i),kind,duration_ms:ms,width:640,height:640,receipt:'r'+i}
  }));
  for(const [kind,max] of [['image',10],['video',5],['audio',5]]){
    assert.equal(videoReferenceInput(refs(kind,max),'unified',model,values).length,max);
    assert.throws(()=>videoReferenceInput(refs(kind,max+1),'unified',model,values),/最多/);
  }
  assert.throws(()=>videoReferenceInput(refs('document',1),'unified',model,values),/移除其他类型/);
  assert.throws(()=>videoReferenceInput(refs('audio',5,6100),'unified',model,values),/30 秒/);
  const edit={...values,omni_reference_task_type:'edit',duration:-1};
  assert.throws(()=>videoReferenceInput(refs('video',1),'unified',model,edit),/4–30/);
  assert.equal(videoReferenceInput(refs('video',1,4000),'unified',model,edit).length,1);
  const [frame]=refs('image',1);
  assert.throws(()=>videoReferenceInput([{...frame,role:'last_frame'}],'unified',model,values),/首帧/);
  assert.throws(()=>videoReferenceInput([{...frame,role:'first_frame'}],'unified',model,{...values,size:'16:9'}),/自适应/);
  const mib=1024*1024;
  assert.equal(videoFile({name:'scene.tiff',size:30*mib-1},model),'image');
  assert.throws(()=>videoFile({name:'scene.jpg',size:30*mib},model));
  assert.equal(videoFile({name:'clip.mp4',size:200*mib},model),'video');
  assert.throws(()=>videoFile({name:'voice.wav',size:15*mib+1},model));
});

test('final Seedance quote includes original input video and three-day source eligibility',()=>{
 const values={...defaultSeedance25(),workflow:'final',draft_request_id:'11111111-1111-4111-8111-111111111111'};
 const source=draftSource({requested_duration:11,reference_duration_ms:22000});
 const q=videoQuote(values,[],source);assert.equal(q.text,'233');assert.equal(q.reservedText,'373');assert.equal(q.referenceSeconds,22);
 const auto=videoQuote(values,[],{...source,requested_duration:-1});assert.equal(auto.text,'367');assert.equal(auto.reservedText,'587.5');
 const now=Date.now(),limit=now-SEEDANCE25_DRAFT_TTL_MS;
 assert.ok(seedance25DraftAvailable({...source,created_at:new Date(limit+1).toISOString()},now));
 assert.equal(seedance25DraftAvailable({...source,created_at:new Date(limit).toISOString()},now),false);
 for(const bad of [{created_at:'invalid'},{created_at:new Date(now-4*86400000).toISOString()},{model:'flux-3-video'},{is_draft:false},{billing_status:'awaiting_balance'},{reference_duration_ms:null},{reference_duration_ms:30001},{provider_task_id:null}])assert.equal(seedance25DraftAvailable({...source,...bad},now),false);
 assert.throws(()=>videoQuote(values,[],{...source,created_at:new Date(now-4*86400000).toISOString()}),/3 天/);
 const nonFinal={...values,workflow:'generate',prompt:'fixture',duration:5,resolution:'480p'};
 assert.equal(videoQuote(nonFinal,[]).text,'11');
});

test('2.5 native auto with video uses compatible constraints and manual editing preserves source constraints',()=>{
 const values={...defaultSeedance25(),prompt:'fixture',duration:8};
 const items=[{id:'v',kind:'video',state:'ready',reference:{id:'v',kind:'video',duration_ms:8000,receipt:'proof-v'}}];
 assert.throws(()=>videoReferenceInput(items,'unified','seedance-2.5',values),/自动时长/);
 assert.equal(values.duration,8);
 const automatic=seedance25EffectiveValues(values,true);
 assert.equal(automatic.duration,-1);assert.equal(automatic.size,'adaptive');assert.equal(automatic.omni_reference_task_type,'auto');
 assert.equal(videoReferenceInput(items,'unified','seedance-2.5',automatic).length,1);
 assert.equal(buildVideoParameters(automatic).duration,-1);
 assert.equal(videoQuote(automatic,items.map(i=>i.reference)).text,'48.5');
 assert.equal(videoQuote(automatic,items.map(i=>i.reference)).reservedText,'77.5');
 assert.throws(()=>videoReferenceInput([{...items[0],reference:{...items[0].reference,duration_ms:3000}}],'unified','seedance-2.5',automatic),/4–30/);
 assert.equal(videoReferenceInput(items,'unified','seedance-2.5',{...values,omni_reference_task_type:'reference'}).length,1);
 assert.throws(()=>videoReferenceInput(items,'unified','seedance-2.5',{...values,omni_reference_task_type:'edit'}),/自动时长/);
 const edit={...values,omni_reference_task_type:'edit',duration:-1};
 assert.equal(buildVideoParameters(edit).duration,-1);
 assert.equal(videoReferenceInput(items,'unified','seedance-2.5',edit).length,1);
 assert.throws(()=>videoReferenceInput([{...items[0],reference:{...items[0].reference,duration_ms:3000}}],'unified','seedance-2.5',edit),/4–30/);
 assert.throws(()=>videoReferenceInput([],'unified','seedance-2.5',edit),/至少需要/);
 assert.deepEqual(videoReferenceInput([],'unified','seedance-2.5',values),[]);
});

test('automatic video constraints preserve the original fixed settings and never rewrite other workflows or models',()=>{
 const original={...defaultSeedance25(),prompt:'Replace a person in the source video',duration:8,size:'16:9'};
 const effective=seedance25EffectiveValues(original,true);
 assert.equal(effective.prompt,original.prompt);assert.equal(effective.omni_reference_task_type,'auto');
 assert.equal(original.duration,8);assert.equal(original.size,'16:9');
 for(const values of [{...original,omni_reference_task_type:'reference'},{...original,omni_reference_task_type:'edit'},{...original,omni_reference_task_type:'extend'},{...original,workflow:'final'}, {...original,model:'seedance-2.0-mini'}]){
   assert.equal(seedance25EffectiveValues(values,true),values);assert.equal(seedance25AutoVideo(values,true),false);
 }
 assert.equal(seedance25EffectiveValues(original,false),original);
 assert.equal(seedance25AutoVideo({...original,workflow:'generate',draft_request_id:'stale-choice'},true),true);
});

test('model order matches the roadmap and Mini, standard and 2.5 are available',()=>{
 assert.deepEqual(VIDEO_MODELS.map(m=>m.name),['Seedance 2.5','Seedance 2.5 Flash','Seedance 2.0','Seedance 2.0 Fast','Seedance 2.0 Mini','Gemini Omni 1.1 Flash','MiniMax H3','MiniMax H3 Max','Wan 3.0','FLUX 3 Video']);
 assert.deepEqual(VIDEO_MODELS.filter(m=>m.available).map(m=>m.id),['seedance-2.5','seedance-2-5-flash','seedance-2.0','seedance-2.0-fast','seedance-2.0-mini','gemini-omni-1.1-flash','MiniMax-H3','MiniMax-H3-Max','wan3.0-video','flux-3-video']);
});
test('2.5 quote uses half-credit units with a separate reservation and excludes audio duration',()=>{
 const v={...defaultSeedance25(),prompt:'clip'};
 assert.equal(videoQuote(v).text,'11');assert.equal(videoQuote(v).reservedText,'17');
 assert.equal(videoQuote(v,[{kind:'audio',duration_ms:3000}]).text,'11');
 assert.equal(videoQuote(v,[{kind:'video',duration_ms:3000}]).reservedText,'16.5');
 assert.equal(videoQuote({...v,workflow:'final',draft_request_id:'11111111-1111-4111-8111-111111111111'},[{kind:'video',duration_ms:3000}],draftSource()).reservedText,'95');
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
