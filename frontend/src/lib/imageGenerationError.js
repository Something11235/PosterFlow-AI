// Persist only these diagnostics. A thrown message or response body can contain
// a signed image URL, credentials, or a gateway's HTML error page.
const transportMessages = {
  RESPONSE_INVALID: '接口返回了无法识别的结果。',
  BROWSER_OFFLINE: '浏览器当前显示网络已断开。',
  CONNECTION_INTERRUPTED: '浏览器未能取得接口响应。',
  WAIT_INTERRUPTED: '等待接口响应时已中断。',
  RESULT_UNCONFIRMED: '页面暂时无法确认请求结果。',
  AUTH_VERIFY_UNAVAILABLE: '登录验证服务暂时不可用。',
  IMAGE_DATABASE_UNAVAILABLE: '暂时无法读取图片任务记录。',
};

export function imageTransportDiagnostic(reason, httpStatus) {
  if (Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599) return `HTTP_${httpStatus}`;
  if (httpStatus != null || reason?.name === 'SyntaxError') return 'RESPONSE_INVALID';
  if (reason?.name === 'AbortError' || reason?.name === 'TimeoutError') return 'WAIT_INTERRUPTED';
  if (globalThis.navigator?.onLine === false) return 'BROWSER_OFFLINE';
  if (/failed to fetch|fetch failed|load failed|network ?error|network request failed/i.test(reason?.message || '')) return 'CONNECTION_INTERRUPTED';
  return 'RESULT_UNCONFIRMED';
}

export function imageDiagnosticText(diagnostic) {
  if (typeof diagnostic !== 'string') return '';
  if (Object.hasOwn(transportMessages, diagnostic)) return transportMessages[diagnostic];
  if (!/^HTTP_[45]\d\d$/.test(diagnostic)) return '';
  const status = diagnostic.slice(5);
  const descriptions = {
    401: '接口要求重新验证身份', 403: '接口拒绝访问', 413: '请求内容超过接口允许的大小',
    429: '接口限制了请求频率', 502: '网关未能取得有效响应', 503: '接口暂时无法处理请求',
    504: '网关等待响应超时',
  };
  return `${descriptions[status] || '接口返回错误'}（HTTP ${status}）。`;
}

export const imageAuthRefreshHint = '请先刷新页面以更新登录状态。如果刷新后仍提示需要登录，再重新登录。';
export function imageAuthNeedsRefresh(code) {
  return ['AUTH_REQUIRED','AUTH_SESSION_EXPIRED','AUTH_TOKEN_INVALID'].includes(code);
}

// These causes can also be shown for history records that only retain a code.
export function imageFailureTitle(code) {
  const titles = {
    IMAGE_PROVIDER_TIMEOUT: '图片生成服务响应超时', PROVIDER_TIMEOUT: '图片生成服务响应超时',
    BUYTOKEN_REQUEST_REJECTED: '图片服务未接受本次请求', APIMART_REQUEST_REJECTED: '图片服务未接受本次请求',
    PROVIDER_REJECTED: '图片服务拒绝了本次请求', PROVIDER_AUTH_INVALID: '图片服务未接受身份验证',
    CREDITS_INSUFFICIENT: '可用积分不足', INSUFFICIENT_CREDITS: '可用积分不足',
    EMAIL_UNVERIFIED: '请先验证邮箱', AUTH_REQUIRED: '需要更新登录状态', ACCESS_DENIED: '当前请求没有访问权限',
    AUTH_SESSION_EXPIRED: '当前请求的登录凭证已过期', AUTH_TOKEN_INVALID: '当前请求的登录凭证未通过验证',
    AUTH_VERIFY_UNAVAILABLE: '登录验证服务暂时不可用',
    IMAGE_DATABASE_UNAVAILABLE: '暂时无法访问图片任务记录',
    IMAGE_SIZE_INVALID: '模型不支持当前图片尺寸', IMAGE_RESOLUTION_INVALID: '模型不支持当前分辨率',
    IMAGE_COUNT_INVALID: '生成张数超出模型限制', PROMPT_INVALID: '提示词未通过校验',
    MODEL_RETIRED: '当前模型已下架', PROVIDER_DNS_FAILED: '无法解析图片服务地址',
    REFERENCE_UPLOAD_FAILED: '参考图上传未完成', REFERENCE_IMAGE_INVALID: '参考图未通过校验',
    REFERENCE_IMAGE_TOO_LARGE: '参考图超过大小限制', REFERENCE_IMAGE_UNSUPPORTED: '参考图格式不受支持',
  };
  return Object.hasOwn(titles, code) ? titles[code] : '';
}

export function closedImageFailure(data, billingMode) {
  const reason = data?.job?.error_code || data?.error_code;
  const code = reason && !['REQUEST_ALREADY_PROCESSED','IMAGE_TASK_PENDING','IMAGE_SAVE_PENDING','BACKEND_OFFLINE'].includes(reason) ? reason : 'IMAGE_TASK_CLOSED';
  const message = typeof data?.job?.failure_reason === 'string' ? data.job.failure_reason : '';
  return {code, billing_mode:billingMode, message:imageFailureTitle(code) || message || '原任务已结束，未取得图片结果。'};
}

export function imageClientFailure(reason, { started, uploadingReferences = false, billingMode }) {
  const code = typeof reason?.code === 'string' ? reason.code : '';
  let diagnostic = reason?.diagnostic || (!code ? imageTransportDiagnostic(reason) : undefined);
  if (!started && diagnostic === 'RESULT_UNCONFIRMED') diagnostic = undefined;
  return {
    billing_mode: billingMode, submission_unknown: started,
    code: code || (started ? 'IMAGE_SUBMISSION_UNKNOWN' : uploadingReferences ? 'REFERENCE_UPLOAD_FAILED' : 'IMAGE_PREPARATION_FAILED'),
    message: started ? '暂未确认生图结果' : uploadingReferences ? '参考图上传未完成' : '生图请求准备未完成',
    detail: code ? typeof reason.detail === 'string' ? reason.detail : reason.message : undefined,
    diagnostic, diagnostic_phase: started ? 'submission' : uploadingReferences ? 'reference' : 'preparation',
  };
}

export function imageQueryFailureMessage(reason) {
  if (imageAuthNeedsRefresh(reason?.code) || reason?.status === 401) {
    return `${imageFailureTitle(reason?.code) || '查询原任务需要验证身份'}。${imageAuthRefreshHint}`;
  }
  if (reason?.status === 404 && ['IMAGE_TASK_NOT_FOUND','GENERATION_NOT_FOUND'].includes(reason.code)) {
    return '暂时查不到该编号的原任务。请确认当前账号并稍后再查询。';
  }
  const diagnostic = reason?.diagnostic || imageTransportDiagnostic(reason, reason?.status);
  const detail = imageDiagnosticText(diagnostic);
  const known = imageFailureTitle(reason?.code);
  return `查询原任务时，${known && reason.code !== diagnostic ? known + '。' : ''}${detail} 任务记录已保留，请稍后继续查询。`;
}

export async function readImageGenerationResult(response) {
  let data;
  let readError;
  try {
    data = await response.json();
  } catch (reason) {
    readError = reason;
  }
  const hasApiError = typeof data?.code === 'string' && (
    typeof data.error === 'string' && data.error || data.error == null && !response.ok
  );
  const hasImages = Array.isArray(data?.images) && data.images.length && data.images.every(image => typeof image?.filename === 'string' && image.filename);
  if (hasApiError || response.ok && !data?.error && hasImages) return data;
  if (response.status >= 400 && response.status < 500 && typeof data?.error === 'string' && data.error) {
    return {...data, diagnostic:imageTransportDiagnostic(null, response.status)};
  }
  // A successful HTTP header can be followed by a connection failure while
  // reading its body. Never surface raw gateway/HTML content to the user.
  const diagnostic = readError && response.ok && readError.name !== 'SyntaxError'
    ? imageTransportDiagnostic(readError) : imageTransportDiagnostic(null, response.status);
  if ([401, 403].includes(response.status)) {
    return {error:imageDiagnosticText(diagnostic), code:response.status === 401 ? 'AUTH_REQUIRED' : 'ACCESS_DENIED', diagnostic};
  }
  throw Object.assign(new Error('暂未收到有效的生图结果'), { diagnostic });
}
