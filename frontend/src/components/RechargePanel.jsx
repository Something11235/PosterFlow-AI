import React,{useEffect,useRef,useState} from 'react';
import {ArrowUpRight,CheckCircle2,CreditCard,Loader2,RefreshCw,Ticket,X} from 'lucide-react';
import {CREDIT_PACKAGES,creditCodeApi,normalizeCreditCode} from '../lib/creditCodes';
import {creditText} from '../lib/credits';

export default function RechargePanel({open,onClose,session,account,authHeaders,onLogin,onAccountRefresh}){
  const [config,setConfig]=useState(null),[code,setCode]=useState(''),[entries,setEntries]=useState([]),[message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const scope=useRef(0),controllers=useRef(new Set());
  const auth=useRef(authHeaders);auth.current=authHeaders;
  const identity=session?.user?.id || '';
  const loggedIn=Boolean(identity),verified=Boolean(account?.email_verified),active=account?.profile?.status==='active';
  useEffect(()=>{
    const pending=controllers.current,version=++scope.current,c=new AbortController();controllers.current.add(c);setCode('');setEntries([]);setMessage('');setError('');setBusy(false);setConfig(null);
    if(open){
      creditCodeApi('/config',{signal:c.signal}).then(d=>{if(!c.signal.aborted&&scope.current===version)setConfig(d);}).catch(e=>{if(!c.signal.aborted)setError(e.message);});
      if(identity)creditCodeApi('/history',{authHeaders:auth.current,signal:c.signal}).then(d=>{if(!c.signal.aborted&&scope.current===version)setEntries(d.entries);}).catch(e=>{if(!c.signal.aborted)setError(e.message);});
    }
    return()=>{for(const task of pending)task.abort();pending.clear();};
  },[open,identity]);
  useEffect(()=>{if(!open)return;const key=e=>{if(e.key==='Escape')onClose();};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[open,onClose]);
  async function redeem(e){
    e.preventDefault();if(busy)return;
    if(!loggedIn){onLogin();return;}
    let clean;try{clean=normalizeCreditCode(code);}catch(e){setError(e.message);return;}
    const version=scope.current,c=new AbortController();controllers.current.add(c);setBusy(true);setError('');setMessage('');
    try{
      const result=await creditCodeApi('/redeem',{authHeaders,body:{code:clean},signal:c.signal});
      if(c.signal.aborted||scope.current!==version)return;
      setCode('');setMessage(result.idempotent?`该兑换码此前已到账 ${creditText(result.credits)} 积分，本次未重复充值。`:`兑换成功，${creditText(result.credits)} 积分已到账。`);
      await onAccountRefresh?.();
      if(c.signal.aborted||scope.current!==version)return;
      const history=await creditCodeApi('/history',{authHeaders,signal:c.signal});if(!c.signal.aborted)setEntries(history.entries);
    }catch(e){if(!c.signal.aborted&&scope.current===version)setError(e.message);}finally{if(scope.current===version)setBusy(false);}
  }
  if(!open)return null;
  const input='min-h-11 w-full rounded-lg border border-border-default bg-bg-primary px-3 py-3 text-sm text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/20';
  return <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="recharge-title">
    <div className="flex max-h-[100dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-lg border border-border-default bg-bg-secondary shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:rounded-lg">
      <header className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4"><div className="flex items-center gap-3"><CreditCard size={22} className="text-accent"/><div><h2 id="recharge-title" className="font-semibold text-text-primary">购买积分</h2><p className="mt-1 text-xs text-text-muted">店铺选购套餐，登录后兑换到账</p></div></div><button type="button" onClick={onClose} aria-label="关闭购买积分窗口" className="min-h-11 min-w-11 text-text-muted"><X size={18}/></button></header>
      <div className="min-h-0 space-y-5 overflow-y-auto overscroll-contain p-5">
        <section className="rounded-lg border border-border-subtle bg-bg-tertiary p-4" aria-label="积分套餐"><h3 className="text-sm font-semibold text-text-primary">选择适合你的创作额度</h3><p className="mt-3 text-sm leading-6 text-text-secondary">在店铺选购套餐并领取本站积分兑换码，登录后兑换到账。购买与售后请通过店铺订单处理。</p><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{CREDIT_PACKAGES.map(p=><div key={p.id} className="rounded-md border border-border-subtle bg-bg-primary px-3 py-3"><strong className="text-accent">{p.credits} 积分</strong><p className="mt-1 text-sm text-text-secondary">¥{p.price}</p></div>)}</div><p className="mt-3 text-xs leading-5 text-text-muted">各模型扣分不同，请在生成前查看预估。</p></section>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border-subtle bg-bg-tertiary p-4" aria-label="积分店铺入口">
          <div className="min-w-0 flex-1">{config?.purchase_available&&config.purchase_url?<a href={config.purchase_url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent hover:bg-accent/20">前往店铺选购<ArrowUpRight size={15} className="shrink-0"/></a>:<span className="text-sm text-text-muted">正在加载购买入口…</span>}<p className="mt-2 text-xs leading-5 text-text-muted">也可以用手机扫描旁边的二维码。</p></div>
          <img src="/liandong-shop-qr.png?v=shop-20261112" alt="链动小铺二维码" className="w-32 shrink-0 rounded-md border border-border-subtle bg-white object-contain sm:w-36"/>
        </div>
        <section className="rounded-lg border border-accent/30 bg-accent/5 p-4"><h3 className="flex items-center gap-2 font-semibold text-text-primary"><Ticket size={18} className="text-accent"/>已有兑换码</h3><p className="mt-2 text-xs leading-5 text-text-muted">如已获得本站积分兑换码，可在此登录兑换。请使用店铺发放的本站积分兑换码。</p>
          <form onSubmit={redeem} className="mt-3 space-y-3"><label className="block text-sm text-text-secondary">积分兑换码<input className={input+' mt-2 font-mono'} aria-label="积分兑换码" value={code} onChange={e=>setCode(e.target.value)} maxLength={160} autoComplete="off" spellCheck={false} placeholder="粘贴 PF 开头的兑换码" disabled={busy}/></label>
          {!loggedIn?<button type="button" onClick={onLogin} className="min-h-11 w-full rounded-md bg-accent px-4 text-sm font-semibold text-white">登录后兑换</button>:<button type="submit" disabled={busy||!verified||!active||!config?.ready||!code.trim()} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50">{busy?<Loader2 size={16} className="animate-spin"/>:<CheckCircle2 size={16}/>}兑换到当前账户</button>}
          {loggedIn&&!verified&&<p className="text-xs text-gold">请先完成邮箱验证。</p>}{loggedIn&&verified&&!active&&<p className="text-xs text-gold">当前账户状态不可用，请刷新账户后核对。</p>}{config&&!config.ready&&<p className="text-xs text-gold">兑换服务尚未就绪，请稍后再试。</p>}</form>
          {message&&<p role="status" className="mt-3 text-sm leading-6 text-mint">{message}</p>}{error&&<p role="alert" className="mt-3 text-sm leading-6 text-error">{error}</p>}
        </section>
        {loggedIn&&<section><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-text-primary">最近兑换记录</h3><button type="button" aria-label="刷新兑换记录" disabled={busy} className="min-h-11 min-w-11 text-accent" onClick={async()=>{const version=scope.current;try{const d=await creditCodeApi('/history',{authHeaders});if(scope.current===version)setEntries(d.entries);}catch(e){if(scope.current===version)setError(e.message);}}}><RefreshCw size={15}/></button></div><div className="divide-y divide-border-subtle rounded-lg border border-border-subtle">{entries.length?entries.map(r=><div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-sm"><div><span className="text-text-secondary">兑换码尾号 {r.suffix}</span><p className="mt-1 text-xs text-text-muted">{new Date(r.redeemed_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</p></div><strong className="text-mint">+{creditText(r.credits)} 积分</strong></div>):<p className="px-3 py-4 text-sm text-text-muted">暂无兑换记录</p>}</div></section>}
        <section className="flex items-center justify-between gap-4 rounded-lg border border-border-subtle bg-bg-tertiary p-4" aria-label="PosterFlow-AI交流群"><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-text-primary">PosterFlow-AI交流群</h3><p className="mt-2 text-xs leading-5 text-text-muted">扫码加入交流群，交流创作经验。</p></div><img src="/posterflow-community-qr.png" alt="PosterFlow-AI交流群二维码" className="w-40 shrink-0 rounded-md border border-border-subtle bg-white object-contain sm:w-48"/></section>
      </div>
    </div>
  </div>;
}
