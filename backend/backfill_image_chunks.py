"""Load (or rebuild) prd.DIM_UI_MONEY_MAPPING_IMAGE_CHUNKS from the photos on SFTP.

The app writes a capture's image chunks at submit time, so this is only needed to
backfill captures taken before that existed, or to rebuild everything after
changing the recipe in image_chunks.py.

    python backfill_image_chunks.py              # captures that have no chunks yet
    python backfill_image_chunks.py --dry-run    # list what would be loaded, change nothing
    python backfill_image_chunks.py --rebuild    # regenerate chunks for every capture

Safe to run while the API is up: it touches only Fabric and SFTP (not the local
DuckDB file) and each capture is replaced in its own transaction.
"""
import argparse
import os
import sys
from datetime import datetime
from pathlib import Path

import pyodbc
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / '.env')

import sftp_storage  # noqa: E402 — reads SFTP_* env vars at import, must follow load_dotenv()
from image_chunks import build_chunks  # noqa: E402


def connect():
    return pyodbc.connect(
        f"Driver={{ODBC Driver 18 for SQL Server}};"
        f"Server={os.environ['FABRIC_DB_HOST']},{os.environ.get('FABRIC_DB_PORT', 1433)};"
        f"Database={os.environ['FABRIC_DB_NAME']};"
        "Authentication=ActiveDirectoryPassword;"
        f"UID={os.environ['FABRIC_DB_USER']};PWD={os.environ['FABRIC_DB_PASS']};"
        "Encrypt=yes;TrustServerCertificate=no;",
        timeout=120,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rebuild', action='store_true', help='regenerate chunks for every capture, not just missing ones')
    ap.add_argument('--dry-run', action='store_true', help='show what would be loaded and change nothing')
    args = ap.parse_args()

    conn = connect()
    conn.autocommit = False
    cur = conn.cursor()

    cur.execute("SELECT CAPTURE_ID, PHOTO_PATH FROM prd.DIM_UI_MONEY_MAPPING_CAPTURE ORDER BY CAPTURED_AT")
    captures = [(r[0], r[1]) for r in cur.fetchall()]
    cur.execute("SELECT DISTINCT CAPTURE_ID FROM prd.DIM_UI_MONEY_MAPPING_IMAGE_CHUNKS")
    have = {r[0] for r in cur.fetchall()}

    todo = [(cid, path) for cid, path in captures if args.rebuild or cid not in have]
    print(f"{len(captures)} captures, {len(have)} already have chunks -> {len(todo)} to load"
          f"{' (rebuild)' if args.rebuild else ''}{' [dry run]' if args.dry_run else ''}")
    if args.dry_run:
        return 0

    done = failed = rows_written = 0
    for cid, path in todo:
        try:
            chunks = build_chunks(sftp_storage.download(path))
            load_run_date = datetime.utcnow().strftime('%Y%m%d%H%M%S')
            cur.execute("DELETE FROM prd.DIM_UI_MONEY_MAPPING_IMAGE_CHUNKS WHERE CAPTURE_ID=?", [cid])
            cur.fast_executemany = True
            cur.executemany(
                "INSERT INTO prd.DIM_UI_MONEY_MAPPING_IMAGE_CHUNKS (CAPTURE_ID, CHUNK_INDEX, CHUNK, LOAD_RUN_DATE) VALUES (?, ?, ?, ?)",
                [[cid, i, c, load_run_date] for i, c in enumerate(chunks)],
            )
            conn.commit()
            done += 1
            rows_written += len(chunks)
        except Exception as e:  # keep going; report at the end
            conn.rollback()
            failed += 1
            print(f"  FAILED {cid} ({path}): {type(e).__name__}: {str(e)[:120]}")

    print(f"done: {done} captures loaded ({rows_written} chunk rows), {failed} failed")
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
