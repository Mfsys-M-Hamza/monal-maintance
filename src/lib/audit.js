'use strict';
const { db, nowIso } = require('../db');

const SKIP = new Set(['updated_at', 'updated_by']);

/** Write an audit entry. before/after are plain row objects (or null). */
function audit({ entityType, entityId = null, siteId = null, action, user = null, before = null, after = null, reason = null, ip = null }) {
  db().prepare(`INSERT INTO audit_log (entity_type, entity_id, site_id, action, user_id, username, before_json, after_json, reason, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    entityType, entityId, siteId, action, user ? user.id : null, user ? user.username : 'system',
    before ? JSON.stringify(clean(before)) : null, after ? JSON.stringify(clean(after)) : null,
    reason, ip, nowIso());
}

function clean(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (k !== 'password_hash') out[k] = v;
  return out;
}

/** Compute changed fields between two audit snapshots for display. */
function diff(beforeJson, afterJson) {
  const b = beforeJson ? JSON.parse(beforeJson) : {};
  const a = afterJson ? JSON.parse(afterJson) : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const changes = [];
  for (const k of keys) {
    if (SKIP.has(k)) continue;
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) changes.push({ field: k, before: b[k], after: a[k] });
  }
  return changes;
}

module.exports = { audit, diff };
