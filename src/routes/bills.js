'use strict';
const express = require('express');
const { db } = require('../db');
const access = require('../lib/access');
const web = require('../lib/web');
const crud = require('../lib/crud');
const time = require('../lib/time');
const svc = require('../services/bills');
const attachments = require('../services/attachments');
const { notFound } = require('../lib/errors');

const router = express.Router();
router.param('id', web.numericParam);
router.param('aid', web.numericParam);

function meterOptions(user) {
  const s = access.inClause('m.site_id', access.allowedSiteIds(user));
  return db().prepare(`SELECT m.*, st.name AS site_name FROM meters m JOIN sites st ON st.id = m.site_id WHERE ${s.sql} ORDER BY st.name, m.location, m.name`).all(...s.params);
}

router.get('/', web.h((req, res) => {
  const q = req.query;
  const siteIds = access.scopeSiteIds(req.user, q.site);
  const fromMonth = time.isValidMonth(q.from_month) ? q.from_month : time.addMonthsToMonth(time.monthOf(time.today()), -5);
  const toMonth = time.isValidMonth(q.to_month) ? q.to_month : time.monthOf(time.today());
  const category = ['site', 'accommodation'].includes(q.category) ? q.category : null;
  const status = ['Unpaid', 'Partially Paid', 'Paid'].includes(q.status) ? q.status : null;
  const rows = svc.list(siteIds, { fromMonth, toMonth, category, status });
  const totals = rows.reduce((a, b) => ({ amount: a.amount + b.amount_pkr, paid: a.paid + b.amount_paid, outstanding: a.outstanding + b.outstanding }), { amount: 0, paid: 0, outstanding: 0 });
  res.render('bills/index', { title: 'WAPDA bills', rows, totals, f: { site: q.site || 'all', fromMonth, toMonth, category: category || '', status: status || '' } });
}));

function renderForm(req, res, { record = null, values = {}, errors = {}, error = null } = {}) {
  res.render('bills/form', { title: record ? 'Edit bill' : 'New WAPDA bill', record, values, errors, error,
    sites: access.accessibleSites(req.user, { activeOnly: true }), meters: meterOptions(req.user),
    files: record ? attachments.listFor('bill', record.id) : [] });
}

router.get('/new', (req, res) => {
  const sites = res.locals.userSites.filter((s) => s.is_active);
  const m = time.addMonthsToMonth(time.monthOf(time.today()), -1);
  renderForm(req, res, { values: { site_id: req.query.site || (sites.length === 1 ? sites[0].id : ''), billing_month: m, period_start: time.monthStart(m), period_end: time.monthEnd(m) } });
});

router.post('/', web.singleFile('attachment'), (req, res, next) => crud.tryForm(res, next, () => {
  const row = svc.create(req.user, req.body, req.file, web.ctx(req));
  web.flash(req, 'success', 'Bill saved.');
  res.redirect(`/bills/${row.id}`);
}, (e) => renderForm(req, res, { values: req.body, ...e })));

function load(req) {
  const rec = svc.get(Number(req.params.id));
  if (!rec) throw notFound();
  access.assertSiteAccess(req.user, rec.site_id);
  return rec;
}

const lockDate = (b) => [b.billing_month + '-01'];

router.get('/:id', web.h((req, res) => {
  const rec = load(req);
  res.render('bills/show', { title: 'WAPDA bill', rec, comparison: svc.compare(rec), files: attachments.listFor('bill', rec.id),
    perms: crud.permissions(req.user, rec, lockDate(rec)), history: crud.history('bill', rec.id), createdBy: crud.userName(rec.created_by), updatedBy: crud.userName(rec.updated_by) });
}));

router.get('/:id/edit', web.h((req, res) => {
  const rec = load(req);
  access.assertCanEdit(req.user, rec);
  renderForm(req, res, { record: rec, values: rec });
}));

router.post('/:id', web.singleFile('attachment'), (req, res, next) => {
  let rec;
  try { rec = load(req); } catch (e) { return next(e); }
  crud.tryForm(res, next, () => {
    svc.update(req.user, rec.id, req.body, req.file, web.ctx(req));
    web.flash(req, 'success', 'Bill updated.');
    res.redirect(`/bills/${rec.id}`);
  }, (e) => renderForm(req, res, { record: rec, values: { ...rec, ...req.body }, ...e }));
});

router.post('/:id/delete', web.h((req, res) => {
  const rec = load(req);
  svc.remove(req.user, rec.id, web.ctx(req));
  web.flash(req, 'success', 'Bill deleted.');
  res.redirect('/bills');
}));

router.post('/:id/attachments/:aid/delete', web.h((req, res) => {
  const rec = load(req);
  access.assertCanEdit(req.user, rec);
  access.assertUnlocked(rec.site_id, rec.billing_month + '-01');
  const a = attachments.softDelete(req.user, Number(req.params.aid), 'bill', rec.id);
  require('../lib/audit').audit({ entityType: 'bill', entityId: rec.id, siteId: rec.site_id, action: 'attachment_delete', user: req.user, before: { attachment: a.original_name }, ip: req.ip });
  web.flash(req, 'success', 'Attachment removed.');
  res.redirect(`/bills/${rec.id}`);
}));

module.exports = router;
