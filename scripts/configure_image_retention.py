"""Configure the encrypted retention credential without printing secrets.

This does not enable cron or delete images. Apply the migration first, run this
script, verify the private cleanup function, then activate cron as postgres.
"""
from pathlib import Path
import re
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend import server


def configure():
    if not server.SUPABASE_STORAGE_ENABLED:
        raise RuntimeError("Supabase server configuration is incomplete")
    if not re.fullmatch(r"https://[a-z0-9]+\.supabase\.co", server.SUPABASE_STORAGE_URL):
        raise RuntimeError("A hosted Supabase HTTPS URL is required")
    # Confirm the existing environment credential reaches the intended bucket.
    server._supabase_storage_request("GET", "/bucket/" + server.SUPABASE_STORAGE_BUCKET)
    result = server.SupabaseGateway().rpc("configure_image_retention", {
        "p_project_url": server.SUPABASE_STORAGE_URL,
        "p_bucket": server.SUPABASE_STORAGE_BUCKET,
        "p_storage_key": server.SUPABASE_STORAGE_SERVICE_KEY,
    })
    if result is not True:
        raise RuntimeError("Retention configuration was not confirmed")
    return True


def main():
    try:
        configure()
    except Exception:
        # Never print exceptions or request bodies which may contain secrets.
        print("Retention setup failed; verify the migration and server environment.", file=sys.stderr)
        return 1
    print("Retention credential configured in Supabase Vault. Cron activation is separate.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
