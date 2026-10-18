import contextlib
import io
from pathlib import Path
import unittest
from unittest.mock import patch

from scripts import configure_image_retention as setup


class RetentionSetupTests(unittest.TestCase):
    def test_setup_uses_existing_server_credential_without_output(self):
        with (
            patch.object(setup.server, "SUPABASE_STORAGE_ENABLED", True),
            patch.object(setup.server, "SUPABASE_STORAGE_URL", "https://project.supabase.co"),
            patch.object(setup.server, "SUPABASE_STORAGE_BUCKET", "posterflow-images"),
            patch.object(setup.server, "SUPABASE_STORAGE_SERVICE_KEY", "test-server-credential"),
            patch.object(setup.server, "_supabase_storage_request") as storage,
            patch.object(setup.server, "SupabaseGateway") as gateway,
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            gateway.return_value.rpc.return_value = True
            self.assertTrue(setup.configure())
            storage.assert_called_once_with("GET", "/bucket/posterflow-images")
            gateway.return_value.rpc.assert_called_once_with("configure_image_retention", {
                "p_project_url": "https://project.supabase.co",
                "p_bucket": "posterflow-images",
                "p_storage_key": "test-server-credential",
            })
            self.assertEqual(output.getvalue(), "")

    def test_setup_rejects_untrusted_host_before_network(self):
        for url in ("http://project.supabase.co", "https://evil.example", "https://project.supabase.co.evil.example"):
            with (
                self.subTest(url=url),
                patch.object(setup.server, "SUPABASE_STORAGE_ENABLED", True),
                patch.object(setup.server, "SUPABASE_STORAGE_URL", url),
                patch.object(setup.server, "_supabase_storage_request") as request,
            ):
                with self.assertRaises(RuntimeError):
                    setup.configure()
                request.assert_not_called()

    def test_failed_bucket_validation_never_writes_vault_configuration(self):
        with (
            patch.object(setup.server, "SUPABASE_STORAGE_ENABLED", True),
            patch.object(setup.server, "SUPABASE_STORAGE_URL", "https://project.supabase.co"),
            patch.object(setup.server, "_supabase_storage_request", side_effect=RuntimeError("not configured")),
            patch.object(setup.server, "SupabaseGateway") as gateway,
        ):
            with self.assertRaises(RuntimeError):
                setup.configure()
            gateway.assert_not_called()

    def test_cli_never_prints_errors_that_might_contain_credentials(self):
        with (
            patch.object(setup, "configure", side_effect=RuntimeError("sensitive-test-value")),
            contextlib.redirect_stderr(io.StringIO()) as output,
        ):
            self.assertEqual(setup.main(), 1)
            self.assertNotIn("sensitive-test-value", output.getvalue())


class RetentionMigrationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "supabase/migrations/20261018014328_image_retention_24h.sql"
        cls.sql = path.read_text(encoding="utf-8")

    def test_storage_objects_are_not_deleted_with_sql(self):
        self.assertNotRegex(self.sql.lower(), r"delete\s+from\s+storage\.")
        self.assertIn("'DELETE', v_url || '/storage/v1/object/'", self.sql)

    def test_filter_preserves_recent_images_and_unrelated_objects(self):
        self.assertEqual(self.sql.count("created_at < v_cutoff"), 2)
        self.assertIn("statement_timestamp() - interval '24 hours'", self.sql)
        self.assertEqual(self.sql.count("^posterflow/[A-Za-z0-9_-]+/images/[A-Za-z0-9_.-]+[.]png$"), 2)
        self.assertEqual(self.sql.count("bucket_id = v_bucket and created_at < v_cutoff"), 2)

    def test_scheduler_is_hourly_and_initially_disabled(self):
        self.assertIn("'17 * * * *'", self.sql)
        self.assertIn("active := false", self.sql)
        self.assertIn("private.prune_generated_images(false)", self.sql)

    def test_work_is_bounded_and_auth_is_not_public(self):
        self.assertIn("for v_iteration in 1..10 loop", self.sql)
        self.assertIn("order by created_at,name limit 100", self.sql)
        self.assertIn("pg_try_advisory_xact_lock", self.sql)
        self.assertIn("security invoker set search_path = ''", self.sql)
        self.assertIn("revoke all on function private.prune_generated_images(boolean) from public, anon, authenticated, service_role", self.sql)
        self.assertIn("revoke all on function public.configure_image_retention(text,text,text) from public, anon, authenticated", self.sql)


class TwelveHourRetentionMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "supabase/migrations/20261018014700_image_retention_12h.sql"
        cls.sql = path.read_text(encoding="utf-8")

    def test_latest_policy_is_12_hours_with_hourly_checks(self):
        self.assertIn("statement_timestamp() - interval '12 hours'", self.sql)
        self.assertIn("'posterflow-image-retention-12h','17 * * * *'", self.sql)
        self.assertIn("cron.unschedule(jobid)", self.sql)
        self.assertIn("where jobname='posterflow-image-retention-24h'", self.sql)
        self.assertIn("active := false", self.sql)

    def test_latest_policy_preserves_storage_and_permission_safety(self):
        self.assertNotRegex(self.sql.lower(), r"delete\s+from\s+storage\.")
        self.assertEqual(self.sql.count("created_at < v_cutoff"), 2)
        self.assertEqual(self.sql.count("^posterflow/[A-Za-z0-9_-]+/images/[A-Za-z0-9_.-]+[.]png$"), 2)
        self.assertIn("security invoker set search_path = ''", self.sql)
        self.assertIn("from public, anon, authenticated, service_role", self.sql)
        self.assertIn("limit 100", self.sql)


if __name__ == "__main__":
    unittest.main()
