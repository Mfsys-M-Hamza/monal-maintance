'use strict';
const { db } = require('../db');
const svc = require('../services/lpg');
const { stockRoutes } = require('./stock-routes');

module.exports = stockRoutes({
  base: '/lpg',
  view: 'lpg',
  entity: 'lpg',
  label: 'LPG',
  table: 'lpg_records',
  svc,
  formData: () => ({}),
  listData: (req, from, params) => ({
    totals: db().prepare(`SELECT
        COALESCE(SUM(CASE WHEN r.unit = 'kg' THEN r.consumed END), 0) AS kg,
        COALESCE(SUM(CASE WHEN r.unit = 'cylinder' THEN r.consumed END), 0) AS cyl ${from}`).get(...params),
  }),
  toForm: (r) => ({ record_date: r.record_date, opening: r.opening_stock, received: r.received_stock, closing: r.closing_stock, recorded_by: r.recorded_by, remarks: r.remarks, site_id: r.site_id }),
  successText: (r) => `LPG record saved: ${r.consumed} ${r.unit === 'kg' ? 'kg' : 'cylinders'} consumed.`,
  decorate: (r) => { r.unit_label = r.unit === 'kg' ? 'kg' : 'cylinders'; },
});

