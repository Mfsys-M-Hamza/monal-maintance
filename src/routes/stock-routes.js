'use strict';
// Shared routes for stock-ledger records (LPG and diesel).
const express = require('express');
const { db } = require('../db');
const access = require('../lib/access');
const web = require('../lib/web');
const crud = require('../lib/crud');
const { notFound } = require('../lib/errors');

/**
 * opts: { base, view, entity, label, svc, table, consumedCol, unitLabel,
 *         listJoin, listSelect, listFilter(req, where, params), formData(req), successText(row) }
 */
function stockRoutes(opts) {
  const router = express.Router();
  router.param('id', web.numericParam);

  router.get('/', web.h((req, res) => {
    const f = crud.listFilters(req);
    const siteIds = access.scopeSiteIds(req.user, f.site);
    const s = access.inClause('r.site_id', siteIds);
    const where = [s.sql, 'r.deleted_at IS NULL', 'r.record_date BETWEEN ? AND ?'];
    const params = [...s.params, f.from, f.to];
    if (f.mine) { where.push('r.created_by = ?'); params.push(req.user.id); }
    if (req.query.flagged === '1') where.push('r.opening_mismatch = 1');
    if (opts.listFilter) opts.listFilter(req, where, params);
    const from = `FROM ${opts.table} r JOIN sites st ON st.id = r.site_id ${opts.listJoin || ''} LEFT JOIN users u ON u.id = r.created_by WHERE ${where.join(' AND ')}`;
    const pg = crud.paginate(from, params, '', f.page);
    const rows = db().prepare(`SELECT r.*, st.name AS site_name, u.full_name AS entered_by ${opts.listSelect || ''} ${from}
      ORDER BY r.record_date DESC, st.name LIMIT ? OFFSET ?`).all(...params, pg.size, pg.offset);
    res.render(`${opts.view}/index`, { title: opts.label, rows, pg, f, ...(opts.listData ? opts.listData(req, from, params) : {}), ...opts.formData(req) });
  }));

  function renderForm(req, res, { record = null, values = {}, errors = {}, error = null } = {}) {
    res.render(`${opts.view}/form`, { title: `${record ? 'Edit' : 'New'} ${opts.label} record`, record, values, errors, error, sites: access.accessibleSites(req.user, { activeOnly: true }), ...opts.formData(req) });
  }

  router.get('/new', (req, res) => {
    const sites = res.locals.userSites.filter((s) => s.is_active);
    renderForm(req, res, { values: { site_id: req.query.site || (sites.length === 1 ? sites[0].id : ''), tank_id: req.query.tank || '', record_date: req.query.date || res.locals.today, recorded_by: req.user.full_name } });
  });

  router.post('/', (req, res, next) => crud.tryForm(res, next, () => {
    const row = opts.svc.create(req.user, req.body, web.ctx(req));
    web.flash(req, 'success', opts.successText(row));
    res.redirect(req.body.next === 'another' ? `${opts.base}/new?site=${row.site_id}&date=${row.record_date}` : `${opts.base}/${row.id}`);
  }, (e) => renderForm(req, res, { values: req.body, ...e })));

  function load(req) {
    const rec = opts.svc.get(Number(req.params.id));
    if (!rec) throw notFound();
    access.assertSiteAccess(req.user, rec.site_id);
    rec.site_name = db().prepare('SELECT name FROM sites WHERE id = ?').get(rec.site_id).name;
    if (opts.decorate) opts.decorate(rec);
    return rec;
  }

  router.get('/:id', web.h((req, res) => {
    const rec = load(req);
    res.render(`${opts.view}/show`, { title: `${opts.label} record`, rec, perms: crud.permissions(req.user, rec), history: crud.history(opts.entity, rec.id),
      createdBy: crud.userName(rec.created_by), updatedBy: crud.userName(rec.updated_by) });
  }));

  router.get('/:id/edit', web.h((req, res) => {
    const rec = load(req);
    access.assertCanEdit(req.user, rec);
    renderForm(req, res, { record: rec, values: opts.toForm(rec) });
  }));

  router.post('/:id', (req, res, next) => {
    let rec;
    try { rec = load(req); } catch (e) { return next(e); }
    crud.tryForm(res, next, () => {
      opts.svc.update(req.user, rec.id, req.body, web.ctx(req));
      web.flash(req, 'success', 'Record updated.');
      res.redirect(`${opts.base}/${rec.id}`);
    }, (e) => renderForm(req, res, { record: rec, values: { ...opts.toForm(rec), ...req.body }, ...e }));
  });

  router.post('/:id/delete', web.h((req, res) => {
    const rec = load(req);
    opts.svc.remove(req.user, rec.id, web.ctx(req));
    web.flash(req, 'success', 'Record deleted.');
    res.redirect(opts.base);
  }));

  return router;
}

module.exports = { stockRoutes };
