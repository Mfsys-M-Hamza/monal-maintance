'use strict';
// Unified, searchable, paginated list of operational records across all types.
const { db } = require('../db');
const access = require('../lib/access');

const TYPES = {
  electricity: { label: 'Electricity', path: '/electricity' },
  lpg: { label: 'LPG', path: '/lpg' },
  generator: { label: 'Generator', path: '/generator' },
  diesel: { label: 'Diesel', path: '/diesel' },
  bill: { label: 'WAPDA bill', path: '/bills' },
  maintenance: { label: 'Maintenance', path: '/maintenance/tasks' },
};

const UNION = `
  SELECT 'electricity' AS type, r.id, r.site_id, r.record_date AS date, m.name || ': ' || printf('%.2f', r.consumption_kwh) || ' kWh' AS summary,
         r.recorded_by AS recorded_by, r.remarks, r.created_by, r.created_at, r.updated_at FROM electricity_readings r JOIN meters m ON m.id = r.meter_id WHERE r.deleted_at IS NULL
  UNION ALL
  SELECT 'lpg', l.id, l.site_id, l.record_date, printf('%.2f', l.consumed) || CASE l.unit WHEN 'kg' THEN ' kg' ELSE ' cylinders' END || ' consumed',
         l.recorded_by, l.remarks, l.created_by, l.created_at, l.updated_at FROM lpg_records l WHERE l.deleted_at IS NULL
  UNION ALL
  SELECT 'generator', g.id, g.site_id, g.operating_date, gn.name || ': ' || replace(g.start_at, 'T', ' ') || ' → ' || COALESCE(replace(g.stop_at, 'T', ' '), 'RUNNING'),
         g.operator_name, g.remarks, g.created_by, g.created_at, g.updated_at FROM generator_sessions g JOIN generators gn ON gn.id = g.generator_id WHERE g.deleted_at IS NULL
  UNION ALL
  SELECT 'diesel', d.id, d.site_id, d.record_date, t.name || ': ' || printf('%.2f', d.consumed_l) || ' L consumed',
         d.recorded_by, d.remarks, d.created_by, d.created_at, d.updated_at FROM diesel_records d JOIN diesel_tanks t ON t.id = d.tank_id WHERE d.deleted_at IS NULL
  UNION ALL
  SELECT 'bill', b.id, b.site_id, b.billing_month || '-01', m.name || ' (' || b.category || '): PKR ' || printf('%,d', CAST(b.amount_pkr AS INTEGER)),
         NULL, b.remarks, b.created_by, b.created_at, b.updated_at FROM bills b JOIN meters m ON m.id = b.meter_id WHERE b.deleted_at IS NULL
  UNION ALL
  SELECT 'maintenance', mt.id, mt.site_id, mt.completion_date, mi.name || ' — completed', mt.completed_by_name, mt.remarks, mt.updated_by, mt.created_at, mt.updated_at
         FROM maintenance_tasks mt JOIN maintenance_items mi ON mi.id = mt.item_id WHERE mt.deleted_at IS NULL AND mt.status = 'completed'
`;

function search(user, { site = 'all', type = '', q = '', from = '', to = '', mine = false, page = 1, pageSize = 25 } = {}) {
  const siteIds = access.scopeSiteIds(user, site);
  const s = access.inClause('x.site_id', siteIds);
  const where = [s.sql];
  const params = [...s.params];
  if (TYPES[type]) { where.push('x.type = ?'); params.push(type); }
  if (from) { where.push('x.date >= ?'); params.push(from); }
  if (to) { where.push('x.date <= ?'); params.push(to); }
  if (mine) { where.push('x.created_by = ?'); params.push(user.id); }
  if (q) {
    where.push("(x.summary LIKE ? ESCAPE '\\' OR x.recorded_by LIKE ? ESCAPE '\\' OR x.remarks LIKE ? ESCAPE '\\' OR st.name LIKE ? ESCAPE '\\' OR u.full_name LIKE ? ESCAPE '\\')");
    const like = `%${String(q).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    params.push(like, like, like, like, like);
  }
  const fromSql = `FROM (${UNION}) x JOIN sites st ON st.id = x.site_id LEFT JOIN users u ON u.id = x.created_by WHERE ${where.join(' AND ')}`;
  const total = db().prepare(`SELECT COUNT(*) AS n ${fromSql}`).get(...params).n;
  const size = Math.min(100, Math.max(5, Number(pageSize) || 25));
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(pages, Math.max(1, Number(page) || 1));
  const rows = db().prepare(`SELECT x.*, st.name AS site_name, u.full_name AS entered_by ${fromSql}
    ORDER BY x.date DESC, x.created_at DESC LIMIT ? OFFSET ?`).all(...params, size, (p - 1) * size);
  for (const r of rows) {
    r.type_label = TYPES[r.type].label;
    r.view_path = `${TYPES[r.type].path}/${r.id}`;
    r.can_edit = access.isAdmin(user) || r.created_by === user.id;
  }
  return { rows, total, page: p, pages, pageSize: size };
}

/** Recent audit activity visible to the user (admins: all; users: their sites). */
function recentActivity(user, siteIds, limit = 10) {
  const s = access.inClause('a.site_id', siteIds);
  const extra = access.isAdmin(user) && siteIds.length === access.allowedSiteIds(user).length ? ' OR a.site_id IS NULL' : '';
  return db().prepare(`SELECT a.*, st.name AS site_name FROM audit_log a LEFT JOIN sites st ON st.id = a.site_id
    WHERE (${s.sql}${extra}) AND a.entity_type NOT IN ('auth') ORDER BY a.id DESC LIMIT ?`).all(...s.params, limit);
}

module.exports = { search, recentActivity, TYPES };
