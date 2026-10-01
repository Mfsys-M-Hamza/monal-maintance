'use strict';
// Test bootstrap: isolated temporary database + upload directory per test process.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umms-test-'));
process.env.DATABASE_PATH = path.join(dir, 'test.db');
process.env.UPLOAD_DIR = path.join(dir, 'uploads');
process.env.SESSION_SECRET = 'test-secret-' + Date.now();

const dbm = require('../src/db');
dbm.init(process.env.DATABASE_PATH);
const { hashPassword } = require('../src/lib/passwords');
const time = require('../src/lib/time');

const PASSWORD = 'TestPass12345';
let seq = 0;

function makeUser(role = 'user', siteIds = []) {
  const ts = dbm.nowIso();
  const username = `${role}${++seq}`;
  const id = Number(dbm.db().prepare(`INSERT INTO users (username, full_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(username, `Test ${username}`, hashPassword(PASSWORD), role, ts, ts).lastInsertRowid);
  for (const s of siteIds) dbm.db().prepare('INSERT INTO user_sites (user_id, site_id) VALUES (?, ?)').run(id, s);
  return dbm.db().prepare('SELECT id, username, full_name, role FROM users WHERE id = ?').get(id);
}

function sites() {
  return dbm.db().prepare('SELECT * FROM sites ORDER BY id').all();
}

/** Create a meter, tank and generator(s) for a site. */
function equip(admin, siteId, { initialReading = 1000, initialDate = time.addDays(time.today(), -60), shared = false } = {}) {
  const adminSvc = require('../src/services/admin');
  const n = ++seq;
  const meter = adminSvc.saveMeter(admin, null, { site_id: String(siteId), name: `Meter ${n}`, location: 'site', initial_reading: String(initialReading), initial_date: initialDate, is_required: '1' });
  const tank = adminSvc.saveTank(admin, null, { site_id: String(siteId), name: `Tank ${n}`, tank_type: shared ? 'shared' : 'individual', is_required: '1' });
  const gen1 = adminSvc.saveGenerator(admin, null, { site_id: String(siteId), name: `Gen ${n}A`, tank_id: String(tank.id) });
  const gen2 = shared ? adminSvc.saveGenerator(admin, null, { site_id: String(siteId), name: `Gen ${n}B`, tank_id: String(tank.id) }) : null;
  return { meter, tank, gen1, gen2 };
}

/** Minimal HTTP client with cookie + CSRF handling. */
async function client(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrf = '';
  const request = async (p, opts = {}) => {
    const headers = { cookie, ...(opts.headers || {}) };
    const r = await fetch(base + p, { redirect: 'manual', ...opts, headers });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return r;
  };
  const refreshCsrf = async () => {
    const r = await request('/login');
    const html = await r.text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    if (m) csrf = m[1];
  };
  return {
    server, request,
    get csrf() { return csrf; },
    async login(username, password = PASSWORD) {
      await refreshCsrf();
      const r = await request('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, username, password }) });
      // CSRF token is regenerated with the session; fetch a page to obtain the new one.
      const page = await request('/account/password');
      const m = (await page.text()).match(/name="_csrf" value="([^"]+)"/);
      if (m) csrf = m[1];
      return r;
    },
    async post(p, body, { json = false } = {}) {
      if (json) return request(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, accept: 'application/json' }, body: JSON.stringify(body) });
      return request(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...body }) });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { dbm, time, makeUser, sites, equip, client, PASSWORD, dir };
