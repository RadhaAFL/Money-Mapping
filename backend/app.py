"""
Money Mapping API — store fixture-capture, HO review, and planogram uploads.
Standalone app (own DuckDB for access control), writes/reads capture and
planogram data directly against Microsoft Fabric Warehouse so Power BI can
connect to it with no extra pipeline. Modeled on the auth/Fabric/RLS
conventions already proven in the SEMANTIC-LAYER app, purpose-built rather
than generic since this app only ever does one thing.
Runs on port 5002, proxied by Apache at /moneymapping-api/
"""
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from werkzeug.utils import secure_filename
import duckdb
import io
import json
import os
import pyodbc
import threading
import traceback
import uuid
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

app = Flask(__name__)
CORS(app)
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024  # 20 MiB — one resized capture photo

# ── Local data paths ───────────────────────────────────────────────────────
# Capture photos and planogram files live on the org's SFTP server
# (sftp_storage.py), not on this disk — only DuckDB's own small admin/audit
# tables are local.
DATA_ROOT = os.path.join(os.path.dirname(__file__), '..', 'data')
DB_PATH   = os.path.join(DATA_ROOT, 'app.duckdb')

# Single persistent DuckDB connection + lock — same convention as
# SEMANTIC-LAYER's get_con()/_db_lock (DuckDB files are single-writer).
_db_lock = threading.Lock()
_db_con: "duckdb.DuckDBPyConnection | None" = None


def get_con() -> "duckdb.DuckDBPyConnection":
    global _db_con
    if _db_con is None:
        _db_con = duckdb.connect(DB_PATH)
    return _db_con


# ── Fabric Warehouse (SQL Server / ODBC) ──────────────────────────────────
load_dotenv(Path(__file__).resolve().parent.parent / '.env')

import sftp_storage as storage  # noqa: E402 — reads SFTP_* env vars at import, must follow load_dotenv()

_FAB_HOST = os.environ.get('FABRIC_DB_HOST', '')
_FAB_PORT = int(os.environ.get('FABRIC_DB_PORT', 1433))
_FAB_DB   = os.environ.get('FABRIC_DB_NAME', '')
_FAB_USER = os.environ.get('FABRIC_DB_USER', '')
_FAB_PASS = os.environ.get('FABRIC_DB_PASS', '')


def _fab_conn():
    """Open a new ODBC connection to Microsoft Fabric. Same shape as
    SEMANTIC-LAYER's _fab_conn() — one connection per request, closed in a
    finally block by each caller."""
    return pyodbc.connect(
        f"Driver={{ODBC Driver 18 for SQL Server}};"
        f"Server={_FAB_HOST},{_FAB_PORT};Database={_FAB_DB};"
        "Authentication=ActiveDirectoryPassword;"
        f"UID={_FAB_USER};PWD={_FAB_PASS};"
        "Encrypt=yes;TrustServerCertificate=no;",
        timeout=120,
    )


FIXTURE_TYPES = [
    "Facade", "Wall", "Hang Rail", "Table", "CTM Table", "CTM Wall", "Denim Table",
    "Denim Wall", "Laundered Black", "Mannequin / Window",
]

CATEGORIES = [
    "Jeans", "Shirts", "Crew", "Collared Tee",
    "Non-denim & Shorts", "Sweatshirts", "Jackets", "Others",
]

BOOTSTRAP_ADMIN = "radhakishan.thakur@arvindfashions.com"


def init_db():
    con = get_con()
    con.execute("CREATE TABLE IF NOT EXISTS admins (email VARCHAR PRIMARY KEY)")
    con.execute("""
        CREATE TABLE IF NOT EXISTS audit_logs (
            id      INTEGER,
            ts      TIMESTAMP,
            email   VARCHAR,
            name    VARCHAR,
            action  VARCHAR,
            details VARCHAR
        )
    """)
    if con.execute("SELECT COUNT(*) FROM admins").fetchone()[0] == 0:
        con.execute("INSERT INTO admins VALUES (?)", [BOOTSTRAP_ADMIN])


def _now_str() -> str:
    return datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')


def _load_run_date() -> str:
    return datetime.utcnow().strftime('%Y%m%d%H%M%S')


def _is_admin(email: str) -> bool:
    email = (email or '').strip().lower()
    if not email:
        return False
    with _db_lock:
        row = get_con().execute(
            "SELECT 1 FROM admins WHERE LOWER(email)=?", [email]
        ).fetchone()
    return row is not None


def _require_admin():
    """Mirrors SEMANTIC-LAYER's _require_admin(). Deliberately reads
    'caller_email' rather than 'email' — some admin endpoints also carry a
    target user's 'email' in the same request, and conflating the two would
    let the admin-check accidentally run against the target instead of the
    actual caller."""
    if request.method in ('POST', 'PUT', 'PATCH'):
        email = request.form.get('caller_email', '') or (request.get_json(silent=True) or {}).get('caller_email', '') or request.args.get('caller_email', '')
    else:
        email = request.args.get('caller_email', '')
    if not _is_admin(email):
        return jsonify({"error": "Admin access required"}), 403
    return None


def _normalize_store_code(raw: str) -> str:
    """dbo.DIM_RLS.STORE carries channel-variant prefixes around the same
    physical store code ('NON-8172', 'O8172', 'T8172', plain '8172') — strip
    them so all variants of one store resolve to the same code Money Mapping
    uses (XSTORE_STORECODE)."""
    s = (raw or '').strip().upper()
    if s.startswith('NON-'):
        return s[4:]
    if s[:1] in ('O', 'T') and s[1:].isdigit():
        return s[1:]
    return s


def _pilot_stores() -> set:
    """Store codes currently in the Money Mapping pilot: BRAND='FM' AND
    FORMAT='Fresh' in the org's store master (prd.DIM_FTP_CONSOLIDATED_
    STORE_MASTER_DOOR). While the pilot is scoped to these ~200 stores, no
    other store is usable in this app — not even one with a DIM_RLS match —
    so this gate is applied everywhere store eligibility is decided, admins
    included. Queried live each call (no caching), same convention as
    _stores_for_email()."""
    conn = None
    try:
        conn = _fab_conn()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT DISTINCT X_STORE_CODE
            FROM prd.DIM_FTP_CONSOLIDATED_STORE_MASTER_DOOR
            WHERE UPPER(BRAND) = 'FM' AND UPPER(FORMAT) = 'FRESH'
        """)
        return {_normalize_store_code(str(r[0])) for r in cursor.fetchall() if r[0] is not None}
    except Exception:
        print("Pilot store lookup failed:", traceback.format_exc(), flush=True)
        return set()
    finally:
        if conn is not None:
            conn.close()


def _stores_for_email(email: str) -> set:
    """Store codes this email is the store-side login for, per the org's
    existing dbo.DIM_RLS.EMAIL_ID — the single source of truth for who may
    capture for a store. Deliberately does NOT check the RM/ARM/CM/... columns
    on that table: those grant Power BI *viewing* visibility up the hierarchy,
    not permission to submit a capture as that store. Intersected with the
    pilot store list (see _pilot_stores()) — a DIM_RLS match alone is not
    enough while the pilot is scoped to ~200 stores."""
    email = (email or '').strip().lower()
    if not email:
        return set()
    conn = None
    try:
        conn = _fab_conn()
        cursor = conn.cursor()
        cursor.execute("SELECT DISTINCT STORE FROM dbo.DIM_RLS WHERE LOWER(EMAIL_ID) = ?", [email])
        stores = {_normalize_store_code(r[0]) for r in cursor.fetchall() if r[0]}
    except Exception:
        print("DIM_RLS lookup failed:", traceback.format_exc(), flush=True)
        return set()
    finally:
        if conn is not None:
            conn.close()
    return stores & _pilot_stores()


def _check_store_access(email: str, store_code: str) -> bool:
    """True if store_code is a pilot store AND (caller is admin, or
    store_code is among the stores dbo.DIM_RLS lists that email's EMAIL_ID
    against). False (never implicitly-allow) if either check comes up
    empty — a user with no matching row, or a store outside the pilot,
    must not be able to submit for that store."""
    store_code = _normalize_store_code(store_code)
    if not store_code:
        return False
    if _is_admin(email):
        return store_code in _pilot_stores()
    return store_code in _stores_for_email(email)


# ── Access endpoints ───────────────────────────────────────────────────────

@app.route('/check-access', methods=['GET'])
def check_access():
    email = request.args.get('email', '').strip().lower()
    if not email:
        return jsonify({"allowed": False}), 400
    is_admin = _is_admin(email)
    store_codes = [] if is_admin else sorted(_stores_for_email(email))
    allowed = is_admin or bool(store_codes)
    return jsonify({"allowed": allowed, "is_admin": is_admin, "store_codes": store_codes})


@app.route('/fixture-types', methods=['GET'])
def fixture_types():
    return jsonify({"fixture_types": FIXTURE_TYPES})


@app.route('/categories', methods=['GET'])
def categories():
    return jsonify({"categories": CATEGORIES})


@app.route('/stores', methods=['GET'])
def list_stores():
    """Admin-only: every pilot store (see _pilot_stores()). Lets an admin
    capture on behalf of any pilot store (they already bypass
    _check_store_access's DIM_RLS check, but not its pilot check) without
    needing their own EMAIL_ID row in dbo.DIM_RLS."""
    email = request.args.get('email', '').strip().lower()
    if not _is_admin(email):
        return jsonify({"error": "Admin access required"}), 403
    return jsonify({"stores": sorted(_pilot_stores())})


# ── Captures ────────────────────────────────────────────────────────────────

@app.route('/captures', methods=['POST'])
def submit_capture():
    email      = request.form.get('email', '').strip().lower()
    name       = request.form.get('name', '')
    store_code = _normalize_store_code(request.form.get('store_code', ''))
    sap_code   = request.form.get('sap_store_code', '').strip()
    brand      = request.form.get('brand', 'FLYING MACHINE').strip().upper()
    fixture    = request.form.get('fixture_type', '').strip()
    fixture_label = request.form.get('fixture_label', '').strip() or None
    bays_raw   = request.form.get('bays', '').strip()
    styles_raw = request.form.get('styles', '[]')
    photo      = request.files.get('photo')

    if not _check_store_access(email, store_code):
        return jsonify({"error": "You do not have access to submit captures for this store"}), 403
    if fixture not in FIXTURE_TYPES:
        return jsonify({"error": f"Unknown fixture_type: {fixture}"}), 400
    if not photo:
        return jsonify({"error": "photo is required"}), 400

    bays = None
    if bays_raw:
        try:
            bays = int(bays_raw)
            if bays < 0:
                raise ValueError
        except ValueError:
            return jsonify({"error": "bays must be a non-negative whole number"}), 400

    try:
        styles = json.loads(styles_raw)
        if not isinstance(styles, list):
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({"error": "styles must be a JSON array"}), 400
    styles = [str(s).strip() for s in styles if str(s).strip()][:500]  # de-noise + cap

    capture_id = uuid.uuid4().hex
    photo_rel_path = '/'.join(['money_mapping', secure_filename(store_code), f"{capture_id}.jpg"])
    photo_bytes = photo.read()

    conn = None
    uploaded = False
    try:
        storage.upload(photo_bytes, photo_rel_path)
        uploaded = True
        conn = _fab_conn()
        conn.autocommit = True
        cursor = conn.cursor()
        load_run_date = _load_run_date()
        cursor.execute(
            """
            INSERT INTO prd.DIM_UI_MONEY_MAPPING_CAPTURE
                (CAPTURE_ID, XSTORE_STORECODE, SAP_STORECODE, BRAND, FIXTURE_TYPE, FIXTURE_LABEL, BAYS,
                 PHOTO_PATH, STYLE_COUNT, STATUS, CAPTURED_AT,
                 SUBMITTED_BY_EMAIL, SUBMITTED_BY_NAME, LOAD_RUN_DATE)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [capture_id, store_code, sap_code or None, brand, fixture, fixture_label, bays,
             photo_rel_path, len(styles), 'SUBMITTED', datetime.utcnow(),
             email, name, load_run_date]
        )
        if styles:
            rows = [[capture_id, style, idx + 1, load_run_date] for idx, style in enumerate(styles)]
            cursor.fast_executemany = True
            cursor.executemany(
                """
                INSERT INTO prd.DIM_UI_MONEY_MAPPING_CAPTURE_STYLE
                    (CAPTURE_ID, STYLE_BARCODE, SCAN_SEQ, LOAD_RUN_DATE)
                VALUES (?, ?, ?, ?)
                """,
                rows
            )
        cursor.execute(
            "SELECT COUNT(*) FROM prd.DIM_UI_MONEY_MAPPING_CAPTURE WHERE CAPTURE_ID=?",
            [capture_id]
        )
        verified = int(cursor.fetchone()[0])
    except Exception as e:
        # Don't leave an orphaned photo behind if the Fabric write failed.
        if uploaded:
            try:
                storage.delete(photo_rel_path)
            except Exception:
                pass
        print("Capture insert failed:", traceback.format_exc(), flush=True)
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()

    return jsonify({
        "status": "ok",
        "capture_id": capture_id,
        "styles_saved": len(styles),
        "verified": verified,
    })


@app.route('/captures', methods=['GET'])
def list_captures():
    email = request.args.get('email', '').strip().lower()
    if not email:
        return jsonify({"error": "email is required"}), 400
    is_admin = _is_admin(email)
    requested_store = _normalize_store_code(request.args.get('store_code', ''))
    fixture = request.args.get('fixture_type', '').strip()
    from_date = request.args.get('from_date', '')
    to_date = request.args.get('to_date', '')

    if is_admin:
        allowed_stores = None  # no restriction
    else:
        allowed_stores = _stores_for_email(email)
        if not allowed_stores:
            return jsonify({"captures": []})
        # Never trust a client-supplied store filter — intersect with what
        # this caller actually has access to.
        if requested_store:
            allowed_stores = allowed_stores & {requested_store}
            if not allowed_stores:
                return jsonify({"captures": []})

    conditions, params = [], []
    if allowed_stores is not None:
        placeholders = ','.join('?' for _ in allowed_stores)
        conditions.append(f"XSTORE_STORECODE IN ({placeholders})")
        params.extend(sorted(allowed_stores))
    elif requested_store:
        conditions.append("XSTORE_STORECODE = ?")
        params.append(requested_store)
    if fixture:
        conditions.append("FIXTURE_TYPE = ?")
        params.append(fixture)
    if from_date:
        conditions.append("CAST(CAPTURED_AT AS DATE) >= ?")
        params.append(from_date)
    if to_date:
        conditions.append("CAST(CAPTURED_AT AS DATE) <= ?")
        params.append(to_date)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    conn = None
    try:
        conn = _fab_conn()
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT CAPTURE_ID, XSTORE_STORECODE, BRAND, FIXTURE_TYPE, FIXTURE_LABEL, BAYS, STYLE_COUNT,
                   STATUS, CAPTURED_AT, SUBMITTED_BY_EMAIL, SUBMITTED_BY_NAME
            FROM prd.DIM_UI_MONEY_MAPPING_CAPTURE
            {where}
            ORDER BY CAPTURED_AT DESC
            """,
            params
        )
        captures = [{
            "capture_id": r[0], "store_code": r[1], "brand": r[2], "fixture_type": r[3],
            "fixture_label": r[4], "bays": r[5], "style_count": r[6], "status": r[7], "captured_at": str(r[8]),
            "submitted_by_email": r[9], "submitted_by_name": r[10],
        } for r in cursor.fetchall()]
    except Exception as e:
        print("List captures failed:", traceback.format_exc(), flush=True)
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()

    return jsonify({"captures": captures})


@app.route('/captures/summary', methods=['GET'])
def captures_summary():
    """Admin-only pilot coverage snapshot for the current calendar month:
    total stores in the pilot (see _pilot_stores()), how many of those
    actually have a capture this month, and how many capture rows (walls)
    that adds up to."""
    email = request.args.get('email', '').strip().lower()
    if not _is_admin(email):
        return jsonify({"error": "Admin access required"}), 403

    total_stores = len(_pilot_stores())
    conn = None
    try:
        conn = _fab_conn()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT COUNT(DISTINCT XSTORE_STORECODE), COUNT(*)
            FROM prd.DIM_UI_MONEY_MAPPING_CAPTURE
            WHERE YEAR(CAPTURED_AT) = YEAR(GETUTCDATE()) AND MONTH(CAPTURED_AT) = MONTH(GETUTCDATE())
        """)
        row = cursor.fetchone()
        active_stores, total_captures = (row[0] or 0, row[1] or 0) if row else (0, 0)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()

    return jsonify({
        "month": datetime.utcnow().strftime('%B %Y'),
        "total_stores": total_stores,
        "active_stores": active_stores,
        "total_captures": total_captures,
    })


@app.route('/captures/<capture_id>/styles', methods=['GET'])
def capture_styles(capture_id):
    email = request.args.get('email', '').strip().lower()
    conn = None
    try:
        conn = _fab_conn()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT XSTORE_STORECODE, SUBMITTED_BY_EMAIL FROM prd.DIM_UI_MONEY_MAPPING_CAPTURE WHERE CAPTURE_ID=?",
            [capture_id]
        )
        row = cursor.fetchone()
        if not row:
            return jsonify({"error": "Capture not found"}), 404
        store_code, submitted_by = row
        if not (_is_admin(email) or email == (submitted_by or '').lower() or _check_store_access(email, store_code)):
            return jsonify({"error": "Not authorized"}), 403
        cursor.execute(
            "SELECT STYLE_BARCODE FROM prd.DIM_UI_MONEY_MAPPING_CAPTURE_STYLE WHERE CAPTURE_ID=? ORDER BY SCAN_SEQ",
            [capture_id]
        )
        styles = [r[0] for r in cursor.fetchall()]
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()
    return jsonify({"styles": styles})


@app.route('/captures/<capture_id>/photo', methods=['GET'])
def capture_photo(capture_id):
    email = request.args.get('email', '').strip().lower()
    conn = None
    try:
        conn = _fab_conn()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT PHOTO_PATH, XSTORE_STORECODE, SUBMITTED_BY_EMAIL FROM prd.DIM_UI_MONEY_MAPPING_CAPTURE WHERE CAPTURE_ID=?",
            [capture_id]
        )
        row = cursor.fetchone()
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()

    if not row:
        return jsonify({"error": "Capture not found"}), 404
    photo_path, store_code, submitted_by = row
    if not (_is_admin(email) or email == (submitted_by or '').lower() or _check_store_access(email, store_code)):
        return jsonify({"error": "Not authorized"}), 403

    try:
        photo_bytes = storage.download(photo_path)
    except FileNotFoundError:
        return jsonify({"error": "Photo file missing on storage"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return send_file(io.BytesIO(photo_bytes), mimetype='image/jpeg', as_attachment=False)


# ── Planograms ──────────────────────────────────────────────────────────────

@app.route('/planograms', methods=['POST'])
def upload_planogram():
    """A planogram here is one whole-store blueprint layout (e.g. 'PMC
    Bangalore - Layout'), not split per fixture type — uploading again for
    a store replaces its blueprint (delete-then-insert keyed by store)."""
    err = _require_admin()
    if err: return err
    brand = request.form.get('brand', 'FLYING MACHINE').strip().upper()
    store_code = _normalize_store_code(request.form.get('store_code', ''))
    effective_date = request.form.get('effective_date', '').strip()
    email = request.form.get('email', '').strip().lower()
    file = request.files.get('file')

    if not store_code:
        return jsonify({"error": "store_code is required"}), 400
    if not effective_date:
        return jsonify({"error": "effective_date is required"}), 400
    if not file:
        return jsonify({"error": "file is required"}), 400

    planogram_id = uuid.uuid4().hex
    ext = os.path.splitext(secure_filename(file.filename or ''))[1] or '.pdf'
    file_rel_path = '/'.join(['planograms', f"{planogram_id}{ext}"])
    file_bytes = file.read()

    conn = None
    uploaded = False
    try:
        storage.upload(file_bytes, file_rel_path)
        uploaded = True
        conn = _fab_conn()
        conn.autocommit = True
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM prd.DIM_UI_MONEY_MAPPING_PLANOGRAM WHERE BRAND=? AND XSTORE_STORECODE=?",
            [brand, store_code]
        )
        cursor.execute(
            """
            INSERT INTO prd.DIM_UI_MONEY_MAPPING_PLANOGRAM
                (PLANOGRAM_ID, BRAND, XSTORE_STORECODE, FILE_PATH,
                 EFFECTIVE_DATE, UPLOADED_BY_EMAIL, UPLOADED_AT, LOAD_RUN_DATE)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [planogram_id, brand, store_code, file_rel_path,
             effective_date, email, datetime.utcnow(), _load_run_date()]
        )
    except Exception as e:
        if uploaded:
            try:
                storage.delete(file_rel_path)
            except Exception:
                pass
        print("Planogram insert failed:", traceback.format_exc(), flush=True)
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()

    return jsonify({"status": "ok", "planogram_id": planogram_id})


@app.route('/planograms', methods=['GET'])
def list_planograms():
    """List planograms (whole-store blueprints) — Head Office only. An
    optional store_code filter returns just that store's blueprint."""
    email = request.args.get('email', '').strip().lower()
    if not _is_admin(email):
        return jsonify({"error": "Admin access required"}), 403
    store_filter = _normalize_store_code(request.args.get('store_code', '')) or None

    where, params = "", []
    if store_filter:
        where = "WHERE XSTORE_STORECODE = ?"
        params = [store_filter]

    conn = None
    try:
        conn = _fab_conn()
        cursor = conn.cursor()
        cursor.execute(f"""
            SELECT PLANOGRAM_ID, BRAND, XSTORE_STORECODE, EFFECTIVE_DATE, UPLOADED_AT
            FROM prd.DIM_UI_MONEY_MAPPING_PLANOGRAM
            {where}
            ORDER BY UPLOADED_AT DESC
        """, params)
        planograms = [{
            "planogram_id": r[0], "brand": r[1],
            "store_code": r[2], "effective_date": str(r[3]), "uploaded_at": str(r[4]),
        } for r in cursor.fetchall()]
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()
    return jsonify({"planograms": planograms})


@app.route('/planograms/<planogram_id>/file', methods=['GET'])
def planogram_file(planogram_id):
    email = request.args.get('email', '').strip().lower()
    if not _is_admin(email):
        return jsonify({"error": "Admin access required"}), 403
    conn = None
    try:
        conn = _fab_conn()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT FILE_PATH FROM prd.DIM_UI_MONEY_MAPPING_PLANOGRAM WHERE PLANOGRAM_ID=?",
            [planogram_id]
        )
        row = cursor.fetchone()
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()
    if not row:
        return jsonify({"error": "Planogram not found"}), 404
    try:
        file_bytes = storage.download(row[0])
    except FileNotFoundError:
        return jsonify({"error": "File missing on storage"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return send_file(io.BytesIO(file_bytes), as_attachment=False, download_name=os.path.basename(row[0]))


# ── Fixture master (area sq ft — needed for SSPD / space-vs-sales in Power BI) ──
# HO-maintained reference data, not a point-in-time event like a capture, so it's
# upsert-by-key (STORE_CODE, FIXTURE_LABEL) same as planograms rather than insert-only.

@app.route('/fixture-master', methods=['POST'])
def upsert_fixture_master():
    err = _require_admin()
    if err: return err
    body = request.get_json() or {}
    store_code = str(body.get('store_code', '')).strip().upper()
    fixture_type = str(body.get('fixture_type', '')).strip()
    fixture_label = str(body.get('fixture_label', '')).strip()
    area_sqft = body.get('area_sqft')
    brand = str(body.get('brand', 'FLYING MACHINE')).strip().upper()

    if not store_code or fixture_type not in FIXTURE_TYPES or not fixture_label:
        return jsonify({"error": "store_code, a valid fixture_type, and fixture_label are required"}), 400
    try:
        area_sqft = float(area_sqft)
        if area_sqft <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"error": "area_sqft must be a positive number"}), 400

    conn = None
    try:
        conn = _fab_conn()
        conn.autocommit = True
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM prd.DIM_UI_MONEY_MAPPING_FIXTURE_MASTER WHERE XSTORE_STORECODE=? AND FIXTURE_LABEL=?",
            [store_code, fixture_label]
        )
        cursor.execute(
            """
            INSERT INTO prd.DIM_UI_MONEY_MAPPING_FIXTURE_MASTER
                (XSTORE_STORECODE, BRAND, FIXTURE_TYPE, FIXTURE_LABEL, AREA_SQFT, UPDATED_BY_EMAIL, UPDATED_AT, LOAD_RUN_DATE)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [store_code, brand, fixture_type, fixture_label, area_sqft,
             body.get('caller_email', ''), datetime.utcnow(), _load_run_date()]
        )
    except Exception as e:
        print("Fixture master upsert failed:", traceback.format_exc(), flush=True)
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()
    return jsonify({"status": "ok"})


@app.route('/fixture-master', methods=['GET'])
def list_fixture_master():
    email = request.args.get('email', '').strip().lower()
    if not email:
        return jsonify({"error": "email is required"}), 400
    is_admin = _is_admin(email)
    requested_store = _normalize_store_code(request.args.get('store_code', ''))
    requested_fixture = request.args.get('fixture_type', '').strip()

    if is_admin:
        allowed_stores = None
    else:
        allowed_stores = _stores_for_email(email)
        if not allowed_stores:
            return jsonify({"fixtures": []})
        if requested_store:
            allowed_stores = allowed_stores & {requested_store}
            if not allowed_stores:
                return jsonify({"fixtures": []})

    conditions, params = [], []
    if allowed_stores is not None:
        placeholders = ','.join('?' for _ in allowed_stores)
        conditions.append(f"XSTORE_STORECODE IN ({placeholders})")
        params.extend(sorted(allowed_stores))
    elif requested_store:
        conditions.append("XSTORE_STORECODE = ?")
        params.append(requested_store)
    if requested_fixture:
        conditions.append("FIXTURE_TYPE = ?")
        params.append(requested_fixture)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    conn = None
    try:
        conn = _fab_conn()
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT XSTORE_STORECODE, FIXTURE_TYPE, FIXTURE_LABEL, AREA_SQFT, UPDATED_AT
            FROM prd.DIM_UI_MONEY_MAPPING_FIXTURE_MASTER
            {where}
            ORDER BY XSTORE_STORECODE, FIXTURE_LABEL
            """,
            params
        )
        fixtures = [{
            "store_code": r[0], "fixture_type": r[1], "fixture_label": r[2],
            "area_sqft": r[3], "updated_at": str(r[4]),
        } for r in cursor.fetchall()]
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()
    return jsonify({"fixtures": fixtures})


# ── Category contribution (store self-reported sales mix) ─────────────────
# Unlike fixture area (HO-set), this is entered by the store itself — their
# own read of which categories drive their business — so it's gated by
# _check_store_access, not _require_admin. Full replace per (store, brand)
# each save, same as planogram/KPI-input: the whole mix is one unit, not
# something to patch category-by-category.

@app.route('/category-contribution', methods=['POST'])
def upsert_category_contribution():
    body = request.get_json() or {}
    email = body.get('email', '').strip().lower()
    store_code = _normalize_store_code(body.get('store_code', ''))
    brand = str(body.get('brand', 'FLYING MACHINE')).strip().upper()
    entries = body.get('entries') or []

    if not _check_store_access(email, store_code):
        return jsonify({"error": "You do not have access to submit data for this store"}), 403
    if not entries:
        return jsonify({"error": "entries are required"}), 400

    rows = []
    for e in entries:
        category = str(e.get('category', '')).strip()
        if category not in CATEGORIES:
            return jsonify({"error": f"Unknown category: {category}"}), 400
        try:
            pct = float(e.get('pct'))
        except (TypeError, ValueError):
            return jsonify({"error": f"Invalid percentage for {category}"}), 400
        rows.append((category, pct))

    conn = None
    try:
        conn = _fab_conn()
        conn.autocommit = True
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM prd.DIM_UI_MONEY_MAPPING_CATEGORY_CONTRIBUTION WHERE XSTORE_STORECODE=? AND BRAND=?",
            [store_code, brand]
        )
        load_run_date = _load_run_date()
        cursor.executemany(
            """
            INSERT INTO prd.DIM_UI_MONEY_MAPPING_CATEGORY_CONTRIBUTION
                (XSTORE_STORECODE, BRAND, CATEGORY, CONTRIBUTION_PCT, UPDATED_BY_EMAIL, UPDATED_AT, LOAD_RUN_DATE)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [[store_code, brand, cat, pct, email, datetime.utcnow(), load_run_date] for cat, pct in rows]
        )
    except Exception as e:
        print("Category contribution upsert failed:", traceback.format_exc(), flush=True)
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()
    return jsonify({"status": "ok", "saved": len(rows)})


@app.route('/category-contribution', methods=['GET'])
def get_category_contribution():
    email = request.args.get('email', '').strip().lower()
    store_code = _normalize_store_code(request.args.get('store_code', ''))
    if not store_code:
        return jsonify({"error": "store_code is required"}), 400
    if not (_is_admin(email) or _check_store_access(email, store_code)):
        return jsonify({"error": "Not authorized"}), 403

    conn = None
    try:
        conn = _fab_conn()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT CATEGORY, CONTRIBUTION_PCT, UPDATED_AT FROM prd.DIM_UI_MONEY_MAPPING_CATEGORY_CONTRIBUTION WHERE XSTORE_STORECODE=?",
            [store_code]
        )
        entries = [{"category": r[0], "pct": r[1], "updated_at": str(r[2])} for r in cursor.fetchall()]
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()
    return jsonify({"entries": entries})


# ── Audit logs ──────────────────────────────────────────────────────────────

@app.route('/logs', methods=['POST'])
def insert_log():
    try:
        body = request.get_json() or {}
        with _db_lock:
            con = get_con()
            next_id = con.execute("SELECT COALESCE(MAX(id),0)+1 FROM audit_logs").fetchone()[0]
            con.execute("INSERT INTO audit_logs VALUES (?,?,?,?,?,?)", [
                next_id, _now_str(),
                body.get('email', ''), body.get('name', ''),
                body.get('action', ''), json.dumps(body.get('details', {})),
            ])
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/logs', methods=['GET'])
def get_logs():
    err = _require_admin()
    if err: return err
    limit = int(request.args.get('limit', 200))
    with _db_lock:
        rows = get_con().execute(
            "SELECT id, ts, email, name, action, details FROM audit_logs ORDER BY ts DESC LIMIT ?",
            [limit]
        ).fetchall()
    return jsonify({"logs": [{
        "id": r[0], "ts": str(r[1]), "email": r[2], "name": r[3],
        "action": r[4], "details": json.loads(r[5]) if r[5] else {},
    } for r in rows]})


init_db()

if __name__ == '__main__':
    # use_reloader=False: the reloader spawns a second process, and DuckDB
    # (like SEMANTIC-LAYER's permissions.duckdb) only allows one process to
    # hold the file open at a time.
    app.run(host='0.0.0.0', port=5002, debug=True, use_reloader=False)
