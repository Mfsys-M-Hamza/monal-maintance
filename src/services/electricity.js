'use strict';
const { db, tx, nowIso } = require('../db');
const { ValidationError, notFound, HttpError } = require('../lib/errors');
const access = require('../lib/access');
const { audit } = require('../lib/audit');
const { parse, round } = require('../lib/validate');
const time = require('../lib/time');

function getMeter(id) {
  return db().prepare('SELECT * FROM meters WHERE id = ?').get(id);
}

function getReading(id) {
  return db().prepare(`SELECT r.*, m.name AS meter_name, m.location, s.name AS site_name
    FROM electricity_readings r JOIN meters m ON m.id = r.meter_id JOIN sites s ON s.id = r.site_id
    WHERE r.id = ? AND r.deleted_at IS NULL`).get(id);
}

function chainData(meterId) {
  const d = db();
  return {
    meter: getMeter(meterId),
    readings: d.prepare('SELECT * FROM electricity_readings WHERE meter_id = ? AND deleted_at IS NULL ORDER BY record_date').all(meterId),
    events: d.prepare('SELECT * FROM meter_events WHERE meter_id = ? AND deleted_at IS NULL ORDER BY event_date, id').all(meterId),
  };
}

/**
 * Walk a meter's timeline: initial reading, then events and readings in date order.
 * An event dated D applies to readings dated on/after D (they are on the new/reset meter).
 * Returns per-reading expected values plus the state at `uptoDate` (exclusive) if given.
 */
function walk({ meter, readings, events }, uptoDate = null, excludeId = null) {
  let baseline = meter.initial_reading;
  let pendingPre = 0;
  let eventId = null;
  let baselineSource = { type: 'initial', date: meter.initial_date };
  let ei = 0;
  const expected = [];
  const problems = [];

  const applyEventsUpTo = (date) => {
    while (ei < events.length && events[ei].event_date <= date) {
      const ev = events[ei++];
      if (ev.old_final_reading !== null && ev.old_final_reading !== undefined) {
        const pre = ev.old_final_reading - baseline;
        if (pre < 0) problems.push(`Meter event on ${time.formatDate(ev.event_date)}: old meter final reading (${ev.old_final_reading}) is lower than the last recorded reading (${baseline}).`);
        pendingPre += Math.max(0, pre);
      }
      baseline = ev.new_start_reading;
      eventId = ev.id;
      baselineSource = { type: 'event', date: ev.event_date, eventType: ev.event_type };
    }
  };

  for (const r of readings) {
    if (r.id === excludeId) continue;
    if (uptoDate && r.record_date >= uptoDate) break;
    applyEventsUpTo(r.record_date);
    const consumption = round(r.current_reading - baseline + pendingPre, 3);
    expected.push({ id: r.id, record_date: r.record_date, previous_reading: baseline, pre_event_kwh: round(pendingPre, 3), consumption_kwh: consumption, baseline_event_id: eventId, current_reading: r.current_reading });
    if (r.current_reading < baseline) {
      problems.push(`Reading on ${time.formatDate(r.record_date)} (${r.current_reading}) is lower than its previous reading (${baseline}).`);
    }
    baseline = r.current_reading;
    baselineSource = { type: 'reading', date: r.record_date };
    pendingPre = 0;
    eventId = null;
  }
  if (uptoDate) applyEventsUpTo(uptoDate);
  return { expected, problems, state: { previous: baseline, preEventKwh: round(pendingPre, 3), baselineEventId: eventId, source: baselineSource } };
}

/** Previous reading that applies to a new reading on `date` for this meter. */
function previousFor(meterId, date, excludeId = null) {
  const data = chainData(meterId);
  if (!data.meter) throw notFound('Meter not found.');
  return walk(data, date, excludeId).state;
}

/**
 * Recompute stored previous/consumption values for every reading of a meter so that the
 * chain stays consistent after inserts, edits, deletes or meter events. Throws if the
 * chain becomes invalid or would modify a locked period.
 */
function recalcChain(meterId) {
  const data = chainData(meterId);
  const { expected, problems } = walk(data);
  if (problems.length) throw new ValidationError(problems[0], { current_reading: problems[0] });
  const upd = db().prepare('UPDATE electricity_readings SET previous_reading = ?, pre_event_kwh = ?, consumption_kwh = ?, baseline_event_id = ? WHERE id = ?');
  for (const e of expected) {
    const cur = data.readings.find((r) => r.id === e.id);
    const changed = cur.previous_reading !== e.previous_reading || cur.consumption_kwh !== e.consumption_kwh ||
      cur.pre_event_kwh !== e.pre_event_kwh || (cur.baseline_event_id || null) !== (e.baseline_event_id || null);
    if (!changed) continue;
    if (access.isLocked(cur.site_id, cur.record_date)) {
      throw new HttpError(423, `This change would alter the reading on ${time.formatDate(cur.record_date)}, which is in a locked period.`);
    }
    upd.run(e.previous_reading, e.pre_event_kwh, e.consumption_kwh, e.baseline_event_id, e.id);
  }
}

function parseInput(body, { editing = false } = {}) {
  const p = parse(body);
  const out = {
    site_id: editing ? null : p.id('site_id', { label: 'Project site' }),
    meter_id: editing ? null : p.id('meter_id', { label: 'Meter' }),
    record_date: p.date('record_date', { label: 'Record date', notFuture: true }),
    current_reading: p.num('current_reading', { required: true, min: 0, label: 'Current reading' }),
    recorded_by: p.str('recorded_by', { required: true, max: 100, label: 'Recorded by' }),
    remarks: p.str('remarks', { max: 1000, label: 'Remarks' }),
  };
  p.done();
  return out;
}

function assertNoDuplicate(meterId, date, excludeId = null) {
  const dup = db().prepare('SELECT id FROM electricity_readings WHERE meter_id = ? AND record_date = ? AND deleted_at IS NULL AND id IS NOT ?')
    .get(meterId, date, excludeId);
  if (dup) throw new ValidationError('A reading already exists for this meter on this date.', { record_date: 'A reading already exists for this meter on this date.' });
}

function validateMeter(meter, siteId, date) {
  if (!meter || meter.site_id !== siteId) throw new ValidationError('Select a meter that belongs to the chosen site.', { meter_id: 'Invalid meter for this site.' });
  if (!meter.is_active) throw new ValidationError('This meter is inactive.', { meter_id: 'This meter is inactive.' });
  if (date < meter.initial_date) {
    throw new ValidationError('Date is before the meter baseline date.', { record_date: `Date must be on or after the meter baseline date (${time.formatDate(meter.initial_date)}).` });
  }
}

function lowReadingError(prev) {
  const msg = `Current reading cannot be lower than the previous reading (${prev}). If the meter was replaced or reset, an admin must record a meter event first.`;
  return new ValidationError(msg, { current_reading: msg });
}

function create(user, body, ctx = {}) {
  const input = parseInput(body);
  access.assertSiteAccess(user, input.site_id);
  access.assertSiteActive(input.site_id);
  access.assertUnlocked(input.site_id, input.record_date);
  return tx((d) => {
    const meter = getMeter(input.meter_id);
    validateMeter(meter, input.site_id, input.record_date);
    assertNoDuplicate(meter.id, input.record_date);
    const prev = previousFor(meter.id, input.record_date);
    if (input.current_reading < prev.previous) throw lowReadingError(prev.previous);
    const ts = nowIso();
    const consumption = round(input.current_reading - prev.previous + prev.preEventKwh, 3);
    const { lastInsertRowid: id } = d.prepare(`INSERT INTO electricity_readings
      (site_id, meter_id, record_date, previous_reading, current_reading, pre_event_kwh, consumption_kwh, baseline_event_id, recorded_by, remarks, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.site_id, meter.id, input.record_date, prev.previous, input.current_reading, prev.preEventKwh, consumption,
      prev.baselineEventId, input.recorded_by, input.remarks, user.id, ts, user.id, ts);
    recalcChain(meter.id);
    const row = d.prepare('SELECT * FROM electricity_readings WHERE id = ?').get(id);
    audit({ entityType: 'electricity', entityId: Number(id), siteId: input.site_id, action: 'create', user, after: row, ip: ctx.ip });
    return row;
  });
}

function update(user, id, body, ctx = {}) {
  const before = db().prepare('SELECT * FROM electricity_readings WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) throw notFound();
  access.assertCanEdit(user, before);
  const input = parseInput(body, { editing: true });
  access.assertUnlocked(before.site_id, before.record_date, input.record_date);
  return tx((d) => {
    const meter = getMeter(before.meter_id);
    if (input.record_date < meter.initial_date) throw new ValidationError('Date is before the meter baseline date.', { record_date: 'Date is before the meter baseline date.' });
    assertNoDuplicate(before.meter_id, input.record_date, before.id);
    const prev = previousFor(before.meter_id, input.record_date, before.id);
    if (input.current_reading < prev.previous) throw lowReadingError(prev.previous);
    d.prepare(`UPDATE electricity_readings SET record_date = ?, current_reading = ?, recorded_by = ?, remarks = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
      .run(input.record_date, input.current_reading, input.recorded_by, input.remarks, user.id, nowIso(), id);
    recalcChain(before.meter_id);
    const after = d.prepare('SELECT * FROM electricity_readings WHERE id = ?').get(id);
    audit({ entityType: 'electricity', entityId: id, siteId: before.site_id, action: 'update', user, before, after, reason: body.change_reason || null, ip: ctx.ip });
    return after;
  });
}

function remove(user, id, ctx = {}) {
  access.assertAdmin(user);
  const before = db().prepare('SELECT * FROM electricity_readings WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) throw notFound();
  access.assertUnlocked(before.site_id, before.record_date);
  tx((d) => {
    d.prepare('UPDATE electricity_readings SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowIso(), user.id, id);
    recalcChain(before.meter_id);
    audit({ entityType: 'electricity', entityId: id, siteId: before.site_id, action: 'delete', user, before, ip: ctx.ip });
  });
}

// ---- Meter events (admin workflow) ----

function createEvent(user, meterId, body, ctx = {}) {
  access.assertAdmin(user);
  const meter = getMeter(meterId);
  if (!meter) throw notFound('Meter not found.');
  const p = parse(body);
  const input = {
    event_type: p.oneOf('event_type', ['replacement', 'reset', 'correction'], { label: 'Event type' }),
    event_date: p.date('event_date', { label: 'Event date', notFuture: true }),
    old_final_reading: p.num('old_final_reading', { min: 0, label: 'Old meter final reading' }),
    new_start_reading: p.num('new_start_reading', { required: true, min: 0, label: 'New starting reading' }),
    new_serial_no: p.str('new_serial_no', { max: 100, label: 'New serial number' }),
    reason: p.str('reason', { required: true, max: 1000, label: 'Reason' }),
  };
  p.done();
  if (input.event_date < meter.initial_date) throw new ValidationError('Event date is before the meter baseline date.', { event_date: 'Event date is before the meter baseline date.' });
  access.assertUnlocked(meter.site_id, input.event_date);
  return tx((d) => {
    const { lastInsertRowid: id } = d.prepare(`INSERT INTO meter_events (meter_id, event_type, event_date, old_final_reading, new_start_reading, new_serial_no, reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(meter.id, input.event_type, input.event_date, input.old_final_reading, input.new_start_reading,
      input.new_serial_no, input.reason, user.id, nowIso());
    if (input.event_type === 'replacement' && input.new_serial_no) {
      d.prepare('UPDATE meters SET serial_no = ?, updated_at = ? WHERE id = ?').run(input.new_serial_no, nowIso(), meter.id);
    }
    recalcChain(meter.id);
    const row = d.prepare('SELECT * FROM meter_events WHERE id = ?').get(id);
    audit({ entityType: 'meter_event', entityId: Number(id), siteId: meter.site_id, action: 'create', user, after: row, reason: input.reason, ip: ctx.ip });
    return row;
  });
}

function deleteEvent(user, eventId, ctx = {}) {
  access.assertAdmin(user);
  const ev = db().prepare('SELECT e.*, m.site_id FROM meter_events e JOIN meters m ON m.id = e.meter_id WHERE e.id = ? AND e.deleted_at IS NULL').get(eventId);
  if (!ev) throw notFound();
  access.assertUnlocked(ev.site_id, ev.event_date);
  tx((d) => {
    d.prepare('UPDATE meter_events SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowIso(), user.id, eventId);
    recalcChain(ev.meter_id);
    audit({ entityType: 'meter_event', entityId: eventId, siteId: ev.site_id, action: 'delete', user, before: ev, ip: ctx.ip });
  });
}

function listEvents(meterId) {
  return db().prepare(`SELECT e.*, u.full_name AS created_by_name FROM meter_events e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.meter_id = ? AND e.deleted_at IS NULL ORDER BY e.event_date DESC, e.id DESC`).all(meterId);
}

module.exports = { getMeter, getReading, previousFor, recalcChain, create, update, remove, createEvent, deleteEvent, listEvents, walk };
