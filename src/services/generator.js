'use strict';
const { db, tx, nowIso } = require('../db');
const { ValidationError, notFound, HttpError } = require('../lib/errors');
const access = require('../lib/access');
const { audit } = require('../lib/audit');
const { parse, round } = require('../lib/validate');
const time = require('../lib/time');

const MAX_SESSION_HOURS = 24 * 7;

function get(id) {
  return db().prepare('SELECT * FROM generator_sessions WHERE id = ? AND deleted_at IS NULL').get(id);
}

/** Clock runtime in hours. Running sessions are measured up to now. */
function runtimeHours(session, nowMs = Date.now()) {
  const s = time.localToMs(session.start_at);
  const e = session.stop_at ? time.localToMs(session.stop_at) : Math.max(s, nowMs);
  return round((e - s) / 3600000, 2);
}

function parseInput(body, editing) {
  const p = parse(body);
  const input = {
    site_id: editing ? null : p.id('site_id', { label: 'Project site' }),
    generator_id: editing ? null : p.id('generator_id', { label: 'Generator' }),
    start_at: p.datetime('start_at', { label: 'Start date and time' }),
    stop_at: p.datetime('stop_at', { required: false, label: 'Stop date and time' }),
    opening_hour_meter: p.num('opening_hour_meter', { min: 0, label: 'Opening hour-meter' }),
    closing_hour_meter: p.num('closing_hour_meter', { min: 0, label: 'Closing hour-meter' }),
    reason: p.str('reason', { required: true, max: 200, label: 'Reason for operation' }),
    operator_name: p.str('operator_name', { required: true, max: 100, label: 'Operator name' }),
    remarks: p.str('remarks', { max: 1000, label: 'Remarks' }),
  };
  p.done();
  validateTimes(input);
  return input;
}

function validateTimes(input) {
  const errors = {};
  // Allow a few minutes of clock skew between phones and the server.
  const limit = time.nowLocal(new Date(Date.now() + 5 * 60000));
  if (input.start_at > limit) errors.start_at = 'Start time cannot be in the future.';
  if (input.stop_at) {
    if (input.stop_at <= input.start_at) errors.stop_at = 'Stop time must be after the start time.';
    else if (input.stop_at > limit) errors.stop_at = 'Stop time cannot be in the future. Leave it empty if the generator is still running.';
    else if ((time.localToMs(input.stop_at) - time.localToMs(input.start_at)) / 3600000 > MAX_SESSION_HOURS) {
      errors.stop_at = `A single session cannot exceed ${MAX_SESSION_HOURS} hours. Check the dates.`;
    }
  } else if (input.closing_hour_meter !== null) {
    errors.closing_hour_meter = 'Closing hour-meter can only be entered once the session is stopped.';
  }
  if (input.opening_hour_meter !== null && input.closing_hour_meter !== null && input.closing_hour_meter < input.opening_hour_meter) {
    errors.closing_hour_meter = 'Closing hour-meter cannot be lower than the opening hour-meter.';
  }
  if (Object.keys(errors).length) throw new ValidationError('Please correct the session times.', errors);
}

function assertNoOverlap(generatorId, startAt, stopAt, excludeId = null) {
  const clash = db().prepare(`SELECT * FROM generator_sessions WHERE generator_id = ? AND deleted_at IS NULL AND id IS NOT ?
      AND start_at < ? AND (stop_at IS NULL OR stop_at > ?) ORDER BY start_at LIMIT 1`)
    .get(generatorId, excludeId, stopAt || '9999-12-31T23:59', startAt);
  if (clash) {
    const msg = clash.stop_at
      ? `This session overlaps an existing session (${time.formatDateTime(clash.start_at)} – ${time.formatDateTime(clash.stop_at)}).`
      : `This generator already has a running session started ${time.formatDateTime(clash.start_at)}. Stop it first.`;
    throw new ValidationError(msg, { start_at: msg });
  }
}

function lockDates(input) {
  return [input.start_at.slice(0, 10), input.stop_at ? input.stop_at.slice(0, 10) : null];
}

function create(user, body, ctx = {}) {
  const input = parseInput(body, false);
  access.assertSiteAccess(user, input.site_id);
  access.assertSiteActive(input.site_id);
  access.assertUnlocked(input.site_id, ...lockDates(input));
  return tx((d) => {
    const gen = d.prepare('SELECT * FROM generators WHERE id = ?').get(input.generator_id);
    if (!gen || gen.site_id !== input.site_id) throw new ValidationError('Select a generator that belongs to the chosen site.', { generator_id: 'Invalid generator for this site.' });
    if (!gen.is_active) throw new ValidationError('This generator is inactive.', { generator_id: 'This generator is inactive.' });
    assertNoOverlap(gen.id, input.start_at, input.stop_at);
    const ts = nowIso();
    const { lastInsertRowid: id } = d.prepare(`INSERT INTO generator_sessions
      (site_id, generator_id, operating_date, start_at, stop_at, opening_hour_meter, closing_hour_meter, reason, operator_name, remarks, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.site_id, gen.id, input.start_at.slice(0, 10), input.start_at, input.stop_at, input.opening_hour_meter, input.closing_hour_meter,
      input.reason, input.operator_name, input.remarks, user.id, ts, user.id, ts);
    const row = get(id);
    audit({ entityType: 'generator_session', entityId: Number(id), siteId: input.site_id, action: 'create', user, after: row, ip: ctx.ip });
    return row;
  });
}

function update(user, id, body, ctx = {}) {
  const before = get(id);
  if (!before) throw notFound();
  access.assertCanEdit(user, before);
  const input = parseInput(body, true);
  access.assertUnlocked(before.site_id, ...lockDates(before), ...lockDates(input));
  return tx((d) => {
    assertNoOverlap(before.generator_id, input.start_at, input.stop_at, id);
    d.prepare(`UPDATE generator_sessions SET operating_date = ?, start_at = ?, stop_at = ?, opening_hour_meter = ?, closing_hour_meter = ?,
      reason = ?, operator_name = ?, remarks = ?, updated_by = ?, updated_at = ? WHERE id = ?`).run(
      input.start_at.slice(0, 10), input.start_at, input.stop_at, input.opening_hour_meter, input.closing_hour_meter,
      input.reason, input.operator_name, input.remarks, user.id, nowIso(), id);
    const after = get(id);
    audit({ entityType: 'generator_session', entityId: id, siteId: before.site_id, action: 'update', user, before, after, ip: ctx.ip });
    return after;
  });
}

/** Quick action: stop a running session. */
function stop(user, id, body, ctx = {}) {
  const before = get(id);
  if (!before) throw notFound();
  access.assertCanEdit(user, before);
  if (before.stop_at) throw new HttpError(409, 'This session has already been stopped.');
  const merged = {
    ...before,
    stop_at: body.stop_at, closing_hour_meter: body.closing_hour_meter,
    remarks: body.remarks !== undefined && body.remarks !== '' ? body.remarks : before.remarks,
  };
  for (const k of ['opening_hour_meter', 'closing_hour_meter']) if (merged[k] === null || merged[k] === undefined) merged[k] = '';
  if (!merged.stop_at) throw new ValidationError('Stop time is required.', { stop_at: 'Stop time is required.' });
  return update(user, id, merged, ctx);
}

function remove(user, id, ctx = {}) {
  access.assertAdmin(user);
  const before = get(id);
  if (!before) throw notFound();
  access.assertUnlocked(before.site_id, ...lockDates(before));
  db().prepare('UPDATE generator_sessions SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowIso(), user.id, id);
  audit({ entityType: 'generator_session', entityId: id, siteId: before.site_id, action: 'delete', user, before, ip: ctx.ip });
}

/**
 * Sessions overlapping [from, to] (inclusive dates) for the given sites, with per-date
 * allocation of hours inside the window. Running sessions are counted up to now.
 */
function sessionsInRange(siteIds, from, to, { generatorIds = null, nowMs = Date.now() } = {}) {
  if (!siteIds.length) return [];
  const site = access.inClause('gs.site_id', siteIds);
  const params = [...site.params, `${time.addDays(to, 1)}T00:00`, `${from}T00:00`];
  let genSql = '';
  if (generatorIds && generatorIds.length) {
    const g = access.inClause('gs.generator_id', generatorIds);
    genSql = ` AND ${g.sql}`;
    params.push(...g.params);
  }
  const rows = db().prepare(`SELECT gs.*, g.name AS generator_name, g.tank_id, s.name AS site_name
    FROM generator_sessions gs JOIN generators g ON g.id = gs.generator_id JOIN sites s ON s.id = gs.site_id
    WHERE ${site.sql} AND gs.deleted_at IS NULL AND gs.start_at < ? AND (gs.stop_at IS NULL OR gs.stop_at > ?)${genSql}
    ORDER BY gs.start_at`).all(...params);
  for (const r of rows) {
    const split = time.splitByDate(r.start_at, r.stop_at, nowMs);
    r.allocation = {};
    r.hours_in_range = 0;
    for (const [d, h] of split) {
      if (d >= from && d <= to) {
        r.allocation[d] = h;
        r.hours_in_range += h;
      }
    }
    r.hours_in_range = round(r.hours_in_range, 2);
    r.runtime_hours = runtimeHours(r, nowMs);
    r.running = !r.stop_at;
    r.hour_meter_hours = r.opening_hour_meter !== null && r.closing_hour_meter !== null ? round(r.closing_hour_meter - r.opening_hour_meter, 2) : null;
  }
  return rows;
}

module.exports = { get, create, update, stop, remove, runtimeHours, sessionsInRange };
