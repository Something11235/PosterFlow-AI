"""Text-only history cursor helpers; never accepts provider or image fields."""
import base64
import json
import uuid
from datetime import datetime, timezone

HISTORY_DAYS = 7
HISTORY_PAGE_SIZE = 50


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
