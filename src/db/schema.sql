-- Project Utilities & Maintenance Management System — SQLite schema
-- Operational dates are stored as 'YYYY-MM-DD' (Asia/Karachi calendar date).
-- Operational date-times are stored as 'YYYY-MM-DDTHH:MM' in Asia/Karachi local time (UTC+05:00, no DST).
-- Audit / system timestamps are stored as ISO-8601 UTC strings.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name            TEXT NOT NULL,
  email                TEXT,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('admin','user')),
  is_active            INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  is_demo              INTEGER NOT NULL DEFAULT 0,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE COLLATE NOCASE,
  code                TEXT,
  address             TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1,
  -- which daily record types are mandatory (drives "missing entry" flags)
  req_electricity     INTEGER NOT NULL DEFAULT 1,
  req_lpg             INTEGER NOT NULL DEFAULT 1,
  req_diesel          INTEGER NOT NULL DEFAULT 1,
  req_generator_log   INTEGER NOT NULL DEFAULT 0,
  -- LPG unit: 'kg' (default) or 'cylinder'
  lpg_unit            TEXT NOT NULL DEFAULT 'kg' CHECK (lpg_unit IN ('kg','cylinder')),
  lpg_cylinder_kg     REAL NOT NULL DEFAULT 45.4,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, site_id)
);

CREATE TABLE IF NOT EXISTS meters (
  id              INTEGER PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id),
  name            TEXT NOT NULL,
  location        TEXT NOT NULL CHECK (location IN ('site','accommodation')),
  account_ref     TEXT,            -- WAPDA reference / consumer number
  serial_no       TEXT,
  initial_reading REAL NOT NULL DEFAULT 0,
  initial_date    TEXT NOT NULL,   -- baseline date for the initial reading
  is_required     INTEGER NOT NULL DEFAULT 1,
  is_active       INTEGER NOT NULL DEFAULT 1,
  is_demo         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (site_id, name)
);

-- Explicit admin workflow for meter replacement / reset / correction.
-- From event_date onward, the next reading's "previous reading" is new_start_reading.
-- If old_final_reading is given, the consumption between the last recorded reading and
-- old_final_reading is credited to the first reading after the event (pre_event_kwh).
CREATE TABLE IF NOT EXISTS meter_events (
  id                 INTEGER PRIMARY KEY,
  meter_id           INTEGER NOT NULL REFERENCES meters(id),
  event_type         TEXT NOT NULL CHECK (event_type IN ('replacement','reset','correction')),
  event_date         TEXT NOT NULL,
  old_final_reading  REAL,
  new_start_reading  REAL NOT NULL,
  new_serial_no      TEXT,
  reason             TEXT NOT NULL,
  is_demo            INTEGER NOT NULL DEFAULT 0,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL,
  deleted_at         TEXT,
  deleted_by         INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS diesel_tanks (
  id          INTEGER PRIMARY KEY,
  site_id     INTEGER NOT NULL REFERENCES sites(id),
  name        TEXT NOT NULL,
  tank_type   TEXT NOT NULL CHECK (tank_type IN ('individual','shared')),
  capacity_l  REAL,
  is_required INTEGER NOT NULL DEFAULT 1,
  is_active   INTEGER NOT NULL DEFAULT 1,
  is_demo     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (site_id, name)
);

CREATE TABLE IF NOT EXISTS generators (
  id           INTEGER PRIMARY KEY,
  site_id      INTEGER NOT NULL REFERENCES sites(id),
  name         TEXT NOT NULL,
  capacity_kva REAL,
  tank_id      INTEGER REFERENCES diesel_tanks(id),
  is_active    INTEGER NOT NULL DEFAULT 1,
  is_demo      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (site_id, name)
);

CREATE TABLE IF NOT EXISTS electricity_readings (
  id               INTEGER PRIMARY KEY,
  site_id          INTEGER NOT NULL REFERENCES sites(id),
  meter_id         INTEGER NOT NULL REFERENCES meters(id),
  record_date      TEXT NOT NULL,
  previous_reading REAL NOT NULL,
  current_reading  REAL NOT NULL,
  pre_event_kwh    REAL NOT NULL DEFAULT 0,
  consumption_kwh  REAL NOT NULL,
  baseline_event_id INTEGER REFERENCES meter_events(id),
  recorded_by      TEXT NOT NULL,
  remarks          TEXT,
  is_demo          INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_by       INTEGER REFERENCES users(id),
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT,
  deleted_by       INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_elec_meter_date ON electricity_readings(meter_id, record_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_elec_site_date ON electricity_readings(site_id, record_date);

CREATE TABLE IF NOT EXISTS lpg_records (
  id               INTEGER PRIMARY KEY,
  site_id          INTEGER NOT NULL REFERENCES sites(id),
  record_date      TEXT NOT NULL,
  unit             TEXT NOT NULL CHECK (unit IN ('kg','cylinder')),
  cylinder_kg      REAL,           -- net kg per cylinder snapshot (cylinder unit only)
  opening_stock    REAL NOT NULL,
  received_stock   REAL NOT NULL DEFAULT 0,
  closing_stock    REAL NOT NULL,
  consumed         REAL NOT NULL,  -- in the record's unit
  opening_mismatch INTEGER NOT NULL DEFAULT 0, -- opening differs from previous closing
  expected_opening REAL,
  recorded_by      TEXT NOT NULL,
  remarks          TEXT,
  is_demo          INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_by       INTEGER REFERENCES users(id),
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT,
  deleted_by       INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lpg_site_date ON lpg_records(site_id, record_date) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS generator_sessions (
  id                 INTEGER PRIMARY KEY,
  site_id            INTEGER NOT NULL REFERENCES sites(id),
  generator_id       INTEGER NOT NULL REFERENCES generators(id),
  operating_date     TEXT NOT NULL,      -- date of start (Karachi)
  start_at           TEXT NOT NULL,      -- 'YYYY-MM-DDTHH:MM' Karachi
  stop_at            TEXT,               -- NULL = still running
  opening_hour_meter REAL,
  closing_hour_meter REAL,
  reason             TEXT NOT NULL,
  operator_name      TEXT NOT NULL,
  remarks            TEXT,
  is_demo            INTEGER NOT NULL DEFAULT 0,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL,
  updated_by         INTEGER REFERENCES users(id),
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT,
  deleted_by         INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_gen_sessions ON generator_sessions(generator_id, start_at);

CREATE TABLE IF NOT EXISTS diesel_records (
  id             INTEGER PRIMARY KEY,
  site_id        INTEGER NOT NULL REFERENCES sites(id),
  tank_id        INTEGER NOT NULL REFERENCES diesel_tanks(id),
  record_date    TEXT NOT NULL,
  opening_l      REAL NOT NULL,
  received_l     REAL NOT NULL DEFAULT 0,
  closing_l      REAL NOT NULL,
  consumed_l     REAL NOT NULL,
  opening_mismatch INTEGER NOT NULL DEFAULT 0,
  expected_opening REAL,
  recorded_by    TEXT NOT NULL,
  remarks        TEXT,
  is_demo        INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_by     INTEGER REFERENCES users(id),
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  deleted_by     INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_diesel_tank_date ON diesel_records(tank_id, record_date) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS maintenance_items (
  id              INTEGER PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id),
  name            TEXT NOT NULL,             -- duct / equipment / area
  category        TEXT NOT NULL DEFAULT 'Duct cleaning',
  frequency_value INTEGER NOT NULL CHECK (frequency_value > 0),
  frequency_unit  TEXT NOT NULL CHECK (frequency_unit IN ('days','weeks','months')),
  assigned_to     TEXT,
  remarks         TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  is_demo         INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- One row per scheduled occurrence. Completed rows are history; completing one creates the next.
CREATE TABLE IF NOT EXISTS maintenance_tasks (
  id                  INTEGER PRIMARY KEY,
  item_id             INTEGER NOT NULL REFERENCES maintenance_items(id),
  site_id             INTEGER NOT NULL REFERENCES sites(id),
  last_completed_date TEXT,
  scheduled_date      TEXT NOT NULL,
  schedule_overridden INTEGER NOT NULL DEFAULT 0,
  assigned_to         TEXT,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  completion_date     TEXT,
  completed_by_name   TEXT,
  remarks             TEXT,
  is_demo             INTEGER NOT NULL DEFAULT 0,
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_by          INTEGER REFERENCES users(id),
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT,
  deleted_by          INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_mt_item ON maintenance_tasks(item_id, status);

CREATE TABLE IF NOT EXISTS bills (
  id             INTEGER PRIMARY KEY,
  site_id        INTEGER NOT NULL REFERENCES sites(id),
  meter_id       INTEGER NOT NULL REFERENCES meters(id),
  category       TEXT NOT NULL CHECK (category IN ('site','accommodation')),
  account_ref    TEXT,
  billing_month  TEXT NOT NULL,   -- 'YYYY-MM'
  period_start   TEXT NOT NULL,
  period_end     TEXT NOT NULL,
  billed_units   REAL NOT NULL,
  amount_pkr     REAL NOT NULL,
  due_date       TEXT,
  amount_paid    REAL NOT NULL DEFAULT 0,
  payment_date   TEXT,
  remarks        TEXT,
  is_demo        INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_by     INTEGER REFERENCES users(id),
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  deleted_by     INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bill_meter_month ON bills(meter_id, billing_month) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY,
  owner_type    TEXT NOT NULL CHECK (owner_type IN ('bill','maintenance_task')),
  owner_id      INTEGER NOT NULL,
  site_id       INTEGER NOT NULL REFERENCES sites(id),
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL UNIQUE,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  is_demo       INTEGER NOT NULL DEFAULT 0,
  uploaded_by   INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_attach_owner ON attachments(owner_type, owner_id);

-- A lock applies to one month for one site (site_id) or for all sites (site_id NULL).
CREATE TABLE IF NOT EXISTS period_locks (
  id         INTEGER PRIMARY KEY,
  site_id    INTEGER REFERENCES sites(id),
  month      TEXT NOT NULL,  -- 'YYYY-MM'
  locked_by  INTEGER REFERENCES users(id),
  locked_at  TEXT NOT NULL,
  note       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lock ON period_locks(IFNULL(site_id, 0), month);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   INTEGER,
  site_id     INTEGER,
  action      TEXT NOT NULL,
  user_id     INTEGER,
  username    TEXT,
  before_json TEXT,
  after_json  TEXT,
  reason      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  sess    TEXT NOT NULL,
  expires INTEGER NOT NULL
);
