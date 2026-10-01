'use strict';
// Single source of truth for all aggregate figures. The dashboard, the in-app reports and
// every export call these functions, so totals always agree. Soft-deleted rows are excluded.
const { db } = require('../db');
const access = require('../lib/access');
const { round } = require('../lib/validate');
const time = require('../lib/time');
const generatorSvc = require('./generator');
const billsSvc = require('./bills');
const maintenance = require('./maintenance');

const add = (obj, key, v) => { obj[key] = round((obj[key] || 0) + v, 3); };

function electricity(siteIds, from, to, { location = null, meterId = null } = {}) {
  const out = { totalKwh: 0, bySite: {}, byDate: {}, byLocation: { site: 0, accommodation: 0 }, byMeter: {}, records: 0 };
  if (!siteIds.length) return out;
  const site = access.inClause('r.site_id', siteIds);
  const where = [site.sql, 'r.deleted_at IS NULL', 'r.record_date >= ?', 'r.record_date <= ?'];
  const params = [...site.params, from, to];
  if (location) { where.push('m.location = ?'); params.push(location); }
  if (meterId) { where.push('r.meter_id = ?'); params.push(meterId); }
  const rows = db().prepare(`SELECT r.site_id, r.record_date, r.meter_id, m.location, r.consumption_kwh FROM electricity_readings r
    JOIN meters m ON m.id = r.meter_id WHERE ${where.join(' AND ')}`).all(...params);
  for (const r of rows) {
    out.totalKwh += r.consumption_kwh;
    add(out.bySite, r.site_id, r.consumption_kwh);
    add(out.byDate, r.record_date, r.consumption_kwh);
    add(out.byLocation, r.location, r.consumption_kwh);
    add(out.byMeter, r.meter_id, r.consumption_kwh);
  }
  out.totalKwh = round(out.totalKwh, 2);
  out.records = rows.length;
  return out;
}

/**
 * LPG totals keep units separate: `kg` from kilogram-based records, `cylinders` from
 * cylinder-based records. `kgFromCylinders` converts cylinders using each record's configured
 * net weight, and `totalKg` = kg + kgFromCylinders (always labelled as such in the UI).
 */
function lpg(siteIds, from, to) {
  const out = { kg: 0, cylinders: 0, kgFromCylinders: 0, totalKg: 0, bySiteKg: {}, byDateKg: {}, bySiteCyl: {}, mismatches: 0, records: 0 };
  if (!siteIds.length) return out;
  const site = access.inClause('site_id', siteIds);
  const rows = db().prepare(`SELECT site_id, record_date, unit, cylinder_kg, consumed, opening_mismatch FROM lpg_records
    WHERE ${site.sql} AND deleted_at IS NULL AND record_date >= ? AND record_date <= ?`).all(...site.params, from, to);
  for (const r of rows) {
    const kg = r.unit === 'kg' ? r.consumed : r.consumed * (r.cylinder_kg || 0);
    if (r.unit === 'kg') out.kg += r.consumed;
    else { out.cylinders += r.consumed; out.kgFromCylinders += kg; add(out.bySiteCyl, r.site_id, r.consumed); }
    add(out.bySiteKg, r.site_id, kg);
    add(out.byDateKg, r.record_date, kg);
    if (r.opening_mismatch) out.mismatches++;
  }
  out.kg = round(out.kg, 2);
  out.cylinders = round(out.cylinders, 2);
  out.kgFromCylinders = round(out.kgFromCylinders, 2);
  out.totalKg = round(out.kg + out.kgFromCylinders, 2);
  out.records = rows.length;
  return out;
}

function generators(siteIds, from, to, { generatorIds = null, nowMs = Date.now() } = {}) {
  const sessions = generatorSvc.sessionsInRange(siteIds, from, to, { generatorIds, nowMs });
  const out = { hours: 0, bySite: {}, byDate: {}, byGenerator: {}, byTankDate: {}, sessions, running: sessions.filter((s) => s.running).length };
  for (const s of sessions) {
    for (const [d, h] of Object.entries(s.allocation)) {
      out.hours += h;
      add(out.bySite, s.site_id, h);
      add(out.byDate, d, h);
      add(out.byGenerator, s.generator_id, h);
      if (s.tank_id) add(out.byTankDate, `${s.tank_id}|${d}`, h);
    }
  }
  out.hours = round(out.hours, 2);
  for (const k of Object.keys(out.bySite)) out.bySite[k] = round(out.bySite[k], 2);
  return out;
}

/**
 * Diesel per tank. Litres per operating hour uses the runtime of generators connected to the
 * tanks that have diesel records, so shared tanks are compared to combined runtime once.
 */
function diesel(siteIds, from, to, { tankIds = null, gen = null } = {}) {
  const out = { litres: 0, bySite: {}, byDate: {}, byTank: {}, records: [], runtimeHours: 0, perHour: null, mismatches: 0 };
  if (!siteIds.length) return out;
  const site = access.inClause('d.site_id', siteIds);
  const params = [...site.params, from, to];
  let tankSql = '';
  if (tankIds && tankIds.length) { const t = access.inClause('d.tank_id', tankIds); tankSql = ` AND ${t.sql}`; params.push(...t.params); }
  const rows = db().prepare(`SELECT d.*, t.name AS tank_name, t.tank_type, s.name AS site_name FROM diesel_records d
    JOIN diesel_tanks t ON t.id = d.tank_id JOIN sites s ON s.id = d.site_id
    WHERE ${site.sql} AND d.deleted_at IS NULL AND d.record_date >= ? AND d.record_date <= ?${tankSql} ORDER BY d.record_date, s.name, t.name`).all(...params);
  const g = gen || generators(siteIds, from, to);
  for (const r of rows) {
    out.litres += r.consumed_l;
    add(out.bySite, r.site_id, r.consumed_l);
    add(out.byDate, r.record_date, r.consumed_l);
    add(out.byTank, r.tank_id, r.consumed_l);
    r.runtime_hours = round(g.byTankDate[`${r.tank_id}|${r.record_date}`] || 0, 2);
    r.l_per_hour = r.runtime_hours > 0 ? round(r.consumed_l / r.runtime_hours, 2) : null;
    if (r.opening_mismatch) out.mismatches++;
  }
  // Runtime of generators attached to the tanks in scope, over the whole period.
  const tanksInScope = new Set(tankIds && tankIds.length ? tankIds : rows.map((r) => r.tank_id));
  let rt = 0;
  for (const [k, h] of Object.entries(g.byTankDate)) if (tanksInScope.has(Number(k.split('|')[0]))) rt += h;
  out.runtimeHours = round(rt, 2);
  out.litres = round(out.litres, 2);
  out.perHour = out.runtimeHours > 0 ? round(out.litres / out.runtimeHours, 2) : null;
  out.records = rows;
  return out;
}

function bills(siteIds, fromMonth, toMonth, { category = null } = {}) {
  const list = billsSvc.list(siteIds, { fromMonth, toMonth, category });
  const out = { amount: 0, paid: 0, outstanding: 0, units: 0, count: list.length, byCategory: { site: { amount: 0, paid: 0, outstanding: 0, units: 0 }, accommodation: { amount: 0, paid: 0, outstanding: 0, units: 0 } }, bySite: {}, byMonth: {}, list };
  for (const b of list) {
    out.amount += b.amount_pkr; out.paid += b.amount_paid; out.outstanding += b.outstanding; out.units += b.billed_units;
    const c = out.byCategory[b.category];
    c.amount += b.amount_pkr; c.paid += b.amount_paid; c.outstanding += b.outstanding; c.units += b.billed_units;
    add(out.bySite, b.site_id, b.amount_pkr);
    out.byMonth[b.billing_month] = out.byMonth[b.billing_month] || { site: 0, accommodation: 0 };
    out.byMonth[b.billing_month][b.category] = round(out.byMonth[b.billing_month][b.category] + b.amount_pkr, 2);
  }
  for (const k of ['amount', 'paid', 'outstanding', 'units']) out[k] = round(out[k], 2);
  for (const c of Object.values(out.byCategory)) for (const k of Object.keys(c)) c[k] = round(c[k], 2);
  return out;
}

function maintenanceSummary(siteIds, from, to) {
  const open = maintenance.listTasks(siteIds, { status: 'open' });
  const completed = maintenance.listTasks(siteIds, { status: 'completed', from, to });
  return {
    overdue: open.filter((t) => t.display_status === 'Overdue'),
    due: open.filter((t) => t.display_status === 'Due'),
    scheduled: open.filter((t) => t.display_status === 'Scheduled'),
    pending: open,
    completed,
    // Tasks scheduled within the period that are still open.
    pendingInPeriod: open.filter((t) => t.scheduled_date <= to),
  };
}

/**
 * Missing daily entries for active sites and required record types, for dates in
 * [from, min(to, today)]. A zero-consumption record is NOT missing.
 */
function missingEntries(siteIds, from, to, { types = null } = {}) {
  const want = (t) => !types || types.includes(t);
  const end = to > time.today() ? time.today() : to;
  const out = { items: [], expected: 0, present: 0, byType: { electricity: 0, lpg: 0, diesel: 0, generator: 0 }, bySite: {} };
  if (!siteIds.length || from > end) return { ...out, completeness: null };
  const d = db();
  const ids = access.inClause('id', siteIds);
  const sites = d.prepare(`SELECT * FROM sites WHERE ${ids.sql} AND is_active = 1 ORDER BY name`).all(...ids.params);
  const dates = time.dateRange(from, end);
  const push = (date, site, type, item) => {
    out.items.push({ date, site_id: site.id, site_name: site.name, type, item });
    out.byType[type]++;
    out.bySite[site.id] = (out.bySite[site.id] || 0) + 1;
  };
  for (const site of sites) {
    if (site.req_electricity && want('electricity')) {
      const meters = d.prepare('SELECT * FROM meters WHERE site_id = ? AND is_active = 1 AND is_required = 1').all(site.id);
      const have = new Set(d.prepare(`SELECT meter_id || '|' || record_date AS k FROM electricity_readings WHERE site_id = ? AND deleted_at IS NULL AND record_date BETWEEN ? AND ?`)
        .all(site.id, from, end).map((r) => r.k));
      for (const m of meters) for (const dt of dates) {
        if (dt < m.initial_date) continue;
        out.expected++;
        if (have.has(`${m.id}|${dt}`)) out.present++; else push(dt, site, 'electricity', `Meter: ${m.name}`);
      }
    }
    if (site.req_lpg && want('lpg')) {
      const have = new Set(d.prepare('SELECT record_date FROM lpg_records WHERE site_id = ? AND deleted_at IS NULL AND record_date BETWEEN ? AND ?')
        .all(site.id, from, end).map((r) => r.record_date));
      for (const dt of dates) { out.expected++; if (have.has(dt)) out.present++; else push(dt, site, 'lpg', 'LPG stock'); }
    }
    if (site.req_diesel && want('diesel')) {
      const tanks = d.prepare('SELECT * FROM diesel_tanks WHERE site_id = ? AND is_active = 1 AND is_required = 1').all(site.id);
      const have = new Set(d.prepare(`SELECT tank_id || '|' || record_date AS k FROM diesel_records WHERE site_id = ? AND deleted_at IS NULL AND record_date BETWEEN ? AND ?`)
        .all(site.id, from, end).map((r) => r.k));
      for (const t of tanks) for (const dt of dates) {
        out.expected++;
        if (have.has(`${t.id}|${dt}`)) out.present++; else push(dt, site, 'diesel', `Tank: ${t.name}`);
      }
    }
    if (site.req_generator_log && want('generator')) {
      const sess = generatorSvc.sessionsInRange([site.id], from, end);
      const have = new Set(sess.flatMap((s) => Object.keys(s.allocation)));
      for (const dt of dates) { out.expected++; if (have.has(dt)) out.present++; else push(dt, site, 'generator', 'Generator log'); }
    }
  }
  out.items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.site_name.localeCompare(b.site_name)));
  out.completeness = out.expected ? round((out.present / out.expected) * 100, 1) : null;
  return out;
}

/** Percentage change; null (render "N/A") when the previous value is zero or unavailable. */
function pctChange(current, previous) {
  if (previous === null || previous === undefined || previous === 0 || current === null || current === undefined) return null;
  return round(((current - previous) / previous) * 100, 1);
}

/** All headline figures for a period — used by dashboard and reports alike. */
function summary(siteIds, from, to, opts = {}) {
  const gen = generators(siteIds, from, to, opts);
  return {
    from, to,
    days: time.diffDays(from, to) + 1,
    electricity: electricity(siteIds, from, to, opts),
    lpg: lpg(siteIds, from, to),
    generators: gen,
    diesel: diesel(siteIds, from, to, { gen }),
    bills: bills(siteIds, time.monthOf(from), time.monthOf(to), { category: opts.location || null }),
  };
}

module.exports = { electricity, lpg, generators, diesel, bills, maintenanceSummary, missingEntries, pctChange, summary };
