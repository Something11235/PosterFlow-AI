import React, { useEffect } from "react";
import { CreditCard, X } from "lucide-react";

export default function RechargePanel({ open, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="recharge-title">
      <div className="flex max-h-[94dvh] w-full max-w-md flex-col overflow-hidden rounded-t-lg border border-border-default bg-bg-secondary shadow-2xl sm:rounded-lg">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-accent/30 bg-accent/12 text-accent"><CreditCard size={20} /></div>
            <h2 id="recharge-title" className="text-base font-semibold text-text-primary">购买积分</h2>
          </div>
          <button type="button" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary" aria-label="关闭购买积分窗口"><X size={18} /></button>
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto p-5">
          <p className="text-sm font-medium leading-6 text-text-primary">好了先别急着骂我</p>
          <p className="text-sm leading-6 text-text-secondary">为了照顾到不熟悉中转站，或希望省去 API 配置步骤的 uu，可以添加站主微信购买积分。</p>
          <p className="text-sm leading-6 text-text-secondary">本站由个人维护，考虑到在线支付的接入和维护成本，目前暂采用人工充值的方式。</p>
          <img src="/wechat-payment.jpg" alt="站主微信二维码" className="mx-auto aspect-square w-full max-w-[320px] rounded-md border border-border-subtle bg-white object-contain" />
          <p className="text-sm leading-6 text-text-secondary">参考官方gpt-image-2平均¥1.4348/张。用户每生成一张图我们烧掉的成本为0.5元左右，所以站主最多只收0.5的成本价用来进行网站服务器的日常维护，当然，积分的初衷是为了照顾到不会使用API或者嫌麻烦的uu，完全可以使用自己的API，也希望大家多多支持宣传，让世界上最强最新的生图模型每个中国人也触手可得。</p>
        </div>
      </div>
    </div>
  );
}
