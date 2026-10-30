"""Account-scoped Grok region edit proofs and strict polygon validation."""
import base64
import hashlib
import hmac
import json
import math
import re
import time

try:
    from backend.apimart_image_provider import ImageTaskError
except ModuleNotFoundError:
    from apimart_image_provider import ImageTaskError

MODEL = "grok-imagine-2.0-ext"


def proof(key, owner, kind, value):
    payload = json.dumps({"owner": hashlib.sha256(owner.encode()).hexdigest(), "kind": kind,
                          "value": value, "expires": int(time.time()) + 3600}, sort_keys=True, separators=(",", ":")).encode()
    encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
    signature = hmac.new(key.encode(), b"posterflow-grok-region-v1:" + encoded.encode(), hashlib.sha256).hexdigest()
    return encoded + "." + signature


def read_proof(key, owner, kind, receipt):
    try:
        if not isinstance(receipt, str) or len(receipt) > 4096:
            raise ValueError()
        encoded, signature = receipt.split(".")
        expected = hmac.new(key.encode(), b"posterflow-grok-region-v1:" + encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError()
        data = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        if data["owner"] != hashlib.sha256(owner.encode()).hexdigest() or data["kind"] != kind or data["expires"] < time.time():
            raise ValueError()
        value = data["value"]
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", value):
            raise ValueError()
        return value
    except Exception:
        raise ImageTaskError("IMAGE_REGION_EXPIRED", "选区原图已失效或不属于当前账户，请重新选择原图。") from None


def selection_regions(value):
    def invalid():
        raise ImageTaskError("IMAGE_REGION_INVALID", "请选择图片内有效的矩形或圆形选区，每次最多 16 个。")

    if not isinstance(value, list) or not 1 <= len(value) <= 16:
        invalid()
    result = []
    for region in value:
        if not isinstance(region, dict) or set(region) != {"outer"} or not isinstance(region["outer"], dict):
            invalid()
        flat = region["outer"].get("points")
        if not isinstance(flat, list) or not 6 <= len(flat) <= 800 or len(flat) % 2:
            invalid()
        if any(type(number) not in (int, float) or not math.isfinite(number) or not 0 <= number <= 1 for number in flat):
            invalid()
        points = list(zip(flat[::2], flat[1::2]))
        if len(set(points)) != len(points):
            invalid()
        # Canvas only emits convex transformed/clipped rectangles and ellipses.
        # Enforce convexity and reject crossings rather than forwarding geometry
        # that the paid upstream may reject.
        turns = []
        for index, a in enumerate(points):
            b, c = points[(index + 1) % len(points)], points[(index + 2) % len(points)]
            turn = (b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0])
            if abs(turn) > 1e-12:
                turns.append(turn > 0)
        area = abs(sum(a[0]*points[(index+1)%len(points)][1]-a[1]*points[(index+1)%len(points)][0] for index,a in enumerate(points)))
        if not turns or any(turn != turns[0] for turn in turns) or area < 1e-8:
            invalid()
        # All other vertices must lie on the same side of every boundary edge.
        for index,a in enumerate(points):
            b=points[(index+1)%len(points)]
            crosses=[(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]) for c in points]
            if min(crosses) < -1e-10 and max(crosses) > 1e-10:
                invalid()
        result.append({"outer": {"points": flat}})
    return result


def build_request(data, key, owner):
    prompt = data.get("prompt")
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 6000 or data.get("count", 1) != 1:
        raise ImageTaskError("IMAGE_REGION_INVALID", "选区编辑每次生成一张，请填写 1–6000 字修改要求。")
    return {"model": MODEL, "operation": "region_edit", "prompt": prompt.strip(), "n": 1,
            "image_id": read_proof(key, owner, "asset", data.get("segment_receipt")),
            "selection_regions": selection_regions(data.get("selection_regions")), "response_format": "url"}
