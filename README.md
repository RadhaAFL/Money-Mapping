# Money Mapping

Store fixture-performance capture for Flying Machine (Arvind Fashions):
store associates photograph each fixture (wall, table, facade, hang rail,
denim wall, laundered black, mannequin/window) and barcode-scan every style
on it; Head Office reviews captures and uploads planograms. All data is
written directly to Microsoft Fabric Warehouse so Power BI can connect to
it with no extra pipeline.

Standalone React + Flask app — same auth (Azure AD) and data source
(Microsoft Fabric) as the "Arvind Analytics" app
(`C:\Users\7517978\Work\SEMANTIC-LAYER`), but purpose-built rather than
generic: it only ever does this one thing, so it skips that app's
multi-portal/wizard machinery. Capture photos and planogram files are
stored on the org's own in-house SFTP server, not on the app VM's disk.

## Manual pre-reqs (not done by this codebase)

Three things need action outside this repo before the app is fully live:

1. **Fabric DDL** — run the three `CREATE TABLE` statements in
   [`docs/fabric_schema.sql`](docs/fabric_schema.sql) against the warehouse.
2. **Azure AD redirect URI** — add
   `https://automationafl.arvindfashions.com/moneymapping` as an allowed
   redirect URI on the same App Registration SEMANTIC-LAYER already uses
   (or register a new one, if a separate one is preferred).
3. **VM deploy** — apply the Apache/systemd config below on the same
   Ubuntu VM that hosts SEMANTIC-LAYER, at a new path (see Deployment).

## Architecture

```text
Microsoft Fabric Warehouse          In-house SFTP server
        |                            (sftp.arvindbrands.com)
        | ODBC Driver 18 / pyodbc            |
        v                                    | paramiko (SFTP)
Flask API — backend/app.py  ───────────────────┘
        |
        | admins, audit_logs
        v
data/app.duckdb

React / Vite frontend
frontend/src
        |
        | /moneymapping-api/*
        v
Apache2 reverse proxy
        |
        v
https://automationafl.arvindfashions.com/moneymapping
```

DuckDB holds only the app-admin list (who can review/upload planograms/set
fixture areas) and the audit log — never capture/planogram data, and never
store-level access. **Who may capture for which store is not decided by
this app at all** — it's read live from the org's existing
`dbo.DIM_RLS` table in Fabric (see Row-level access below), the same table
already used for Power BI RLS elsewhere. Captures are INSERT-only;
planograms are DELETE-then-INSERT-by-store (a planogram is one whole-store
blueprint layout, not split per fixture type — re-uploading for a store
replaces its blueprint) directly against Fabric, the same pattern
SEMANTIC-LAYER's KPI-input portal already proves works at this scale.

Capture photos and planogram files themselves live on the org's in-house
SFTP server (`backend/sftp_storage.py`), not on this VM's disk — Fabric's
`PHOTO_PATH`/`FILE_PATH` columns hold a path relative to `SFTP_ROOT`
(default `money_mapping_uploads`), and the backend uploads/downloads those
files over SFTP on every request (no local caching yet — see that file's
docstring for the one-connection-per-call rationale).

### Photos in Power BI

Power BI can't read files on SFTP, so at submit time the backend also writes a
small text copy of each capture photo to
`prd.DIM_UI_MONEY_MAPPING_IMAGE_CHUNKS` (`CAPTURE_ID`, `CHUNK_INDEX`, `CHUNK`):
500px JPEG at quality 80, base64 as `data:image/jpeg;base64,...`, split into
7,500-character pieces (the SQL endpoint caps text at 8,000). This is the same
recipe as the Fabric notebook behind Lakehouse table
`dim_money_mapping_image_chunks` (`backend/image_chunks.py` — keep the two in
step), so one measure works for both. Capture, styles and chunks are written in
one transaction, a same-day delete removes all three, and the full-size photo
stays on SFTP. To show it, relate `IMAGE_CHUNKS[CAPTURE_ID]` to
`CAPTURE[CAPTURE_ID]` and use a measure like the one below, with its data
category set to *Image URL*:

```dax
Capture Photo =
CONCATENATEX (
    'DIM_UI_MONEY_MAPPING_IMAGE_CHUNKS',
    'DIM_UI_MONEY_MAPPING_IMAGE_CHUNKS'[CHUNK],
    "",
    'DIM_UI_MONEY_MAPPING_IMAGE_CHUNKS'[CHUNK_INDEX], ASC
)
```

`python backend/backfill_image_chunks.py` loads chunks for captures that don't
have them yet (`--dry-run` to preview, `--rebuild` to regenerate everything
from SFTP after changing the recipe).

## Project structure

```text
Money_Mapping/
  backend/
    app.py               # Flask API — access control, captures, planograms
    sftp_storage.py       # capture-photo / planogram file storage over SFTP
    image_chunks.py       # photo -> 500px base64 text pieces for Power BI
    backfill_image_chunks.py  # load/rebuild those pieces from the photos on SFTP
    requirements.txt
    .env.example
  frontend/
    src/
      main.jsx            # MSAL init + render root
      authConfig.js        # MSAL config, env-driven
      AuthWrapper.jsx       # login gate, routes to Capture/Review/Fixtures
      CapturePortal.jsx      # store-user capture screen
      ReviewPortal.jsx        # HO review + planogram upload
      FixtureMasterPage.jsx    # HO: set fixture area (sq ft) per store
      logger.js                 # fire-and-forget audit log calls
    vite.config.js
    package.json
  docs/
    fabric_schema.sql       # manual pre-req DDL (Money Mapping's own tables —
                             # NOT dbo.DIM_RLS, which already exists)
  data/                     # gitignored — app.duckdb (admins/audit_logs) lives here
```

## Environment variables

Root `.env` (loaded by `backend/app.py`, see `backend/.env.example`):

```env
FABRIC_DB_HOST=<fabric-host>
FABRIC_DB_PORT=1433
FABRIC_DB_NAME=<fabric-warehouse-name>
FABRIC_DB_USER=<fabric-user>
FABRIC_DB_PASS=<fabric-password>

SFTP_HOST=sftp.arvindbrands.com
SFTP_PORT=22
SFTP_USER=<sftp-user>
SFTP_PASS=<sftp-password>
SFTP_ROOT=money_mapping_uploads
```

`frontend/.env` (Vite, build-time):

```env
VITE_AZURE_CLIENT_ID=<azure-app-client-id>
VITE_AZURE_TENANT_ID=<azure-tenant-id>
VITE_REDIRECT_PATH=/moneymapping
```

## Local development

### Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Runs on `http://localhost:5002`. On first boot it creates `data/app.duckdb`
and seeds one bootstrap admin
(`radhakishan.thakur@arvindfashions.com` — change `BOOTSTRAP_ADMIN` in
`app.py` if that should be someone else). Almost everything needs real
Fabric `.env` credentials and the "ODBC Driver 18 for SQL Server" installed
— including `/check-access` now, since store access is resolved live from
`dbo.DIM_RLS`. Only `/fixture-types` and `/logs` work without Fabric.

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

Runs on `http://localhost:3000/moneymapping/`, proxying
`/moneymapping-api/*` to `http://localhost:5002`.

### Build

```powershell
cd frontend
npm run build
```

Output: `frontend/dist`.

## Backend API

Base path in production: `/moneymapping-api`

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/check-access?email=` | `{allowed, is_admin, store_codes}` — `store_codes` comes live from `dbo.DIM_RLS` |
| `GET` | `/fixture-types` | Static list of the 7 fixture types |
| `GET` | `/stores?email=` | Admin-only: every distinct store code in `dbo.DIM_RLS` — lets an admin capture on behalf of any store, since admins already bypass the store-access check |
| `POST` | `/captures` | multipart: `email, name, store_code, fixture_type, fixture_label (optional), size (optional, whole number), styles (JSON array), photo` |
| `GET` | `/captures?email=&store_code=&fixture_type=&from_date=&to_date=` | List, RLS-filtered server-side. `from_date`/`to_date` are inclusive `YYYY-MM-DD` Indian (IST) calendar days — `CAPTURED_AT` is UTC, so the filter shifts it +5:30 first; a malformed date returns 400. The Head Office review screen opens on "Today" with Yesterday / Last 7 days / All dates presets. |
| `GET` | `/captures/<id>/styles?email=` | Scanned style codes for one capture |
| `PUT` | `/captures/<id>` | JSON `{email, fixture_label, size, styles[]}` — **same-day only** edit of a capture's label, size and style list (photo is not replaceable; delete and re-capture instead) |
| `DELETE` | `/captures/<id>?email=` | **Same-day only** delete — removes the Fabric rows (capture, styles, image chunks), then the SFTP photo |

"Same day" means the Indian calendar day (IST) of `CAPTURED_AT`, checked on the server (`_is_today_ist`); `GET /captures` returns an `editable` flag per row so the UI only offers the controls where they'll work. Edit/delete use the same store-access check as submitting (store login, or an admin on a pilot store) — after midnight IST a capture is locked for everyone, admins included.
| `GET` | `/captures/<id>/photo?email=` | Inline photo (`as_attachment=False`) |
| `GET` | `/captures/summary?email=` | Admin-only: network coverage for the current month — total stores (`dbo.DIM_RLS`), stores with a capture, total capture count |
| `POST` | `/planograms` | Admin-only, multipart: `caller_email, email, store_code, effective_date, file` — one whole-store blueprint layout, replaces that store's existing blueprint |
| `GET` | `/planograms?email=&store_code=` | Admin-only — the blueprint is HO-facing design reference, unlike captures which stores both submit and see their own |
| `GET` | `/planograms/<id>/file?email=` | Admin-only file download |
| `POST` | `/fixture-master` | Admin: `{store_code, fixture_type, fixture_label, area_sqft, caller_email}` — upsert by `(store_code, fixture_label)` |
| `GET` | `/fixture-master?email=&store_code=&fixture_type=` | List, RLS-filtered server-side same as `/captures` — the capture flow uses this (filtered to one store+fixture type) to populate the "which Wall/Table/…" instance picker |
| `POST` | `/logs`, `GET /logs?caller_email=` | Audit log write / admin read |

Note the `email` vs. `caller_email` split on admin endpoints that also
carry a target user's email (e.g. `/fixture-master` POST): `caller_email`
is always the authenticated admin performing the action, `email` is
whoever else is referenced. Conflating the two was an actual bug caught
during development — SEMANTIC-LAYER's own `_require_admin()` uses the same
`caller_email` convention for the same reason.

## Row-level access

Store-level access is **not** app-managed data — it's read live from the
org's existing `dbo.DIM_RLS` table in Fabric, the same table other Power BI
reports already use for RLS. One row per store, with `EMAIL_ID` as that
store's own login and a wide stack of escalation columns (`RM EMAIL`,
`ARM EMAIL`, `CM EMAIL`, `HEAD EMAIL`, ... `IT SUPPORT 1..15`, `Audit`) for
the reporting hierarchy above it.

`_stores_for_email()` in `app.py` queries `dbo.DIM_RLS` for
`WHERE LOWER(EMAIL_ID) = <caller>` — **deliberately only `EMAIL_ID`**, not
the escalation columns. Those columns grant a manager visibility into a
store's data on the Power BI side; they do not grant permission to submit a
capture *as* that store. A user with no matching `EMAIL_ID` row gets zero
stores back — there is no implicit "no restriction = see everything"
fallback here, unlike SEMANTIC-LAYER's read-side RLS convention. Admins
(the small `admins` table in DuckDB) bypass the DIM_RLS check for the
Review/Fixture-areas/Planogram-upload screens, but not the pilot-store gate
below — nobody, admin included, can act on a store outside the pilot.

### Pilot store gate

Money Mapping is currently piloted on a subset of stores, not the whole
network: `_pilot_stores()` in `app.py` queries
`prd.DIM_FTP_CONSOLIDATED_STORE_MASTER_DOOR` for `X_STORE_CODE` where
`BRAND = 'FM' AND FORMAT = 'Fresh'` (~200 stores), normalized the same way
as `dbo.DIM_RLS.STORE`. `_stores_for_email()` intersects with this set, and
`_check_store_access()` checks it directly for the admin-bypass path — so a
store outside the pilot is unusable even for an admin explicitly typing its
code into "Capture for a store," and `/stores` (that screen's store list)
and `/captures/summary`'s `total_stores` both only ever show pilot stores.
Widening the pilot later just means adding rows to that store master table
(or dropping the `BRAND`/`FORMAT` filter entirely) — no code change needed.

`STORE` in `dbo.DIM_RLS` carries channel-variant prefixes around the same
physical store — `8172`, `NON-8172`, `O8172`, `T8172` all mean the same
store. `_normalize_store_code()` strips `NON-`/leading `O`/leading `T`
before comparing against `XSTORE_STORECODE`, mirroring the equivalent
`BASE_STORE_CODE` calculated column on the Power BI side (see the RLS role
definition, not checked into this repo, built directly in Power BI
Desktop).

## Deployment (same VM as SEMANTIC-LAYER, new path)

Apache — add alongside the existing `/permissions-api`/`/downloadui` block:

```apache
# Money Mapping API
ProxyTimeout 900
ProxyPass        /moneymapping-api/ http://localhost:5002/ timeout=900 connectiontimeout=30 retry=0
ProxyPassReverse /moneymapping-api/ http://localhost:5002/

# Money Mapping UI
Alias /moneymapping /home/appuser/money-mapping/frontend/dist
LimitRequestBody 20971520
Timeout 300

<Directory /home/appuser/money-mapping/frontend/dist>
    Options FollowSymLinks
    AllowOverride None
    Require all granted

    RewriteEngine On
    RewriteBase /moneymapping
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteRule ^ /moneymapping/index.html [L]

    # index.html must always be revalidated so a stale SPA shell never
    # keeps referencing an old, since-deleted hashed JS/CSS bundle after a
    # deploy (browsers otherwise heuristically cache it with no explicit
    # Cache-Control header — this is what caused a stale pre-fixture-label
    # build to render style codes as a comma blob for one user).
    <Files "index.html">
        Header set Cache-Control "no-cache, must-revalidate"
    </Files>
</Directory>

# Hashed asset filenames (assets/index-<hash>.js etc.) change whenever
# their content does, so these are safe to cache for a long time.
<Directory /home/appuser/money-mapping/frontend/dist/assets>
    Header set Cache-Control "public, max-age=31536000, immutable"
</Directory>
```

Requires `mod_headers` (`sudo a2enmod headers`) — already enabled on this VM.

systemd (`money-mapping-api.service`):

```ini
[Unit]
Description=Money Mapping API
After=network.target

[Service]
User=appuser
WorkingDirectory=/home/appuser/money-mapping/backend
ExecStart=/home/appuser/money-mapping/env/bin/gunicorn --workers 1 --threads 16 --timeout 1200 --bind 127.0.0.1:5002 app:app
Restart=always

[Install]
WantedBy=multi-user.target
```

One gunicorn worker — same reason as SEMANTIC-LAYER: DuckDB opens
`data/app.duckdb` as a single local file, so only one process may hold it.

```bash
sudo systemctl daemon-reload
sudo systemctl restart money-mapping-api
sudo apachectl configtest
sudo systemctl reload apache2
```

## Shared VM notes

This VM also runs other teams' stacks (SEMANTIC-LAYER, ai-da-agents, Langfuse,
Streamlit, ...). Nothing below is deployed by this repo; it's recorded here so
it isn't lost.

### Langfuse ClickHouse log cap (applied 2026-10-12)

**Why.** The disk climbed to 62% because ClickHouse inside the Langfuse stack
(`/opt/langfuse`, containers `langfuse-*`) was logging about 40 GB to its own
internal tables (`system.trace_log` 19.5 GB, `text_log` 12.8 GB, plus four more),
with no expiry. Langfuse's own data was tiny (106 traces, 244 observations) and
has had no new traces since 2026-06-18. The only app wired to it is ai-da-agents
(production, `LANGFUSE_HOST=http://host.docker.internal:3000`); its tracing
config and keys are valid, there is just no chat traffic. Money Mapping and
SEMANTIC-LAYER have no connection to this ClickHouse (not on its Docker network,
no code or Apache config references it).

**What was done.** The six big log tables (`trace_log`, `text_log`, `metric_log`,
`part_log`, `asynchronous_metric_log`, `histogram_metric_log`) were emptied, then
capped at 7 days with this file inside the ClickHouse container at
`/etc/clickhouse-server/config.d/zz-system-log-ttl.xml`:

```xml
<clickhouse>
    <trace_log><ttl>event_date + INTERVAL 7 DAY DELETE</ttl></trace_log>
    <text_log><ttl>event_date + INTERVAL 7 DAY DELETE</ttl></text_log>
    <metric_log><ttl>event_date + INTERVAL 7 DAY DELETE</ttl></metric_log>
    <part_log><ttl>event_date + INTERVAL 7 DAY DELETE</ttl></part_log>
    <asynchronous_metric_log><ttl>event_date + INTERVAL 7 DAY DELETE</ttl></asynchronous_metric_log>
    <histogram_metric_log><ttl>event_date + INTERVAL 7 DAY DELETE</ttl></histogram_metric_log>
</clickhouse>
```

Result: disk 62% -> 29% (76 GB -> 36 GB used); the ClickHouse data volume went
from 43 GB to about 140 MB, and should level off around 2 GB.

**It can silently stop working.** ClickHouse only applies a log-table TTL from
config when it *creates* the table, and the file lives in the container's own
filesystem, not in a volume. A plain `docker restart` keeps it, but recreating
the container (`docker compose up --force-recreate`, an image upgrade) discards
it and the logs will grow again without any error. Check with:

```bash
sudo docker exec langfuse-clickhouse-1 ls /etc/clickhouse-server/config.d   # expect zz-system-log-ttl.xml
sudo docker system df -v | grep clickhouse_data                            # expect a few GB, not tens
```

**To re-apply.** In this order, so the config is loaded before the tables are
recreated: (1) `docker cp` the file above into `config.d/`; (2) `docker restart
langfuse-clickhouse-1`; (3) `DROP TABLE system.<name>` for each of the six, then
`SYSTEM FLUSH LOGS`, which recreates them with the TTL (run the SQL with
`docker exec langfuse-clickhouse-1 sh -c 'clickhouse-client --user "$CLICKHOUSE_USER"
--password "$CLICKHOUSE_PASSWORD" -q "..."'` so the password never leaves the
container). Confirm with `SHOW CREATE TABLE system.trace_log`, which should
include `TTL event_date + toIntervalDay(7)`. If ClickHouse sets a `<name>_0` copy
aside on a later restart, it is a tiny leftover and can be dropped.
The durable fix is a bind mount of that file in `/opt/langfuse/docker-compose.yml`;
that file belongs to the Langfuse/ai-da-agents owners, so it was left alone.
