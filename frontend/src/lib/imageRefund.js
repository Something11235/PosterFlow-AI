import { creditText } from './credits.js';

// Only a server-confirmed platform refund is terminal. An HTTP error, a missing
// image or a zero charge alone never proves that the reservation was returned.
export function imageRefundError(data, billingMode = data?.billing_mode || data?.job?.billing_mode) {
  if (billingMode !== 'platform' || !(data?.refunded === true || data?.billing?.status === 'refunded'
    || data?.billing_status === 'refunded' || data?.status === 'refunded'
    || data?.job?.refunded === true || data?.job?.billing_status === 'refunded')) return null;
  return {
    code: data.code || data.error_code || data.job?.error_code || 'IMAGE_UNDELIVERED_REFUNDED',
    message: '本次未取得图片结果，预留积分已退回。',
    detail: '退款已退回账户，原任务已结束。如需再次生成，可以主动发起新任务。',
    recovery: ['可在账户中查看退回的积分', '如需再次生成，请发起新任务'],
    refunded: true, submission_unknown: false, recovery_confirmed: false, billing_mode: 'platform',
  };
}

export function accountAfterImageRefund(account, data, billingMode) {
  if (!account?.credits || !imageRefundError(data, billingMode)) return account;
  try {
    const balance = creditText(data.credit_balance);
    if (balance.startsWith('-')) return account;
    return {...account, credits: {...account.credits, balance}};
  } catch { return account; }
}
