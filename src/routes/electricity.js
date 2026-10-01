'use strict';
const express = require('express');
const { db } = require('../db');
const access = require('../lib/access');
const web = require('../lib/web');
const crud = require('../lib/crud');
const svc = require('../services/electricity');
const { notFound } = require('../lib/errors');

const router = express.Router();
router.param('id', web.numericParam);

function meterOptions(user) {
  const ids = access.allowedSiteIds(user);
  const s = access.inClause('m.site_id', ids);
  return db().prepare(`SELECT m.*, st.name AS site_name FROM meters m JOIN sites st ON st.id = m.site_id
    WHERE ${s.sql} ORDER BY st.name, m.location, m.name`).all(...s.params);
}

router.get('/', web.h((req, res) => {
  const f = crud.listFilters(req);
  const siteIds = access.scopeSiteIds(req.user, f.site);
  const s = access.inClause('r.site_id', siteIds);
  const where = [s.sql, 'r.deleted_at IS NULL', 'r.record_date BETWEEN ? AND ?'];
  const params = [...s.params, f.from, f.to];
  if (/^\d+$/.test(req.query.meter || '')) { where.push('r.meter_id = ?'); params.push(Number(req.query.meter)); }
  if (['site', 'accommodation'].includes(req.query.location)) { where.push('m.location = ?'); params.push(req.query.location); }
  if (f.mine) { where.push('r.created_by = ?'); params.push(req.user.id); }
  const from = `FROM electricity_readings r JOIN meters m ON m.id = r.meter_id JOIN sites st ON st.id = r.site_id LEFT JOIN users u ON u.id = r.created_by WHERE ${where.join(' AND ')}`;
  const pg = crud.paginate(from, params, '', f.page);
  const rows = db().prepare(`SELECT r.*, m.name AS meter_name, m.location, st.name AS site_name, u.full_name AS entered_by ${from}
    ORDER BY r.record_date DESC, st.name, m.name LIMIT ? OFFSET ?`).all(...params, pg.size, pg.offset);
  const total = db().prepare(`SELECT COALESCE(SUM(r.consumption_kwh), 0) AS kwh ${from}`).get(...params).kwh;
  res.render('electricity/index', { title: 'Electricity', rows, pg, f, total, meters: meterOptions(req.user) });
}));

function renderForm(req, res, { record = null, values = {}, errors = {}, error = null } = {}) {
  res.render('electricity/form', {
    title: record ? 'Edit electricity reading' : 'New electricity reading',
    record, values, errors, error,
    sites: access.accessibleSites(req.user, { activeOnly: true }),
    meters: meterOptions(req.user).filter((m) => m.is_active),
  });
}

router.get('/new', (req, res) => {
  renderForm(req, res, { values: { site_id: req.query.site || (res.locals.userSites.length === 1 ? res.locals.userSites[0].id : ''), record_date: req.query.date || res.locals.today, recorded_by: req.user.full_name } });
});

router.post('/', (req, res, next) => crud.tryForm(res, next, () => {
  const row = svc.create(req.user, req.body, web.ctx(req));
  web.flash(req, 'success', `Reading saved: ${row.consumption_kwh} kWh consumed.`);
  res.redirect(req.body.next === 'another' ? `/electricity/new?site=${row.site_id}&date=${row.record_date}` : `/electricity/${row.id}`);
}, (e) => renderForm(req, res, { values: req.body, ...e })));

function load(req) {
  const rec = svc.getReading(Number(req.params.id));
  if (!rec) throw notFound();
  access.assertSiteAccess(req.user, rec.site_id);
  return rec;
}

router.get('/:id', web.h((req, res) => {
  const rec = load(req);
  const event = rec.baseline_event_id ? db().prepare('SELECT * FROM meter_events WHERE id = ?').get(rec.baseline_event_id) : null;
  res.render('electricity/show', { title: 'Electricity reading', rec, event, perms: crud.permissions(req.user, rec),
    history: crud.history('electricity', rec.id), createdBy: crud.userName(rec.created_by), updatedBy: crud.userName(rec.updated_by) });
}));

router.get('/:id/edit', web.h((req, res) => {
  const rec = load(req);
  access.assertCanEdit(req.user, rec);
  renderForm(req, res, { record: rec, values: rec });
}));

router.post('/:id', (req, res, next) => {
  let rec;
  try { rec = load(req); } catch (e) { return next(e); }
  crud.tryForm(res, next, () => {
    svc.update(req.user, rec.id, req.body, web.ctx(req));
    web.flash(req, 'success', 'Reading updated.');
    res.redirect(`/electricity/${rec.id}`);
  }, (e) => renderForm(req, res, { record: rec, values: { ...rec, ...req.body }, ...e }));
});

router.post('/:id/delete', web.h((req, res) => {
  const rec = load(req);
  svc.remove(req.user, rec.id, web.ctx(req));
  web.flash(req, 'success', 'Reading deleted. Later readings for this meter were recalculated.');
  res.redirect('/electricity');
}));

module.exports = router;
