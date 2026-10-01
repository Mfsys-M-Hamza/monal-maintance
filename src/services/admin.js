'use strict';
// Admin-managed configuration: users, sites, meters, generators, diesel tanks, period locks.
const { db, tx, nowIso } = require('../db');
const { ValidationError, notFound, HttpError } = require('../lib/errors');
const access = require('../lib/access');
const { audit } = require('../lib/audit');
const { parse } = require('../lib/validate');
const { hashPassword, passwordPolicyError, verifyPassword } = require('../lib/passwords');
const time = require('../lib/time');

const uniqueError = (err, field, msg) => {
  if (String(err.message).includes('UNIQUE')) throw new ValidationError(msg, { [field]: msg });
  throw err;
};

// ---------------- Users ----------------

function getUser(id) {
  const u = db().prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (u) u.site_ids = db().prepare('SELECT site_id FROM user_sites WHERE user_id = ?').all(id).map((r) => r.site_id);
  return u;
}

function publicUser(u) {
  if (!u) return u;
  const { password_hash, ...rest } = u;
  void password_hash;
  return rest;
}

function listUsers() {
  const users = db().prepare('SELECT * FROM users ORDER BY role, full_name').all();
  const links = db().prepare('SELECT us.user_id, s.name FROM user_sites us JOIN sites s ON s.id = us.site_id ORDER BY s.name').all();
  return users.map((u) => ({ ...publicUser(u), site_names: links.filter((l) => l.user_id === u.id).map((l) => l.name) }));
}

function setUserSites(userId, siteIds) {
  db().prepare('DELETE FROM user_sites WHERE user_id = ?').run(userId);
  const ins = db().prepare('INSERT INTO user_sites (user_id, site_id) VALUES (?, ?)');
  const valid = new Set(db().prepare('SELECT id FROM sites').all().map((r) => r.id));
  for (const sid of new Set(siteIds)) if (valid.has(sid)) ins.run(userId, sid);
}

function activeAdminCount(excludeId) {
  return db().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?").get(excludeId ?? 0).n;
}

function createUser(admin, body, ctx = {}) {
  access.assertAdmin(admin);
  const p = parse(body);
  const input = {
    username: p.str('username', { required: true, max: 50, label: 'Username' }),
    full_name: p.str('full_name', { required: true, max: 100, label: 'Full name' }),
    email: p.str('email', { max: 150, label: 'Email' }),
    role: p.oneOf('role', ['admin', 'user'], { label: 'Role' }),
    password: typeof body.password === 'string' ? body.password : '',
    site_ids: p.ids('site_ids'),
  };
  if (input.username && !/^[a-zA-Z0-9._-]{3,50}$/.test(input.username)) p.fail('username', 'Use 3–50 letters, numbers, dots, dashes or underscores.');
  const pwErr = passwordPolicyError(input.password);
  if (pwErr) p.fail('password', pwErr);
  if (input.role === 'user' && !input.site_ids.length) p.fail('site_ids', 'Assign at least one site to a user.');
  p.done();
  return tx(() => {
    const ts = nowIso();
    let id;
    try {
      id = db().prepare(`INSERT INTO users (username, full_name, email, password_hash, role, must_change_password, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(input.username, input.full_name, input.email, hashPassword(input.password), input.role, ts, ts).lastInsertRowid;
    } catch (err) { uniqueError(err, 'username', 'This username is already taken.'); }
    if (input.role === 'user') setUserSites(Number(id), input.site_ids);
    const u = getUser(Number(id));
    audit({ entityType: 'user', entityId: u.id, action: 'create', user: admin, after: publicUser(u), ip: ctx.ip });
    return u;
  });
}

function updateUser(admin, id, body, ctx = {}) {
  access.assertAdmin(admin);
  const before = getUser(id);
  if (!before) throw notFound('User not found.');
  const p = parse(body);
  const input = {
    full_name: p.str('full_name', { required: true, max: 100, label: 'Full name' }),
    email: p.str('email', { max: 150, label: 'Email' }),
    role: p.oneOf('role', ['admin', 'user'], { label: 'Role' }),
    is_active: p.bool('is_active'),
    site_ids: p.ids('site_ids'),
  };
  if (input.role === 'user' && !input.site_ids.length) p.fail('site_ids', 'Assign at least one site to a user.');
  if (before.id === admin.id && (input.role !== 'admin' || !input.is_active)) p.fail('role', 'You cannot remove your own admin access or deactivate yourself.');
  if (before.role === 'admin' && (input.role !== 'admin' || !input.is_active) && activeAdminCount(before.id) === 0) p.fail('role', 'At least one active admin is required.');
  p.done();
  return tx((d) => {
    d.prepare('UPDATE users SET full_name = ?, email = ?, role = ?, is_active = ?, updated_at = ? WHERE id = ?')
      .run(input.full_name, input.email, input.role, input.is_active, nowIso(), id);
    setUserSites(id, input.role === 'user' ? input.site_ids : []);
    if (!input.is_active) d.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(id);
    const after = getUser(id);
    audit({ entityType: 'user', entityId: id, action: 'update', user: admin, before: publicUser(before), after: publicUser(after), ip: ctx.ip });
    return after;
  });
}

/** Admin-controlled reset: sets a temporary password the user must change at next login. */
function resetPassword(admin, id, body, ctx = {}) {
  access.assertAdmin(admin);
  const u = getUser(id);
  if (!u) throw notFound('User not found.');
  const pw = typeof body.password === 'string' ? body.password : '';
  const err = passwordPolicyError(pw);
  if (err) throw new ValidationError(err, { password: err });
  db().prepare('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?').run(hashPassword(pw), nowIso(), id);
  db().prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(id);
  audit({ entityType: 'user', entityId: id, action: 'password_reset', user: admin, ip: ctx.ip });
}

function changeOwnPassword(user, body, ctx = {}) {
  const u = db().prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const errors = {};
  if (!verifyPassword(body.current_password || '', u.password_hash)) errors.current_password = 'Current password is incorrect.';
  const err = passwordPolicyError(body.new_password);
  if (err) errors.new_password = err;
  else if (body.new_password !== body.confirm_password) errors.confirm_password = 'Passwords do not match.';
  else if (body.new_password === body.current_password) errors.new_password = 'Choose a password different from the current one.';
  if (Object.keys(errors).length) throw new ValidationError('Password not changed.', errors);
  db().prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(hashPassword(body.new_password), nowIso(), user.id);
  audit({ entityType: 'user', entityId: user.id, action: 'password_change', user, ip: ctx.ip });
}

// ---------------- Sites ----------------

function parseSite(body) {
  const p = parse(body);
  const input = {
    name: p.str('name', { required: true, max: 100, label: 'Site name' }),
    code: p.str('code', { max: 20, label: 'Code' }),
    address: p.str('address', { max: 300, label: 'Address' }),
    is_active: p.bool('is_active'),
    req_electricity: p.bool('req_electricity'),
    req_lpg: p.bool('req_lpg'),
    req_diesel: p.bool('req_diesel'),
    req_generator_log: p.bool('req_generator_log'),
    lpg_unit: p.oneOf('lpg_unit', ['kg', 'cylinder'], { label: 'LPG unit', required: false, fallback: 'kg' }),
    lpg_cylinder_kg: p.num('lpg_cylinder_kg', { min: 0.1, max: 1000, label: 'Net LPG kg per cylinder' }) ?? 45.4,
  };
  p.done();
  return input;
}

function saveSite(admin, id, body, ctx = {}) {
  access.assertAdmin(admin);
  const input = parseSite(body);
  const before = id ? db().prepare('SELECT * FROM sites WHERE id = ?').get(id) : null;
  if (id && !before) throw notFound('Site not found.');
  const ts = nowIso();
  try {
    if (before) {
      db().prepare(`UPDATE sites SET name = ?, code = ?, address = ?, is_active = ?, req_electricity = ?, req_lpg = ?, req_diesel = ?, req_generator_log = ?,
        lpg_unit = ?, lpg_cylinder_kg = ?, updated_at = ? WHERE id = ?`).run(input.name, input.code, input.address, input.is_active, input.req_electricity,
        input.req_lpg, input.req_diesel, input.req_generator_log, input.lpg_unit, input.lpg_cylinder_kg, ts, id);
    } else {
      id = Number(db().prepare(`INSERT INTO sites (name, code, address, is_active, req_electricity, req_lpg, req_diesel, req_generator_log, lpg_unit, lpg_cylinder_kg, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.name, input.code, input.address, input.is_active, input.req_electricity, input.req_lpg,
        input.req_diesel, input.req_generator_log, input.lpg_unit, input.lpg_cylinder_kg, ts, ts).lastInsertRowid);
    }
  } catch (err) { uniqueError(err, 'name', 'A site with this name already exists.'); }
  const after = db().prepare('SELECT * FROM sites WHERE id = ?').get(id);
  audit({ entityType: 'site', entityId: id, siteId: id, action: before ? 'update' : 'create', user: admin, before, after, ip: ctx.ip });
  return after;
}

// ---------------- Meters / tanks / generators ----------------

function saveMeter(admin, id, body, ctx = {}) {
  access.assertAdmin(admin);
  const p = parse(body);
  const before = id ? db().prepare('SELECT * FROM meters WHERE id = ?').get(id) : null;
  if (id && !before) throw notFound('Meter not found.');
  const input = {
    site_id: before ? before.site_id : p.id('site_id', { label: 'Site' }),
    name: p.str('name', { required: true, max: 100, label: 'Meter name' }),
    location: p.oneOf('location', ['site', 'accommodation'], { label: 'Location' }),
    account_ref: p.str('account_ref', { max: 100, label: 'Account / reference no.' }),
    serial_no: p.str('serial_no', { max: 100, label: 'Serial number' }),
    is_required: p.bool('is_required'),
    is_active: before ? p.bool('is_active') : 1,
  };
  if (!before) {
    input.initial_reading = p.num('initial_reading', { required: true, min: 0, label: 'Initial reading' });
    input.initial_date = p.date('initial_date', { label: 'Initial reading date' });
  }
  p.done();
  const ts = nowIso();
  try {
    if (before) {
      // Initial reading/date are fixed after creation; use a meter event to change the baseline.
      db().prepare('UPDATE meters SET name = ?, location = ?, account_ref = ?, serial_no = ?, is_required = ?, is_active = ?, updated_at = ? WHERE id = ?')
        .run(input.name, input.location, input.account_ref, input.serial_no, input.is_required, input.is_active, ts, id);
    } else {
      id = Number(db().prepare(`INSERT INTO meters (site_id, name, location, account_ref, serial_no, initial_reading, initial_date, is_required, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(input.site_id, input.name, input.location, input.account_ref, input.serial_no, input.initial_reading,
        input.initial_date, input.is_required, ts, ts).lastInsertRowid);
    }
  } catch (err) { uniqueError(err, 'name', 'A meter with this name already exists at this site.'); }
  const after = db().prepare('SELECT * FROM meters WHERE id = ?').get(id);
  audit({ entityType: 'meter', entityId: id, siteId: after.site_id, action: before ? 'update' : 'create', user: admin, before, after, ip: ctx.ip });
  return after;
}

function saveTank(admin, id, body, ctx = {}) {
  access.assertAdmin(admin);
  const p = parse(body);
  const before = id ? db().prepare('SELECT * FROM diesel_tanks WHERE id = ?').get(id) : null;
  if (id && !before) throw notFound('Tank not found.');
  const input = {
    site_id: before ? before.site_id : p.id('site_id', { label: 'Site' }),
    name: p.str('name', { required: true, max: 100, label: 'Tank name' }),
    tank_type: p.oneOf('tank_type', ['individual', 'shared'], { label: 'Tank type' }),
    capacity_l: p.num('capacity_l', { min: 0, label: 'Capacity (L)' }),
    is_required: p.bool('is_required'),
    is_active: before ? p.bool('is_active') : 1,
  };
  p.done();
  if (before && input.tank_type === 'individual') {
    const n = db().prepare('SELECT COUNT(*) AS n FROM generators WHERE tank_id = ? AND is_active = 1').get(id).n;
    if (n > 1) throw new ValidationError('This tank feeds more than one generator; it must be marked as shared.', { tank_type: 'Tank feeds several generators.' });
  }
  const ts = nowIso();
  try {
    if (before) {
      db().prepare('UPDATE diesel_tanks SET name = ?, tank_type = ?, capacity_l = ?, is_required = ?, is_active = ?, updated_at = ? WHERE id = ?')
        .run(input.name, input.tank_type, input.capacity_l, input.is_required, input.is_active, ts, id);
    } else {
      id = Number(db().prepare('INSERT INTO diesel_tanks (site_id, name, tank_type, capacity_l, is_required, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.site_id, input.name, input.tank_type, input.capacity_l, input.is_required, ts, ts).lastInsertRowid);
    }
  } catch (err) { uniqueError(err, 'name', 'A tank with this name already exists at this site.'); }
  const after = db().prepare('SELECT * FROM diesel_tanks WHERE id = ?').get(id);
  audit({ entityType: 'diesel_tank', entityId: id, siteId: after.site_id, action: before ? 'update' : 'create', user: admin, before, after, ip: ctx.ip });
  return after;
}

function saveGenerator(admin, id, body, ctx = {}) {
  access.assertAdmin(admin);
  const p = parse(body);
  const before = id ? db().prepare('SELECT * FROM generators WHERE id = ?').get(id) : null;
  if (id && !before) throw notFound('Generator not found.');
  const input = {
    site_id: before ? before.site_id : p.id('site_id', { label: 'Site' }),
    name: p.str('name', { required: true, max: 100, label: 'Generator name' }),
    capacity_kva: p.num('capacity_kva', { min: 0, label: 'Capacity (kVA)' }),
    tank_id: p.id('tank_id', { required: false, label: 'Diesel tank' }),
    is_active: before ? p.bool('is_active') : 1,
  };
  p.done();
  if (input.tank_id) {
    const tank = db().prepare('SELECT * FROM diesel_tanks WHERE id = ?').get(input.tank_id);
    if (!tank || tank.site_id !== input.site_id) throw new ValidationError('Tank must belong to the same site.', { tank_id: 'Tank must belong to the same site.' });
    if (tank.tank_type === 'individual') {
      const other = db().prepare('SELECT name FROM generators WHERE tank_id = ? AND id IS NOT ? AND is_active = 1').get(tank.id, id || null);
      if (other) throw new ValidationError(`This individual tank already feeds ${other.name}. Mark it as shared or pick another tank.`, { tank_id: 'Individual tank already in use.' });
    }
  }
  const ts = nowIso();
  try {
    if (before) {
      db().prepare('UPDATE generators SET name = ?, capacity_kva = ?, tank_id = ?, is_active = ?, updated_at = ? WHERE id = ?')
        .run(input.name, input.capacity_kva, input.tank_id, input.is_active, ts, id);
    } else {
      id = Number(db().prepare('INSERT INTO generators (site_id, name, capacity_kva, tank_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.site_id, input.name, input.capacity_kva, input.tank_id, ts, ts).lastInsertRowid);
    }
  } catch (err) { uniqueError(err, 'name', 'A generator with this name already exists at this site.'); }
  const after = db().prepare('SELECT * FROM generators WHERE id = ?').get(id);
  audit({ entityType: 'generator', entityId: id, siteId: after.site_id, action: before ? 'update' : 'create', user: admin, before, after, ip: ctx.ip });
  return after;
}

// ---------------- Period locks ----------------

function lockPeriod(admin, body, ctx = {}) {
  access.assertAdmin(admin);
  const p = parse(body);
  const month = p.month('month', { label: 'Month' });
  const siteId = p.id('site_id', { required: false, label: 'Site' });
  const note = p.str('note', { max: 300, label: 'Note' });
  p.done();
  if (month >= time.monthOf(time.today())) throw new HttpError(422, 'Only completed months can be locked.');
  try {
    const id = Number(db().prepare('INSERT INTO period_locks (site_id, month, locked_by, locked_at, note) VALUES (?, ?, ?, ?, ?)')
      .run(siteId, month, admin.id, nowIso(), note).lastInsertRowid);
    audit({ entityType: 'period_lock', entityId: id, siteId, action: 'lock', user: admin, after: { site_id: siteId, month, note }, ip: ctx.ip });
  } catch (err) { uniqueError(err, 'month', 'This period is already locked.'); }
}

function unlockPeriod(admin, id, ctx = {}) {
  access.assertAdmin(admin);
  const lock = db().prepare('SELECT * FROM period_locks WHERE id = ?').get(id);
  if (!lock) throw notFound('Lock not found.');
  db().prepare('DELETE FROM period_locks WHERE id = ?').run(id);
  audit({ entityType: 'period_lock', entityId: id, siteId: lock.site_id, action: 'unlock', user: admin, before: lock, ip: ctx.ip });
}

function listLocks() {
  return db().prepare(`SELECT l.*, s.name AS site_name, u.full_name AS locked_by_name FROM period_locks l
    LEFT JOIN sites s ON s.id = l.site_id LEFT JOIN users u ON u.id = l.locked_by ORDER BY l.month DESC, s.name`).all();
}

module.exports = {
  getUser, publicUser, listUsers, createUser, updateUser, resetPassword, changeOwnPassword,
  saveSite, saveMeter, saveTank, saveGenerator, lockPeriod, unlockPeriod, listLocks,
};
