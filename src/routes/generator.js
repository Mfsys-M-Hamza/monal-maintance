'use strict';
const express = require('express');
const { db } = require('../db');
const access = require('../lib/access');
const web = require('../lib/web');
const crud = require('../lib/crud');
const time = require('../lib/time');
const svc = require('../services/generator');
const { notFound } = require('../lib/errors');

const router = express.Router();
router.param('id', web.numericParam);

function generatorOptions(user) {
  const s = access.inClause('g.site_id', access.allowedSiteIds(user));
  return db().prepare(`SELECT g.*, st.name AS site_name FROM generators g JOIN sites st ON st.id = g.site_id WHERE ${s.sql} ORDER BY st.name, g.name`).all(...s.params);
}

router.get('/', web.h((req, res) => {
  const f = crud.listFilters(req);
  const siteIds = access.scopeSiteIds(req.user, f.site);
  const genIds = /^\d+$/.test(req.query.generator || '') ? [Number(req.query.generator)] : null;
  let sessions = svc.sessionsInRange(siteIds, f.from, f.to, { generatorIds: genIds });
  if (f.mine) sessions = sessions.filter((s) => s.created_by === req.user.id);
  sessions.sort((a, b) => (a.start_at < b.start_at ? 1 : -1));
  const running = svc.sessionsInRange(siteIds, '2000-01-01', time.today()).filter((s) => s.running);
  const totalHours = sessions.reduce((a, s) => a + s.hours_in_range, 0);
  const size = 25;
  const pages = Math.max(1, Math.ceil(sessions.length / size));
  const page = Math.min(pages, Math.max(1, f.page));
  res.render('generator/index', { title: 'Generator logbook', rows: sessions.slice((page - 1) * size, page * size), pg: { page, pages, total: sessions.length },
    f, running, totalHours, generators: generatorOptions(req.user) });
}));

function renderForm(req, res, { record = null, values = {}, errors = {}, error = null } = {}) {
  res.render('generator/form', { title: record ? 'Edit generator session' : 'New generator session', record, values, errors, error,
    sites: access.accessibleSites(req.user, { activeOnly: true }), generators: generatorOptions(req.user).filter((g) => g.is_active) });
}

router.get('/new', (req, res) => {
  const sites = res.locals.userSites.filter((s) => s.is_active);
  renderForm(req, res, { values: { site_id: req.query.site || (sites.length === 1 ? sites[0].id : ''), generator_id: req.query.generator || '', start_at: time.nowLocal(), operator_name: req.user.full_name } });
});

router.post('/', (req, res, next) => crud.tryForm(res, next, () => {
  const row = svc.create(req.user, req.body, web.ctx(req));
  web.flash(req, 'success', row.stop_at ? `Session saved: ${svc.runtimeHours(row)} h runtime.` : 'Session started — it is shown as running until stopped.');
  res.redirect(`/generator/${row.id}`);
}, (e) => renderForm(req, res, { values: req.body, ...e })));

function load(req) {
  const rec = svc.get(Number(req.params.id));
  if (!rec) throw notFound();
  access.assertSiteAccess(req.user, rec.site_id);
  const g = db().prepare('SELECT g.name, s.name AS site_name FROM generators g JOIN sites s ON s.id = g.site_id WHERE g.id = ?').get(rec.generator_id);
  rec.generator_name = g.name;
  rec.site_name = g.site_name;
  rec.runtime_hours = svc.runtimeHours(rec);
  rec.allocation = [...time.splitByDate(rec.start_at, rec.stop_at)].map(([date, h]) => ({ date, hours: Math.round(h * 100) / 100 }));
  return rec;
}

const lockDates = (r) => [r.start_at.slice(0, 10), r.stop_at ? r.stop_at.slice(0, 10) : null];

router.get('/:id', web.h((req, res) => {
  const rec = load(req);
  res.render('generator/show', { title: 'Generator session', rec, perms: crud.permissions(req.user, rec, lockDates(rec)), history: crud.history('generator_session', rec.id),
    createdBy: crud.userName(rec.created_by), updatedBy: crud.userName(rec.updated_by), errors: {}, error: null, nowLocal: time.nowLocal() });
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
    web.flash(req, 'success', 'Session updated.');
    res.redirect(`/generator/${rec.id}`);
  }, (e) => renderForm(req, res, { record: rec, values: { ...rec, ...req.body }, ...e }));
});

router.post('/:id/stop', (req, res, next) => {
  let rec;
  try { rec = load(req); } catch (e) { return next(e); }
  crud.tryForm(res, next, () => {
    const row = svc.stop(req.user, rec.id, req.body, web.ctx(req));
    web.flash(req, 'success', `Session stopped: ${svc.runtimeHours(row)} h runtime.`);
    res.redirect(`/generator/${rec.id}`);
  }, (e) => res.render('generator/show', { title: 'Generator session', rec, perms: crud.permissions(req.user, rec, lockDates(rec)), history: crud.history('generator_session', rec.id),
    createdBy: crud.userName(rec.created_by), updatedBy: crud.userName(rec.updated_by), nowLocal: time.nowLocal(), ...e }));
});

router.post('/:id/delete', web.h((req, res) => {
  const rec = load(req);
  svc.remove(req.user, rec.id, web.ctx(req));
  web.flash(req, 'success', 'Session deleted.');
  res.redirect('/generator');
}));

module.exports = router;
