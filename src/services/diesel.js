'use strict';
const { db } = require('../db');
const { ValidationError } = require('../lib/errors');
const { makeStockService } = require('./stock');

// Diesel stock is recorded per tank. A tank is either 'individual' (feeds one generator)
// or 'shared' (feeds several). Because each tank has at most one record per day, shared-tank
// consumption is counted exactly once and is compared against the combined runtime of all
// generators connected to that tank.
const service = makeStockService({
  table: 'diesel_records',
  entity: 'diesel',
  scopeCol: 'tank_id',
  cols: { opening: 'opening_l', received: 'received_l', closing: 'closing_l', consumed: 'consumed_l' },
  duplicateMessage: 'A diesel record already exists for this tank on this date.',
  parseExtra: (p) => ({ tank_id: p.id('tank_id', { label: 'Generator / tank' }) }),
  resolveScope(input) {
    const tank = db().prepare('SELECT * FROM diesel_tanks WHERE id = ?').get(input.tank_id);
    if (!tank || tank.site_id !== input.site_id) throw new ValidationError('Select a tank that belongs to the chosen site.', { tank_id: 'Invalid tank for this site.' });
    if (!tank.is_active) throw new ValidationError('This tank is inactive.', { tank_id: 'This tank is inactive.' });
    return { scopeId: tank.id, extra: { tank_id: tank.id } };
  },
});

/** Tanks with their connected generators, for selectors. */
function tanksWithGenerators(siteIds, { activeOnly = true } = {}) {
  if (!siteIds.length) return [];
  const ph = siteIds.map(() => '?').join(',');
  const tanks = db().prepare(`SELECT t.*, s.name AS site_name FROM diesel_tanks t JOIN sites s ON s.id = t.site_id
    WHERE t.site_id IN (${ph}) ${activeOnly ? 'AND t.is_active = 1' : ''} ORDER BY s.name, t.name`).all(...siteIds);
  const gens = db().prepare(`SELECT id, name, tank_id FROM generators WHERE site_id IN (${ph}) ${activeOnly ? 'AND is_active = 1' : ''} ORDER BY name`).all(...siteIds);
  for (const t of tanks) {
    t.generators = gens.filter((g) => g.tank_id === t.id);
    const names = t.generators.map((g) => g.name).join(', ') || 'no generator linked';
    t.label = t.tank_type === 'shared' ? `${t.name} — shared tank (${names})` : `${names} — ${t.name}`;
  }
  return tanks;
}

module.exports = { ...service, tanksWithGenerators };
