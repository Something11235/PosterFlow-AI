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
      <div className="w-full max-w-md overflow-hidden rounded-t-lg border border-border-default bg-bg-secondary shadow-2xl sm:rounded-lg">
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-accent/30 bg-accent/12 text-accent"><CreditCard size={20} /></div>
            <h2 id="recharge-title" className="text-base font-semibold text-text-primary">购买积分</h2>
          </div>
          <button type="button" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary" aria-label="关闭购买积分窗口"><X size={18} /></button>
        </div>
        <div className="space-y-4 p-5">
          <p className="text-sm leading-6 text-text-secondary">为了照顾不会使用中转站或者嫌麻烦的uu，可添加站主微信直接购买积分</p>
          <img src="/wechat-payment.jpg" alt="站主微信二维码" className="mx-auto aspect-square w-full max-w-[320px] rounded-md border border-border-subtle bg-white object-contain" />
        </div>
      </div>
    </div>
  );
}