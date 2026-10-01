'use strict';
// JSON API. Mounted behind requireAuth; every handler scopes data with the same
// access checks as the HTML routes, so direct API calls cannot reach other sites.
// Mutating requests require the CSRF token in the `X-CSRF-Token` header.
const express = require('express');
const { db } = require('../db');
const access = require('../lib/access');
const web = require('../lib/web');
const time = require('../lib/time');
const { notFound } = require('../lib/errors');
const electricity = require('../services/electricity');
const lpg = require('../services/lpg');
const diesel = require('../services/diesel');
const generator = require('../services/generator');
const records = require('../services/records');
const reports = require('../services/reports');
const { dashboardData } = require('./dashboard');

const router = express.Router();

router.get('/me', (req, res) => {
  res.json({ user: req.user, sites: access.accessibleSites(req.user).map((s) => ({ id: s.id, name: s.name, is_active: !!s.is_active })) });
});

router.get('/sites', (req, res) => res.json(access.accessibleSites(req.user)));

function scoped(req, table, extraCols = '') {
  const ids = access.scopeSiteIds(req.user, req.query.site);
  const s = access.inClause('site_id', ids);
  return db().prepare(`SELECT *${extraCols} FROM ${table} WHERE ${s.sql} ORDER BY name`).all(...s.params);
}

router.get('/meters', web.h((req, res) => res.json(scoped(req, 'meters'))));
router.get('/generators', web.h((req, res) => res.json(scoped(req, 'generators'))));
router.get('/tanks', web.h((req, res) => res.json(diesel.tanksWithGenerators(access.scopeSiteIds(req.user, req.query.site)))));

router.get('/electricity/previous', web.h((req, res) => {
  const meter = electricity.getMeter(Number(req.query.meter));
  if (!meter) throw notFound('Meter not found.');
  access.assertSiteAccess(req.user, meter.site_id);
  const date = time.isValidDate(req.query.date) ? req.query.date : time.today();
  const exclude = /^\d+$/.test(req.query.exclude || '') ? Number(req.query.exclude) : null;
  const p = electricity.previousFor(meter.id, date, exclude);
  const dup = db().prepare('SELECT id FROM electricity_readings WHERE meter_id = ? AND record_date = ? AND deleted_at IS NULL AND id IS NOT ?').get(meter.id, date, exclude);
  res.json({ previous: p.previous, preEventKwh: p.preEventKwh, source: p.source, duplicateId: dup ? dup.id : null, locked: access.isLocked(meter.site_id, date) });
}));

router.get('/lpg/suggest', web.h((req, res) => {
  const siteId = Number(req.query.site);
  access.assertSiteAccess(req.user, siteId);
  const date = time.isValidDate(req.query.date) ? req.query.date : time.today();
  const unit = lpg.unitInfo(siteId);
  const dup = db().prepare('SELECT id FROM lpg_records WHERE site_id = ? AND record_date = ? AND deleted_at IS NULL').get(siteId, date);
  res.json({ ...lpg.suggestion(siteId, date, { unit: unit.unit }), ...unit, duplicateId: dup ? dup.id : null, locked: access.isLocked(siteId, date) });
}));

router.get('/diesel/suggest', web.h((req, res) => {
  const tank = db().prepare('SELECT * FROM diesel_tanks WHERE id = ?').get(Number(req.query.tank));
  if (!tank) throw notFound('Tank not found.');
  access.assertSiteAccess(req.user, tank.site_id);
  const date = time.isValidDate(req.query.date) ? req.query.date : time.today();
  const dup = db().prepare('SELECT id FROM diesel_records WHERE tank_id = ? AND record_date = ? AND deleted_at IS NULL').get(tank.id, date);
  res.json({ ...diesel.suggestion(tank.id, date), duplicateId: dup ? dup.id : null, locked: access.isLocked(tank.site_id, date) });
}));

router.get('/dashboard', web.h((req, res) => {
  const d = dashboardData(req.user, req.query);
  res.json({
    range: d.range,
    totals: {
      electricity_kwh: d.summary.electricity.totalKwh,
      lpg_kg: d.summary.lpg.kg, lpg_cylinders: d.summary.lpg.cylinders, lpg_total_kg_equiv: d.summary.lpg.totalKg,
      generator_hours: d.summary.generators.hours, diesel_l: d.summary.diesel.litres, diesel_l_per_hour: d.summary.diesel.perHour,
      bills_pkr: d.summary.bills.amount, paid_pkr: d.summary.bills.paid, outstanding_pkr: d.summary.bills.outstanding,
    },
    maintenance: { overdue: d.maint.overdue.length, due: d.maint.due.length },
    missing: { count: d.missing.items.length, completeness_pct: d.missing.completeness },
    sites: d.siteRows,
    charts: d.charts,
  });
}));

router.get('/records', web.h((req, res) => res.json(records.search(req.user, { ...req.query }))));

router.get('/reports/:kind', web.h((req, res) => {
  if (req.params.kind === 'daily') return res.json(reports.dailyReport(req.user, req.query));
  if (req.params.kind === 'monthly') return res.json(reports.monthlyReport(req.user, req.query));
  throw notFound();
}));

// Record creation (same services and checks as the forms)
const creators = { electricity: electricity.create, lpg: lpg.create, diesel: diesel.create, 'generator-sessions': generator.create };
for (const [name, fn] of Object.entries(creators)) {
  router.post(`/${name}`, web.h((req, res) => res.status(201).json(fn(req.user, req.body, web.ctx(req)))));
}

router.use((req, res) => res.status(404).json({ error: 'Not found.' }));

module.exports = router;
