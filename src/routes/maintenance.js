'use strict';
const express = require('express');
const access = require('../lib/access');
const web = require('../lib/web');
const crud = require('../lib/crud');
const svc = require('../services/maintenance');
const attachments = require('../services/attachments');
const { notFound } = require('../lib/errors');

const router = express.Router();
router.param('id', web.numericParam);

router.get('/', web.h((req, res) => {
  const site = req.query.site || 'all';
  const siteIds = access.scopeSiteIds(req.user, site);
  const tab = ['open', 'Overdue', 'Due', 'Scheduled', 'completed'].includes(req.query.status) ? req.query.status : 'open';
  const all = svc.listTasks(siteIds, { status: 'open' });
  const counts = { open: all.length, Overdue: 0, Due: 0, Scheduled: 0 };
  for (const t of all) counts[t.display_status]++;
  const rows = tab === 'open' ? all : tab === 'completed' ? svc.listTasks(siteIds, { status: 'completed', limit: 200 }) : all.filter((t) => t.display_status === tab);
  res.render('maintenance/index', { title: 'Duct cleaning & maintenance', rows, tab, counts, f: { site }, dueWindow: svc.dueWindowDays() });
}));

function loadTask(req) {
  const t = svc.getTask(Number(req.params.id));
  if (!t) throw notFound();
  access.assertSiteAccess(req.user, t.site_id);
  t.display_status = svc.displayStatus(t);
  t.frequency_label = svc.frequencyLabel(t);
  return t;
}

function renderTask(req, res, task, extra = {}) {
  const item = svc.getItem(task.item_id);
  const historyRows = svc.listTasks([task.site_id], { status: 'all', itemId: task.item_id });
  for (const h of historyRows) h.files = attachments.listFor('maintenance_task', h.id);
  res.render('maintenance/show', { title: task.item_name, task, item, historyRows, files: attachments.listFor('maintenance_task', task.id),
    audit: crud.history('maintenance_task', task.id), suggestedNext: svc.nextDate(res.locals.today, item.frequency_value, item.frequency_unit),
    errors: {}, error: null, values: { completion_date: res.locals.today, completed_by_name: task.assigned_to || '' }, ...extra });
}

router.get('/tasks/:id', web.h((req, res) => renderTask(req, res, loadTask(req))));

router.post('/tasks/:id/complete', web.singleFile('attachment'), (req, res, next) => {
  let task;
  try { task = loadTask(req); } catch (e) { return next(e); }
  crud.tryForm(res, next, () => {
    const r = svc.complete(req.user, task.id, req.body, req.file, web.ctx(req));
    web.flash(req, 'success', r.nextTaskId ? 'Task completed and the next cleaning has been scheduled.' : 'Task completed.');
    res.redirect(r.nextTaskId ? `/maintenance/tasks/${r.nextTaskId}` : `/maintenance/tasks/${task.id}`);
  }, (e) => renderTask(req, res, task, { values: req.body, ...e }));
});

router.post('/tasks/:id/reschedule', web.requireAdmin, (req, res, next) => {
  let task;
  try { task = loadTask(req); } catch (e) { return next(e); }
  crud.tryForm(res, next, () => {
    svc.reschedule(req.user, task.id, req.body, web.ctx(req));
    web.flash(req, 'success', 'Schedule updated.');
    res.redirect(`/maintenance/tasks/${task.id}`);
  }, (e) => renderTask(req, res, task, { rescheduleErrors: e.errors, error: e.error }));
});

router.post('/tasks/:id/delete', web.requireAdmin, web.h((req, res) => {
  const task = loadTask(req);
  svc.removeTask(req.user, task.id, web.ctx(req));
  web.flash(req, 'success', 'Task deleted.');
  res.redirect('/maintenance');
}));

// ---- Items (admin) ----

router.get('/items', web.requireAdmin, web.h((req, res) => {
  res.render('maintenance/items', { title: 'Maintenance items', items: svc.listItems(access.allowedSiteIds(req.user)) });
}));

function renderItemForm(req, res, { item = null, values = {}, errors = {}, error = null } = {}) {
  res.render('maintenance/item-form', { title: item ? 'Edit maintenance item' : 'New maintenance item', item, values, errors, error, sites: access.accessibleSites(req.user, { activeOnly: true }) });
}

router.get('/items/new', web.requireAdmin, (req, res) => renderItemForm(req, res, { values: { frequency_value: 1, frequency_unit: 'months', category: 'Duct cleaning', site_id: req.query.site || '' } }));

router.post('/items', web.requireAdmin, (req, res, next) => crud.tryForm(res, next, () => {
  svc.createItem(req.user, req.body, web.ctx(req));
  web.flash(req, 'success', 'Maintenance item created with its first scheduled task.');
  res.redirect('/maintenance/items');
}, (e) => renderItemForm(req, res, { values: req.body, ...e })));

router.get('/items/:id/edit', web.requireAdmin, web.h((req, res) => {
  const item = svc.getItem(Number(req.params.id));
  if (!item) throw notFound();
  renderItemForm(req, res, { item, values: item });
}));

router.post('/items/:id', web.requireAdmin, (req, res, next) => {
  const item = svc.getItem(Number(req.params.id));
  if (!item) return next(notFound());
  crud.tryForm(res, next, () => {
    svc.updateItem(req.user, item.id, req.body, web.ctx(req));
    web.flash(req, 'success', 'Maintenance item updated. Changes to frequency apply from the next completion.');
    res.redirect('/maintenance/items');
  }, (e) => renderItemForm(req, res, { item, values: { ...item, ...req.body }, ...e }));
});

module.exports = router;
