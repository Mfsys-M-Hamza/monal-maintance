'use strict';
const { db } = require('../db');
const { forbidden, HttpError } = require('./errors');
const time = require('./time');

const isAdmin = (user) => !!user && user.role === 'admin';

/**
 * Site IDs a user may access. Admins: every site. Users: their assigned, active sites.
 */
function allowedSiteIds(user) {
  if (!user) return [];
  if (isAdmin(user)) return db().prepare('SELECT id FROM sites ORDER BY name').all().map((r) => r.id);
  return db().prepare(`SELECT s.id FROM user_sites us JOIN sites s ON s.id = us.site_id
    WHERE us.user_id = ? AND s.is_active = 1 ORDER BY s.name`).all(user.id).map((r) => r.id);
}

/** Sites the user may see, for selectors. activeOnly hides deactivated sites for data entry. */
function accessibleSites(user, { activeOnly = false } = {}) {
  const ids = allowedSiteIds(user);
  if (!ids.length) return [];
  const rows = db().prepare(`SELECT * FROM sites WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`).all(...ids);
  return activeOnly ? rows.filter((s) => s.is_active) : rows;
}

function canAccessSite(user, siteId) {
  return allowedSiteIds(user).includes(Number(siteId));
}

function assertSiteAccess(user, siteId) {
  if (!canAccessSite(user, siteId)) throw forbidden('You do not have access to this site.');
}

/** Site must be active to accept new data entry. */
function assertSiteActive(siteId) {
  const s = db().prepare('SELECT is_active FROM sites WHERE id = ?').get(siteId);
  if (!s) throw new HttpError(404, 'Site not found.');
  if (!s.is_active) throw new HttpError(409, 'This site is deactivated; new entries are not accepted.');
}

/**
 * Resolve a requested site filter to a list of IDs the user is allowed to query.
 * siteParam: '' / 'all' / undefined -> all accessible; otherwise a single ID (checked).
 */
function scopeSiteIds(user, siteParam) {
  const allowed = allowedSiteIds(user);
  if (siteParam === undefined || siteParam === null || siteParam === '' || siteParam === 'all') return allowed;
  const id = Number(siteParam);
  if (!allowed.includes(id)) throw forbidden('You do not have access to this site.');
  return [id];
}

function isLocked(siteId, date) {
  if (!date) return false;
  const month = time.monthOf(date);
  return !!db().prepare('SELECT 1 FROM period_locks WHERE month = ? AND (site_id IS NULL OR site_id = ?)').get(month, siteId);
}

function assertUnlocked(siteId, ...dates) {
  for (const d of dates) {
    if (d && isLocked(siteId, d)) {
      throw new HttpError(423, `The reporting period ${time.formatMonth(time.monthOf(d))} is locked for this site. An admin must unlock it before changes can be made.`);
    }
  }
}

/** Users may edit only their own records; admins may edit any. Lock is checked separately. */
function assertCanEdit(user, record) {
  assertSiteAccess(user, record.site_id);
  if (isAdmin(user)) return;
  if (record.created_by !== user.id) throw forbidden('You can only edit records you created.');
}

function assertAdmin(user) {
  if (!isAdmin(user)) throw forbidden();
}

/** SQL fragment "col IN (?,?,...)" with params; empty list matches nothing. */
function inClause(col, ids) {
  if (!ids.length) return { sql: '0', params: [] };
  return { sql: `${col} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

module.exports = {
  isAdmin, allowedSiteIds, accessibleSites, canAccessSite, assertSiteAccess, assertSiteActive,
  scopeSiteIds, isLocked, assertUnlocked, assertCanEdit, assertAdmin, inClause,
};
