import unittest
from unittest.mock import patch

from backend import grok_region as region
from backend.apimart_image_provider import ImageTaskError

POLYGON=[{"outer":{"points":[0.1,0.1,0.9,0.1,0.9,0.9,0.1,0.9]}}]


class GrokRegionTests(unittest.TestCase):
    def test_receipts_bind_owner_key_stage_and_expiry(self):
        receipt=region.proof("synthetic", "owner-one", "asset", "asset_123")
        self.assertEqual(region.read_proof("synthetic","owner-one","asset",receipt),"asset_123")
        for key,owner,kind,value in [("other","owner-one","asset",receipt),("synthetic","other","asset",receipt),("synthetic","owner-one","task",receipt),("synthetic","owner-one","asset",receipt+"x")]:
            with self.assertRaises(ImageTaskError):region.read_proof(key,owner,kind,value)
        with patch.object(region.time,"time",return_value=9999999999):
            with self.assertRaises(ImageTaskError):region.read_proof("synthetic","owner-one","asset",receipt)

    def test_paid_request_uses_only_verified_asset_and_whitelisted_parameters(self):
        receipt=region.proof("synthetic","owner","asset","asset_123")
        body=region.build_request({"prompt":"edit", "segment_receipt":receipt,"selection_regions":POLYGON,"image_id":"foreign","webhook":"https://invalid.example"},"synthetic","owner")
        self.assertEqual(body["image_id"],"asset_123")
        self.assertEqual(body["n"],1)
        self.assertNotIn("image_urls",body)
        self.assertNotIn("webhook",body)

    def test_invalid_or_crossing_regions_are_rejected_before_submission(self):
        self.assertEqual(region.selection_regions(POLYGON),POLYGON)
        for points in [[0,0,1,1,1,0,0,1],[0,0,0,0,1,1],[0,0,1,0,2,1],[0,0,float('nan'),0,1,1],[0,0,0.5,0,1,0]]:
            with self.subTest(points=points),self.assertRaises(ImageTaskError):region.selection_regions([{"outer":{"points":points}}])
