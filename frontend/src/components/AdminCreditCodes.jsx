import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Download,Loader2,Plus,RefreshCw,Ticket,Trash2} from 'lucide-react';
import {CREDIT_PACKAGES,creditCodeApi,downloadCreditCodes} from '../lib/creditCodes';
import {creditText} from '../lib/credits';

const input='mt-2 min-h-11 w-full rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary outline-none focus:border-accent';
const button='inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border-default px-3 text-sm text-text-secondary hover:bg-bg-elevated disabled:opacity-50';

export default function AdminCreditCodes({authHeaders}){
  const [batches,setBatches]=useState([]),[redemptions,setRedemptions]=useState([]),[packageId,setPackageId]=useState('pf20'),[quantity,setQuantity]=useState('100'),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [voidCode,setVoidCode]=useState(''),[voidReason,setVoidReason]=useState('');
  const controllers=useRef(new Set()),scope=useRef(0),requestId=useRef(null);
  const load=useCallback(async signal=>{
    const d=await creditCodeApi('/admin/batches',{authHeaders,signal});
    if(!signal?.aborted){setBatches(d.batches);setRedemptions(d.redemptions);}
  },[authHeaders]);
  useEffect(()=>{
    const pending=controllers.current,version=++scope.current,c=new AbortController();controllers.current.add(c);setBatches([]);setRedemptions([]);setVoidCode('');setVoidReason('');setError('');setNotice('');setBusy(false);requestId.current=null;
    load(c.signal).catch(e=>{if(!c.signal.aborted&&scope.current===version)setError(e.message);});
    return()=>{for(const task of pending)task.abort();pending.clear();};
  },[load]);
  useEffect(()=>{requestId.current=null;},[packageId,quantity,note]);
  async function run(action){
    if(busy)return;
    const version=scope.current,c=new AbortController();controllers.current.add(c);setBusy(true);setError('');setNotice('');
    try{await action(c.signal,()=>!c.signal.aborted&&scope.current===version);}
    catch(e){if(!c.signal.aborted&&scope.current===version)setError(e.message);}
    finally{if(scope.current===version)setBusy(false);}
  }
  function create(e){
    e.preventDefault();const n=Number(quantity);
    if(!Number.isInteger(n)||n<1||n>500){setError('每批数量为 1–500 个。');return;}
    requestId.current ||= crypto.randomUUID();const id=requestId.current;
    run(async(signal,live)=>{
      const d=await creditCodeApi('/admin/batches',{authHeaders,signal,body:{request_id:id,package_id:packageId,quantity:n,note}});
      if(!live())return;
      requestId.current=null;setNotice(`${d.existing?'已找到原批次':'已创建批次'}，共 ${d.batch.quantity} 个、每个 ${creditText(d.batch.credits)} 积分。请下载后仅导入对应卡种。`);
      await load(signal);
    });
  }
  function exportBatch(b){run(async(signal,live)=>{
    const d=await creditCodeApi('/admin/batches/'+b.id+'/export',{authHeaders,signal,body:{}});if(!live())return;
    downloadCreditCodes(d,b);setNotice(`已导出 ${d.count} 个未使用兑换码。重复导出仍是原码，勿重复导入多个卡种。`);await load(signal);
  });}
  function voidBatch(b){
    const reason=window.prompt(`作废此批次剩余 ${b.ready} 个未兑换码，已兑换积分不变。请输入原因：`);
    if(reason===null)return;if(reason.trim().length<2){setError('请填写至少 2 字的作废原因。');return;}
    run(async(signal,live)=>{const d=await creditCodeApi('/admin/batches/'+b.id+'/void',{authHeaders,signal,body:{reason:reason.trim()}});if(!live())return;setNotice(`已作废 ${d.voided} 个未使用兑换码。`);await load(signal);});
  }
  function voidSingle(e){e.preventDefault();run(async(signal,live)=>{const d=await creditCodeApi('/admin/cards/void',{authHeaders,signal,body:{code:voidCode,reason:voidReason}});if(!live())return;setVoidCode('');setVoidReason('');setNotice(d.voided?'已作废此兑换码，其他兑换码不受影响。':'此兑换码此前已作废。');await load(signal);});}
  return <section className="my-5 min-w-0 rounded-lg border border-accent/25 bg-bg-tertiary" aria-label="积分兑换码管理">
    <header className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3"><h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Ticket size={17} className="text-accent"/>积分兑换码</h3><button type="button" className={button} disabled={busy} onClick={()=>run(async signal=>load(signal))}><RefreshCw size={15}/>刷新批次</button></header>
    <div className="space-y-4 p-4"><p className="text-xs leading-6 text-text-muted">每个兑换码只能到账一次；按面额分别导入店铺库存，不使用重复卡密生成器。制码不计作收入或充值，用户实际兑换时才记积分到账。店铺订单核销及退款尚未自动关联。</p>
      <form onSubmit={create} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><label className="text-xs text-text-secondary">积分套餐<select className={input} aria-label="制码积分套餐" disabled={busy} value={packageId} onChange={e=>setPackageId(e.target.value)}>{CREDIT_PACKAGES.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="text-xs text-text-secondary">生成数量<input className={input} aria-label="生成兑换码数量" type="number" min={1} max={500} step={1} disabled={busy} value={quantity} onChange={e=>setQuantity(e.target.value)}/></label><label className="text-xs text-text-secondary">批次说明<input className={input} aria-label="兑换码批次说明" maxLength={240} disabled={busy} value={note} onChange={e=>setNote(e.target.value)} placeholder="例如：店铺首批库存"/></label><button type="submit" disabled={busy} className="mt-auto inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white disabled:opacity-50">{busy?<Loader2 size={16} className="animate-spin"/>:<Plus size={16}/>}生成本批兑换码</button></form>
      {error&&<p role="alert" className="text-sm leading-6 text-error">{error} 若提交结果未确认，请先刷新批次列表核对。</p>}{notice&&<p role="status" className="text-sm leading-6 text-mint">{notice}</p>}
      <div className="max-h-96 space-y-2 overflow-y-auto">{batches.length?batches.map(b=><article key={b.id} className="rounded-md border border-border-subtle bg-bg-primary p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><strong className="text-sm text-text-primary">{creditText(b.credits)} 积分／码 · {b.quantity} 个</strong><p className="mt-1 break-all text-xs text-text-muted">{new Date(b.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} · {b.id}</p>{b.note&&<p className="mt-1 break-words text-xs text-text-secondary">{b.note}</p>}<p className="mt-2 text-xs text-text-secondary">待兑换 {b.ready} · 已兑换 {b.redeemed} · 已作废 {b.voided} · 导出 {b.export_count} 次</p></div><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy||b.status!=='active'||!b.ready} onClick={()=>exportBatch(b)}><Download size={15}/>下载卡密 TXT</button><button type="button" className={button} disabled={busy||b.status!=='active'||!b.ready} onClick={()=>voidBatch(b)}><Trash2 size={15}/>作废剩余码</button></div></div></article>):<p className="py-4 text-sm text-text-muted">暂无批次。生成后下载 TXT，每行一个兑换码，可导入对应卡种。</p>}</div>
      <details className="border-t border-border-subtle pt-3"><summary className="cursor-pointer text-sm text-text-secondary">作废单个未兑换码</summary><form onSubmit={voidSingle} className="mt-3 grid gap-3 sm:grid-cols-3"><label className="text-xs text-text-secondary">完整兑换码<input className={input} aria-label="待作废兑换码" value={voidCode} maxLength={160} autoComplete="off" spellCheck={false} disabled={busy} onChange={e=>setVoidCode(e.target.value)}/></label><label className="text-xs text-text-secondary">作废原因<input className={input} aria-label="单码作废原因" value={voidReason} maxLength={240} disabled={busy} onChange={e=>setVoidReason(e.target.value)}/></label><button type="submit" className={button+' mt-auto'} disabled={busy||!voidCode||voidReason.trim().length<2}>作废此码</button></form><p className="mt-2 text-xs text-text-muted">请先核实对应订单；此操作不会向店铺发起退款，也不会扣回已到账积分。</p></details>
      <details className="border-t border-border-subtle pt-3"><summary className="cursor-pointer text-sm text-text-secondary">最近兑换记录（{redemptions.length}）</summary><div className="mt-2 max-h-64 space-y-2 overflow-y-auto">{redemptions.map(r=><div key={r.id} className="flex flex-wrap justify-between gap-2 rounded-md bg-bg-primary p-3 text-xs text-text-secondary"><div><p>{r.username || '已删除账户'} · 尾号 {r.suffix}</p><p className="mt-1">{new Date(r.redeemed_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</p></div><strong className="text-mint">+{creditText(r.credits)} 积分</strong></div>)}</div></details>
    </div>
  </section>;
}
