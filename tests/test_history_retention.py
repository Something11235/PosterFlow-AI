import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from backend import server


class HistoryRetentionTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 8, 12, 12, 0, tzinfo=timezone.utc)

    def entry(self, entry_id, timestamp, images=None):
        return {
            "id": entry_id,
            "timestamp": timestamp,
            "images": images or [],
        }

    def test_partitions_entries_around_retention_boundary(self):
        recent = self.entry("recent", (self.now - timedelta(days=29)).isoformat())
        boundary = self.entry("boundary", (self.now - timedelta(days=30)).isoformat())
        old = self.entry("old", (self.now - timedelta(days=30, seconds=1)).isoformat())

        retained, expired = server.partition_expired_history([recent, boundary, old], now=self.now)

        self.assertEqual([item["id"] for item in retained], ["recent", "boundary"])
        self.assertEqual([item["id"] for item in expired], ["old"])

    def test_supports_z_suffix_and_retains_invalid_timestamps(self):
        old_z = self.entry("old-z", "2026-07-01T00:00:00Z")
        malformed = self.entry("malformed", "not-a-date")
        missing = {"id": "missing", "images": []}

        retained, expired = server.partition_expired_history([old_z, malformed, missing], now=self.now)

        self.assertEqual([item["id"] for item in retained], ["malformed", "missing"])
        self.assertEqual([item["id"] for item in expired], ["old-z"])

    def test_cleanup_deletes_images_before_rewriting_history(self):
        recent = self.entry("recent", (self.now - timedelta(days=2)).isoformat(), ["recent.png"])
        old = self.entry("old", (self.now - timedelta(days=31)).isoformat(), ["old-a.png", "old-b.png"])
        calls = []

        with (
            patch.object(server, "remove_stored_images", side_effect=lambda names: calls.append(("remove", names))),
            patch.object(server, "write_history", side_effect=lambda history: calls.append(("write", history))),
        ):
            result = server.cleanup_expired_history([recent, old], now=self.now)

        self.assertEqual(result, [recent])
        self.assertEqual(calls, [("remove", ["old-a.png", "old-b.png"]), ("write", [recent])])

    def test_cleanup_preserves_history_when_image_removal_fails(self):
        old = self.entry("old", (self.now - timedelta(days=31)).isoformat(), ["old.png"])

        with (
            patch.object(server, "remove_stored_images", side_effect=OSError("storage unavailable")),
            patch.object(server, "write_history") as write_history,
            patch.object(server.app.logger, "exception") as log_exception,
        ):
            result = server.cleanup_expired_history([old], now=self.now)

        self.assertEqual(result, [old])
        write_history.assert_not_called()
        log_exception.assert_called_once_with("Failed to clean expired generation history")

    def test_saving_entry_prunes_expired_records(self):
        old = self.entry("old", "2000-01-01T00:00:00+00:00", ["old.png"])
        new = self.entry("new", self.now.isoformat(), ["new.png"])

        with (
            patch.object(server, "load_history", return_value=[old]),
            patch.object(server, "remove_stored_images") as remove_images,
            patch.object(server, "write_history") as write_history,
        ):
            server.save_history_entry(new)

        remove_images.assert_called_once_with(["old.png"])
        write_history.assert_called_once_with([new])


if __name__ == "__main__":
    unittest.main()
