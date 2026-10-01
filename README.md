# Project Utilities & Maintenance Management System

A web app for recording and reporting daily electricity, LPG, generator runtime, diesel, duct-cleaning schedules and monthly WAPDA bills across multiple project sites. It has admin and site-user roles, a central dashboard, and daily and monthly reports. Reports can be viewed, printed, or exported to PDF, Excel and CSV.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22.13+ (tested on 24) | Runs on Windows or Linux without build tools |
| Web | Express 5, server-rendered EJS | Permission checks run on the server for every page and API call. No front-end build step. |
| Database | SQLite through Node's built-in `node:sqlite` | A single persistent file with transactions, partial unique indexes and foreign keys. No native module to compile. |
| Charts | Chart.js, served locally | Strict Content Security Policy with no CDN |
| Exports | PDFKit, ExcelJS, built-in CSV | Every format renders the same report structure |
| Security | scrypt password hashing (built in), sessions stored in the database, CSRF tokens, Helmet CSP, login throttling | |

## Setup

```bash
cd utilities-management
npm install
cp .env.example .env          # then set SESSION_SECRET (see below)
npm run db:init               # creates the database and the 7 project sites
npm run create-admin          # creates the first admin (password prompted, hidden)
npm start                     # http://localhost:3000
```

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Creating the first admin securely
`npm run create-admin` asks for a username, full name and password. The password is typed without being shown and must meet the password policy. For automated provisioning:

```bash
ADMIN_PASSWORD='...' npm run create-admin -- --username ops.admin --name "Operations Admin"
```

No credentials are hard-coded and there is no public registration. Admins create every other account in **Admin → Users**. New and reset users must change their password at first sign-in.

### Environment variables
| Variable | Default | Notes |
|---|---|---|
| `SESSION_SECRET` | random per process (development only) | **Required** when `NODE_ENV=production` |
| `NODE_ENV` | — | `production` turns on secure cookies |
| `PORT` | `3000` | |
| `DATABASE_PATH` | `data/app.db` | Back this file up. Use `sqlite3 .backup` or copy it while the app is stopped. |
| `UPLOAD_DIR` | `storage/uploads` | Private storage for bill and maintenance attachments |
| `MAX_UPLOAD_MB` | `5` | PDF, JPG and PNG only. File content is checked, not just the extension. |
| `SESSION_HOURS` | `12` | Sliding session lifetime |
| `COOKIE_SECURE` | `true` in production | Set `false` only for local HTTP testing |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy that terminates HTTPS |

### Demonstration data
Load sample data from **Admin → Settings & demo data**, or with `npm run demo:seed`. The seed creates meters, generators, tanks, 75 days of readings, generator sessions, diesel and LPG records, maintenance history and bills for every site. It also creates a demo user limited to two sites, whose password is generated and shown once. Every demo row is flagged and labelled **DEMO** in the interface. Remove it all with the button on the same page or with `npm run demo:remove`. The seven sites are never removed. If real records were entered against demo meters or generators, removal is refused until those records are dealt with.

## Tests
```bash
npm test
```
The 22 automated tests cover:
- admin access across sites
- user access limited to assigned sites, across pages, API, exports and attachments
- CSRF protection
- electricity calculations, including backdated inserts, edits, deletes and meter replacement
- LPG and diesel stock balances, carry-forward, flagging, and kg/cylinder separation
- generator sessions across midnight, overlaps and running sessions
- diesel per hour and shared tanks
- maintenance scheduling, including month-end handling, history and admin override
- bill balances, duplicate bills and bill-vs-meter comparison
- period locks
- dashboard and report totals agreeing with each other
- CSV, Excel and PDF export accuracy
- demo data removal

---

## Database structure

| Table | Purpose |
|---|---|
| `users`, `user_sites` | Accounts (admin / user) and site assignments |
| `sites` | Configurable sites: active flag, which daily records are required, LPG unit (kg or cylinders, with net kg per cylinder) |
| `meters` | Several per site. Location is project site or accommodation. Stores the account reference and the initial baseline reading and date. |
| `meter_events` | Admin workflow for meter **replacement / reset / correction**. Sets a new baseline and can credit the old meter's final usage. |
| `electricity_readings` | Daily readings. The previous reading is always worked out on the server from the meter's history. Unique per meter and date. |
| `lpg_records` | Daily stock per site. Each record keeps its own unit and cylinder weight. Flags openings that differ from the previous closing. |
| `diesel_tanks`, `generators` | Each generator links to an **individual** or **shared** tank |
| `generator_sessions` | Start and stop times (Asia/Karachi). A missing stop time means the session is still running. Overlaps are blocked. |
| `diesel_records` | Daily stock **per tank**. A shared tank therefore has one record per day, so its diesel is never counted twice. |
| `maintenance_items`, `maintenance_tasks` | Item and frequency, plus one row per scheduled occurrence. Completing a task keeps it as history and creates the next one. |
| `bills` | One per meter per billing month, with overlap checks. The outstanding balance and payment status are calculated rather than stored. |
| `attachments` | Files stored outside the web root under random names and served only after a site-access check |
| `period_locks` | A locked month, for one site or for all sites |
| `audit_log` | Before and after values for every change, plus sign-ins and exports |
| `sessions`, `settings` | Server-side sessions and app settings (for example the "Due" window for maintenance) |

Every operational record has `created_by/at`, `updated_by/at` and `deleted_at/by` (soft delete), plus `is_demo`.

## Screens
- **Sign in / Change password** (forced after an admin reset)
- **Dashboard**:
  - all sites or one site, with Today, Yesterday, This month, Last month or a custom range
  - KPI cards
  - five charts: electricity trend, LPG trend, generator runtime, diesel, site comparison
  - a monthly bills chart
  - overdue and due cleaning tasks
  - missing entries, shown separately from zero consumption
  - site summary, recent records and recent activity
- **Daily entry**, designed for phones:
  - Electricity: the previous reading and consumption update as you type, with duplicate and lock warnings
  - LPG and Diesel: opening stock is carried forward, consumption updates as you type, invalid balances are flagged
  - Generator logbook: running sessions can be stopped in one tap, and sessions crossing midnight are flagged
- **Duct cleaning**: tabs for overdue, due, scheduled and completed. Completing a task accepts an optional photo or PDF and schedules the next one. Admins can override the date.
- **WAPDA bills**: payment tracking, attachments, and a billed-vs-recorded comparison with reliability notes
- **Records**: search across every record type, with pagination and view/edit links
- **Reports**: daily or monthly. Filters cover site, dates or month, record type, site or accommodation, meter and generator. Output can be viewed, printed, or downloaded as PDF (with page numbers), Excel or CSV.
- **Admin**: users (sites, deactivation, password reset), sites, meters and meter events, generators and tanks, maintenance items, period locks, audit trail, settings and demo data

## Calculation rules
- **Electricity:** consumption = current − previous (+ the old meter's final usage after a replacement). Editing or deleting a reading recalculates every later reading for that meter. A change that would make any reading negative, or alter a locked month, is rejected.
- **LPG and diesel:** consumed = opening + received − closing. A negative result is rejected. When opening ≠ previous closing, remarks are required and the record is flagged.
- **Generator runtime:** sessions are split at midnight (Asia/Karachi, UTC+5) for daily totals. Running sessions count up to the current time and are labelled.
- **Diesel per hour:** litres ÷ runtime of the generators on that tank. Shows **N/A** when runtime is zero.
- **Missing entries:** checked only for active sites, active and required meters and tanks, record types the site requires, and dates up to today. A zero reading is *not* missing.
- **Averages:** total ÷ calendar days (days elapsed so far for the current month). This is labelled in the report.
- **% change** shows **N/A** when the previous period is zero or unavailable.
- **One source of truth:** the dashboard, reports and all exports use the same `services/metrics.js` functions, so their totals match.
- **Locks:** a locked month blocks create, edit and delete for everyone until an admin unlocks it.

## Permissions
| | Admin | User |
|---|---|---|
| Sites | All | Assigned, active sites only (enforced on pages, API, exports and files) |
| Enter records | ✔ | ✔ (assigned sites) |
| Edit records | Any | Own records only, unless the period is locked |
| Delete records (soft delete) | ✔ | ✘ |
| Complete maintenance tasks | ✔ (with date override) | ✔ |
| Users, sites, meters, generators, tanks, locks, audit, demo data | ✔ | ✘ |

## JSON API (session-authenticated)
`GET /api/me`, `/api/sites`, `/api/meters?site=`, `/api/generators?site=`, `/api/tanks?site=`, `/api/electricity/previous?meter=&date=`, `/api/lpg/suggest`, `/api/diesel/suggest`, `/api/dashboard?site=&preset=|from=&to=`, `/api/records`, `/api/reports/daily|monthly`.
`POST /api/electricity`, `/api/lpg`, `/api/diesel` and `/api/generator-sessions` create records. They need the `X-CSRF-Token` header and go through the same validation and permission checks as the forms.

## Production notes
- Run behind HTTPS (nginx, Caddy or IIS) with `NODE_ENV=production`, `TRUST_PROXY=true` and a strong `SESSION_SECRET`.
- Back up `DATABASE_PATH` and `UPLOAD_DIR` together.
- Keep the app running with a process manager such as PM2, NSSM (Windows service) or systemd.
