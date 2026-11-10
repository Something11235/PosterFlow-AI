"""Bounded classification input. Raw provider text is never a public explanation."""
import json
import re

ERROR_FIELDS = ('error', 'message', 'detail', 'reason', 'failure_reason', 'error_message',
                'code', 'type', 'error_code', 'error_name', 'title', 'innererror', 'cause')


def error_text(value):
    parts, budget = [], [24000]
    def visit(item, depth):
        if depth > 5 or budget[0] <= 0:
            return
        if isinstance(item, dict):
            for key in ERROR_FIELDS:
                if key in item:
                    visit(item[key], depth + 1)
        elif isinstance(item, str):
            text = item[:min(12000, budget[0])]
            budget[0] -= len(text)
            # Only error containers are read; prompts, headers, media and keys
            # are never inspected or echoed. Encoded nested JSON is common.
            try:
                nested = json.loads(text)
            except ValueError:
                nested = None
            if isinstance(nested, dict):
                visit(nested, depth + 1)
            else:
                parts.append(re.sub(r'https?://\S+', ' ', text))
    visit(value, 0)
    return ' '.join(parts)


def is_timeout(value, status=None):
    return status in (408, 504, 524) or bool(re.search(
        r'\b(?:HTTP\s*)?(?:504|524)\b|origin_gateway_timeout|gateway[ _-]*time[ _-]*out|timed?\s*out|timeout|超时',
        error_text(value), re.I))


IMAGE_TIMEOUT = '图片生成服务响应超时，暂时无法完成本次请求。这通常是服务繁忙或上游处理耗时过长。'
IMAGE_TIMEOUT_RECOVERY = ['至少等待 2 分钟后再尝试；已有任务请先查询原任务，勿重复提交。']
REFERENCE_FAILURE_REASONS = {
    'REFERENCE_UPLOAD_FAILED': '参考图上传未完成，尚未提交生图。',
    'REFERENCE_UPLOAD_QUOTA_EXCEEDED': '图片服务的参考素材上传额度已用尽，本次尚未提交生图。请等待额度恢复；如持续无法使用，请联系站主。',
    'REFERENCE_UPLOAD_RATE_LIMITED': '图片服务暂时限制参考图上传，本次尚未提交生图。请稍后重试，避免连续提交。',
    'REFERENCE_LINK_UNAVAILABLE': '参考图临时链接暂时无法准备，本次尚未提交生图。请稍后重试；如持续无法使用，请联系站主。',
}


def image_failure_code(value, status=None):
    return 'IMAGE_PROVIDER_TIMEOUT' if is_timeout(value, status) else 'APIMART_TASK_FAILED'


def image_failure_reason(code):
    return REFERENCE_FAILURE_REASONS.get(code) or (IMAGE_TIMEOUT if code == 'IMAGE_PROVIDER_TIMEOUT' else '图片服务未完成本次任务，已按实际结果退回预留积分。')
