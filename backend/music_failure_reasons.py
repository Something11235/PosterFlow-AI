"""Translate recognized upstream failure categories without exposing raw logs."""
import re
try:
    from backend.generation_failures import error_text, is_timeout
except ModuleNotFoundError:
    from generation_failures import error_text, is_timeout

REASONS = {
    "MUSIC_PARAMETER_TYPE_MISMATCH": "音乐服务返回“请求参数类型不匹配”，未指明具体字段。请保留任务编号联系站主排查。",
    "MUSIC_PROVIDER_JOB_FAILED": "音乐服务返回“任务失败，请稍后再试”，未提供具体失败原因。请保留任务编号，稍后再试或联系站主核查。",
    "MUSIC_AUDIO_MATCH": "参考音频与曲库中已有录音匹配，未通过音频查重。请更换为你拥有使用权且符合服务要求的原创录音。",
    "MUSIC_FLOW_SOURCE_EXPIRED": "改编设置已超过保留期限，请重新添加音频并填写改编描述。",
    "MUSIC_LYRICS_COPYRIGHT": "歌词包含受版权保护的内容，请修改歌词后重试。",
    "MUSIC_AUDIO_COPYRIGHT": "参考音频涉及版权限制，请更换音频后重试。",
    "MUSIC_ARTIST_REFERENCE": "描述中包含不被允许的歌手或艺人名称，请改用曲风、乐器和声音特点描述。",
    "MUSIC_CONTENT_REJECTED": "歌词、描述或参考音频未通过内容审核，请修改后重试。",
    "MUSIC_LYRICS_INVALID": "歌词为空、过长或格式不符合要求，请检查歌词后重试。",
    "MUSIC_AUDIO_INVALID": "参考音频无法读取或格式不受支持，请更换音频后重试。",
    "MUSIC_AUDIO_DURATION": "参考音频或目标时长不符合要求，请调整时长后重试。",
    "MUSIC_PROVIDER_BUSY": "音乐服务当前繁忙或请求过多，请稍后重试。",
    "MUSIC_PROVIDER_BALANCE": "音乐服务的可用额度不足，请联系站主；自带 Key 用户请检查服务余额。",
    "MUSIC_PROVIDER_PERMISSION": "音乐服务的密钥或模型权限不可用，请联系站主；自带 Key 用户请检查配置。",
    "MUSIC_PROVIDER_TIMEOUT": "音乐服务未能在规定时间内完成生成，请稍后重试。",
    "MUSIC_TASK_FAILED": "音乐生成未完成，服务未提供可识别的具体原因。请保留任务编号核对。",
}
PATTERNS = (
    ("MUSIC_PARAMETER_TYPE_MISMATCH", r"request\s+parameter\s+type\s+mismatch|(?:parameter|field|argument).{0,60}type\s*(?:mismatch|does\s+not\s+match)|cannot\s+unmarshal.{0,160}(?:into|type)|参数.{0,20}类型.{0,20}(?:不匹配|错误|不符)"),
    ("MUSIC_AUDIO_MATCH", r"(?:audio|recording).{0,100}matches?\s+(?:an?\s+)?existing\s+recording|(?:audio|recording).{0,100}(?:already\s+exists?\s+in|matches?.{0,40})\s*(?:our\s+)?catalog|音频.{0,60}(?:已有录音|曲库|查重)"),
    ("MUSIC_LYRICS_COPYRIGHT", r"(?:lyric|歌词).{0,120}(?:copyright|版权)|copyrighted\s+(?:material|lyrics)"),
    ("MUSIC_AUDIO_COPYRIGHT", r"(?:audio|song|音频|歌曲).{0,100}(?:copyright|版权)|copyright"),
    ("MUSIC_ARTIST_REFERENCE", r"artist.{0,50}name|歌手.{0,30}(?:名字|名称)|艺人"),
    ("MUSIC_PROVIDER_BALANCE", r"insufficient.{0,25}(?:quota|credit|balance)|quota_not_enough|余额不足|额度不足"),
    ("MUSIC_PROVIDER_PERMISSION", r"invalid_api_key|authentication_error|permission_error|\binvalid\s+(?:api\s+)?key\b|unauthorized|密钥无效|无权限"),
    ("MUSIC_CONTENT_REJECTED", r"moderat|content.{0,30}(?:policy|reject|block)|内容审核|违禁|敏感"),
    ("MUSIC_LYRICS_INVALID", r"lyric.{0,50}(?:long|empty|invalid)|歌词.{0,30}(?:过长|为空|格式)"),
    ("MUSIC_AUDIO_DURATION", r"(?:audio|duration|时长).{0,40}(?:short|long|invalid|不符合|不足|超出)"),
    ("MUSIC_AUDIO_INVALID", r"(?:audio|音频).{0,50}(?:invalid|download|unsupported|unavailable|无法|格式)"),
    ("MUSIC_PROVIDER_BUSY", r"rate_limit|too many requests|overload|capacity|繁忙|请求过多"),
    ("MUSIC_PROVIDER_TIMEOUT", r"timed?\s*out|timeout|超时"),
    ("MUSIC_PROVIDER_JOB_FAILED", r"job\s+failed\s*[,，.]\s*please\s+try\s+again\s+later"),
)

def failure_code(error):
    content = error_text(error)
    if content in REASONS:
        return content
    if is_timeout(error):
        return "MUSIC_PROVIDER_TIMEOUT"
    for code, pattern in PATTERNS:
        if re.search(pattern, content, re.IGNORECASE | re.DOTALL):
            return code
    return "MUSIC_TASK_FAILED"

def failure_reason(code):
    return REASONS.get(code, REASONS["MUSIC_TASK_FAILED"])
