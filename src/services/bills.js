'use strict';
const { db, tx, nowIso } = require('../db');
const { ValidationError, notFound } = require('../lib/errors');
const access = require('../lib/access');
const { audit } = require('../lib/audit');
const { parse, round } = require('../lib/validate');
const time = require('../lib/time');
const attachments = require('./attachments');

function paymentStatus(bill) {
  if (!bill.amount_paid || bill.amount_paid <= 0) return 'Unpaid';
  if (bill.amount_paid < bill.amount_pkr) return 'Partially Paid';
  return 'Paid';
}

function decorate(b) {
  if (!b) return b;
  b.outstanding = round(b.amount_pkr - b.amount_paid, 2);
  b.payment_status = paymentStatus(b);
  b.overdue = b.outstanding > 0 && b.due_date && b.due_date < time.today();
  return b;
}

function get(id) {
  return decorate(db().prepare(`SELECT b.*, m.name AS meter_name, s.name AS site_name FROM bills b
    JOIN meters m ON m.id = b.meter_id JOIN sites s ON s.id = b.site_id WHERE b.id = ? AND b.deleted_at IS NULL`).get(id));
}

function parseInput(body, editing) {
  const p = parse(body);
  const input = {
    site_id: editing ? null : p.id('site_id', { label: 'Project site' }),
    meter_id: editing ? null : p.id('meter_id', { label: 'Meter' }),
    account_ref: p.str('account_ref', { max: 100, label: 'Account reference' }),
    billing_month: p.month('billing_month', { label: 'Billing month' }),
    period_start: p.date('period_start', { label: 'Billing period start' }),
    period_end: p.date('period_end', { label: 'Billing period end' }),
    billed_units: p.num('billed_units', { required: true, min: 0, label: 'Billed units (kWh)' }),
    amount_pkr: p.num('amount_pkr', { required: true, min: 0, label: 'Bill amount (PKR)' }),
    due_date: p.date('due_date', { required: false, label: 'Due date' }),
    amount_paid: p.num('amount_paid', { min: 0, label: 'Amount paid (PKR)' }) ?? 0,
    payment_date: p.date('payment_date', { required: false, label: 'Payment date', notFuture: true }),
    remarks: p.str('remarks', { max: 1000, label: 'Remarks' }),
  };
  if (input.period_start && input.period_end && input.period_end < input.period_start) p.fail('period_end', 'Period end must be on or after the period start.');
  if (input.amount_pkr !== null && input.amount_paid > input.amount_pkr) p.fail('amount_paid', 'Amount paid cannot exceed the bill amount.');
  if (input.amount_paid > 0 && !input.payment_date) p.fail('payment_date', 'Payment date is required when an amount has been paid.');
  if (!input.amount_paid && input.payment_date) p.fail('payment_date', 'Remove the payment date or enter the amount paid.');
  p.done();
  return input;
}

function assertNoDuplicate(meterId, input, excludeId = null) {
  const sameMonth = db().prepare('SELECT id FROM bills WHERE meter_id = ? AND billing_month = ? AND deleted_at IS NULL AND id IS NOT ?')
    .get(meterId, input.billing_month, excludeId);
  if (sameMonth) throw new ValidationError('A bill already exists for this meter and billing month.', { billing_month: 'A bill already exists for this meter and billing month.' });
  const overlap = db().prepare(`SELECT * FROM bills WHERE meter_id = ? AND deleted_at IS NULL AND id IS NOT ? AND period_start <= ? AND period_end >= ?`)
    .get(meterId, excludeId, input.period_end, input.period_start);
  // Consecutive WAPDA periods share the reading day (end of one = start of next); allow that boundary.
  if (overlap && !(overlap.period_end === input.period_start || overlap.period_start === input.period_end)) {
    const msg = `Billing period overlaps an existing bill for this meter (${time.formatDate(overlap.period_start)} – ${time.formatDate(overlap.period_end)}).`;
    throw new ValidationError(msg, { period_start: msg });
  }
}

function create(user, body, file, ctx = {}) {
  const input = parseInput(body, false);
  access.assertSiteAccess(user, input.site_id);
  access.assertSiteActive(input.site_id);
  access.assertUnlocked(input.site_id, input.billing_month + '-01');
  return tx((d) => {
    const meter = d.prepare('SELECT * FROM meters WHERE id = ?').get(input.meter_id);
    if (!meter || meter.site_id !== input.site_id) throw new ValidationError('Select a meter that belongs to the chosen site.', { meter_id: 'Invalid meter for this site.' });
    assertNoDuplicate(meter.id, input);
    const ts = nowIso();
    const { lastInsertRowid: id } = d.prepare(`INSERT INTO bills (site_id, meter_id, category, account_ref, billing_month, period_start, period_end, billed_units, amount_pkr,
      due_date, amount_paid, payment_date, remarks, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.site_id, meter.id, meter.location, input.account_ref || meter.account_ref, input.billing_month, input.period_start, input.period_end,
      input.billed_units, input.amount_pkr, input.due_date, input.amount_paid, input.payment_date, input.remarks, user.id, ts, user.id, ts);
    if (file) attachments.save(file, { ownerType: 'bill', ownerId: Number(id), siteId: input.site_id, user });
    const row = get(id);
    audit({ entityType: 'bill', entityId: Number(id), siteId: input.site_id, action: 'create', user, after: row, ip: ctx.ip });
    return row;
  });
}

function update(user, id, body, file, ctx = {}) {
  const before = get(id);
  if (!before) throw notFound();
  access.assertCanEdit(user, before);
  const input = parseInput(body, true);
  access.assertUnlocked(before.site_id, before.billing_month + '-01', input.billing_month + '-01');
  return tx((d) => {
    assertNoDuplicate(before.meter_id, input, id);
    d.prepare(`UPDATE bills SET account_ref = ?, billing_month = ?, period_start = ?, period_end = ?, billed_units = ?, amount_pkr = ?, due_date = ?,
      amount_paid = ?, payment_date = ?, remarks = ?, updated_by = ?, updated_at = ? WHERE id = ?`).run(
      input.account_ref || before.account_ref, input.billing_month, input.period_start, input.period_end, input.billed_units, input.amount_pkr,
      input.due_date, input.amount_paid, input.payment_date, input.remarks, user.id, nowIso(), id);
    if (file) attachments.save(file, { ownerType: 'bill', ownerId: id, siteId: before.site_id, user });
    const after = get(id);
    audit({ entityType: 'bill', entityId: id, siteId: before.site_id, action: 'update', user, before, after, ip: ctx.ip });
    return after;
  });
}

function remove(user, id, ctx = {}) {
  access.assertAdmin(user);
  const before = get(id);
  if (!before) throw notFound();
  access.assertUnlocked(before.site_id, before.billing_month + '-01');
  db().prepare('UPDATE bills SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowIso(), user.id, id);
  audit({ entityType: 'bill', entityId: id, siteId: before.site_id, action: 'delete', user, before, ip: ctx.ip });
}

/**
 * Compare billed units with recorded meter consumption for the bill period.
 * Meter readings are cumulative, so recorded consumption over the billing period equals the
 * sum of daily consumption for dates in (period_start, period_end] — exact only when readings
 * exist on both boundary dates.
 */
function compare(bill) {
  const d = db();
  const agg = d.prepare(`SELECT COALESCE(SUM(consumption_kwh), 0) AS kwh, COUNT(*) AS n FROM electricity_readings
    WHERE meter_id = ? AND deleted_at IS NULL AND record_date > ? AND record_date <= ?`).get(bill.meter_id, bill.period_start, bill.period_end);
  const hasStart = !!d.prepare('SELECT 1 FROM electricity_readings WHERE meter_id = ? AND record_date = ? AND deleted_at IS NULL').get(bill.meter_id, bill.period_start);
  const meter = d.prepare('SELECT initial_date FROM meters WHERE id = ?').get(bill.meter_id);
  const startIsBaseline = meter && meter.initial_date === bill.period_start;
  const hasEnd = !!d.prepare('SELECT 1 FROM electricity_readings WHERE meter_id = ? AND record_date = ? AND deleted_at IS NULL').get(bill.meter_id, bill.period_end);
  const correction = d.prepare(`SELECT 1 FROM meter_events WHERE meter_id = ? AND deleted_at IS NULL AND event_date > ? AND event_date <= ?
    AND old_final_reading IS NULL`).get(bill.meter_id, bill.period_start, bill.period_end);
  const daysInPeriod = time.diffDays(bill.period_start, bill.period_end);
  const recorded = round(agg.kwh, 2);
  const issues = [];
  if (agg.n === 0) issues.push('No meter readings recorded in this billing period.');
  else {
    if (!hasStart && !startIsBaseline) issues.push(`No reading on the period start date (${time.formatDate(bill.period_start)}).`);
    if (!hasEnd) issues.push(`No reading on the period end date (${time.formatDate(bill.period_end)}).`);
    if (correction) issues.push('A meter correction without a final reading occurred in this period; some consumption may be unrecorded.');
  }
  const comparable = issues.length === 0;
  const variance = comparable ? round(bill.billed_units - recorded, 2) : null;
  return {
    recorded_kwh: recorded,
    readings_count: agg.n,
    days_in_period: daysInPeriod,
    missing_days: Math.max(0, daysInPeriod - agg.n),
    comparable,
    status: agg.n === 0 ? 'No data' : comparable ? 'Comparable' : 'Incomplete',
    issues,
    variance_kwh: variance,
    variance_pct: comparable && recorded > 0 ? round((variance / recorded) * 100, 1) : null,
  };
}

/** Bills for sites, filtered by billing month range and optional category/meter. */
function list(siteIds, { fromMonth = null, toMonth = null, category = null, meterId = null, status = null } = {}) {
  if (!siteIds.length) return [];
  const site = access.inClause('b.site_id', siteIds);
  const where = [site.sql, 'b.deleted_at IS NULL'];
  const params = [...site.params];
  if (fromMonth) { where.push('b.billing_month >= ?'); params.push(fromMonth); }
  if (toMonth) { where.push('b.billing_month <= ?'); params.push(toMonth); }
  if (category) { where.push('b.category = ?'); params.push(category); }
  if (meterId) { where.push('b.meter_id = ?'); params.push(meterId); }
  const rows = db().prepare(`SELECT b.*, m.name AS meter_name, s.name AS site_name,
      (SELECT COUNT(*) FROM attachments a WHERE a.owner_type = 'bill' AND a.owner_id = b.id AND a.deleted_at IS NULL) AS attachment_count
    FROM bills b JOIN meters m ON m.id = b.meter_id JOIN sites s ON s.id = b.site_id
    WHERE ${where.join(' AND ')} ORDER BY b.billing_month DESC, s.name, b.category, m.name`).all(...params).map(decorate);
  return status ? rows.filter((r) => r.payment_status === status) : rows;
}

module.exports = { get, create, update, remove, compare, list, paymentStatus, decorate };
