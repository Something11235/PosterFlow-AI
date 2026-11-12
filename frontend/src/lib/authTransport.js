const AUTH_PATHS = new Set(['token','signup','recover','verify','resend','user','logout']);

async function fetchAuthWithDeadline(request, fetchImpl, timeoutMs) {
  if(request.signal.aborted)throw new DOMException('Aborted','AbortError');
  const controller=new AbortController();let timer,stop,status;
  const interruption=new Promise((_,reject)=>{stop=reject;timer=setTimeout(()=>{
    reject(Object.assign(new Error('登录服务连接超时，请稍后重试。'),{code:'AUTH_NETWORK_TIMEOUT',authHttpStatus:status}));controller.abort();
  },timeoutMs);});
  const abort=()=>{stop(new DOMException('Aborted','AbortError'));controller.abort();};
  request.signal.addEventListener('abort',abort,{once:true});
  try {
    return await Promise.race([interruption,(async()=>{
      const response=await fetchImpl(new Request(request,{credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal}));
      status=response.status;
      try {
        const body=await response.text();
        return new Response(status===204?null:body,{status,headers:response.headers});
      }catch(error){if(error && typeof error==='object')error.authHttpStatus=status;throw error;}
    })()]);
  }finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);}
}

// Retain the SDK URL/storage key. Password login and user reads try Supabase
// directly, then use this site's transport once on connection failure only.
// Mail sends, verification and refresh-token rotation always use one route.
export function createAuthProxyFetch(supabaseUrl, {fetchImpl=(...args)=>globalThis.fetch(...args), origin=globalThis.location?.origin, timeoutMs=30000,directTimeoutMs=8000} = {}) {
  const configured = new URL(supabaseUrl);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== configured.origin || !url.pathname.startsWith('/auth/v1/')) return fetchImpl(input, init);
    const endpoint=url.pathname.slice('/auth/v1/'.length);
    if (!AUTH_PATHS.has(endpoint) || url.username || url.password) return new Response(JSON.stringify({code:'auth_proxy_route_blocked',msg:'该登录操作不受支持。'}),{status:404,headers:{'Content-Type':'application/json'}});
    const original=new Request(input,init);
    const directFirst=(endpoint==='token' && original.method==='POST' && url.searchParams.get('grant_type')==='password') || (endpoint==='user' && original.method==='GET');
    // Clone before the direct request consumes its body; a transport retry must
    // carry the exact same input without reading or recording credentials.
    const backup=original.clone();
    if(directFirst){
      try{return await fetchAuthWithDeadline(original,fetchImpl,directTimeoutMs);}
      catch(error){
        const network=error?.code==='AUTH_NETWORK_TIMEOUT' || error?.name==='TypeError' || error?.name==='NetworkError';
        if(original.signal.aborted || error?.authHttpStatus>=400 || !network)throw error;
      }
    }
    const proxy=new Request(new URL('/api/auth/proxy/'+endpoint+url.search,origin),backup);
    const headers=new Headers(proxy.headers);headers.set('X-Posterflow-Auth','1');
    return fetchAuthWithDeadline(new Request(proxy,{headers}),fetchImpl,timeoutMs);
  };
}

export function authErrorMessage(error) {
  const code=error?.code, message=String(error?.message||'');
  if (code==='invalid_credentials' || /invalid login credentials/i.test(message)) return '邮箱或密码不匹配，请检查输入；忘记密码可通过注册邮箱重置。';
  if (code==='email_not_confirmed' || /email not confirmed/i.test(message)) return '邮箱尚未验证，请先打开验证邮件完成验证，再登录。';
  if (error?.status===429 || /^over_.*rate_limit$/.test(code||'')) return '操作过于频繁，请稍后再试。';
  if (code==='weak_password') return '密码强度不足，请使用更长且不易猜测的密码。';
  if (code==='user_already_exists' || code==='email_exists') return '该邮箱已注册，请直接登录或使用“忘记密码”。';
  if (code==='auth_proxy_not_configured') return '登录服务暂未配置，请联系站主。';
  if (code==='auth_network_unavailable' || error?.name==='AuthRetryableFetchError' || /failed to fetch|networkerror|load failed|fetch failed|连接.*超时|连接.*中断/i.test(message)) return '暂时无法连接登录服务，这不表示密码错误。请稍后重试，或切换网络后再登录。也可以尝试使用科学上网后重试。';
  return '操作未完成，请稍后重试；若持续出现，请联系站主。';
}
