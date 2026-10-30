"""Validate edit masks before credit reservation; never repair silently."""
import base64
import io

from PIL import Image


def validate_edit_mask(mask_b64, reference_b64):
    try:
        raw = base64.b64decode(mask_b64, validate=True)
        if not raw or len(raw) >= 4 * 1024 * 1024:
            raise ValueError()
        with Image.open(io.BytesIO(base64.b64decode(reference_b64, validate=True))) as reference:
            size = reference.size
        with Image.open(io.BytesIO(raw)) as mask:
            if mask.format != "PNG" or mask.size != size or not 0 < mask.width * mask.height <= 40_000_000:
                raise ValueError()
            if "A" not in mask.getbands():
                raise ValueError()
            mask.load()
            if mask.getchannel("A").getextrema()[0] != 0:
                raise ValueError()
    except Exception:
        raise ValueError("蒙版须为小于 4 MB、与主图同像素尺寸的 PNG，且修改区域必须完全透明。请重新导出画布选区。") from None
