'use strict';
const { db, tx, nowIso, getSetting } = require('../db');
const { ValidationError, notFound, HttpError } = require('../lib/errors');
const access = require('../lib/access');
const { audit } = require('../lib/audit');
const { parse } = require('../lib/validate');
const time = require('../lib/time');
const attachments = require('./attachments');

const UNITS = ['days', 'weeks', 'months'];

function nextDate(fromDate, value, unit) {
  if (unit === 'days') return time.addDays(fromDate, value);
  if (unit === 'weeks') return time.addDays(fromDate, value * 7);
  return time.addMonths(fromDate, value);
}

function dueWindowDays() {
  return Number(getSetting('maintenance_due_window_days')) || 7;
}

/** Status is derived at read time so it never goes stale. */
function displayStatus(task, today = time.today(), window = dueWindowDays()) {
  if (task.status === 'completed') return 'Completed';
  if (task.scheduled_date < today) return 'Overdue';
  if (task.scheduled_date <= time.addDays(today, window)) return 'Due';
  return 'Scheduled';
}

function frequencyLabel(item) {
  const v = item.frequency_value;
  const unit = v === 1 ? item.frequency_unit.replace(/s$/, '') : item.frequency_unit;
  return `Every ${v} ${unit}`;
}

function getItem(id) {
  return db().prepare('SELECT i.*, s.name AS site_name FROM maintenance_items i JOIN sites s ON s.id = i.site_id WHERE i.id = ?').get(id);
}

function getTask(id) {
  return db().prepare(`SELECT t.*, i.name AS item_name, i.category, i.frequency_value, i.frequency_unit, s.name AS site_name
    FROM maintenance_tasks t JOIN maintenance_items i ON i.id = t.item_id JOIN sites s ON s.id = t.site_id
    WHERE t.id = ? AND t.deleted_at IS NULL`).get(id);
}

function parseItem(body, editing) {
  const p = parse(body);
  const input = {
    site_id: editing ? null : p.id('site_id', { label: 'Project site' }),
    name: p.str('name', { required: true, max: 150, label: 'Duct / equipment / area' }),
    category: p.str('category', { max: 80, label: 'Category' }) || 'Duct cleaning',
    frequency_value: p.num('frequency_value', { required: true, min: 1, max: 365, integer: true, label: 'Frequency' }),
    frequency_unit: p.oneOf('frequency_unit', UNITS, { label: 'Frequency unit' }),
    assigned_to: p.str('assigned_to', { max: 150, label: 'Assigned person / vendor' }),
    remarks: p.str('remarks', { max: 1000, label: 'Remarks' }),
    is_active: editing ? p.bool('is_active') : 1,
    last_completed_date: editing ? null : p.date('last_completed_date', { required: false, label: 'Last completed date', notFuture: true }),
    first_scheduled_date: editing ? null : p.date('first_scheduled_date', { required: false, label: 'Next scheduled date' }),
  };
  p.done();
  return input;
}

/** Admin: create a maintenance item and its first scheduled task. */
function createItem(user, body, ctx = {}) {
  access.assertAdmin(user);
  const input = parseItem(body, false);
  access.assertSiteAccess(user, input.site_id);
  return tx((d) => {
    const ts = nowIso();
    const { lastInsertRowid: itemId } = d.prepare(`INSERT INTO maintenance_items (site_id, name, category, frequency_value, frequency_unit, assigned_to, remarks, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.site_id, input.name, input.category, input.frequency_value, input.frequency_unit,
      input.assigned_to, input.remarks, user.id, ts, ts);
    const computed = input.last_completed_date ? nextDate(input.last_completed_date, input.frequency_value, input.frequency_unit) : time.today();
    const scheduled = input.first_scheduled_date || computed;
    d.prepare(`INSERT INTO maintenance_tasks (item_id, site_id, last_completed_date, scheduled_date, schedule_overridden, assigned_to, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(itemId, input.site_id, input.last_completed_date, scheduled,
      input.first_scheduled_date && input.first_scheduled_date !== computed ? 1 : 0, input.assigned_to, user.id, ts, user.id, ts);
    const item = getItem(itemId);
    audit({ entityType: 'maintenance_item', entityId: Number(itemId), siteId: input.site_id, action: 'create', user, after: item, ip: ctx.ip });
    return item;
  });
}

function updateItem(user, id, body, ctx = {}) {
  access.assertAdmin(user);
  const before = getItem(id);
  if (!before) throw notFound();
  const input = parseItem(body, true);
  db().prepare(`UPDATE maintenance_items SET name = ?, category = ?, frequency_value = ?, frequency_unit = ?, assigned_to = ?, remarks = ?, is_active = ?, updated_at = ? WHERE id = ?`)
    .run(input.name, input.category, input.frequency_value, input.frequency_unit, input.assigned_to, input.remarks, input.is_active, nowIso(), id);
  const after = getItem(id);
  audit({ entityType: 'maintenance_item', entityId: id, siteId: before.site_id, action: 'update', user, before, after, ip: ctx.ip });
  return after;
}

/**
 * Mark a task completed and create the next scheduled task.
 * Users (for their sites) and admins may complete; only admins may override the next date.
 */
function complete(user, taskId, body, file, ctx = {}) {
  const task = getTask(taskId);
  if (!task) throw notFound();
  access.assertSiteAccess(user, task.site_id);
  if (task.status === 'completed') throw new HttpError(409, 'This task is already completed.');
  const p = parse(body);
  const input = {
    completion_date: p.date('completion_date', { label: 'Completion date', notFuture: true }),
    completed_by_name: p.str('completed_by_name', { required: true, max: 150, label: 'Completed by (person / vendor)' }),
    remarks: p.str('remarks', { max: 1000, label: 'Remarks' }),
    next_date_override: p.date('next_date_override', { required: false, label: 'Next scheduled date' }),
  };
  p.done();
  if (input.next_date_override && !access.isAdmin(user)) throw new HttpError(403, 'Only an admin can override the next scheduled date.');
  if (input.next_date_override && input.next_date_override <= input.completion_date) {
    throw new ValidationError('Next date must be after the completion date.', { next_date_override: 'Next date must be after the completion date.' });
  }
  access.assertUnlocked(task.site_id, input.completion_date);
  return tx((d) => {
    const ts = nowIso();
    const item = getItem(task.item_id);
    d.prepare(`UPDATE maintenance_tasks SET status = 'completed', completion_date = ?, completed_by_name = ?, remarks = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
      .run(input.completion_date, input.completed_by_name, input.remarks, user.id, ts, taskId);
    if (file) attachments.save(file, { ownerType: 'maintenance_task', ownerId: taskId, siteId: task.site_id, user });
    let nextId = null;
    if (item.is_active) {
      const computed = nextDate(input.completion_date, item.frequency_value, item.frequency_unit);
      const scheduled = input.next_date_override || computed;
      nextId = d.prepare(`INSERT INTO maintenance_tasks (item_id, site_id, last_completed_date, scheduled_date, schedule_overridden, assigned_to, created_by, created_at, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.id, task.site_id, input.completion_date, scheduled, scheduled !== computed ? 1 : 0,
        item.assigned_to, user.id, ts, user.id, ts).lastInsertRowid;
    }
    const after = getTask(taskId);
    audit({ entityType: 'maintenance_task', entityId: taskId, siteId: task.site_id, action: 'complete', user, before: task, after, ip: ctx.ip });
    return { task: after, nextTaskId: nextId ? Number(nextId) : null };
  });
}

/** Admin override of an open task's scheduled date (or assignee). */
function reschedule(user, taskId, body, ctx = {}) {
  access.assertAdmin(user);
  const task = getTask(taskId);
  if (!task) throw notFound();
  if (task.status === 'completed') throw new HttpError(409, 'Completed tasks cannot be rescheduled.');
  const p = parse(body);
  const scheduled = p.date('scheduled_date', { label: 'Scheduled date' });
  const assigned = p.str('assigned_to', { max: 150, label: 'Assigned person / vendor' });
  const reason = p.str('reason', { required: true, max: 500, label: 'Reason for change' });
  p.done();
  db().prepare('UPDATE maintenance_tasks SET scheduled_date = ?, schedule_overridden = 1, assigned_to = ?, updated_by = ?, updated_at = ? WHERE id = ?')
    .run(scheduled, assigned, user.id, nowIso(), taskId);
  const after = getTask(taskId);
  audit({ entityType: 'maintenance_task', entityId: taskId, siteId: task.site_id, action: 'reschedule', user, before: task, after, reason, ip: ctx.ip });
  return after;
}

function removeTask(user, taskId, ctx = {}) {
  access.assertAdmin(user);
  const task = getTask(taskId);
  if (!task) throw notFound();
  db().prepare('UPDATE maintenance_tasks SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowIso(), user.id, taskId);
  audit({ entityType: 'maintenance_task', entityId: taskId, siteId: task.site_id, action: 'delete', user, before: task, ip: ctx.ip });
}

/** Task list with derived status. filter.status: open|completed|Overdue|Due|Scheduled|all */
function listTasks(siteIds, { status = 'open', from = null, to = null, itemId = null, limit = 500 } = {}) {
  if (!siteIds.length) return [];
  const site = access.inClause('t.site_id', siteIds);
  const where = [site.sql, 't.deleted_at IS NULL', 'i.is_active = 1 OR t.status = \'completed\''];
  const params = [...site.params];
  if (status === 'completed') where.push("t.status = 'completed'");
  else if (status !== 'all') where.push("t.status = 'open'");
  if (from && status === 'completed') { where.push('t.completion_date >= ?'); params.push(from); }
  if (to && status === 'completed') { where.push('t.completion_date <= ?'); params.push(to); }
  if (itemId) { where.push('t.item_id = ?'); params.push(itemId); }
  const rows = db().prepare(`SELECT t.*, i.name AS item_name, i.category, i.frequency_value, i.frequency_unit, s.name AS site_name
    FROM maintenance_tasks t JOIN maintenance_items i ON i.id = t.item_id JOIN sites s ON s.id = t.site_id
    WHERE ${where.map((w) => `(${w})`).join(' AND ')}
    ORDER BY CASE WHEN t.status = 'open' THEN t.scheduled_date END ASC, t.completion_date DESC LIMIT ?`).all(...params, limit);
  const today = time.today();
  const win = dueWindowDays();
  for (const r of rows) {
    r.display_status = displayStatus(r, today, win);
    r.frequency_label = frequencyLabel(r);
  }
  if (['Overdue', 'Due', 'Scheduled'].includes(status)) return rows.filter((r) => r.display_status === status);
  return rows;
}

function listItems(siteIds) {
  if (!siteIds.length) return [];
  const site = access.inClause('i.site_id', siteIds);
  const rows = db().prepare(`SELECT i.*, s.name AS site_name,
      (SELECT MAX(completion_date) FROM maintenance_tasks t WHERE t.item_id = i.id AND t.status = 'completed' AND t.deleted_at IS NULL) AS last_done
    FROM maintenance_items i JOIN sites s ON s.id = i.site_id WHERE ${site.sql} ORDER BY s.name, i.name`).all(...site.params);
  for (const r of rows) r.frequency_label = frequencyLabel(r);
  return rows;
}

module.exports = { nextDate, displayStatus, dueWindowDays, frequencyLabel, getItem, getTask, createItem, updateItem, complete, reschedule, removeTask, listTasks, listItems };
