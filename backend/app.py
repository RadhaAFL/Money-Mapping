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
DATA_ROOT             = os.path.join(os.path.dirname(__file__), '..', 'data')
DB_PATH               = os.path.join(DATA_ROOT, 'app.duckdb')
CAPTURE_UPLOAD_DIR    = os.path.join(DATA_ROOT, 'uploads', 'money_mapping')
PLANOGRAM_UPLOAD_DIR  = os.path.join(DATA_ROOT, 'uploads', 'planograms')
os.makedirs(CAPTURE_UPLOAD_DIR, exist_ok=True)
os.makedirs(PLANOGRAM_UPLOAD_DIR, exist_ok=True)

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
    "Facade", "Wall", "Hang Rail", "Table",
    "Denim Wall", "Laundered Black", "Mannequin / Window",
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


def _stores_for_email(email: str) -> set:
    """Store codes this email is the store-side login for, per the org's
    existing dbo.DIM_RLS.EMAIL_ID — the single source of truth for who may
    capture for a store. Deliberately does NOT check the RM/ARM/CM/... columns
    on that table: those grant Power BI *viewing* visibility up the hierarchy,
    not permission to submit a capture as that store."""
    email = (email or '').strip().lower()
    if not email:
        return set()
    conn = None
    try:
        conn = _fab_conn()
        cursor = conn.cursor()
        cursor.execute("SELECT DISTINCT STORE FROM dbo.DIM_RLS WHERE LOWER(EMAIL_ID) = ?", [email])
        return {_normalize_store_code(r[0]) for r in cursor.fetchall() if r[0]}
    except Exception:
        print("DIM_RLS lookup failed:", traceback.format_exc(), flush=True)
        return set()
    finally:
        if conn is not None:
            conn.close()


def _check_store_access(email: str, store_code: str) -> bool:
    """True if caller is admin, or store_code is among the stores dbo.DIM_RLS
    lists that email's EMAIL_ID against. False (never implicitly-allow) if
    the lookup returns nothing — a user with no matching row must not be able
    to submit for arbitrary stores."""
    store_code = _normalize_store_code(store_code)
    if not store_code:
        return False
    if _is_admin(email):
        return True
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


# ── Captures ────────────────────────────────────────────────────────────────

@app.route('/captures', methods=['POST'])
def submit_capture():
    email      = request.form.get('email', '').strip().lower()
    name       = request.form.get('name', '')
    store_code = _normalize_store_code(request.form.get('store_code', ''))
    sap_code   = request.form.get('sap_store_code', '').strip()
    brand      = request.form.get('brand', 'FLYING MACHINE').strip().upper()
    fixture    = request.form.get('fixture_type', '').strip()
    styles_raw = request.form.get('styles', '[]')
    photo      = request.files.get('photo')

    if not _check_store_access(email, store_code):
        return jsonify({"error": "You do not have access to submit captures for this store"}), 403
    if fixture not in FIXTURE_TYPES:
        return jsonify({"error": f"Unknown fixture_type: {fixture}"}), 400
    if not photo:
        return jsonify({"error": "photo is required"}), 400

    try:
        styles = json.loads(styles_raw)
        if not isinstance(styles, list):
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({"error": "styles must be a JSON array"}), 400
    styles = [str(s).strip() for s in styles if str(s).strip()][:500]  # de-noise + cap

    capture_id = uuid.uuid4().hex
    store_dir = os.path.join(CAPTURE_UPLOAD_DIR, secure_filename(store_code))
    os.makedirs(store_dir, exist_ok=True)
    photo_rel_path = os.path.join('money_mapping', secure_filename(store_code), f"{capture_id}.jpg")
    photo_abs_path = os.path.join(DATA_ROOT, 'uploads', photo_rel_path)
    photo.save(photo_abs_path)

    conn = None
    try:
        conn = _fab_conn()
        conn.autocommit = True
        cursor = conn.cursor()
        load_run_date = _load_run_date()
        cursor.execute(
            """
            INSERT INTO prd.DIM_UI_MONEY_MAPPING_CAPTURE
                (CAPTURE_ID, XSTORE_STORECODE, SAP_STORECODE, BRAND, FIXTURE_TYPE,
                 PHOTO_PATH, STYLE_COUNT, STATUS, CAPTURED_AT,
                 SUBMITTED_BY_EMAIL, SUBMITTED_BY_NAME, LOAD_RUN_DATE)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [capture_id, store_code, sap_code or None, brand, fixture,
             photo_rel_path.replace('\\', '/'), len(styles), 'SUBMITTED', datetime.utcnow(),
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
        if os.path.exists(photo_abs_path):
            os.remove(photo_abs_path)
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
            SELECT CAPTURE_ID, XSTORE_STORECODE, BRAND, FIXTURE_TYPE, STYLE_COUNT,
                   STATUS, CAPTURED_AT, SUBMITTED_BY_EMAIL, SUBMITTED_BY_NAME
            FROM prd.DIM_UI_MONEY_MAPPING_CAPTURE
            {where}
            ORDER BY CAPTURED_AT DESC
            """,
            params
        )
        captures = [{
            "capture_id": r[0], "store_code": r[1], "brand": r[2], "fixture_type": r[3],
            "style_count": r[4], "status": r[5], "captured_at": str(r[6]),
            "submitted_by_email": r[7], "submitted_by_name": r[8],
        } for r in cursor.fetchall()]
    except Exception as e:
        print("List captures failed:", traceback.format_exc(), flush=True)
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()

    return jsonify({"captures": captures})


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

    full_path = os.path.join(DATA_ROOT, 'uploads', photo_path)
    if not os.path.exists(full_path):
        return jsonify({"error": "Photo file missing on disk"}), 404
    return send_file(full_path, mimetype='image/jpeg', as_attachment=False)


# ── Planograms ──────────────────────────────────────────────────────────────

@app.route('/planograms', methods=['POST'])
def upload_planogram():
    err = _require_admin()
    if err: return err
    brand = request.form.get('brand', 'FLYING MACHINE').strip().upper()
    fixture = request.form.get('fixture_type', '').strip()
    store_code = request.form.get('store_code', '').strip().upper() or None
    effective_date = request.form.get('effective_date', '').strip()
    email = request.form.get('email', '').strip().lower()
    file = request.files.get('file')

    if fixture not in FIXTURE_TYPES:
        return jsonify({"error": f"Unknown fixture_type: {fixture}"}), 400
    if not effective_date:
        return jsonify({"error": "effective_date is required"}), 400
    if not file:
        return jsonify({"error": "file is required"}), 400

    planogram_id = uuid.uuid4().hex
    ext = os.path.splitext(secure_filename(file.filename or ''))[1] or '.pdf'
    file_rel_path = os.path.join('planograms', f"{planogram_id}{ext}")
    file_abs_path = os.path.join(DATA_ROOT, 'uploads', file_rel_path)
    file.save(file_abs_path)

    conn = None
    try:
        conn = _fab_conn()
        conn.autocommit = True
        cursor = conn.cursor()
        if store_code:
            cursor.execute(
                "DELETE FROM prd.DIM_UI_MONEY_MAPPING_PLANOGRAM WHERE BRAND=? AND FIXTURE_TYPE=? AND XSTORE_STORECODE=?",
                [brand, fixture, store_code]
            )
        else:
            cursor.execute(
                "DELETE FROM prd.DIM_UI_MONEY_MAPPING_PLANOGRAM WHERE BRAND=? AND FIXTURE_TYPE=? AND XSTORE_STORECODE IS NULL",
                [brand, fixture]
            )
        cursor.execute(
            """
            INSERT INTO prd.DIM_UI_MONEY_MAPPING_PLANOGRAM
                (PLANOGRAM_ID, BRAND, FIXTURE_TYPE, XSTORE_STORECODE, FILE_PATH,
                 EFFECTIVE_DATE, UPLOADED_BY_EMAIL, UPLOADED_AT, LOAD_RUN_DATE)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [planogram_id, brand, fixture, store_code, file_rel_path.replace('\\', '/'),
             effective_date, email, datetime.utcnow(), _load_run_date()]
        )
    except Exception as e:
        if os.path.exists(file_abs_path):
            os.remove(file_abs_path)
        print("Planogram insert failed:", traceback.format_exc(), flush=True)
        return jsonify({"error": str(e)}), 500
    finally:
        if conn is not None:
            conn.close()

    return jsonify({"status": "ok", "planogram_id": planogram_id})


@app.route('/planograms', methods=['GET'])
def list_planograms():
    email = request.args.get('email', '').strip().lower()
    if not email:
        return jsonify({"error": "email is required"}), 400
    if not (_is_admin(email) or _stores_for_email(email)):
        return jsonify({"error": "Not authorized"}), 403

    conn = None
    try:
        conn = _fab_conn()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT PLANOGRAM_ID, BRAND, FIXTURE_TYPE, XSTORE_STORECODE, EFFECTIVE_DATE, UPLOADED_AT
            FROM prd.DIM_UI_MONEY_MAPPING_PLANOGRAM
            ORDER BY UPLOADED_AT DESC
        """)
        planograms = [{
            "planogram_id": r[0], "brand": r[1], "fixture_type": r[2],
            "store_code": r[3], "effective_date": str(r[4]), "uploaded_at": str(r[5]),
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
    if not (_is_admin(email) or _stores_for_email(email)):
        return jsonify({"error": "Not authorized"}), 403
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
    full_path = os.path.join(DATA_ROOT, 'uploads', row[0])
    if not os.path.exists(full_path):
        return jsonify({"error": "File missing on disk"}), 404
    return send_file(full_path, as_attachment=False)


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
