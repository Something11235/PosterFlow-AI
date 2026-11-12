import assert from 'node:assert/strict';
import test from 'node:test';
import {createClient} from '@supabase/supabase-js';
import {createAuthProxyFetch,authErrorMessage} from '../src/lib/authTransport.js';

const project='https://project.supabase.co',origin='https://posterflow.example';
const json=(body,status=200,headers={})=>new Response(status===204?null:JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...headers}});

test('Auth Request inputs retain overridden bodies and headers while using only same-origin transport',async()=>{
  let captured;
  const proxy=createAuthProxyFetch(project,{origin,fetchImpl:async request=>{captured=request;return json({ok:true});}});
  const original=new Request(project+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-old'})});
  await proxy(original,{body:JSON.stringify({password:'synthetic-new'}),headers:{'Content-Type':'application/json','X-Supabase-Api-Version':'2024-01-01'}});
  assert.equal(captured.url,origin+'/api/auth/proxy/token?grant_type=refresh_token');
  assert.deepEqual(await captured.json(),{password:'synthetic-new'});
  assert.equal(captured.headers.get('X-Supabase-Api-Version'),'2024-01-01');
  assert.equal(captured.headers.get('X-Posterflow-Auth'),'1');
  assert.equal(captured.credentials,'omit');assert.equal(captured.cache,'no-store');assert.equal(captured.redirect,'error');
});

test('unsupported Auth paths are blocked and unrelated project/storage traffic is not rewritten',async()=>{
  const calls=[];
  const proxy=createAuthProxyFetch(project,{origin,fetchImpl:async(input,init)=>{calls.push([input,init]);return json({});}});
  assert.equal((await proxy(project+'/auth/v1/admin/users')).status,404);assert.equal(calls.length,0);
  for(const url of [project+'/storage/v1/object', 'https://other.supabase.co/auth/v1/token']) {
    await proxy(url,{method:'GET'});assert.equal(calls.at(-1)[0],url);
  }
});

test('timeouts or network failures never fall back or replay a signup request',async()=>{
  let calls=0;
  const proxy=createAuthProxyFetch(project,{origin,timeoutMs:5,fetchImpl:()=>{calls++;return new Promise(()=>{});}});
  await assert.rejects(proxy(project+'/auth/v1/signup',{method:'POST',body:'{}'}),/超时/);
  assert.equal(calls,1);
  const offline=createAuthProxyFetch(project,{origin,fetchImpl:async()=>{calls++;throw new TypeError('Failed to fetch');}});
  await assert.rejects(offline(project+'/auth/v1/signup',{method:'POST',body:'{}'}),/Failed to fetch/);assert.equal(calls,2);
});

test('the caller abort signal cancels the direct request without falling back',async()=>{
  const controller=new AbortController();let calls=0;
  const proxy=createAuthProxyFetch(project,{origin,fetchImpl:request=>{calls++;return new Promise((_,reject)=>request.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));}});
  const result=proxy(project+'/auth/v1/token?grant_type=password',{method:'POST',body:'{}',signal:controller.signal});
  controller.abort();await assert.rejects(result,{name:'AbortError'});assert.equal(calls,1);
});

test('credential and network failures have distinct Chinese messages without leaking raw details',()=>{
  assert.match(authErrorMessage({code:'invalid_credentials'}),/邮箱或密码错误/);
  assert.match(authErrorMessage({message:'Failed to fetch'}),/使用科学上网后刷新重试/);
  assert.match(authErrorMessage({name:'AuthRetryableFetchError'}),/暂时无法连接/);
  assert.match(authErrorMessage({code:'email_not_confirmed'}),/邮箱尚未验证/);
  assert.match(authErrorMessage({status:429}),/过于频繁/);
  assert.ok(!authErrorMessage({message:'private password or token detail'}).includes('private'));
});

test('installed Supabase SDK signs in, refreshes, reads user and logs out through the proxy with existing semantics',async()=>{
  const calls=[];
  const user={id:'11111111-1111-4111-8111-111111111111',aud:'authenticated',role:'authenticated',email:'fixture@example.invalid'};
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:user.id,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})+'.synthetic';
  const proxy=createAuthProxyFetch(project,{origin,fetchImpl:async request=>{
    calls.push({url:request.url,method:request.method,headers:Object.fromEntries(request.headers),body:request.method==='GET'?null:await request.clone().text()});
    if(new URL(request.url).origin===project)throw new TypeError('Failed to fetch');
    const path=new URL(request.url).pathname;
    if(path.endsWith('/logout'))return json(null,204);
    if(path.endsWith('/user'))return json(user);
    return json({access_token:token,refresh_token:'synthetic-refresh',token_type:'bearer',expires_in:3600,user});
  }});
  const client=createClient(project,'sb_publishable_fixture',{global:{fetch:proxy},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const login=await client.auth.signInWithPassword({email:user.email,password:'synthetic-only'});
  assert.equal(login.error,null);assert.equal(login.data.user.id,user.id);
  assert.equal((await client.auth.refreshSession()).error,null);
  assert.equal((await client.auth.getUser()).data.user.id,user.id);
  assert.equal((await client.auth.signOut()).error,null);
  assert.deepEqual(calls.map(call=>new URL(call.url).pathname.split('/').at(-1)),['token','token','token','user','user','logout']);
  assert.equal(new URL(calls[0].url).searchParams.get('grant_type'),'password');
  assert.equal(new URL(calls[2].url).searchParams.get('grant_type'),'refresh_token');
  assert.ok([1,2,4,5].every(index=>calls[index].url.startsWith(origin+'/api/auth/proxy/')));
  assert.ok(calls.every(call=>call.headers['x-supabase-api-version']==='2024-01-01'));
  assert.equal(calls[4].headers.authorization,'Bearer '+token);
});

test('successful direct password and user requests do not use the proxy',async()=>{
  const calls=[];
  const transport=createAuthProxyFetch(project,{origin,fetchImpl:async request=>{calls.push(request.url);return json({ok:true});}});
  await transport(project+'/auth/v1/token?grant_type=password',{method:'POST',body:'{}'});
  await transport(project+'/auth/v1/user');
  assert.deepEqual(calls,[project+'/auth/v1/token?grant_type=password',project+'/auth/v1/user']);
});

test('a direct password connection failure falls back once with exactly the original body',async()=>{
  const calls=[];
  const transport=createAuthProxyFetch(project,{origin,fetchImpl:async request=>{
    calls.push({url:request.url,body:await request.text()});
    if(calls.length===1)throw new TypeError('Failed to fetch');
    return json({ok:true});
  }});
  assert.equal((await transport(project+'/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email:'fixture@example.invalid',password:'synthetic-only'})})).status,200);
  assert.equal(calls.length,2);assert.equal(calls[0].body,calls[1].body);
  assert.equal(calls[1].url,origin+'/api/auth/proxy/token?grant_type=password');
});

test('direct timeout falls back once and proxy failure does not start another route',async()=>{
  const calls=[];
  const transport=createAuthProxyFetch(project,{origin,directTimeoutMs:5,timeoutMs:20,fetchImpl:async request=>{
    calls.push(request.url);
    if(calls.length===1)return new Promise(()=>{});
    throw new TypeError('Failed to fetch');
  }});
  await assert.rejects(transport(project+'/auth/v1/token?grant_type=password',{method:'POST',body:'{}'}),/Failed to fetch/);
  assert.equal(calls.length,2);assert.ok(calls[1].startsWith(origin+'/api/auth/proxy/'));
});

test('credential, rate-limit and other HTTP rejections never trigger a fallback password POST',async()=>{
  for(const status of [400,401,403,429,503]) {
    let calls=0;
    const transport=createAuthProxyFetch(project,{origin,fetchImpl:async()=>{calls++;return json({code:'invalid_credentials'},status);}});
    assert.equal((await transport(project+'/auth/v1/token?grant_type=password',{method:'POST',body:'{}'})).status,status);
    assert.equal(calls,1);
  }
});

test('an already received HTTP rejection remains single-route even if its body breaks or stalls',async()=>{
  for(const status of [400,429])for(const stalled of [false,true]) {
    let calls=0;
    const transport=createAuthProxyFetch(project,{origin,directTimeoutMs:5,fetchImpl:async()=>{
      calls++;
      return {status,headers:new Headers(),text:()=>stalled?new Promise(()=>{}):Promise.reject(new TypeError('response body disconnected'))};
    }});
    await assert.rejects(transport(project+'/auth/v1/token?grant_type=password',{method:'POST',body:'{}'}));
    assert.equal(calls,1);
  }
});

test('mail, verification, logout and all non-password grants use the proxy once',async()=>{
  const calls=[];
  const transport=createAuthProxyFetch(project,{origin,fetchImpl:async request=>{calls.push(request.url);return json({});}});
  for(const path of ['signup','recover','resend','verify','logout','token?grant_type=refresh_token','token?grant_type=pkce']) {
    await transport(project+'/auth/v1/'+path,{method:'POST',body:'{}'});
    assert.equal(calls.at(-1),origin+'/api/auth/proxy/'+path);
  }
  assert.equal(calls.length,7);
});

test('installed SDK signup and password-email requests stay same-origin, and credential errors retain their code',async()=>{
  const calls=[];let rejectCredentials=false;
  const proxy=createAuthProxyFetch(project,{origin,fetchImpl:async request=>{
    calls.push({url:request.url,body:await request.text()});
    if(rejectCredentials)return json({code:'invalid_credentials',msg:'Invalid login credentials'},400,{'X-Supabase-Api-Version':'2024-01-01'});
    if(new URL(request.url).pathname.endsWith('/signup'))return json({id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.invalid'});
    return json({});
  }});
  const client=createClient(project,'sb_publishable_fixture',{global:{fetch:proxy},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  assert.equal((await client.auth.signUp({email:'fixture@example.invalid',password:'synthetic-only',options:{data:{username:'fixture'}}})).error,null);
  assert.equal((await client.auth.resetPasswordForEmail('fixture@example.invalid',{redirectTo:origin+'/api/auth/reset-password'})).error,null);
  assert.ok(calls[0].url.startsWith(origin+'/api/auth/proxy/signup'));
  assert.equal(new URL(calls[1].url).searchParams.get('redirect_to'),origin+'/api/auth/reset-password');
  assert.equal(JSON.parse(calls[0].body).data.username,'fixture');
  rejectCredentials=true;
  const result=await client.auth.signInWithPassword({email:'fixture@example.invalid',password:'synthetic-invalid'});
  assert.equal(result.error.code,'invalid_credentials');assert.match(authErrorMessage(result.error),/邮箱或密码错误/);
  assert.equal(calls.length,3);
});
