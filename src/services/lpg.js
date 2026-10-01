'use strict';
const { db } = require('../db');
const { makeStockService } = require('./stock');

// LPG is held per site. Unit is configured per site: kilograms (default) or cylinders.
// Each record snapshots its unit (and net kg per cylinder) so history is never re-interpreted
// if the site setting changes later. Records in different units never carry stock forward.
const service = makeStockService({
  table: 'lpg_records',
  entity: 'lpg',
  scopeCol: 'site_id',
  cols: { opening: 'opening_stock', received: 'received_stock', closing: 'closing_stock', consumed: 'consumed' },
  duplicateMessage: 'An LPG record already exists for this site on this date.',
  resolveScope(input) {
    const site = db().prepare('SELECT * FROM sites WHERE id = ?').get(input.site_id);
    return {
      scopeId: site.id,
      extra: { unit: site.lpg_unit, cylinder_kg: site.lpg_unit === 'cylinder' ? site.lpg_cylinder_kg : null },
    };
  },
  compatible: (prev, cur) => prev.unit === cur.unit,
});

function unitInfo(siteId) {
  const s = db().prepare('SELECT lpg_unit, lpg_cylinder_kg FROM sites WHERE id = ?').get(siteId);
  return s ? { unit: s.lpg_unit, cylinder_kg: s.lpg_cylinder_kg } : null;
}

module.exports = { ...service, unitInfo };
