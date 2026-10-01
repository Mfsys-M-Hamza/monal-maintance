'use strict';
// Builds report documents as plain data: { title, meta, kpis, sections[] }. The HTML view,
// print layout, PDF, Excel and CSV exporters all render this same structure, so every format
// shows identical figures (which also come from services/metrics.js, like the dashboard).
const { db } = require('../db');
const access = require('../lib/access');
const { round } = require('../lib/validate');
const time = require('../lib/time');
const metrics = require('./metrics');
const billsSvc = require('./bills');

const RECORD_TYPES = ['electricity', 'lpg', 'generator', 'diesel', 'maintenance', 'bills'];

/** Normalise and authorise report filters. Throws 403 if a site is not accessible. */
function resolveFilters(user, q, kind) {
  const siteIds = access.scopeSiteIds(user, q.site);
  const f = {
    kind,
    site: siteIds.length === 1 && q.site && q.site !== 'all' ? siteIds[0] : 'all',
    siteIds,
    types: RECORD_TYPES.includes(q.type) ? [q.type] : RECORD_TYPES,
    type: RECORD_TYPES.includes(q.type) ? q.type : '',
    location: ['site', 'accommodation'].includes(q.location) ? q.location : null,
    meterId: /^\d+$/.test(q.meter || '') ? Number(q.meter) : null,
    generatorId: /^\d+$/.test(q.generator || '') ? Number(q.generator) : null,
  };
  // Meter / generator filters must belong to an accessible site.
  if (f.meterId) {
    const m = db().prepare('SELECT site_id FROM meters WHERE id = ?').get(f.meterId);
    if (!m || !siteIds.includes(m.site_id)) f.meterId = null;
  }
  if (f.generatorId) {
    const g = db().prepare('SELECT site_id FROM generators WHERE id = ?').get(f.generatorId);
    if (!g || !siteIds.includes(g.site_id)) f.generatorId = null;
  }
  if (kind === 'monthly') {
    const m = time.isValidMonth(q.month) ? q.month : time.addMonthsToMonth(time.monthOf(time.today()), -1);
    f.month = m;
    f.from = time.monthStart(m);
    f.to = time.monthEnd(m);
  } else {
    const t = time.today();
    f.from = time.isValidDate(q.from) ? q.from : t;
    f.to = time.isValidDate(q.to) ? q.to : f.from;
    if (f.to < f.from) [f.from, f.to] = [f.to, f.from];
    if (time.diffDays(f.from, f.to) > 92) f.to = time.addDays(f.from, 92); // keep daily reports bounded
  }
  return f;
}

function siteLabel(f) {
  if (f.site === 'all') return f.siteIds.length === access.allowedSiteIds({ role: 'admin' }).length ? 'All sites' : `All assigned sites (${f.siteIds.length})`;
  return db().prepare('SELECT name FROM sites WHERE id = ?').get(f.site).name;
}

function filterNotes(f) {
  const notes = [];
  if (f.type) notes.push(`Record type: ${f.type}`);
  if (f.location) notes.push(`Location: ${f.location === 'site' ? 'Project site' : 'Accommodation'}`);
  if (f.meterId) notes.push(`Meter: ${db().prepare('SELECT name FROM meters WHERE id = ?').get(f.meterId).name}`);
  if (f.generatorId) notes.push(`Generator: ${db().prepare('SELECT name FROM generators WHERE id = ?').get(f.generatorId).name}`);
  return notes;
}

const col = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
const want = (f, t) => f.types.includes(t);

// ---------------- section builders ----------------

function electricitySection(f, from, to) {
  const site = access.inClause('r.site_id', f.siteIds);
  const where = [site.sql, 'r.deleted_at IS NULL', 'r.record_date BETWEEN ? AND ?'];
  const params = [...site.params, from, to];
  if (f.location) { where.push('m.location = ?'); params.push(f.location); }
  if (f.meterId) { where.push('r.meter_id = ?'); params.push(f.meterId); }
  const rows = db().prepare(`SELECT r.*, m.name AS meter_name, m.location, s.name AS site_name FROM electricity_readings r
    JOIN meters m ON m.id = r.meter_id JOIN sites s ON s.id = r.site_id WHERE ${where.join(' AND ')} ORDER BY r.record_date, s.name, m.name`).all(...params);
  const total = metrics.electricity(f.siteIds, from, to, { location: f.location, meterId: f.meterId });
  return {
    id: 'electricity', title: 'Electricity consumption', unit: 'kWh',
    columns: [col('record_date', 'Date', 'date'), col('site_name', 'Site'), col('meter_name', 'Meter'), col('location_label', 'Location'),
      col('previous_reading', 'Previous reading', 'num', { dp: 2 }), col('current_reading', 'Current reading', 'num', { dp: 2 }),
      col('consumption_kwh', 'Consumption (kWh)', 'num', { dp: 2 }), col('recorded_by', 'Recorded by'), col('remarks', 'Remarks')],
    rows: rows.map((r) => ({ ...r, location_label: r.location === 'site' ? 'Project site' : 'Accommodation',
      remarks: [r.pre_event_kwh ? `Includes ${r.pre_event_kwh} kWh from replaced/reset meter.` : '', r.remarks || ''].filter(Boolean).join(' ') })),
    totals: { consumption_kwh: total.totalKwh },
    notes: [`Project site: ${round(total.byLocation.site, 2)} kWh · Accommodation: ${round(total.byLocation.accommodation, 2)} kWh`],
  };
}

function lpgSection(f, from, to) {
  const site = access.inClause('l.site_id', f.siteIds);
  const rows = db().prepare(`SELECT l.*, s.name AS site_name FROM lpg_records l JOIN sites s ON s.id = l.site_id
    WHERE ${site.sql} AND l.deleted_at IS NULL AND l.record_date BETWEEN ? AND ? ORDER BY l.record_date, s.name`).all(...site.params, from, to);
  const total = metrics.lpg(f.siteIds, from, to);
  const notes = [];
  if (total.cylinders) notes.push(`Cylinder-based sites: ${total.cylinders} cylinders consumed (≈ ${total.kgFromCylinders} kg at each site's configured net kg per cylinder). Cylinder counts and kilograms are shown in separate columns.`);
  if (total.mismatches) notes.push(`${total.mismatches} record(s) have an opening stock that differs from the previous closing stock (flagged).`);
  return {
    id: 'lpg', title: 'LPG consumption', unit: 'kg / cylinders',
    columns: [col('record_date', 'Date', 'date'), col('site_name', 'Site'), col('unit_label', 'Unit'),
      col('opening_stock', 'Opening', 'num', { dp: 2 }), col('received_stock', 'Received', 'num', { dp: 2 }), col('closing_stock', 'Closing', 'num', { dp: 2 }),
      col('consumed_kg', 'Consumed (kg)', 'num', { dp: 2 }), col('consumed_cyl', 'Consumed (cylinders)', 'num', { dp: 2 }),
      col('flag', 'Flag'), col('recorded_by', 'Recorded by'), col('remarks', 'Remarks')],
    rows: rows.map((r) => ({ ...r, unit_label: r.unit === 'kg' ? 'kg' : `cylinder (${r.cylinder_kg} kg)`,
      consumed_kg: r.unit === 'kg' ? r.consumed : null, consumed_cyl: r.unit === 'cylinder' ? r.consumed : null,
      flag: r.opening_mismatch ? `Opening ≠ previous closing (${r.expected_opening})` : '' })),
    totals: { consumed_kg: total.kg, consumed_cyl: total.cylinders || null },
    notes,
  };
}

function generatorSections(f, from, to, gen) {
  const sessions = gen.sessions;
  const allocRows = [];
  for (const s of sessions) for (const [d, h] of Object.entries(s.allocation)) {
    allocRows.push({ date: d, site_name: s.site_name, generator_name: s.generator_name, hours: round(h, 2), status: s.running ? 'Running' : '' });
  }
  allocRows.sort((a, b) => (a.date + a.site_name + a.generator_name).localeCompare(b.date + b.site_name + b.generator_name));
  const notes = [];
  if (gen.running) notes.push(`${gen.running} session(s) are still running; their hours are counted up to the time this report was generated.`);
  notes.push('Sessions that cross midnight are split across dates in the daily runtime allocation.');
  return [{
    id: 'generator', title: 'Generator sessions', unit: 'hours',
    columns: [col('site_name', 'Site'), col('generator_name', 'Generator'), col('start_at', 'Start', 'datetime'), col('stop_label', 'Stop'),
      col('runtime_hours', 'Session runtime (h)', 'num', { dp: 2 }), col('hours_in_range', 'Hours in period (h)', 'num', { dp: 2 }),
      col('hour_meter_hours', 'Hour-meter (h)', 'num', { dp: 2 }), col('reason', 'Reason'), col('operator_name', 'Operator'), col('remarks', 'Remarks')],
    rows: sessions.map((s) => ({ ...s, stop_label: s.stop_at ? time.formatDateTime(s.stop_at) : 'RUNNING' })),
    totals: { hours_in_range: gen.hours },
    notes,
  }, {
    id: 'generator_daily', title: 'Generator runtime by date', unit: 'hours',
    columns: [col('date', 'Date', 'date'), col('site_name', 'Site'), col('generator_name', 'Generator'), col('hours', 'Runtime (h)', 'num', { dp: 2 }), col('status', 'Status')],
    rows: allocRows,
    totals: { hours: gen.hours },
    notes: [],
  }];
}

function dieselSection(f, from, to, dsl) {
  return {
    id: 'diesel', title: 'Diesel consumption', unit: 'litres',
    columns: [col('record_date', 'Date', 'date'), col('site_name', 'Site'), col('tank_label', 'Tank'),
      col('opening_l', 'Opening (L)', 'num', { dp: 2 }), col('received_l', 'Received (L)', 'num', { dp: 2 }), col('closing_l', 'Closing (L)', 'num', { dp: 2 }),
      col('consumed_l', 'Consumed (L)', 'num', { dp: 2 }), col('runtime_hours', 'Runtime (h)', 'num', { dp: 2 }), col('l_per_hour', 'L per hour', 'num', { dp: 2, na: 'N/A' }),
      col('recorded_by', 'Recorded by'), col('remarks', 'Remarks')],
    rows: dsl.records.map((r) => ({ ...r, tank_label: `${r.tank_name} (${r.tank_type})` })),
    totals: { consumed_l: dsl.litres, runtime_hours: dsl.runtimeHours, l_per_hour: dsl.perHour },
    notes: ['Shared tanks are recorded once per day and compared with the combined runtime of all connected generators, so no diesel is counted twice.',
      'L per hour shows N/A when runtime is zero or unavailable.'],
  };
}

function maintenanceSections(f, from, to) {
  const m = metrics.maintenanceSummary(f.siteIds, from, to);
  const cols = [col('site_name', 'Site'), col('item_name', 'Duct / equipment / area'), col('frequency_label', 'Frequency'),
    col('last_completed_date', 'Last completed', 'date'), col('scheduled_date', 'Scheduled', 'date'), col('assigned_to', 'Assigned to'), col('display_status', 'Status')];
  return [{
    id: 'maintenance_pending', title: 'Duct cleaning & maintenance — pending (due by period end)', unit: '',
    columns: cols, rows: m.pendingInPeriod, totals: null, notes: [`${m.overdue.length} overdue, ${m.due.length} due soon (as of today).`],
  }, {
    id: 'maintenance_completed', title: 'Duct cleaning & maintenance — completed in period', unit: '',
    columns: [col('completion_date', 'Completed', 'date'), col('site_name', 'Site'), col('item_name', 'Duct / equipment / area'),
      col('scheduled_date', 'Was scheduled', 'date'), col('completed_by_name', 'Completed by'), col('remarks', 'Remarks')],
    rows: m.completed, totals: null, notes: [],
  }];
}

function missingSection(f, from, to) {
  const types = f.types.filter((t) => ['electricity', 'lpg', 'diesel', 'generator'].includes(t));
  const miss = metrics.missingEntries(f.siteIds, from, to, { types });
  const label = { electricity: 'Electricity', lpg: 'LPG', diesel: 'Diesel', generator: 'Generator log' };
  return {
    section: {
      id: 'missing', title: 'Missing daily entries', unit: '',
      columns: [col('date', 'Date', 'date'), col('site_name', 'Site'), col('type_label', 'Record type'), col('item', 'Item')],
      rows: miss.items.map((i) => ({ ...i, type_label: label[i.type] })),
      totals: null,
      notes: [`Data completeness: ${miss.completeness === null ? 'N/A' : miss.completeness + '%'} (${miss.present} of ${miss.expected} required entries). Missing entries are not treated as zero consumption. Only active sites and required record types are checked; future dates are excluded.`],
    },
    miss,
  };
}

function billsSection(f, fromMonth, toMonth) {
  const list = billsSvc.list(f.siteIds, { fromMonth, toMonth, category: f.location, meterId: f.meterId });
  const totals = list.reduce((a, b) => ({ amount_pkr: a.amount_pkr + b.amount_pkr, amount_paid: a.amount_paid + b.amount_paid, outstanding: a.outstanding + b.outstanding, billed_units: a.billed_units + b.billed_units }),
    { amount_pkr: 0, amount_paid: 0, outstanding: 0, billed_units: 0 });
  for (const k of Object.keys(totals)) totals[k] = round(totals[k], 2);
  return {
    id: 'bills', title: 'WAPDA electricity bills', unit: 'PKR',
    columns: [col('site_name', 'Site'), col('category_label', 'Category'), col('meter_name', 'Meter'), col('account_ref', 'Account ref'),
      col('billing_month_label', 'Billing month'), col('period_label', 'Billing period'), col('billed_units', 'Billed units (kWh)', 'num', { dp: 0 }),
      col('recorded_kwh', 'Recorded (kWh)', 'num', { dp: 2, na: 'N/A' }), col('comparison', 'Comparison'),
      col('amount_pkr', 'Amount (PKR)', 'pkr'), col('amount_paid', 'Paid (PKR)', 'pkr'), col('outstanding', 'Outstanding (PKR)', 'pkr'), col('payment_status', 'Status')],
    rows: list.map((b) => {
      const c = billsSvc.compare(b);
      return { ...b, category_label: b.category === 'site' ? 'Project site' : 'Accommodation', billing_month_label: time.formatMonth(b.billing_month),
        period_label: `${time.formatDate(b.period_start)} – ${time.formatDate(b.period_end)}`, recorded_kwh: c.readings_count ? c.recorded_kwh : null,
        comparison: c.comparable ? `Variance ${c.variance_kwh >= 0 ? '+' : ''}${c.variance_kwh} kWh${c.variance_pct !== null ? ` (${c.variance_pct}%)` : ''}` : `${c.status}: ${c.issues.join(' ')}` };
    }),
    totals,
    notes: ['Recorded kWh is the sum of daily meter consumption within the billing period. Comparisons are only made when readings exist on both period boundary dates.'],
  };
}

// ---------------- reports ----------------

function base(f, title, periodLabel) {
  return { title, periodLabel, siteLabel: siteLabel(f), filters: filterNotes(f), generatedAt: time.formatTimestamp(new Date().toISOString()), timeZone: 'Asia/Karachi (PKT)', kpis: [], sections: [] };
}

function dailyReport(user, q) {
  const f = resolveFilters(user, q, 'daily');
  const periodLabel = f.from === f.to ? time.formatDate(f.from) : `${time.formatDate(f.from)} – ${time.formatDate(f.to)}`;
  const doc = base(f, 'Daily Utilities & Maintenance Report', periodLabel);
  doc.filtersResolved = f;
  const gen = metrics.generators(f.siteIds, f.from, f.to, { generatorIds: f.generatorId ? [f.generatorId] : null });
  const dsl = metrics.diesel(f.siteIds, f.from, f.to, { gen: f.generatorId ? metrics.generators(f.siteIds, f.from, f.to) : gen });
  const days = time.diffDays(f.from, f.to) + 1;

  if (want(f, 'electricity')) {
    const s = electricitySection(f, f.from, f.to);
    doc.sections.push(s);
    doc.kpis.push({ label: 'Electricity', value: s.totals.consumption_kwh, unit: 'kWh', dp: 2 });
  }
  if (want(f, 'lpg')) {
    const s = lpgSection(f, f.from, f.to);
    doc.sections.push(s);
    doc.kpis.push({ label: 'LPG', value: s.totals.consumed_kg, unit: 'kg', dp: 2, note: s.totals.consumed_cyl ? `+ ${s.totals.consumed_cyl} cylinders` : null });
  }
  if (want(f, 'generator')) {
    doc.sections.push(...generatorSections(f, f.from, f.to, gen));
    doc.kpis.push({ label: 'Generator runtime', value: gen.hours, unit: 'h', dp: 2, note: gen.running ? `${gen.running} running` : null });
  }
  if (want(f, 'diesel')) {
    doc.sections.push(dieselSection(f, f.from, f.to, dsl));
    doc.kpis.push({ label: 'Diesel', value: dsl.litres, unit: 'L', dp: 2 });
    doc.kpis.push({ label: 'Diesel per operating hour', value: dsl.perHour, unit: 'L/h', dp: 2 });
  }
  if (want(f, 'maintenance')) doc.sections.push(...maintenanceSections(f, f.from, f.to));
  const { section, miss } = missingSection(f, f.from, f.to);
  doc.sections.push(section);
  doc.kpis.push({ label: 'Data completeness', value: miss.completeness, unit: '%', dp: 1, note: `${miss.items.length} missing` });
  if (days > 1) doc.notes = [`Period covers ${days} calendar days.`];
  return doc;
}

function monthlyReport(user, q) {
  const f = resolveFilters(user, q, 'monthly');
  const doc = base(f, 'Monthly Utilities & Maintenance Report', time.formatMonth(f.month));
  doc.filtersResolved = f;
  const prevMonth = time.addMonthsToMonth(f.month, -1);
  const pf = time.monthStart(prevMonth), pt = time.monthEnd(prevMonth);
  const today = time.today();
  // For the current month, averages use elapsed days only.
  const effTo = f.to > today ? today : f.to;
  const days = f.from > today ? 0 : time.diffDays(f.from, effTo) + 1;

  const opts = { location: f.location, meterId: f.meterId, generatorIds: f.generatorId ? [f.generatorId] : null };
  const cur = metrics.summary(f.siteIds, f.from, f.to, opts);
  const prev = metrics.summary(f.siteIds, pf, pt, opts);
  const miss = metrics.missingEntries(f.siteIds, f.from, f.to);
  const maint = metrics.maintenanceSummary(f.siteIds, f.from, f.to);

  const avg = (v) => (days > 0 && v !== null ? round(v / days, 2) : null);
  const metricsRows = [];
  const addMetric = (type, label, unit, c, p, avgOk = true) => {
    if (!want(f, type)) return;
    metricsRows.push({ metric: label, unit, current: c, previous: p, change: c !== null && p !== null ? round(c - p, 2) : null,
      pct: metrics.pctChange(c, p), daily_avg: avgOk ? avg(c) : null });
  };
  addMetric('electricity', 'Electricity consumption', 'kWh', cur.electricity.totalKwh, prev.electricity.totalKwh);
  addMetric('lpg', 'LPG consumption (kg-based sites)', 'kg', cur.lpg.kg, prev.lpg.kg);
  if (cur.lpg.cylinders || prev.lpg.cylinders) addMetric('lpg', 'LPG consumption (cylinder-based sites)', 'cylinders', cur.lpg.cylinders, prev.lpg.cylinders);
  addMetric('generator', 'Generator operating hours', 'h', cur.generators.hours, prev.generators.hours);
  addMetric('diesel', 'Diesel consumption', 'L', cur.diesel.litres, prev.diesel.litres);
  addMetric('diesel', 'Diesel per operating hour', 'L/h', cur.diesel.perHour, prev.diesel.perHour, false);
  addMetric('bills', 'Bill amount (project site)', 'PKR', cur.bills.byCategory.site.amount, prev.bills.byCategory.site.amount, false);
  addMetric('bills', 'Bill amount (accommodation)', 'PKR', cur.bills.byCategory.accommodation.amount, prev.bills.byCategory.accommodation.amount, false);
  addMetric('bills', 'Amount paid', 'PKR', cur.bills.paid, prev.bills.paid, false);
  addMetric('bills', 'Outstanding', 'PKR', cur.bills.outstanding, prev.bills.outstanding, false);

  if (want(f, 'electricity')) doc.kpis.push({ label: 'Electricity', value: cur.electricity.totalKwh, unit: 'kWh', dp: 0, pct: metrics.pctChange(cur.electricity.totalKwh, prev.electricity.totalKwh) });
  if (want(f, 'lpg')) doc.kpis.push({ label: 'LPG', value: cur.lpg.kg, unit: 'kg', dp: 1, pct: metrics.pctChange(cur.lpg.kg, prev.lpg.kg), note: cur.lpg.cylinders ? `+ ${cur.lpg.cylinders} cylinders` : null });
  if (want(f, 'generator')) doc.kpis.push({ label: 'Generator hours', value: cur.generators.hours, unit: 'h', dp: 1, pct: metrics.pctChange(cur.generators.hours, prev.generators.hours) });
  if (want(f, 'diesel')) {
    doc.kpis.push({ label: 'Diesel', value: cur.diesel.litres, unit: 'L', dp: 0, pct: metrics.pctChange(cur.diesel.litres, prev.diesel.litres) });
    doc.kpis.push({ label: 'Diesel per hour', value: cur.diesel.perHour, unit: 'L/h', dp: 2 });
  }
  if (want(f, 'bills')) {
    doc.kpis.push({ label: 'Bills', value: cur.bills.amount, unit: 'PKR', type: 'pkr' });
    doc.kpis.push({ label: 'Outstanding', value: cur.bills.outstanding, unit: 'PKR', type: 'pkr' });
  }
  doc.kpis.push({ label: 'Data completeness', value: miss.completeness, unit: '%', dp: 1 });

  doc.sections.push({
    id: 'comparison', title: `Comparison with previous month (${time.formatMonth(prevMonth)})`, unit: '',
    columns: [col('metric', 'Metric'), col('unit', 'Unit'), col('current', time.formatMonth(f.month), 'num', { dp: 2, na: 'N/A' }),
      col('previous', time.formatMonth(prevMonth), 'num', { dp: 2, na: 'N/A' }), col('change', 'Change', 'num', { dp: 2, na: 'N/A', signed: true }),
      col('pct', '% change', 'pct', { na: 'N/A' }), col('daily_avg', `Daily average (÷ ${days} days)`, 'num', { dp: 2, na: '—' })],
    rows: metricsRows, totals: null,
    notes: [`Daily average = monthly total ÷ ${days} calendar day(s)${f.to > today ? ' elapsed so far this month' : ' in the month'}. % change shows N/A when the previous month is zero or unavailable.`],
  });

  // Site-wise comparison
  const sites = db().prepare(`SELECT id, name FROM sites WHERE ${access.inClause('id', f.siteIds).sql} ORDER BY name`).all(...f.siteIds);
  doc.sections.push({
    id: 'sites', title: 'Site-wise comparison', unit: '',
    columns: [col('name', 'Site'), col('elec_site', 'Electricity — site (kWh)', 'num', { dp: 2 }), col('elec_acc', 'Electricity — accom. (kWh)', 'num', { dp: 2 }),
      col('lpg_kg', 'LPG (kg)', 'num', { dp: 2 }), col('lpg_cyl', 'LPG (cylinders)', 'num', { dp: 2, na: '—' }), col('gen_h', 'Generator (h)', 'num', { dp: 2 }),
      col('diesel_l', 'Diesel (L)', 'num', { dp: 2 }), col('l_per_h', 'L per hour', 'num', { dp: 2, na: 'N/A' }), col('bill_amount', 'Bills (PKR)', 'pkr'),
      col('bill_outstanding', 'Outstanding (PKR)', 'pkr'), col('completeness', 'Data completeness', 'pct', { na: 'N/A' })],
    rows: sites.map((s) => {
      const one = metrics.summary([s.id], f.from, f.to, opts);
      const mm = metrics.missingEntries([s.id], f.from, f.to);
      return { name: s.name, elec_site: round(one.electricity.byLocation.site, 2), elec_acc: round(one.electricity.byLocation.accommodation, 2),
        lpg_kg: one.lpg.kg, lpg_cyl: one.lpg.cylinders || null, gen_h: one.generators.hours, diesel_l: one.diesel.litres, l_per_h: one.diesel.perHour,
        bill_amount: one.bills.amount, bill_outstanding: one.bills.outstanding, completeness: mm.completeness };
    }),
    totals: { elec_site: round(cur.electricity.byLocation.site, 2), elec_acc: round(cur.electricity.byLocation.accommodation, 2), lpg_kg: cur.lpg.kg,
      lpg_cyl: cur.lpg.cylinders || null, gen_h: cur.generators.hours, diesel_l: cur.diesel.litres, l_per_h: cur.diesel.perHour,
      bill_amount: cur.bills.amount, bill_outstanding: cur.bills.outstanding, completeness: miss.completeness },
    notes: [],
  });

  // Daily breakdown
  const dates = time.dateRange(f.from, f.to);
  doc.sections.push({
    id: 'daily', title: 'Daily breakdown', unit: '',
    columns: [col('date', 'Date', 'date'), col('kwh', 'Electricity (kWh)', 'num', { dp: 2 }), col('lpg', 'LPG (kg equiv.)', 'num', { dp: 2 }),
      col('gen', 'Generator (h)', 'num', { dp: 2 }), col('diesel', 'Diesel (L)', 'num', { dp: 2 }), col('missing', 'Missing entries', 'int')],
    rows: dates.filter((d) => d <= today).map((d) => ({ date: d, kwh: cur.electricity.byDate[d] || 0, lpg: cur.lpg.byDateKg[d] || 0,
      gen: round(cur.generators.byDate[d] || 0, 2), diesel: cur.diesel.byDate[d] || 0, missing: miss.items.filter((i) => i.date === d).length })),
    totals: { kwh: cur.electricity.totalKwh, lpg: cur.lpg.totalKg, gen: cur.generators.hours, diesel: cur.diesel.litres, missing: miss.items.length },
    notes: cur.lpg.cylinders ? ['LPG column converts cylinder-based records to kg using each site\'s configured net kg per cylinder.'] : [],
  });

  if (want(f, 'bills')) doc.sections.push(billsSection(f, f.month, f.month));
  if (want(f, 'maintenance')) {
    const ms = maintenanceSections(f, f.from, f.to);
    ms[0].notes.unshift(`${maint.completed.length} completed this month · ${maint.pendingInPeriod.length} pending (scheduled on or before month end).`);
    doc.sections.push(...ms);
  }
  doc.sections.push(missingSection(f, f.from, f.to).section);
  return doc;
}

module.exports = { dailyReport, monthlyReport, resolveFilters, RECORD_TYPES };
