"""Administrator-only, safe explanations for stored generation failure codes."""
import re
try:
    from backend.music_failure_reasons import REASONS
    from backend.generation_failures import IMAGE_TIMEOUT, REFERENCE_FAILURE_REASONS
    from backend.video_provider import video_failure
except ModuleNotFoundError:
    from music_failure_reasons import REASONS
    from generation_failures import IMAGE_TIMEOUT, REFERENCE_FAILURE_REASONS
    from video_provider import video_failure

LABELS = {
    'MUSIC_PARAMETER_TYPE_MISMATCH': '请求参数类型',
    'MUSIC_PROVIDER_JOB_FAILED': '服务生成失败',
    'MUSIC_AUDIO_MATCH': '参考音频查重', 'MUSIC_AUDIO_COPYRIGHT': '音频版权限制',
    'MUSIC_LYRICS_COPYRIGHT': '歌词版权限制', 'MUSIC_ARTIST_REFERENCE': '艺人名称限制',
    'MUSIC_CONTENT_REJECTED': '内容审核', 'VIDEO_CONTENT_REJECTED': '内容审核',
    'MUSIC_PROVIDER_TIMEOUT': '服务超时', 'IMAGE_PROVIDER_TIMEOUT': '服务超时',
    'VIDEO_PROVIDER_TIMEOUT': '服务超时', 'PROVIDER_TIMEOUT': '服务超时',
    'VIDEO_REFERENCE_RESOLUTION': '参考素材尺寸', 'VIDEO_REFERENCE_INVALID': '参考素材不符',
    'VIDEO_REFERENCE_DURATION': '参考素材时长',
    'VIDEO_OMNI_FRAME_INVALID': '首尾帧参数', 'VIDEO_CONTINUATION_INVALID': '续写源任务',
    'REFERENCE_UPLOAD_FAILED': '参考图上传失败', 'VIDEO_TASK_CONSTRAINT': '视频任务参数不符',
    'REFERENCE_UPLOAD_QUOTA_EXCEEDED': '参考素材上传额度已用尽',
    'REFERENCE_UPLOAD_RATE_LIMITED': '参考图上传被限流',
    'REFERENCE_LINK_UNAVAILABLE': '参考图临时链接不可用',
    'VIDEO_PARAMETER_INVALID': '视频参数不符',
    'MUSIC_PROVIDER_BUSY': '服务繁忙', 'VIDEO_PROVIDER_BUSY': '服务繁忙',
    'MUSIC_PROVIDER_BALANCE': '服务额度不足', 'VIDEO_PROVIDER_BALANCE': '服务额度不足',
    'MUSIC_PROVIDER_PERMISSION': '服务权限', 'VIDEO_PROVIDER_PERMISSION': '服务权限',
}


def explanation(kind, code):
    if kind == 'music' and code in REASONS and code != 'MUSIC_TASK_FAILED':
        reason = REASONS[code]
    elif kind == 'video' and code in {
        'VIDEO_REFERENCE_RESOLUTION', 'VIDEO_REFERENCE_DURATION', 'VIDEO_REFERENCE_INVALID', 'VIDEO_TASK_CONSTRAINT', 'VIDEO_PARAMETER_INVALID',
        'VIDEO_DRAFT_INVALID', 'VIDEO_CONTENT_REJECTED', 'VIDEO_PROVIDER_BALANCE',
        'VIDEO_PROVIDER_PERMISSION', 'VIDEO_PROVIDER_BUSY', 'VIDEO_PROVIDER_TIMEOUT',
        'VIDEO_OMNI_FRAME_INVALID', 'VIDEO_CONTINUATION_INVALID',
    }:
        reason = video_failure(code)[1]
    elif kind == 'image' and code in {'IMAGE_PROVIDER_TIMEOUT', 'PROVIDER_TIMEOUT'}:
        reason = IMAGE_TIMEOUT
    elif kind == 'image' and code in REFERENCE_FAILURE_REASONS:
        reason = REFERENCE_FAILURE_REASONS[code]
    else:
        return '原因未记录', '未记录可识别的具体原因，请结合请求编号核对。'
    return LABELS.get(code, '生成参数或素材限制'), reason


def enrich_overview(data):
    # Existing RPC fields remain intact; no extra queries or provider calls.
    result = dict(data)
    for field, kind in [('jobs', 'music'), ('image_jobs', 'image'), ('video_jobs', 'video')]:
        result[field] = []
        for source in data.get(field) or []:
            row = dict(source)
            if row.get('error_code') and not re.fullmatch(r'[A-Z][A-Z0-9_]{1,79}', str(row['error_code'])):
                row['error_code'] = 'UNCLASSIFIED'
            if row.get('status') in {'failed', 'refunded'}:
                row['failure_label'], row['failure_reason'] = explanation(kind, row.get('error_code'))
            result[field].append(row)
    if 'failure_counts' in data:
        result['failure_counts'] = []
        for source in data.get('failure_counts') or []:
            label, reason = explanation(source.get('kind'), source.get('error_code'))
            # Group diagnostics never need raw upstream text/identifiers.
            result['failure_counts'].append({'kind': source.get('kind'), 'count': source.get('count', 0), 'label': label, 'reason': reason})
    return result
