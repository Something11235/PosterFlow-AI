import base64
import io
import unittest

from PIL import Image
from backend.image_edit_mask import validate_edit_mask


def encoded_image(mode="RGBA", size=(64, 48), alpha=0, format="PNG"):
    image = Image.new(mode, size, (0, 0, 0, alpha) if mode == "RGBA" else (0, 0, 0))
    output = io.BytesIO()
    image.save(output, format=format)
    return base64.b64encode(output.getvalue()).decode("ascii")


class EditMaskTests(unittest.TestCase):
    def test_accepts_alpha_png_matching_first_image(self):
        validate_edit_mask(encoded_image(), encoded_image("RGB"))

    def test_rejects_opaque_missing_alpha_mismatched_dimensions_and_wrong_format(self):
        for mask in [encoded_image(alpha=255), encoded_image("RGB"), encoded_image(size=(32, 24)), encoded_image("RGB", format="JPEG"), "not-base64"]:
            with self.subTest(mask_length=len(mask)), self.assertRaises(ValueError):
                validate_edit_mask(mask, encoded_image())

    def test_rejects_oversized_mask_before_decoding_image(self):
        with self.assertRaises(ValueError):
            validate_edit_mask(base64.b64encode(b"x" * (4 * 1024 * 1024)).decode(), encoded_image())
