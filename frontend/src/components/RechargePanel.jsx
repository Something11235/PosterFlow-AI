import React, { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, CreditCard, Loader2, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

const PACKAGES = [10, 20, 50, 100];

export default function RechargePanel({ open, authHeaders, account, paymentEnabled, paymentChannels = [], onClose, onAccountRefresh }) {
  const [amount, setAmount] = useState(10);
  const [channel, setChannel] = useState("alipay");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [order, setOrder] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const hasAlipay = paymentChannels.includes("alipay");
  const orderExpired = order?.status === "pending" && order.expires_at && Date.parse(order.expires_at) <= now;
  const orderPending = order?.status === "pending" && !orderExpired;

  useEffect(() => {
    if (!hasAlipay && channel === "alipay") setChannel("");
    if (hasAlipay && channel !== "alipay") setChannel("alipay");
  }, [channel, hasAlipay]);

  useEffect(() => {
    if (!open || !order?.id || !orderPending) return undefined;
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch(`/api/credits/orders/${order.id}`, { headers: authHeaders, credentials: "include" });
        const data = await response.json();
        if (!active || !response.ok || !data.order) return;
        setOrder(data.order);
        if (data.order.status === "paid") {
          await onAccountRefresh?.();
          setError("支付成功，积分已经到账。");
        }
      } catch {
        // The next polling round will retry a transient network error.
      }
    };
    const timer = window.setInterval(poll, 3000);
    poll();
    return () => { active = false; window.clearInterval(timer); };
  }, [authHeaders, onAccountRefresh, open, order?.id, orderPending]);

  useEffect(() => {
    if (!open || !order?.expires_at || order.status !== "pending") return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, order?.expires_at, order?.status]);

  if (!open) return null;
  const submit = async () => {
    if (!paymentEnabled || !paymentChannels.includes(channel)) {
      setError("在线支付还没有配置完成，请联系管理员。");
      return;
    }
    if (orderPending) {
      setError("当前已有待支付订单，请先完成或等待该订单过期，不要重复创建。");
      return;
    }
    const amountYuan = Number.parseInt(amount, 10);
    if (!Number.isInteger(amountYuan) || amountYuan < 10) {
      setError("充值金额最低为 10 元，请输入整数金额。");
      return;
    }
    setBusy(true);
    setError("");
    setOrder(null);
    setNow(Date.now());
    try {
      const response = await fetch("/api/credits/orders", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ amount_yuan: amountYuan, channel }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "充值订单创建失败");
      setOrder(data.order || null);
      await onAccountRefresh?.();
      setError("订单已创建，请使用支付宝扫码完成支付。");
    } catch (reason) {
      setError(reason.message || "充值暂时不可用");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="recharge-title">
      <div className="w-full max-w-lg overflow-hidden rounded-t-lg border border-border-default bg-bg-secondary shadow-2xl sm:rounded-lg">
        <div className="flex items-start justify-between border-b border-border-subtle px-5 py-4"><div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-lg border border-accent/30 bg-accent/12 text-accent"><CreditCard size={20} /></div><div><h2 id="recharge-title" className="text-base font-semibold text-text-primary">一键购买积分</h2><p className="mt-1 text-sm text-text-muted">1 元兑换 10 积分，充值金额最低 10 元</p></div></div><button type="button" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary" aria-label="关闭充值"><X size={18} /></button></div>
        <div className="space-y-5 p-5"><div className="rounded-lg border border-accent/20 bg-accent/8 p-3 text-sm leading-6 text-text-secondary">附加说明：此功能是为了照顾不会使用中转站或者嫌麻烦的uu，此价格完全等于甚至小于作者接入的中转站生成一张图片消耗的价格，作者一分钱不赚，只想免费开源分享给大家使用。</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{PACKAGES.map((value) => <button type="button" key={value} onClick={() => setAmount(value)} className={`min-h-16 rounded-lg border text-left transition ${Number(amount) === value ? "border-accent/60 bg-accent/12 text-accent" : "border-border-subtle bg-bg-tertiary text-text-secondary hover:bg-bg-elevated"}`}><span className="block px-3 pt-3 text-lg font-semibold">¥{value}</span><span className="block px-3 pb-3 text-xs text-text-muted">{value * 10} 积分</span></button>)}</div>
          <label className="block text-sm font-medium text-text-secondary">自定义金额（整数元）<input type="number" min="10" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} className="mt-2 min-h-12 w-full rounded-lg border border-border-default bg-bg-primary px-3 text-base text-text-primary outline-none focus:border-accent/70" /></label>
          <div><p className="text-sm font-medium text-text-secondary">支付方式</p><div className="mt-2"><button type="button" disabled={!hasAlipay} onClick={() => setChannel("alipay")} className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border text-sm transition ${channel === "alipay" ? "border-accent/50 bg-accent/10 text-accent" : "border-border-subtle text-text-secondary hover:bg-bg-elevated disabled:cursor-not-allowed disabled:opacity-40"}`}><CreditCard size={16} />支付宝当面付</button></div></div>
          <div className="rounded-lg border border-gold/30 bg-gold/8 p-3 text-xs leading-5 text-text-muted">充值采用服务端订单和支付回调入账，不会在浏览器保存支付密钥。当前账户余额：<strong className="text-accent">{account?.credits?.balance ?? 0} 积分</strong>。</div>
          {!paymentEnabled || !paymentChannels.length ? <div className="flex gap-2 rounded-lg border border-gold/30 bg-gold/8 p-3 text-sm leading-5 text-gold" role="status"><AlertCircle size={17} className="mt-0.5 flex-shrink-0" /><span>在线充值暂未开放。管理员配置并审核支付宝当面付商户通道后，这里会自动显示可用支付方式。</span></div> : null}
          {order?.code_url && orderPending && <div className="flex flex-col items-center gap-3 rounded-lg border border-accent/25 bg-bg-tertiary p-4"><QRCodeSVG value={order.code_url} size={184} bgColor="#ffffff" fgColor="#10151d" includeMargin /><p className="text-center text-sm text-text-primary">请使用支付宝扫码支付 ¥{(Number(order.amount_fen || 0) / 100).toFixed(2)}</p><p className="text-xs text-text-muted">页面会自动检查到账状态；请不要重复创建订单。</p></div>}
          {orderExpired && <p className="rounded-lg border border-gold/30 bg-gold/8 px-3 py-3 text-sm text-gold" role="status">这笔订单已过期，二维码不可用，请重新创建充值订单。</p>}
          {order?.status === "paid" && <p className="flex items-center gap-2 rounded-lg border border-mint/30 bg-mint/10 px-3 py-3 text-sm text-mint" role="status"><CheckCircle2 size={17} />支付成功，积分已到账。</p>}
          {orderPending && order.expires_at && <p className="text-center text-xs text-text-muted">订单有效期至 {new Date(order.expires_at).toLocaleString("zh-CN")}。</p>}
          {error && <p className={`whitespace-pre-line rounded-lg border px-3 py-3 text-sm ${error.includes("已创建") || error.includes("支付成功") ? "border-mint/30 bg-mint/10 text-mint" : "border-error/35 bg-error/10 text-error"}`} role="alert">{error}</p>}
          <button type="button" onClick={submit} disabled={busy || !paymentEnabled || !paymentChannels.length || orderPending} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">{busy && <Loader2 size={16} className="animate-spin-soft" />}{orderPending ? "已有待支付订单" : "创建充值订单"}</button>
        </div>
      </div>
    </div>
  );
}
