'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, time, makeUser, sites, equip, client } = require('./helpers');
const { createApp } = require('../src/app');
const electricity = require('../src/services/electricity');

const app = createApp({ dbPath: process.env.DATABASE_PATH });
const admin = makeUser('admin');
const [s1, s2] = sites();
const user = makeUser('user', [s1.id]);
const other = makeUser('user', [s1.id]);
const e1 = equip(admin, s1.id, { initialReading: 0 });
const e2 = equip(admin, s2.id, { initialReading: 0 });
const day = time.addDays(time.today(), -3);
const rec2 = electricity.create(admin, { site_id: s2.id, meter_id: e2.meter.id, record_date: day, current_reading: '10', recorded_by: 'Admin' });

test('unauthenticated access is redirected or rejected', async () => {
  const c = await client(app);
  try {
    const r = await c.request('/');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');
    const api = await c.request('/api/dashboard');
    assert.equal(api.status, 401);
    const reg = await c.request('/register');
    assert.notEqual(reg.status, 200); // no public registration
  } finally { await c.close(); }
});

test('login rejects bad credentials and CSRF-less posts', async () => {
  const c = await client(app);
  try {
    const bad = await c.login(user.username, 'wrong-password-1');
    assert.equal(bad.status, 401);
    const noCsrf = await c.request('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=x&password=y' });
    assert.equal(noCsrf.status, 403);
  } finally { await c.close(); }
});

test('admin can access every site and admin pages', async () => {
  const c = await client(app);
  try {
    const r = await c.login(admin.username);
    assert.equal(r.status, 302);
    assert.equal((await c.request(`/electricity/${rec2.id}`)).status, 200);
    assert.equal((await c.request('/admin/users')).status, 200);
    const api = await (await c.request('/api/sites')).json();
    assert.equal(api.length, sites().length);
  } finally { await c.close(); }
});

test('user is limited to assigned sites — pages, API and direct requests', async () => {
  const c = await client(app);
  try {
    await c.login(user.username);
    // Other site's record, by page and filters
    assert.equal((await c.request(`/electricity/${rec2.id}`)).status, 403);
    assert.equal((await c.request(`/electricity?site=${s2.id}`)).status, 403);
    assert.equal((await c.request(`/reports/daily?site=${s2.id}&format=csv`)).status, 403);
    assert.equal((await c.request(`/api/electricity/previous?meter=${e2.meter.id}`)).status, 403);
    // API only lists assigned sites
    const me = await (await c.request('/api/me')).json();
    assert.deepEqual(me.sites.map((s) => s.id), [s1.id]);
    const dash = await (await c.request('/api/dashboard')).json();
    assert.deepEqual(dash.sites.map((s) => s.name), [s1.name]);
    // "All sites" export silently scopes to assigned sites
    const csv = await (await c.request('/reports/daily?site=all&format=csv')).text();
    assert.ok(!csv.includes(s2.name));
    // Admin areas forbidden
    assert.equal((await c.request('/admin/users')).status, 403);
    assert.equal((await c.post('/admin/demo/seed', {})).status, 403);
    assert.equal((await c.request('/maintenance/items/new')).status, 403);
    // Direct API create for another site is refused
    const apiCreate = await c.post('/api/electricity', { site_id: s2.id, meter_id: e2.meter.id, record_date: day, current_reading: 20, recorded_by: 'x' }, { json: true });
    assert.equal(apiCreate.status, 403);
    // ...but allowed for an assigned site
    const ok = await c.post('/api/electricity', { site_id: s1.id, meter_id: e1.meter.id, record_date: day, current_reading: 20, recorded_by: 'x' }, { json: true });
    assert.equal(ok.status, 201);
    const created = await ok.json();
    assert.equal(created.consumption_kwh, 20);
    // Missing CSRF header on API mutation is refused
    const noToken = await c.request('/api/electricity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noToken.status, 403);
  } finally { await c.close(); }
});

test('users edit only their own records and cannot delete; locked periods block edits', async () => {
  const mine = electricity.create(user, { site_id: s1.id, meter_id: e1.meter.id, record_date: time.addDays(day, 1), current_reading: '30', recorded_by: 'U' });
  const theirs = electricity.create(other, { site_id: s1.id, meter_id: e1.meter.id, record_date: time.addDays(day, 2), current_reading: '40', recorded_by: 'O' });
  const c = await client(app);
  try {
    await c.login(user.username);
    let r = await c.post(`/electricity/${mine.id}`, { record_date: mine.record_date, current_reading: '31', recorded_by: 'U' });
    assert.equal(r.status, 302);
    assert.equal(dbm.db().prepare('SELECT current_reading FROM electricity_readings WHERE id = ?').get(mine.id).current_reading, 31);
    r = await c.post(`/electricity/${theirs.id}`, { record_date: theirs.record_date, current_reading: '45', recorded_by: 'U' });
    assert.equal(r.status, 403);
    r = await c.post(`/electricity/${mine.id}/delete`, {});
    assert.equal(r.status, 403);
    // Lock the period containing a past record created by the user
    const oldMonth = time.addMonthsToMonth(time.monthOf(time.today()), -2);
    const e3 = equip(admin, s1.id, { initialReading: 0, initialDate: `${oldMonth}-01` });
    const old = electricity.create(user, { site_id: s1.id, meter_id: e3.meter.id, record_date: `${oldMonth}-05`, current_reading: '5', recorded_by: 'U' });
    require('../src/services/admin').lockPeriod(admin, { month: oldMonth });
    r = await c.post(`/electricity/${old.id}`, { record_date: old.record_date, current_reading: '6', recorded_by: 'U' });
    assert.equal(r.status, 423);
  } finally { await c.close(); }
});

test('deactivated users are signed out; forced password change is enforced', async () => {
  const temp = makeUser('user', [s1.id]);
  const c = await client(app);
  try {
    await c.login(temp.username);
    assert.equal((await c.request('/electricity')).status, 200);
    require('../src/services/admin').updateUser(admin, temp.id, { full_name: 'X', role: 'user', site_ids: [String(s1.id)] }); // is_active omitted → deactivated
    assert.equal((await c.request('/electricity')).status, 302);
  } finally { await c.close(); }

  const reset = makeUser('user', [s1.id]);
  require('../src/services/admin').resetPassword(admin, reset.id, { password: 'Temporary123' });
  const c2 = await client(app);
  try {
    const r = await c2.login(reset.username, 'Temporary123');
    assert.equal(r.headers.get('location'), '/account/password');
    const blocked = await c2.request('/electricity');
    assert.equal(blocked.headers.get('location'), '/account/password');
  } finally { await c2.close(); }
});

test('attachments are only served to users with access to the site', async () => {
  const attachments = require('../src/services/attachments');
  const pdf = Buffer.from('%PDF-1.4\n%test file\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const a = attachments.save({ buffer: pdf, size: pdf.length, originalname: 'bill.pdf' }, { ownerType: 'bill', ownerId: 1, siteId: s2.id, user: admin });
  assert.throws(() => attachments.save({ buffer: Buffer.from('MZ-executable-content'), size: 20, originalname: 'x.pdf' }, { ownerType: 'bill', ownerId: 1, siteId: s2.id, user: admin }), /Only PDF/);
  const c = await client(app);
  try {
    await c.login(user.username);
    assert.equal((await c.request(`/files/${a.id}`)).status, 403);
  } finally { await c.close(); }
  const c2 = await client(app);
  try {
    await c2.login(admin.username);
    const r = await c2.request(`/files/${a.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
  } finally { await c2.close(); }
});
