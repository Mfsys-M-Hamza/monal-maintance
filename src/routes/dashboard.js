'use strict';
const express = require('express');
const { db } = require('../db');
const access = require('../lib/access');
const web = require('../lib/web');
const time = require('../lib/time');
const { round } = require('../lib/validate');
const metrics = require('../services/metrics');
const records = require('../services/records');

const router = express.Router();

/** Build every dashboard figure. Shared by the HTML page and /api/dashboard. */
function dashboardData(user, q) {
  const siteIds = access.scopeSiteIds(user, q.site);
  const range = time.resolvePreset(q.preset, q.from, q.to);
  const { from, to } = range;
  const sum = metrics.summary(siteIds, from, to);
  const maint = metrics.maintenanceSummary(siteIds, from, to);
  const missing = metrics.missingEntries(siteIds, from, to);

  // Trends: use the selected range, or the 14 days ending at `to` when the range is short.
  const shortRange = time.diffDays(from, to) < 6;
  const tFrom = shortRange ? time.addDays(to, -13) : from;
  const trend = shortRange ? metrics.summary(siteIds, tFrom, to) : sum;
  const dates = time.dateRange(tFrom, to);

  // Site comparison
  const sites = siteIds.length ? db().prepare(`SELECT id, name FROM sites WHERE ${access.inClause('id', siteIds).sql} ORDER BY name`).all(...siteIds) : [];
  const siteRows = sites.map((s) => ({
    name: s.name,
    kwh: round(sum.electricity.bySite[s.id] || 0, 2),
    lpg: round(sum.lpg.bySiteKg[s.id] || 0, 2),
    gen: round(sum.generators.bySite[s.id] || 0, 2),
    diesel: round(sum.diesel.bySite[s.id] || 0, 2),
    bills: round(sum.bills.bySite[s.id] || 0, 2),
    missing: missing.bySite[s.id] || 0,
  }));

  // Monthly bills: last 6 months ending at the range end
  const toMonth = time.monthOf(to);
  const fromMonth = time.addMonthsToMonth(toMonth, -5);
  const billTrend = metrics.bills(siteIds, fromMonth, toMonth);
  const months = [];
  for (let m = fromMonth; m <= toMonth; m = time.addMonthsToMonth(m, 1)) months.push(m);

  return {
    range, siteIds, summary: sum, maint, missing, siteRows,
    charts: {
      trendLabel: shortRange ? 'Last 14 days' : range.label,
      dates: dates.map((d) => time.formatDate(d).slice(0, 6)),
      electricity: dates.map((d) => round(trend.electricity.byDate[d] || 0, 2)),
      lpg: dates.map((d) => round(trend.lpg.byDateKg[d] || 0, 2)),
      runtime: dates.map((d) => round(trend.generators.byDate[d] || 0, 2)),
      diesel: dates.map((d) => round(trend.diesel.byDate[d] || 0, 2)),
      sites: siteRows,
      months: months.map((m) => time.formatMonth(m).replace(/^(\w{3})\w* (\d{4})$/, '$1 $2')),
      billsSite: months.map((m) => (billTrend.byMonth[m] ? billTrend.byMonth[m].site : 0)),
      billsAccommodation: months.map((m) => (billTrend.byMonth[m] ? billTrend.byMonth[m].accommodation : 0)),
    },
  };
}

router.get('/', web.h((req, res) => {
  const data = dashboardData(req.user, req.query);
  const recent = records.search(req.user, { site: req.query.site || 'all', page: 1, pageSize: 8 });
  const activity = records.recentActivity(req.user, data.siteIds, 8);
  res.render('dashboard', { title: 'Dashboard', ...data, recent, activity, f: { site: req.query.site || 'all', preset: data.range.preset, from: data.range.from, to: data.range.to } });
}));

module.exports = router;
module.exports.dashboardData = dashboardData;
