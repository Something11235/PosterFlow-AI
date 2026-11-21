import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { closedImageFailure, imageClientFailure, imageDiagnosticText, imageFailureTitle, imageQueryFailureMessage, readImageGenerationResult } from '../src/lib/imageGenerationError.js';
import { createImageTaskStore } from '../src/lib/imageTasks.js';
import { isPendingImageTaskError } from '../src/lib/imageTaskRecovery.js';
import { recoverGeneration } from '../src/lib/client.js';
import { uploadReferenceBlobs } from '../src/lib/referenceUpload.js';

const json = (data, status) => new Response(JSON.stringify(data), {status});

test('a missing or non-JSON generation response keeps the original task uncertain with the observed cause', async () => {
  for (const [response, diagnostic] of [
    [new Response('<html>sensitive gateway body</html>', {status:504}), 'HTTP_504'],
    [json({error:'Bad gateway'}, 502), 'HTTP_502'],
    [json({error:{code:'FUNCTION_INVOCATION_TIMEOUT'}}, 504), 'HTTP_504'],
    [json({code:'Gateway Error',error:{message:'Bad Gateway'}},502),'HTTP_502'],
    [json(null,200), 'RESPONSE_INVALID'], [json({images:[]},200), 'RESPONSE_INVALID'],
  ]) {
    await assert.rejects(readImageGenerationResult(response), reason => {
      const error = imageClientFailure(reason,{started:true,billingMode:'platform'});
      assert.equal(error.diagnostic, diagnostic);
      assert.equal(error.code, 'IMAGE_SUBMISSION_UNKNOWN');
      assert.equal(isPendingImageTaskError(error), true);
      assert.doesNotMatch(JSON.stringify(error), /sensitive|Bad gateway|INVOCATION_TIMEOUT/);
      return true;
    });
  }
  for (const [status,code] of [[401,'AUTH_REQUIRED'],[403,'ACCESS_DENIED']]) {
    const error=await readImageGenerationResult(new Response('denied',{status}));
    assert.equal(error.code,code);
    assert.equal(isPendingImageTaskError(error),false);
  }
  const rejected={error:'积分不足',code:'INSUFFICIENT_CREDITS',generation_submitted:false};
  assert.deepEqual(await readImageGenerationResult(json(rejected,402)),rejected);
  const ok={images:[{filename:'done.png'}]};
  assert.deepEqual(await readImageGenerationResult(json(ok,200)),ok);
});

test('a lost connection during reference upload is distinguished from a lost generation receipt', async t => {
  t.mock.method(globalThis,'fetch',async()=>new Response('<html>invalid gateway page</html>',{status:503}));
  const upload=uploadReferenceBlobs([{blob:new Blob(['x'],{type:'image/png'}),name:'local.png'}]);
  await assert.rejects(upload, reason => {
    const failure=imageClientFailure(reason,{started:false,uploadingReferences:true,billingMode:'platform'});
    assert.equal(failure.diagnostic_phase,'reference');
    assert.equal(failure.diagnostic,'HTTP_503');
    assert.equal(isPendingImageTaskError(failure),false);
    return true;
  });
  const nativeAbort=new DOMException('aborted','AbortError');
  assert.equal(imageClientFailure(nativeAbort,{started:true}).diagnostic,'WAIT_INTERRUPTED');
  assert.equal(imageClientFailure(new TypeError('Failed to fetch'),{started:true}).diagnostic,'CONNECTION_INTERRUPTED');
  assert.equal(imageClientFailure(new Error('internal application error'),{started:true}).diagnostic,'RESULT_UNCONFIRMED');
  assert.equal(imageClientFailure(new Error('internal application error'),{started:false}).diagnostic_phase,'preparation');
  assert.match(imageQueryFailureMessage({status:404,code:'IMAGE_TASK_NOT_FOUND'}),/查不到该编号/);
  assert.match(imageQueryFailureMessage({status:503,code:'IMAGE_DATABASE_UNAVAILABLE'}),/查询原任务时，暂时无法访问图片任务记录。.*503/);
  assert.doesNotMatch(imageQueryFailureMessage({status:403}),/恢复网络/);
  assert.match(imageQueryFailureMessage({status:503,code:'AUTH_VERIFY_UNAVAILABLE'}),/验证服务暂时不可用/);
});

test('archived historic offline errors are neutral and transport metadata contains no response bodies', () => {
  let saved=JSON.stringify(['failed','pending'].map((status,index)=>({
    id:'old'+index,status,error:{code:'BACKEND_OFFLINE'},createdAt:Date.now(),billingMode:'platform',
  })));
  const storage={getItem:()=>saved,setItem:(_key,value)=>{saved=value;}};
  const restored=createImageTaskStore(3,'owner',{storage});
  assert.deepEqual(restored.getSnapshot().map(task=>task.error.code),['GENERATE_FAILED','IMAGE_SUBMISSION_UNKNOWN']);
  const task=restored.getSnapshot()[1];
  restored.finish(task.id,{pending:true,error:{...task.error,diagnostic:'HTTP_503',diagnostic_phase:'query',detail:'private provider response'}});
  const error=createImageTaskStore(3,'owner',{storage}).getSnapshot()[1].error;
  assert.match(imageDiagnosticText(error.diagnostic),/503/);
  assert.equal(error.diagnostic_phase,'query');
  assert.doesNotMatch(saved,/private provider response|BACKEND_OFFLINE/);
  assert.equal(imageDiagnosticText('signed URL'), '');
});

test('auth notices recommend refreshing before signing in, and distinguish a verification outage',()=>{
  for (const code of ['AUTH_REQUIRED','AUTH_TOKEN_INVALID','AUTH_SESSION_EXPIRED']) {
    const message=imageQueryFailureMessage({status:401,code});
    assert.match(message,/先刷新页面.*刷新后仍.*再重新登录/);
  }
  assert.doesNotMatch(imageQueryFailureMessage({status:503,code:'AUTH_VERIFY_UNAVAILABLE'}),/重新登录/);
});

test('GET recovery can return a confirmed terminal failure without turning it into a pending submission', async t => {
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url, init)=>{calls.push([url,init.method || 'GET']);return json({status:'failed',error_code:'IMAGE_PROVIDER_TIMEOUT',images:[]},200);});
  const result=await recoverGeneration('original',{includeTerminal:true});
  const failure=closedImageFailure(result,'platform');
  assert.equal(isPendingImageTaskError(failure), false);
  assert.match(imageFailureTitle(failure.code),/超时/);
  assert.equal(isPendingImageTaskError(closedImageFailure({error_code:'REQUEST_ALREADY_PROCESSED'},'platform')),false);
  assert.deepEqual(calls,[['/api/generations/original','GET']]);
  assert.equal(await recoverGeneration('original'),null);
});

test('gallery shows the observed cause and the action allowed for the actual task state', async t => {
  const server=await createServer({
    root:fileURLToPath(new URL('..',import.meta.url)), configFile:false, logLevel:'error',
    server:{middlewareMode:true,watch:null,ws:false}, optimizeDeps:{noDiscovery:true,include:[]}, appType:'custom',
  });
  t.after(()=>server.close());
  const {default:Gallery}=await server.ssrLoadModule('/src/components/Gallery.jsx');
  const scenarios=[
    [{code:'IMAGE_SUBMISSION_UNKNOWN',diagnostic:'HTTP_504',diagnostic_phase:'submission',submission_unknown:true},
      ['HTTP 504','查询原任务 · 找回图片'],['重新生成</button>','科学上网']],
    [{code:'IMAGE_TASK_PENDING',diagnostic:'HTTP_503',diagnostic_phase:'query'},['查询原任务时','HTTP 503'],['失败一般为以下原因']],
    [{code:'REFERENCE_UPLOAD_FAILED',diagnostic:'CONNECTION_INTERRUPTED',diagnostic_phase:'reference'},
      ['尚未提交','重新生成'],['查询原任务 · 找回图片']],
    [{code:'PROVIDER_REJECTED',message:'图片服务未接受本次请求',upstream_error:{message:'请求中的参数不受支持'}},
      ['图片服务返回的说明','请求中的参数不受支持'],['科学上网']],
    [{code:'AUTH_VERIFY_UNAVAILABLE',message:'登录验证服务暂时不可用'},['登录验证服务暂时不可用'],['失败一般为以下原因']],
    ...['AUTH_REQUIRED','AUTH_SESSION_EXPIRED','AUTH_TOKEN_INVALID'].map(code=>[
      {code,message:'旧版本：请重新登录',detail:'请立即重新登录',recovery:['重新生成']},
      ['请先刷新页面','刷新后仍提示需要登录，再重新登录','刷新页面</button>'],['旧版本','请立即重新登录','重新生成'],
    ]),
    [{code:'BUYTOKEN_REQUEST_REJECTED',refunded:true}, ['图片服务未接受本次请求','发起新生成'], ['失败一般为以下原因']],
    [{code:'GENERATE_FAILED'},['具体原因暂未确认','可排查以下情况'],['BACKEND_OFFLINE']],
    [{code:'IMAGE_UNDELIVERED_REFUNDED',refunded:true},['具体失败原因','预留积分已退回'],['BACKEND_OFFLINE']],
    ...['REQUEST_ALREADY_PROCESSED','IMAGE_TASK_PENDING','IMAGE_SAVE_PENDING'].map(code=>[
      {code, refunded:true,cause:'等待原任务处理'}, ['预留积分已退回','发起新生成'], ['正在确认','正在处理','正在保存','等待原任务处理'],
    ]),
  ];
  for (const [error,expected,unexpected] of scenarios) {
    const html=renderToStaticMarkup(React.createElement(Gallery,{images:[],billingMode:'platform',error,onQueryTask(){}}));
    for (const copy of expected) assert.ok(html.includes(copy),copy);
    for (const copy of unexpected) assert.ok(!html.includes(copy),copy);
  }
});
