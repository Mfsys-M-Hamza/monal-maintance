'use strict';
const { db } = require('../db');
const access = require('./access');
const { diff } = require('./audit');
const { ValidationError } = require('./errors');
const time = require('./time');

/** Errors that should re-render the form rather than show an error page. */
const isFormError = (e) => e instanceof ValidationError || [403, 409, 423].includes(e.status);

/** Run a form action; on a form error re-render with errors and the submitted values. */
function tryForm(res, next, action, render) {
  try {
    return action();
  } catch (e) {
    if (!isFormError(e)) return next(e);
    res.status(e.status || 422);
    return render({ errors: e.fields || {}, error: e.message });
  }
}

function history(entityType, id) {
  return db().prepare('SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC').all(entityType, id)
    .map((a) => ({ ...a, changes: diff(a.before_json, a.after_json) }));
}

/** Common list filters with a sensible default window (last 30 days). */
function listFilters(req) {
  const q = req.query;
  const to = time.isValidDate(q.to) ? q.to : time.today();
  const from = time.isValidDate(q.from) ? q.from : time.addDays(to, -30);
  return { site: q.site || 'all', from, to, page: Number(q.page) || 1, mine: q.mine === '1' };
}

function permissions(user, record, dates = [record.record_date]) {
  const locked = dates.some((d) => d && access.isLocked(record.site_id, d));
  const owner = access.isAdmin(user) || record.created_by === user.id;
  return { locked, canEdit: owner && !locked, canDelete: access.isAdmin(user) && !locked };
}

function userName(id) {
  if (!id) return null;
  const u = db().prepare('SELECT full_name FROM users WHERE id = ?').get(id);
  return u ? u.full_name : null;
}

/** Simple paginated query helper. */
function paginate(sqlFrom, params, orderBy, page, size = 25) {
  const total = db().prepare(`SELECT COUNT(*) AS n ${sqlFrom}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(pages, Math.max(1, page));
  return { total, pages, page: p, size, offset: (p - 1) * size, orderBy };
}

module.exports = { isFormError, tryForm, history, listFilters, permissions, userName, paginate };
