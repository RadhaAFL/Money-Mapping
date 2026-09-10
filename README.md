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
multi-portal/wizard machinery.

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
Microsoft Fabric Warehouse
        |
        | ODBC Driver 18 / pyodbc
        v
Flask API — backend/app.py
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
already used for Power BI RLS elsewhere. Captures and planograms are
INSERT-only (captures) or DELETE-then-INSERT-by-key (planograms, since a
planogram is "current state per fixture") directly against Fabric, the same
pattern SEMANTIC-LAYER's KPI-input portal already proves works at this
scale.

## Project structure

```text
Money_Mapping/
  backend/
    app.py               # Flask API — access control, captures, planograms
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
  data/                     # gitignored — app.duckdb + uploads/ live here
```

## Environment variables

Root `.env` (loaded by `backend/app.py`, see `backend/.env.example`):

```env
FABRIC_DB_HOST=<fabric-host>
FABRIC_DB_PORT=1433
FABRIC_DB_NAME=<fabric-warehouse-name>
FABRIC_DB_USER=<fabric-user>
FABRIC_DB_PASS=<fabric-password>
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
| `POST` | `/captures` | multipart: `email, name, store_code, fixture_type, styles (JSON array), photo` |
| `GET` | `/captures?email=&store_code=&fixture_type=&from_date=&to_date=` | List, RLS-filtered server-side |
| `GET` | `/captures/<id>/styles?email=` | Scanned style codes for one capture |
| `GET` | `/captures/<id>/photo?email=` | Inline photo (`as_attachment=False`) |
| `POST` | `/planograms` | Admin, multipart: `caller_email, email, fixture_type, store_code (optional), effective_date, file` |
| `GET` | `/planograms?email=` | List |
| `GET` | `/planograms/<id>/file?email=` | File download |
| `POST` | `/fixture-master` | Admin: `{store_code, fixture_type, fixture_label, area_sqft, caller_email}` — upsert by `(store_code, fixture_label)` |
| `GET` | `/fixture-master?email=&store_code=` | List, RLS-filtered server-side same as `/captures` |
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
(the small `admins` table in DuckDB) bypass this check entirely, for the
Review/Fixture-areas/Planogram-upload screens.

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
</Directory>
```

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
