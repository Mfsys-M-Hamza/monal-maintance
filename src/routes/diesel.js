'use strict';
const { db } = require('../db');
const access = require('../lib/access');
const svc = require('../services/diesel');
const metrics = require('../services/metrics');
const { stockRoutes } = require('./stock-routes');
const { round } = require('../lib/validate');

module.exports = stockRoutes({
  base: '/diesel',
  view: 'diesel',
  entity: 'diesel',
  label: 'Diesel',
  table: 'diesel_records',
  svc,
  listJoin: 'JOIN diesel_tanks t ON t.id = r.tank_id',
  listSelect: ', t.name AS tank_name, t.tank_type',
  listFilter(req, where, params) {
    if (/^\d+$/.test(req.query.tank || '')) { where.push('r.tank_id = ?'); params.push(Number(req.query.tank)); }
  },
  listData: (req, from, params) => ({ totalL: db().prepare(`SELECT COALESCE(SUM(r.consumed_l), 0) AS l ${from}`).get(...params).l }),
  formData: (req) => ({ tanks: svc.tanksWithGenerators(access.allowedSiteIds(req.user)) }),
  toForm: (r) => ({ record_date: r.record_date, tank_id: r.tank_id, opening: r.opening_l, received: r.received_l, closing: r.closing_l, recorded_by: r.recorded_by, remarks: r.remarks, site_id: r.site_id }),
  successText: (r) => `Diesel record saved: ${r.consumed_l} L consumed.`,
  decorate(r) {
    const tank = svc.tanksWithGenerators([r.site_id], { activeOnly: false }).find((t) => t.id === r.tank_id);
    r.tank_label = tank ? tank.label : '';
    r.tank_type = tank ? tank.tank_type : '';
    const gen = metrics.generators([r.site_id], r.record_date, r.record_date);
    r.runtime_hours = round(gen.byTankDate[`${r.tank_id}|${r.record_date}`] || 0, 2);
    r.l_per_hour = r.runtime_hours > 0 ? round(r.consumed_l / r.runtime_hours, 2) : null;
  },
});
