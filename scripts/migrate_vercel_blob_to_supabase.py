"""Copy PosterFlow image objects from Vercel Blob to private Supabase Storage."""

import argparse
from pathlib import Path
import sys

# Make the script runnable as `python scripts/...py` from the project root.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend import server


def iter_blob_objects():
    cursor = None
    while True:
        page = server._blob_list("posterflow/", cursor)
        for blob in page.get("blobs", []):
            pathname = str(blob.get("pathname") or "").strip()
            if pathname:
                yield pathname
        if not page.get("hasMore"):
            return
        next_cursor = page.get("cursor")
        if not next_cursor or next_cursor == cursor:
            raise RuntimeError("Vercel Blob returned an invalid pagination cursor")
        cursor = next_cursor


def migrate(execute=False, delete_source=False):
    if not server.BLOB_STORAGE_ENABLED:
        raise RuntimeError("BLOB_READ_WRITE_TOKEN is not configured")
    if not server.SUPABASE_STORAGE_ENABLED:
        raise RuntimeError("Supabase Storage server configuration is incomplete")

    totals = {"found": 0, "copied": 0, "failed": 0, "deleted": 0}
    for pathname in iter_blob_objects():
        totals["found"] += 1
        if not execute:
            continue
        try:
            source = server._blob_download(pathname)
            content_type = source.headers.get("content-type", "application/octet-stream")
            server._supabase_put(pathname, source.content, content_type)
            totals["copied"] += 1
            if delete_source:
                server._blob_delete([source.url or pathname])
                totals["deleted"] += 1
        except Exception:
            totals["failed"] += 1
            print(f"FAILED {pathname}", file=sys.stderr)

    return totals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="List the number of matching objects only")
    mode.add_argument("--execute", action="store_true", help="Copy matching objects to Supabase Storage")
    parser.add_argument(
        "--delete-source",
        action="store_true",
        help="Delete each Vercel Blob object after its Supabase copy succeeds",
    )
    args = parser.parse_args()
    if args.delete_source and not args.execute:
        parser.error("--delete-source requires --execute")

    try:
        totals = migrate(execute=args.execute, delete_source=args.delete_source)
    except Exception as error:
        print(f"Migration stopped: {error}", file=sys.stderr)
        return 1

    print(
        "Objects found: {found}; copied: {copied}; failed: {failed}; deleted from source: {deleted}".format(
            **totals
        )
    )
    return 1 if totals["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
