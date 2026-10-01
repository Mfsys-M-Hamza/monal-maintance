'use strict';
const express = require('express');
const { db } = require('../db');
const access = require('../lib/access');
const web = require('../lib/web');
const time = require('../lib/time');
const reports = require('../services/reports');
const exporters = require('../services/exporters');
const { audit } = require('../lib/audit');

const router = express.Router();

function filterOptions(user) {
  const ids = access.allowedSiteIds(user);
  const m = access.inClause('m.site_id', ids), g = access.inClause('g.site_id', ids);
  return {
    meters: db().prepare(`SELECT m.id, m.name, m.site_id, m.location, s.name AS site_name FROM meters m JOIN sites s ON s.id = m.site_id WHERE ${m.sql} ORDER BY s.name, m.name`).all(...m.params),
    generators: db().prepare(`SELECT g.id, g.name, g.site_id, s.name AS site_name FROM generators g JOIN sites s ON s.id = g.site_id WHERE ${g.sql} ORDER BY s.name, g.name`).all(...g.params),
  };
}

function fileName(doc, ext) {
  const f = doc.filtersResolved;
  const period = f.kind === 'monthly' ? f.month : f.from === f.to ? f.from : `${f.from}_to_${f.to}`;
  const site = doc.siteLabel.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `${f.kind}-report_${site}_${period}.${ext}`;
}

router.get('/', (req, res) => {
  res.render('reports/index', { title: 'Reports', doc: null, kind: 'daily', q: { from: res.locals.today, to: res.locals.today, month: time.addMonthsToMonth(time.monthOf(res.locals.today), -1) }, ...filterOptions(req.user) });
});

for (const kind of ['daily', 'monthly']) {
  router.get(`/${kind}`, web.h(async (req, res) => {
    const doc = kind === 'daily' ? reports.dailyReport(req.user, req.query) : reports.monthlyReport(req.user, req.query);
    const format = req.query.format;
    if (['pdf', 'xlsx', 'csv'].includes(format)) {
      audit({ entityType: 'report', action: `export_${format}`, user: req.user, reason: `${doc.title} · ${doc.periodLabel} · ${doc.siteLabel}`, ip: req.ip });
    }
    if (format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${fileName(doc, 'csv')}"`);
      return res.send(exporters.toCsv(doc));
    }
    if (format === 'xlsx') {
      const buf = await exporters.toXlsx(doc);
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="${fileName(doc, 'xlsx')}"`);
      return res.send(Buffer.from(buf));
    }
    if (format === 'pdf') {
      const buf = await exporters.toPdf(doc);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${fileName(doc, 'pdf')}"`);
      return res.send(buf);
    }
    const f = doc.filtersResolved;
    const q = { ...req.query, site: f.site, from: f.from, to: f.to, month: f.month || req.query.month };
    const exportQuery = new URLSearchParams(Object.fromEntries(Object.entries(req.query).filter(([k, v]) => k !== 'format' && typeof v === 'string' && v !== ''))).toString();
    res.render(format === 'print' ? 'reports/print' : 'reports/index', { title: doc.title, doc, kind, q, exportQuery, ...filterOptions(req.user) });
  }));
}

module.exports = router;
