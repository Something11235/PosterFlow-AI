import assert from 'node:assert/strict';
import test from 'node:test';
import { canvasEffectiveControls, canvasGenerationQuote, canvasGenerationQuoteDetails, canvasGenerationSettings, canvasModelCapabilities, canvasModelOptions, queryCanvasGeneration, submitCanvasGeneration, validateCanvasInputs } from '../src/lib/creationCanvasGeneration.js';
import { APIMART_IMAGE_MODELS, IMAGE_MODEL_OPTIONS } from '../src/lib/provider.js';
import { VIDEO_MODELS } from '../src/lib/studioCatalog.js';
import { defaultVideoForModel, videoQuote } from '../src/lib/video.js';

const requestId = 'bad413b2-480b-479c-8859-f541d73af135';
const context = { authenticated: true, authHeaders: { Authorization: 'Bearer example' } };
const reply = (body, status = 200) => Response.json(body, { status });

const ownImage = (endpoint, model) => ({ ...context, billingMode: 'own_key', imageModel: model, providerHeaders: {
  ...context.authHeaders, 'X-Provider-Api-Key': 'configured-image-key', 'X-Provider-Endpoint': endpoint,
  'X-Provider-Model': model, 'X-Provider-Auth-Type': 'bearer', 'X-Billing-Mode': 'own_key',
} });
const idList = options => options.map(({ value }) => value);

test('each image node exposes the actual reference and resolution limits and sends the selected ratio', async t => {
  const bodies = [];
  t.mock.method(globalThis,'fetch',async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return reply({job:{status:'processing'}});
  });
  for (const spec of IMAGE_MODEL_OPTIONS) {
    const caps = canvasModelCapabilities('image',spec.value);
    assert.equal(caps.maxImages,spec.maxReferences);
    const selected = spec.resolutions.at(-1);
    const params = {resolution:selected,size:'portrait_9_16'};
    const options = {kind:'image',model:spec.value,context,params};
    const result = await submitCanvasGeneration({...options,requestId,prompt:'风景'});
    assert.equal(result.status,'pending',spec.value);
    const b = bodies.at(-1);
    assert.equal(b.size, params.size);
    assert.equal(b.count,1);
    assert.equal(b.resolution, spec.automaticResolution ? undefined : selected);
    assert.throws(() => validateCanvasInputs(canvasGenerationSettings(options),[{kind:'audio'}]),/不支持/);
    assert.throws(() => validateCanvasInputs(canvasGenerationSettings(options),Array.from({length:spec.maxReferences+1}, () => ({kind:'image'}))),/支持/);
  }
});

test('video controls honor family-specific resolution, duration, workflow, watermark and aspect constraints', () => {
  const get = (model,params) => canvasGenerationSettings({kind:'video',context,model,params}).params;
  assert.equal(get('seedance-2.0',{resolution:'4k',duration:15}).resolution,'4k');
  assert.throws(() => get('seedance-2.0-fast',{resolution:'4k'}),/清晰度/);
  assert.throws(() => get('seedance-2-5-flash',{duration:31}),/时长/);
  const edit = get('seedance-2-5-flash',{omni_reference_task_type:'edit',size:'9:16',duration:4});
  assert.deepEqual([edit.duration,edit.size],[-1,'adaptive']);
  assert.equal(get('seedance-2.5',{workflow:'draft',resolution:'720p'}).resolution,'480p');
  assert.equal(get('flux-3-video',{workflow:'draft',resolution:'fhd',safety_tolerance:0}).resolution,'hd');
  assert.equal(get('flux-3-video',{aspect_ratio:'2:1'}).aspect_ratio,'2:1');
  assert.equal(get('gemini-omni-1.1-flash',{aspect_ratio:'9:16',resolution:'4k'}).duration,undefined);
  assert.throws(() => get('MiniMax-H3-Max',{duration:4}),/时长/);
  assert.equal(get('MiniMax-H3',{duration:4,resolution:'2k'}).duration,4);
  assert.equal(get('wan3.0-video',{duration:2,link_url:'https://public.example/page'}).duration,2);
  assert.ok(!canvasModelCapabilities('video','MiniMax-H3-Max',{resolution:'1080p'}).controls.some(c => c.key==='watermark'));
});

test('effective control values match source-dependent overrides without discarding the saved values',()=>{
  const options={kind:'video',model:'seedance-2.5',context,params:{duration:20,size:'9:16'}};
  const settings=canvasGenerationSettings(options);
  const byKey=refs=>Object.fromEntries(canvasEffectiveControls(settings,refs).map(c=>[c.key,c]));
  const empty=byKey([]);
  assert.equal(empty.duration.disabled,false);assert.equal(empty.duration.effectiveValue,20);
  const first=byKey([{kind:'image'}]);
  assert.equal(first.size.disabled,true);assert.deepEqual(idList(first.size.options),['adaptive']);
  const clip=byKey([{kind:'video',duration_ms:9000}]);
  assert.equal(clip.size.disabled,true);
  assert.equal(clip.duration.disabled,true);
  assert.deepEqual(idList(clip.duration.options),[-1]);
  assert.equal(clip.duration.effectiveValue,-1);
  assert.deepEqual([settings.params.duration,settings.params.size],[20,'9:16']);
  assert.equal(byKey([]).size.effectiveValue,'9:16');
  const own=ownImage('https://api.apimart.ai/v1/images/generations','gpt-image-2.6-flare');
  const direct=canvasGenerationSettings({kind:'image',context:own});
  assert.deepEqual(canvasEffectiveControls(direct).find(c=>c.key==='resolution').options,[{value:'1K',label:'1K'}]);
  assert.ok(idList(canvasEffectiveControls(direct).find(c=>c.key==='size').options).includes('portrait_2_3'));
  const custom=canvasGenerationSettings({kind:'image',context:ownImage('https://my.example/v1/images/generations','custom-model')});
  assert.deepEqual(custom.params,{});
  assert.deepEqual(canvasEffectiveControls(custom),[]);
});

test('all video models can generate from text alone with no uploads and selected nondefault parameters remain on the wire', async t => {
  const calls=[];
  t.mock.method(globalThis,'fetch',async (url,init) => {
    assert.equal(url,'/api/video/generations');
    calls.push(JSON.parse(init.body));
    return reply({job:{status:'processing'}});
  });
  for (const {id:model} of VIDEO_MODELS.filter(m=>m.available)) {
    const caps=canvasModelCapabilities('video',model);
    const res=caps.controls.find(c=>c.key==='resolution').options.at(-1).value;
    const duration=caps.controls.find(c=>c.key==='duration')?.options.at(-1).value;
    const settings=canvasGenerationSettings({kind:'video',model,context,params:{resolution:res,...duration&&{duration}}});
    const r=await submitCanvasGeneration({...settings,context,requestId,prompt:'日出'});
    assert.equal(r.status,'pending',model + ' ' + r.message);
    const {parameters,references}=calls.at(-1);
    assert.deepEqual(references,[]);
    assert.equal(parameters.resolution,res);
    assert.equal(parameters.duration,duration);
    assert.equal(parameters.prompt,'日出');
  }
});

test('video modes preserve ordered frame roles, multi-image charges, verified durations and quote agreement before dispatch',async t=>{
  const posts=[];
  const source=(kind,index=1)=>({kind,url:`https://media.example/${index}.${kind==='video'?'mp4':'png'}`,name:`${index}.${kind==='video'?'mp4':'png'}`,...kind==='video'&&{duration_ms:6000}});
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const b=JSON.parse(init.body);
    if(url.endsWith('/references/import-url')){
      const video=b.filename.endsWith('.mp4');
      return reply({reference:{id:b.filename,kind:video?'video':'image',receipt:'receipt-'+b.filename,width:1024,height:576,size:1024,...video&&{duration_ms:6000}}});
    }
    assert.equal(url,'/api/video/generations');posts.push(b);return reply({job:{status:'processing'}});
  });
  const images=Array.from({length:3},(_,i)=>source('image',i));
  const frames={kind:'video',model:'seedance-2-5-flash',params:{imageMode:'frames',duration:17,output_format:'mov',generate_audio:false},context,requestId,prompt:'窗外'};
  assert.equal((await submitCanvasGeneration({...frames,references:images.slice(0,2)})).status,'pending');
  assert.deepEqual(posts.at(-1).references.map(r=>r.role),['first_frame','last_frame']);
  assert.equal(posts.at(-1).parameters.output_format,'mov');
  assert.equal(posts.at(-1).parameters.generate_audio,false);
  assert.equal(posts.at(-1).parameters.duration,17);
  const normal={...frames,model:'MiniMax-H3-Max',params:{imageMode:'reference',duration:10}};
  const price=canvasGenerationQuote({...normal,referenceInfo:images});
  assert.ok(price>canvasGenerationQuote({...normal,referenceInfo:images.slice(0,2)}));
  assert.equal((await submitCanvasGeneration({...normal,references:images,expectedCredits:price})).status,'pending');
  assert.deepEqual(posts.at(-1).references.map(r=>r.receipt),images.map(r=>'receipt-'+r.name));
  assert.equal(posts.at(-1).references[0].role,undefined);
  const edit={...frames,model:'seedance-2.5',params:{omni_reference_task_type:'edit',resolution:'720p'}};
  const ref=source('video');
  const cost=canvasGenerationQuoteDetails({...edit,referenceInfo:[ref]});
  assert.ok(cost.reservedCredits>=cost.credits);
  await submitCanvasGeneration({...edit,references:[ref],expectedCredits:cost.credits});
  assert.equal(posts.at(-1).parameters.duration,-1);
  assert.deepEqual(posts.at(-1).references,[{receipt:'receipt-1.mp4'}]);
  const count=posts.length;
  assert.equal((await submitCanvasGeneration({...edit,references:[ref],expectedCredits:1})).status,'failed');
  assert.equal((await submitCanvasGeneration({...edit,references:[ref],expectedCredits:cost.credits,expectedReservedCredits:1})).status,'failed');
  assert.equal(posts.length,count);
  assert.throws(()=>canvasGenerationQuote({...edit,referenceInfo:[{kind:'video'}]}),/时长/);
  validateCanvasInputs(canvasGenerationSettings(edit),[],{partial:true});
  assert.throws(()=>validateCanvasInputs(canvasGenerationSettings(edit),[]),/至少需要一段视频/);
  assert.throws(()=>validateCanvasInputs(canvasGenerationSettings(frames),images),/首尾帧/);
});

test('Wan connects document, audio and video references in order; excessive combined durations stop before a paid request',async t=>{
  const calls=[];
  const refs=[{kind:'document',name:'slides.pdf'},{kind:'audio',name:'theme.wav',duration_ms:4200},{kind:'video',name:'shot.mp4',duration_ms:6100}]
    .map(item=>({...item,url:'https://media.example/'+item.name}));
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const body=JSON.parse(init.body);
    if(url.endsWith('/references/import-url')){
      const r=refs.find(item=>item.name===body.filename);
      return reply({reference:{...r,id:r.name,receipt:'receipt-'+r.name,size:1024,width:768,height:512,pages:r.kind==='document'?1:null}});
    }
    calls.push(body);
    return reply({job:{status:'processing'}});
  });
  const options={kind:'video',model:'wan3.0-video',context,params:{size:'9:16',duration:17,audio:false},prompt:'解说这段素材',requestId};
  const expectedCredits=canvasGenerationQuote({...options,referenceInfo:refs});
  const result=await submitCanvasGeneration({...options,references:refs,expectedCredits});
  assert.equal(result.status,'pending',result.message);
  assert.equal(calls[0].parameters.audio,false);
  assert.equal(calls[0].parameters.size,'9:16');
  assert.deepEqual(calls[0].references,refs.map(r=>({receipt:'receipt-'+r.name})));
  const long=await submitCanvasGeneration({...options,params:{duration:30},references:refs});
  assert.equal(long.status,'failed');
  assert.equal(calls.length,1);
});

test('uses reference-aware pricing and the same defaults at quote and submission', () => {
  assert.equal(canvasGenerationQuote({ kind: 'image', context }), 1);
  assert.equal(canvasGenerationQuote({ kind: 'image', referenceCount: 1, context }), 1.5);
  assert.equal(canvasGenerationQuote({ kind: 'video', context }), 11);
  assert.equal(canvasGenerationQuote({ kind: 'video', billingMode: 'own_key', context }), 0);
  assert.equal(canvasGenerationSettings({ kind: 'video', context }).model, 'seedance-2.5');
});

test('image selectors use the platform catalog or only the configured service and its known models', () => {
  const [first, next] = IMAGE_MODEL_OPTIONS;
  assert.deepEqual(idList(canvasModelOptions('image', context)), idList(IMAGE_MODEL_OPTIONS));
  const apimart = ownImage('https://api.apimart.ai/v1/images/generations', next.value);
  assert.deepEqual(idList(canvasModelOptions('image', apimart)), idList(APIMART_IMAGE_MODELS));
  assert.equal(canvasGenerationSettings({ kind: 'image', context: apimart }).model, next.value);
  const buytoken = ownImage('https://api.buytoken.work/v1/images/generations', first.value);
  assert.deepEqual(idList(canvasModelOptions('image', buytoken)), IMAGE_MODEL_OPTIONS.filter(m => /^gpt-image-2\.[56]-/.test(m.value)).map(m => m.value));
  const custom = ownImage('https://custom.example.test/v1/images/generations', 'my-unique-alias');
  assert.deepEqual(canvasModelOptions('image', custom), [{ value: 'my-unique-alias', label: 'my-unique-alias' }]);
  assert.throws(() => canvasGenerationSettings({ kind: 'image', context: custom, model: next.value }));
  assert.ok(!JSON.stringify(canvasGenerationSettings({ kind: 'image', context: custom })).includes('configured-image-key'));
});

test('switching image models keeps the original service and key; recovery never reuses a key across services', async t => {
  const initial = ownImage('https://api.apimart.ai/v1/images/generations', 'seedream-5-5');
  const saved = canvasGenerationSettings({ kind: 'image', context: initial, model: 'gemini-nano-banana-2.1' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const h = new Headers(init.headers);
    calls.push([url, init.method || 'GET', h.get('X-Provider-Model'), h.get('X-Provider-Endpoint'), h.get('X-Provider-Api-Key')]);
    return reply({ job: { status: 'processing' } });
  });
  assert.equal((await submitCanvasGeneration({ kind: 'image', ...saved, context: initial, prompt: '落日下的湖泊', requestId })).status, 'pending');
  assert.equal((await queryCanvasGeneration({ kind: 'image', ...saved, context: initial, requestId })).status, 'pending');
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [
    ['/api/apimart-images/generations', 'POST'], [`/api/apimart-images/tasks/${requestId}`, 'GET'],
  ]);
  for (const call of calls) assert.deepEqual(call.slice(2), [saved.model, initial.providerHeaders['X-Provider-Endpoint'], 'configured-image-key']);
  const other = ownImage('https://another.example.test/images', saved.model);
  const otherResult = await queryCanvasGeneration({ kind: 'image', ...saved, context: other, requestId });
  assert.match(otherResult.message, /原来/);
  const legacy = { ...saved }; delete legacy.providerOrigin;
  const oldResult = await queryCanvasGeneration({ kind: 'image', ...legacy, context: initial, requestId });
  assert.match(oldResult.message, /原来/);
  assert.equal(calls.length, 2);
});

test('each platform image submits to its normal adapter; text-only models reject a reference before any upload', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({ url, body: JSON.parse(init.body), mode: headers.get('X-Billing-Mode'), key: headers.get('X-Provider-Api-Key') });
    return reply({ job: { status: 'processing' } });
  });
  const frame = new Blob(['ref'], { type: 'image/png' });
  for (const spec of IMAGE_MODEL_OPTIONS) {
    const run = { kind: 'image', model: spec.value, requestId, context, prompt: '湖心的小船' };
    if (spec.maxReferences === 0) {
      const before = calls.length;
      assert.match((await submitCanvasGeneration({ ...run, references: [frame] })).message, /仅支持文字/);
      assert.equal(calls.length, before);
    }
    const result = await submitCanvasGeneration(run);
    assert.equal(result.status, 'pending', spec.value);
    const { url, body, mode, key } = calls.at(-1);
    assert.equal(url, spec.provider === 'buytoken' ? '/api/buytoken-images/generations'
      : spec.value.startsWith('gpt-image-2.5-') ? '/api/generate' : '/api/apimart-images/generations');
    assert.equal(body.platform_model, spec.value);
    assert.equal(body.resolution, spec.automaticResolution ? undefined : spec.resolutions[0]);
    assert.equal(mode, 'platform');
    assert.equal(key, null);
  }
  assert.equal(calls.length, IMAGE_MODEL_OPTIONS.length);
});

test('every active video adapter quotes and submits one image using its actual frame and duration contract', async t => {
  const models = idList(canvasModelOptions('video', context));
  assert.deepEqual(models, VIDEO_MODELS.filter(m => m.available).map(m => m.id));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({ url, model: headers.get('X-Video-Model'), key: headers.get('X-Video-Api-Key'), body: init.body && JSON.parse(init.body) });
    if (url.endsWith('/references/import-url')) return reply({ reference: {
      id: 'frame.jpg', receipt: 'verified', kind: 'image', width: 800, height: 600, size: 1024,
    } });
    return reply({ job: { status: 'processing' } });
  });
  for (const model of models) {
    const settings = canvasGenerationSettings({ kind: 'video', context, model });
    const defaults = defaultVideoForModel(model);
    assert.equal(settings.duration, defaults.duration);
    assert.equal(settings.resolution, defaults.resolution);
    const run = { kind: 'video', requestId, context, ...settings };
    const result = await submitCanvasGeneration({ ...run, prompt: '海面上的日出', references: [{ url: 'https://media.example.test/start.jpg' }] });
    assert.equal(result.status, 'pending', model + ': ' + result.message);
    const { url, body, model: headerModel, key } = calls.at(-1);
    assert.equal(url, '/api/video/generations');
    assert.equal(headerModel, model);
    assert.equal(key, null);
    assert.equal(body.parameters.model, model);
    assert.equal(body.parameters.duration, defaults.duration);
    assert.deepEqual(body.references, model === 'flux-3-video' ? [{ receipt: 'verified' }] : [{ receipt: 'verified', role: 'first_frame' }]);
    assert.equal(body.parameters.return_last_frame, Object.hasOwn(defaults, 'return_last_frame') ? true : undefined);
    if (model === 'gemini-omni-1.1-flash') assert.equal(body.parameters.task, 'auto');
    assert.equal(canvasGenerationQuote(run), Number(videoQuote(body.parameters).text));
    const recovered = await queryCanvasGeneration({ ...run, context: { ...context, videoConnection: {
      model: 'some-other-model', mode: 'own_key', key: 'other-video-kept-private',
    } } });
    assert.equal(recovered.status, 'pending');
    assert.equal(calls.at(-1).url, `/api/video/tasks/${requestId}`);
    assert.equal(calls.at(-1).model, model);
    assert.equal(calls.at(-1).key, null);
  }
  assert.equal(calls.filter(call => call.url.endsWith('/generations')).length, models.length);
});

test('custom video service lists its selected model, and blocks recovery after an endpoint change', async t => {
  const own = { ...context, videoConnection: { mode: 'own_key', key: 'video-private', endpoint: 'https://movies.example.test/v1/videos/generations', model: 'MiniMax-H3' } };
  assert.deepEqual(idList(canvasModelOptions('video', own)), ['MiniMax-H3']);
  const settings = canvasGenerationSettings({ kind: 'video', context: own });
  assert.equal(settings.model, 'MiniMax-H3');
  assert.equal(canvasGenerationQuote({ kind: 'video', ...settings, context: own }), 0);
  t.mock.method(globalThis, 'fetch', () => assert.fail('no request should be sent when the provider changed'));
  for (const patch of [{ endpoint: 'https://different.example.test/generations' }, { queryTemplate: 'https://different.example.test/tasks/{task_id}' }]) {
    const current = { ...context, videoConnection: { ...own.videoConnection, ...patch } };
    const result = await queryCanvasGeneration({ kind: 'video', requestId, ...settings, context: current });
    assert.equal(result.status, 'pending');
    assert.match(result.message, /原来/);
  }
});

test('refresh only reads the original request, including ambiguous and refunded results', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init.method || 'GET']);
    if (url.startsWith('/api/video/')) return reply({ job: { status: 'processing' } });
    return reply({ job: { status: 'failed', billing_status: 'refunded' } });
  });
  assert.equal((await queryCanvasGeneration({ kind: 'video', requestId, context })).status, 'pending');
  const stored = canvasGenerationSettings({ kind: 'image', context });
  const terminal = await queryCanvasGeneration({ kind: 'image', requestId, context: { ...context, billingMode: 'own_key' }, ...stored });
  assert.equal(terminal.status, 'failed');
  assert.match(terminal.message, /退回/);
  assert.deepEqual(calls, [[`/api/video/tasks/${requestId}`, 'GET'], [`/api/buytoken-images/tasks/${requestId}`, 'GET']]);
});

test('a legacy snapshot without a billing mode never picks up the key from the active image settings', async t => {
  const current = ownImage('https://api.apimart.ai/v1/images/generations', 'seedream-5-5');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init.method || 'GET', new Headers(init.headers).get('X-Provider-Api-Key')]);
    return reply({ status: 'processing' });
  });
  await queryCanvasGeneration({ kind: 'image', model: 'gpt-image-2.5-flare', requestId, context: current });
  assert.deepEqual(calls, [[`/api/generations/${requestId}`, 'GET', null]]);
});

test('an unreadable original task never becomes a new submission', async t => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.method || 'GET', 'GET');
    return reply({ error: '未找到', code: 'IMAGE_TASK_NOT_FOUND' }, 404);
  });
  const result = await queryCanvasGeneration({ kind: 'image', requestId, context });
  assert.equal(result.status, 'pending');
});

test('a cancelled preparation cannot start a paid generation on either route', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async url => {
    paths.push(url);
    return reply({ reference: { id: 'r', kind: 'image', width: 768, height: 512, receipt: 'owner-receipt' } });
  });
  for (const kind of ['image', 'video']) {
    const result = await submitCanvasGeneration({ kind, requestId, context, prompt: '画面',
      references: kind === 'video' ? [{ url: 'https://example.invalid/frame.png' }] : [],
      beforeDispatch: async () => { throw new Error('此准备已取消。'); } });
    assert.equal(result.status, 'failed');
  }
  assert.deepEqual(paths, ['/api/video/references/import-url']);
});

test('connected reference and prompt are sent once and the received image is retained as a reusable Blob', async t => {
  const previousWindow = globalThis.window;
  globalThis.window = Object.assign(new EventTarget(), { location: new URL('https://studio.example.test') });
  t.after(() => { if (previousWindow) globalThis.window = previousWindow; else delete globalThis.window; });
  const signedUrl = 'https://storage.example.test/upload';
  const mediaUrl = 'https://storage.example.test/frame';
  const paid = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === '/api/reference-upload-url') return reply({ path: 'references/owned.png', signed_url: signedUrl });
    if (url === signedUrl) return new Response(null, { status: 200 });
    if (url === '/api/reference-cleanup') return reply({ success: true });
    if (url === '/api/buytoken-images/generations') {
      paid.push(JSON.parse(init.body));
      assert.equal(new Headers(init.headers).get('X-Request-Id'), requestId);
      return reply({ job: { status: 'completed' }, images: [{ filename: 'canvas-img.png' }] });
    }
    if (url === '/api/images/canvas-img.png/url') return reply({ url: mediaUrl, expires_in: 100 });
    assert.equal(url, mediaUrl);
    return new Response(new Uint8Array([137,80,78,71]), { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  const progress = [];
  const result = await submitCanvasGeneration({ kind: 'image', requestId, context, references: [new Blob(['ref'], { type: 'image/png' })], prompt: '片头分镜',
    onUploadProgress: event => progress.push(event) });
  assert.equal(result.status, 'completed');
  assert.equal(result.blob.type, 'image/png');
  assert.equal(progress.at(-1).stage, 'complete');
  assert.equal(progress.at(-1).fraction, 1);
  assert.deepEqual(paid.map(body => [body.prompt, body.request_id, body.reference_storage_paths]), [['片头分镜', requestId, ['references/owned.png']]]);
});

test('video can reuse a CDN frame as its first frame when the browser cannot read it', async t => {
  const frame = 'https://media.example.test/frame.png';
  const video = 'https://media.example.test/shot.mp4';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(url);
    if (url === '/api/video/references/import-url') {
      assert.deepEqual(JSON.parse(init.body), { url: frame, filename: 'last-frame.png' });
      return reply({ reference: { id: 'r', kind: 'image', width: 768, height: 512, receipt: 'owner-receipt' } });
    }
    if (url === '/api/video/generations') {
      const body = JSON.parse(init.body);
      assert.equal(body.request_id, requestId);
      assert.equal(body.parameters.prompt, '转身看向镜头');
      assert.equal(body.parameters.return_last_frame, true);
      assert.deepEqual(body.references, [{ receipt: 'owner-receipt', role: 'first_frame' }]);
      return reply({ job: { status: 'submitted' } });
    }
    if (url === `/api/video/tasks/${requestId}`) return reply({ job: { status: 'completed', billing_status: 'settled' }, videos: [{ url: video, last_frame_url: frame }] });
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers, undefined);
    throw new TypeError('CDN does not permit CORS');
  });
  assert.equal((await submitCanvasGeneration({ kind: 'video', requestId, context, references: [{ url: frame }], prompt: '转身看向镜头' })).status, 'pending');
  const result = await queryCanvasGeneration({ kind: 'video', requestId, context });
  assert.equal(result.status, 'completed');
  assert.equal(result.lastFrameUrl, frame);
  assert.equal(result.url, video);
  assert.equal(result.blob, undefined);
  assert.equal(calls.filter(url => url.endsWith('/generations')).length, 1);
});
