"""History cursor and bounded thumbnail metadata; never stores media URLs."""
import base64
import json
import uuid
from datetime import datetime, timedelta, timezone
import re

HISTORY_DAYS = 7
HISTORY_PAGE_SIZE = 50
HISTORY_PREVIEW_HOURS = 12
MUSIC_HISTORY_FIELDS = {"model", "version", "parameter_format", "custom", "instrumental", "prompt", "sound_prompt", "lyrics", "title", "style", "negative_tags", "operation", "strength"}


def history_preview_expiry(created_at, now=None):
    now = now or datetime.now(timezone.utc)
    try:
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        if created.tzinfo is None or not now - timedelta(hours=HISTORY_PREVIEW_HOURS) < created <= now:
            return None
        return (created + timedelta(hours=HISTORY_PREVIEW_HOURS)).astimezone(timezone.utc).isoformat()
    except (TypeError, ValueError, AttributeError):
        return None


def history_preview_metadata(row, now=None):
    expires = history_preview_expiry(row.get("created_at"), now)
    names = row.get("image_keys")
    if not expires or not isinstance(names, list):
        return None
    names = list(dict.fromkeys(name for name in names if isinstance(name, str)
        and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,180}\.(?:png|gif)", name)
        and not name.startswith("_thumb_")))[:4]
    return {"filenames": names, "expires_at": expires} if names else None


def music_prompt_snapshot(parameters):
    clean = {key: value for key, value in parameters.items() if key in MUSIC_HISTORY_FIELDS and isinstance(value, (str, bool))}
    parts = [f"{label}：{clean[key]}" for key, label in (("title", "标题"), ("prompt", "描述或歌词"), ("sound_prompt", "音乐描述"), ("lyrics", "歌词"), ("style", "风格"), ("negative_tags", "排除风格")) if clean.get(key)]
    label = {"inspo": "参考音频创作", "upload_cover": "音频改编", "flow_cover": "Flow 音频改编"}.get(clean.get("operation"))
    return {"prompt": "\n\n".join(([label] if label else []) + parts) or "纯音乐", "parameters": clean}


def video_history_parameters(parameters):
    try:
        from backend.video_provider import normalized_video_parameters, VideoError
    except ModuleNotFoundError:
        from video_provider import normalized_video_parameters, VideoError
    allowed = {'model','prompt','duration','size','resolution','seed','generate_audio','return_last_frame','tools','nsfw_check',
               'draft','draft_request_id','output_format','watermark','omni_reference_task_type','aspect_ratio','task','continue_request_id','audio','safety_tolerance'}
    clean = {k:v for k,v in parameters.items() if k in allowed} if isinstance(parameters,dict) else {}
    try:
        return normalized_video_parameters(clean)
    except VideoError:
        return {'model':'seedance-2.0-mini','prompt':str(clean.get('prompt',''))[:32000]}


def history_cursor(row):
    value = json.dumps({"before": row["created_at"], "id": row["id"]}, separators=(",", ":"))
    return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


def parse_history_cursor(value):
    if not value:
        return None
    try:
        if len(value) > 512:
            raise ValueError("cursor too long")
        data = json.loads(base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True))
        timestamp = datetime.fromisoformat(data["before"].replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            raise ValueError("timezone required")
        return timestamp.astimezone(timezone.utc).isoformat(), str(uuid.UUID(data["id"]))
    except (TypeError, KeyError, ValueError, AttributeError, UnicodeError) as exc:
        raise ValueError("invalid history cursor") from exc
