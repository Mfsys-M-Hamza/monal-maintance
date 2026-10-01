'use strict';
const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const web = require('../lib/web');
const crud = require('../lib/crud');
const time = require('../lib/time');
const { diff, audit } = require('../lib/audit');
const { notFound, ValidationError } = require('../lib/errors');
const adminSvc = require('../services/admin');
const electricity = require('../services/electricity');
const dieselSvc = require('../services/diesel');
const demo = require('../services/demo');

const router = express.Router();
router.param('id', web.numericParam);

const allSites = () => db().prepare('SELECT * FROM sites ORDER BY name').all();

router.get('/', (req, res) => res.redirect('/admin/users'));

/** Generic form handler for admin entities. */
function formPair({ view, title, load, save, redirect, extra = () => ({}) }) {
  const render = (req, res, entity, values, errors = {}, error = null) =>
    res.render(view, { title: entity ? `Edit ${title}` : `New ${title}`, entity, values, errors, error, sites: allSites(), ...extra(req, entity) });
  return {
    newForm: (req, res) => render(req, res, null, { ...req.query, is_active: 1, is_required: 1 }),
    editForm: web.h((req, res) => {
      const entity = load(Number(req.params.id));
      if (!entity) throw notFound();
      render(req, res, entity, entity);
    }),
    submit: (req, res, next) => {
      const id = req.params.id ? Number(req.params.id) : null;
      const entity = id ? load(id) : null;
      if (id && !entity) return next(notFound());
      crud.tryForm(res, next, () => {
        const saved = save(req.user, id, req.body, web.ctx(req));
        web.flash(req, 'success', `${title[0].toUpperCase() + title.slice(1)} saved.`);
        res.redirect(redirect(saved));
      }, (e) => render(req, res, entity, { ...(entity || {}), ...req.body }, e.errors, e.error));
    },
  };
}

function mount(path, pair) {
  router.get(`${path}/new`, pair.newForm);
  router.post(path, pair.submit);
  router.get(`${path}/:id/edit`, pair.editForm);
  router.post(`${path}/:id`, pair.submit);
}

// ---------------- Users ----------------

router.get('/users', (req, res) => res.render('admin/users', { title: 'Users', users: adminSvc.listUsers() }));

const userForm = formPair({
  view: 'admin/user-form', title: 'user',
  load: (id) => adminSvc.getUser(id),
  save: (u, id, body, ctx) => (id ? adminSvc.updateUser(u, id, body, ctx) : adminSvc.createUser(u, body, ctx)),
  redirect: () => '/admin/users',
});
mount('/users', userForm);

router.post('/users/:id/reset-password', (req, res, next) => {
  const u = adminSvc.getUser(Number(req.params.id));
  if (!u) return next(notFound());
  try {
    adminSvc.resetPassword(req.user, u.id, req.body, web.ctx(req));
    web.flash(req, 'success', `Temporary password set for ${u.username}. They must change it at next sign-in. Share it with them securely.`);
  } catch (e) {
    if (!(e instanceof ValidationError)) return next(e);
    web.flash(req, 'error', e.message);
  }
  res.redirect(`/admin/users/${u.id}/edit`);
});

// ---------------- Sites ----------------

router.get('/sites', (req, res) => {
  const counts = db().prepare(`SELECT s.id,
      (SELECT COUNT(*) FROM meters m WHERE m.site_id = s.id AND m.is_active = 1) AS meters,
      (SELECT COUNT(*) FROM generators g WHERE g.site_id = s.id AND g.is_active = 1) AS generators,
      (SELECT COUNT(*) FROM diesel_tanks t WHERE t.site_id = s.id AND t.is_active = 1) AS tanks,
      (SELECT COUNT(*) FROM user_sites us WHERE us.site_id = s.id) AS users FROM sites s`).all();
  res.render('admin/sites', { title: 'Project sites', sites: allSites(), counts: Object.fromEntries(counts.map((c) => [c.id, c])) });
});
mount('/sites', formPair({
  view: 'admin/site-form', title: 'site',
  load: (id) => db().prepare('SELECT * FROM sites WHERE id = ?').get(id),
  save: adminSvc.saveSite,
  redirect: () => '/admin/sites',
}));

// ---------------- Meters ----------------

router.get('/meters', (req, res) => {
  const site = /^\d+$/.test(req.query.site || '') ? Number(req.query.site) : null;
  const meters = db().prepare(`SELECT m.*, s.name AS site_name,
      (SELECT MAX(record_date) FROM electricity_readings r WHERE r.meter_id = m.id AND r.deleted_at IS NULL) AS last_reading_date
    FROM meters m JOIN sites s ON s.id = m.site_id ${site ? 'WHERE m.site_id = ?' : ''} ORDER BY s.name, m.location, m.name`).all(...(site ? [site] : []));
  res.render('admin/meters', { title: 'Meters', meters, site, sites: allSites() });
});
mount('/meters', formPair({
  view: 'admin/meter-form', title: 'meter',
  load: (id) => db().prepare('SELECT * FROM meters WHERE id = ?').get(id),
  save: adminSvc.saveMeter,
  redirect: (m) => `/admin/meters/${m.id}`,
}));

function renderMeter(req, res, meter, extra = {}) {
  const site = db().prepare('SELECT name FROM sites WHERE id = ?').get(meter.site_id);
  const last = db().prepare('SELECT * FROM electricity_readings WHERE meter_id = ? AND deleted_at IS NULL ORDER BY record_date DESC LIMIT 1').get(meter.id);
  res.render('admin/meter-show', { title: meter.name, meter, siteName: site.name, events: electricity.listEvents(meter.id), last,
    history: crud.history('meter', meter.id), values: { event_date: time.today(), event_type: 'replacement' }, errors: {}, error: null, ...extra });
}

router.get('/meters/:id', web.h((req, res) => {
  const meter = db().prepare('SELECT * FROM meters WHERE id = ?').get(Number(req.params.id));
  if (!meter) throw notFound();
  renderMeter(req, res, meter);
}));

router.post('/meters/:id/events', (req, res, next) => {
  const meter = db().prepare('SELECT * FROM meters WHERE id = ?').get(Number(req.params.id));
  if (!meter) return next(notFound());
  crud.tryForm(res, next, () => {
    electricity.createEvent(req.user, meter.id, req.body, web.ctx(req));
    web.flash(req, 'success', 'Meter event recorded. Readings after the event were recalculated from the new baseline.');
    res.redirect(`/admin/meters/${meter.id}`);
  }, (e) => renderMeter(req, res, meter, { values: req.body, ...e }));
});

router.post('/meter-events/:id/delete', web.h((req, res) => {
  const ev = db().prepare('SELECT meter_id FROM meter_events WHERE id = ?').get(Number(req.params.id));
  if (!ev) throw notFound();
  try {
    electricity.deleteEvent(req.user, Number(req.params.id), web.ctx(req));
    web.flash(req, 'success', 'Meter event removed and readings recalculated.');
  } catch (e) {
    if (!crud.isFormError(e)) throw e;
    web.flash(req, 'error', e.message);
  }
  res.redirect(`/admin/meters/${ev.meter_id}`);
}));

// ---------------- Generators & tanks ----------------

router.get('/equipment', (req, res) => {
  const tanks = dieselSvc.tanksWithGenerators(allSites().map((s) => s.id), { activeOnly: false });
  const generators = db().prepare(`SELECT g.*, s.name AS site_name, t.name AS tank_name, t.tank_type FROM generators g JOIN sites s ON s.id = g.site_id
    LEFT JOIN diesel_tanks t ON t.id = g.tank_id ORDER BY s.name, g.name`).all();
  res.render('admin/equipment', { title: 'Generators & diesel tanks', tanks, generators });
});
const tankList = () => db().prepare('SELECT t.*, s.name AS site_name FROM diesel_tanks t JOIN sites s ON s.id = t.site_id ORDER BY s.name, t.name').all();
mount('/generators', formPair({
  view: 'admin/generator-form', title: 'generator',
  load: (id) => db().prepare('SELECT * FROM generators WHERE id = ?').get(id),
  save: adminSvc.saveGenerator,
  redirect: () => '/admin/equipment',
  extra: () => ({ tanks: tankList() }),
}));
mount('/tanks', formPair({
  view: 'admin/tank-form', title: 'diesel tank',
  load: (id) => db().prepare('SELECT * FROM diesel_tanks WHERE id = ?').get(id),
  save: adminSvc.saveTank,
  redirect: () => '/admin/equipment',
}));

// ---------------- Period locks ----------------

router.get('/locks', (req, res) => res.render('admin/locks', { title: 'Period locks', locks: adminSvc.listLocks(), sites: allSites(), errors: {}, error: null,
  values: { month: time.addMonthsToMonth(time.monthOf(time.today()), -1) } }));
router.post('/locks', (req, res, next) => crud.tryForm(res, next, () => {
  adminSvc.lockPeriod(req.user, req.body, web.ctx(req));
  web.flash(req, 'success', 'Reporting period locked. Records in this period can no longer be created, edited or deleted.');
  res.redirect('/admin/locks');
}, (e) => res.render('admin/locks', { title: 'Period locks', locks: adminSvc.listLocks(), sites: allSites(), values: req.body, ...e })));
router.post('/locks/:id/delete', web.h((req, res) => {
  adminSvc.unlockPeriod(req.user, Number(req.params.id), web.ctx(req));
  web.flash(req, 'success', 'Period unlocked.');
  res.redirect('/admin/locks');
}));

// ---------------- Audit trail ----------------

router.get('/audit', web.h((req, res) => {
  const q = req.query;
  const where = ['1'];
  const params = [];
  if (q.entity) { where.push('a.entity_type = ?'); params.push(String(q.entity)); }
  if (q.action) { where.push('a.action = ?'); params.push(String(q.action)); }
  if (/^\d+$/.test(q.site || '')) { where.push('a.site_id = ?'); params.push(Number(q.site)); }
  if (/^\d+$/.test(q.entity_id || '')) { where.push('a.entity_id = ?'); params.push(Number(q.entity_id)); }
  if (q.user) { where.push('a.username LIKE ?'); params.push(`%${String(q.user).slice(0, 50)}%`); }
  if (time.isValidDate(q.from)) { where.push('a.created_at >= ?'); params.push(new Date(time.dateStartMs(q.from)).toISOString()); }
  if (time.isValidDate(q.to)) { where.push('a.created_at < ?'); params.push(new Date(time.dateStartMs(time.addDays(q.to, 1))).toISOString()); }
  const from = `FROM audit_log a LEFT JOIN sites s ON s.id = a.site_id WHERE ${where.join(' AND ')}`;
  const pg = crud.paginate(from, params, '', Number(q.page) || 1, 40);
  const rows = db().prepare(`SELECT a.*, s.name AS site_name ${from} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, pg.size, pg.offset)
    .map((a) => ({ ...a, changes: diff(a.before_json, a.after_json) }));
  const entities = db().prepare('SELECT DISTINCT entity_type FROM audit_log ORDER BY 1').all().map((r) => r.entity_type);
  res.render('admin/audit', { title: 'Audit trail', rows, pg, entities, sites: allSites(), f: q });
}));

// ---------------- Settings & demo data ----------------

router.get('/settings', (req, res) => res.render('admin/settings', { title: 'Settings & demo data', dueWindow: getSetting('maintenance_due_window_days'),
  demoSeeded: demo.isSeeded(), demoCounts: demo.demoCounts(), demoCredentials: null }));

router.post('/settings', web.h((req, res) => {
  const v = Number(req.body.maintenance_due_window_days);
  if (!Number.isInteger(v) || v < 0 || v > 90) {
    web.flash(req, 'error', 'Due window must be a whole number of days between 0 and 90.');
  } else {
    const before = getSetting('maintenance_due_window_days');
    setSetting('maintenance_due_window_days', v);
    audit({ entityType: 'setting', action: 'update', user: req.user, before: { maintenance_due_window_days: before }, after: { maintenance_due_window_days: String(v) }, ip: req.ip });
    web.flash(req, 'success', 'Settings saved.');
  }
  res.redirect('/admin/settings');
}));

router.post('/demo/seed', web.h((req, res) => {
  const r = demo.seed(req.user);
  res.render('admin/settings', { title: 'Settings & demo data', dueWindow: getSetting('maintenance_due_window_days'), demoSeeded: true, demoCounts: demo.demoCounts(),
    demoCredentials: r.demoUser, flash: [{ type: 'success', message: 'Demonstration data loaded. All demo rows are labelled DEMO and can be removed here.' }] });
}));

router.post('/demo/remove', web.h((req, res) => {
  try {
    demo.remove(req.user);
    web.flash(req, 'success', 'All demonstration data has been removed.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    web.flash(req, 'error', e.message);
  }
  res.redirect('/admin/settings');
}));

module.exports = router;
