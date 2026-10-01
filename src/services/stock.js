'use strict';
// Shared logic for stock-balance records (LPG per site, diesel per tank):
//   consumed = opening + received - closing
// Opening stock is carried forward from the previous closing stock when available.
const { db, tx, nowIso } = require('../db');
const { ValidationError, notFound } = require('../lib/errors');
const access = require('../lib/access');
const { audit } = require('../lib/audit');
const { parse, round } = require('../lib/validate');

/**
 * spec: {
 *   table, entity, scopeCol,               // scopeCol: column that identifies one stock ledger
 *   cols: {opening, received, closing, consumed},
 *   unitLabel(record) -> string,
 *   resolveScope(user, input, body) -> {scopeId, extra}   // validates & returns extra columns to insert
 *   compatible(prevRow, extra) -> bool     // whether previous closing may carry forward
 * }
 */
function makeStockService(spec) {
  const { table, entity, scopeCol, cols } = spec;

  function get(id) {
    return db().prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id);
  }

  function previousRecord(scopeId, date, excludeId = null) {
    return db().prepare(`SELECT * FROM ${table} WHERE ${scopeCol} = ? AND record_date < ? AND deleted_at IS NULL AND id IS NOT ?
      ORDER BY record_date DESC LIMIT 1`).get(scopeId, date, excludeId);
  }

  /** Re-evaluate opening-vs-previous-closing flags for a ledger after any change. */
  function refreshFlags(scopeId) {
    const rows = db().prepare(`SELECT * FROM ${table} WHERE ${scopeCol} = ? AND deleted_at IS NULL ORDER BY record_date`).all(scopeId);
    const upd = db().prepare(`UPDATE ${table} SET expected_opening = ?, opening_mismatch = ? WHERE id = ?`);
    let prev = null;
    for (const r of rows) {
      const ok = prev && (!spec.compatible || spec.compatible(prev, r));
      const expected = ok ? prev[cols.closing] : null;
      const mismatch = expected !== null && round(expected, 3) !== round(r[cols.opening], 3) ? 1 : 0;
      if (r.expected_opening !== expected || r.opening_mismatch !== mismatch) upd.run(expected, mismatch, r.id);
      prev = r;
    }
  }

  function parseInput(body, editing) {
    const p = parse(body);
    const input = {
      site_id: editing ? null : p.id('site_id', { label: 'Project site' }),
      record_date: p.date('record_date', { label: 'Date', notFuture: true }),
      opening: p.num('opening', { min: 0, label: 'Opening stock' }),
      received: p.num('received', { min: 0, label: 'Received' }) ?? 0,
      closing: p.num('closing', { required: true, min: 0, label: 'Closing stock' }),
      recorded_by: p.str('recorded_by', { required: true, max: 100, label: 'Recorded by' }),
      remarks: p.str('remarks', { max: 1000, label: 'Remarks' }),
    };
    if (spec.parseExtra && !editing) Object.assign(input, spec.parseExtra(p));
    p.done();
    return input;
  }

  function computeAndValidate(input, prev, extra) {
    const carry = prev && (!spec.compatible || spec.compatible(prev, extra));
    const expected = carry ? prev[cols.closing] : null;
    if (input.opening === null) {
      if (expected === null) throw new ValidationError('Opening stock is required because there is no previous closing stock.', { opening: 'Opening stock is required (no previous closing stock).' });
      input.opening = expected;
    }
    const consumed = round(input.opening + input.received - input.closing, 3);
    if (consumed < 0) {
      const msg = `Invalid stock balance: closing stock (${input.closing}) is greater than opening + received (${round(input.opening + input.received, 3)}).`;
      throw new ValidationError(msg, { closing: msg });
    }
    const mismatch = expected !== null && round(expected, 3) !== round(input.opening, 3) ? 1 : 0;
    if (mismatch && !input.remarks) {
      const msg = `Opening stock differs from the previous closing stock (${expected}). Please explain the difference in Remarks.`;
      throw new ValidationError(msg, { remarks: msg });
    }
    return { consumed, expected, mismatch };
  }

  function assertNoDuplicate(scopeId, date, excludeId = null) {
    const dup = db().prepare(`SELECT id FROM ${table} WHERE ${scopeCol} = ? AND record_date = ? AND deleted_at IS NULL AND id IS NOT ?`).get(scopeId, date, excludeId);
    if (dup) throw new ValidationError(spec.duplicateMessage, { record_date: spec.duplicateMessage });
  }

  function create(user, body, ctx = {}) {
    const input = parseInput(body, false);
    access.assertSiteAccess(user, input.site_id);
    access.assertSiteActive(input.site_id);
    access.assertUnlocked(input.site_id, input.record_date);
    return tx((d) => {
      const { scopeId, extra } = spec.resolveScope(input);
      assertNoDuplicate(scopeId, input.record_date);
      const prev = previousRecord(scopeId, input.record_date);
      const { consumed, expected, mismatch } = computeAndValidate(input, prev, extra);
      const ts = nowIso();
      const row = {
        site_id: input.site_id, record_date: input.record_date, ...extra,
        [cols.opening]: input.opening, [cols.received]: input.received, [cols.closing]: input.closing, [cols.consumed]: consumed,
        opening_mismatch: mismatch, expected_opening: expected, recorded_by: input.recorded_by, remarks: input.remarks,
        created_by: user.id, created_at: ts, updated_by: user.id, updated_at: ts,
      };
      const keys = Object.keys(row);
      const { lastInsertRowid: id } = d.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
        .run(...keys.map((k) => row[k] ?? null));
      refreshFlags(scopeId);
      const saved = get(id);
      audit({ entityType: entity, entityId: Number(id), siteId: input.site_id, action: 'create', user, after: saved, ip: ctx.ip });
      return saved;
    });
  }

  function update(user, id, body, ctx = {}) {
    const before = get(id);
    if (!before) throw notFound();
    access.assertCanEdit(user, before);
    const input = parseInput(body, true);
    access.assertUnlocked(before.site_id, before.record_date, input.record_date);
    return tx((d) => {
      const scopeId = before[scopeCol];
      assertNoDuplicate(scopeId, input.record_date, id);
      const prev = previousRecord(scopeId, input.record_date, id);
      const { consumed, expected, mismatch } = computeAndValidate(input, prev, before);
      d.prepare(`UPDATE ${table} SET record_date = ?, ${cols.opening} = ?, ${cols.received} = ?, ${cols.closing} = ?, ${cols.consumed} = ?,
        opening_mismatch = ?, expected_opening = ?, recorded_by = ?, remarks = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
        .run(input.record_date, input.opening, input.received, input.closing, consumed, mismatch, expected,
          input.recorded_by, input.remarks, user.id, nowIso(), id);
      refreshFlags(scopeId);
      const after = get(id);
      audit({ entityType: entity, entityId: id, siteId: before.site_id, action: 'update', user, before, after, ip: ctx.ip });
      return after;
    });
  }

  function remove(user, id, ctx = {}) {
    access.assertAdmin(user);
    const before = get(id);
    if (!before) throw notFound();
    access.assertUnlocked(before.site_id, before.record_date);
    tx((d) => {
      d.prepare(`UPDATE ${table} SET deleted_at = ?, deleted_by = ? WHERE id = ?`).run(nowIso(), user.id, id);
      refreshFlags(before[scopeCol]);
      audit({ entityType: entity, entityId: id, siteId: before.site_id, action: 'delete', user, before, ip: ctx.ip });
    });
  }

  /** Suggested opening stock for a new record (carry-forward), for the entry form. */
  function suggestion(scopeId, date, extra = {}) {
    const prev = previousRecord(scopeId, date);
    if (!prev || (spec.compatible && !spec.compatible(prev, extra))) return { opening: null, previousDate: null };
    return { opening: prev[cols.closing], previousDate: prev.record_date };
  }

  return { get, create, update, remove, suggestion, refreshFlags, previousRecord };
}

module.exports = { makeStockService };
