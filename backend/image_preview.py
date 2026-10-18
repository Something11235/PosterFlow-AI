"""Small, disposable gallery previews; original image bytes are never changed."""
import io
import warnings

from PIL import Image, ImageOps


PREVIEW_MAX_EDGE = 512
PREVIEW_MAX_PIXELS = 20_000_000


def preview_filename(filename):
    return "_thumb_" + filename


def create_image_preview(content):
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(content)) as image:
            if image.width * image.height > PREVIEW_MAX_PIXELS:
                raise ValueError("Preview pixel limit exceeded")
            image = ImageOps.exif_transpose(image)
            image.thumbnail((PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE), Image.Resampling.LANCZOS)
            # A genuine PNG sidecar matches the existing 12h cleanup rule.
            # Palette quantization affects previews only, including transparency.
            image = image.convert("RGBA").quantize(colors=128, method=Image.Quantize.FASTOCTREE)
            output = io.BytesIO()
            image.save(output, format="PNG", optimize=True)
            return output.getvalue()
