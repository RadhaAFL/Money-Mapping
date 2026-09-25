-- Money Mapping — Fabric Warehouse schema
-- Manual pre-req: run these against the same warehouse SEMANTIC-LAYER
-- connects to, before deploying backend/app.py. Nothing in this codebase
-- issues DDL against Fabric (same as SEMANTIC-LAYER's own
-- prd.DIM_UI_KPI_TRACKER_THCK, which was created the same way).
--
-- NOTE: dbo.DIM_RLS (store -> EMAIL_ID + RM/ARM/CM/... escalation columns)
-- already exists and is NOT created here — backend/app.py's
-- _stores_for_email() and the Power BI RLS role both read it directly.

CREATE TABLE prd.DIM_UI_MONEY_MAPPING_CAPTURE (
    CAPTURE_ID          VARCHAR(64)   NOT NULL,   -- uuid4 hex, server-generated
    XSTORE_STORECODE    VARCHAR(50)   NOT NULL,
    SAP_STORECODE       VARCHAR(50)   NULL,
    BRAND               VARCHAR(50)   NOT NULL,   -- 'FLYING MACHINE'
    FIXTURE_TYPE        VARCHAR(50)   NOT NULL,   -- Wall/Table/Facade/Hang Rail/CTM Table/CTM Wall/Denim Table/Denim Wall/Laundered Black/Mannequin / Window
    FIXTURE_LABEL       VARCHAR(100)  NULL,       -- which instance of that fixture type (e.g. 'Wall 1') — matches DIM_UI_MONEY_MAPPING_FIXTURE_MASTER.FIXTURE_LABEL when set up; NULL if the store has no fixture master rows for that type yet
    BAYS                INT           NULL,       -- optional bay count for this fixture, free entry by the store user
    PHOTO_PATH          VARCHAR(500)  NOT NULL,   -- relative path on the SFTP server
    STYLE_COUNT         INT           NOT NULL,
    STATUS              VARCHAR(20)   NOT NULL,   -- SUBMITTED / REVIEWED / REJECTED
    CAPTURED_AT         DATETIME2(6)  NOT NULL,
    SUBMITTED_BY_EMAIL  VARCHAR(200)  NOT NULL,
    SUBMITTED_BY_NAME   VARCHAR(200)  NULL,
    LOAD_RUN_DATE       VARCHAR(20)   NOT NULL
);
-- On an existing deployment (these columns added after go-live), apply as:
-- ALTER TABLE prd.DIM_UI_MONEY_MAPPING_CAPTURE ADD FIXTURE_LABEL VARCHAR(100) NULL;
-- ALTER TABLE prd.DIM_UI_MONEY_MAPPING_CAPTURE ADD BAYS INT NULL;

CREATE TABLE prd.DIM_UI_MONEY_MAPPING_CAPTURE_STYLE (
    CAPTURE_ID     VARCHAR(64)  NOT NULL,   -- app-level FK only, no enforced constraint
    STYLE_BARCODE  VARCHAR(50)  NOT NULL,
    SCAN_SEQ       INT          NOT NULL,
    LOAD_RUN_DATE  VARCHAR(20)  NOT NULL
);

-- One whole-store blueprint layout (e.g. "PMC Bangalore - Layout"), not
-- split per fixture type — re-uploading for a store replaces its blueprint.
CREATE TABLE prd.DIM_UI_MONEY_MAPPING_PLANOGRAM (
    PLANOGRAM_ID       VARCHAR(64)  NOT NULL,
    BRAND              VARCHAR(50)  NOT NULL,
    XSTORE_STORECODE   VARCHAR(50)  NOT NULL,
    FILE_PATH          VARCHAR(500) NOT NULL,
    EFFECTIVE_DATE     DATE         NOT NULL,
    UPLOADED_BY_EMAIL  VARCHAR(200) NOT NULL,
    UPLOADED_AT        DATETIME2(6) NOT NULL,
    LOAD_RUN_DATE      VARCHAR(20)  NOT NULL
);

-- HO-maintained fixture area (sq ft) per store. Required for the Power BI
-- SSPD (Sales/ft2/day) and space-vs-sales measures — without this table those
-- measures have no denominator. Upsert-by-(XSTORE_STORECODE, FIXTURE_LABEL),
-- same idiom as Planogram above, since this is reference data, not an event.
CREATE TABLE prd.DIM_UI_MONEY_MAPPING_FIXTURE_MASTER (
    XSTORE_STORECODE   VARCHAR(50)  NOT NULL,
    BRAND              VARCHAR(50)  NOT NULL,
    FIXTURE_TYPE       VARCHAR(50)  NOT NULL,
    FIXTURE_LABEL      VARCHAR(100) NOT NULL,   -- e.g. 'Wall 1', 'Denim Table'
    AREA_SQFT          FLOAT        NOT NULL,
    UPDATED_BY_EMAIL   VARCHAR(200) NOT NULL,
    UPDATED_AT         DATETIME2(6) NOT NULL,
    LOAD_RUN_DATE      VARCHAR(20)  NOT NULL
);

-- Store-entered (not HO-entered) sales mix by category — the store's own
-- read of which categories drive their business. Full replace per
-- (XSTORE_STORECODE, BRAND) on every save, same idiom as Planogram.
CREATE TABLE prd.DIM_UI_MONEY_MAPPING_CATEGORY_CONTRIBUTION (
    XSTORE_STORECODE   VARCHAR(50)  NOT NULL,
    BRAND              VARCHAR(50)  NOT NULL,
    CATEGORY           VARCHAR(50)  NOT NULL,   -- Jeans/Shirts/Crew/Collared Tee/Non-denim & Shorts/Sweatshirts/Jackets/Others
    CONTRIBUTION_PCT   FLOAT        NOT NULL,
    UPDATED_BY_EMAIL   VARCHAR(200) NOT NULL,
    UPDATED_AT         DATETIME2(6) NOT NULL,
    LOAD_RUN_DATE      VARCHAR(20)  NOT NULL
);
