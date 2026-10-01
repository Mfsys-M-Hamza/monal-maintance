'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, time, makeUser, sites, equip } = require('./helpers');
const electricity = require('../src/services/electricity');
const lpg = require('../src/services/lpg');
const diesel = require('../src/services/diesel');
const generator = require('../src/services/generator');
const maintenance = require('../src/services/maintenance');
const bills = require('../src/services/bills');
const adminSvc = require('../src/services/admin');
const metrics = require('../src/services/metrics');

const admin = makeUser('admin');
const [s1, s2, s3] = sites();
const today = time.today();
const d = (n) => time.addDays(today, -n);

const rejects = (fn, re) => assert.throws(fn, (e) => { assert.match(e.message + JSON.stringify(e.fields || {}), re); return true; });

test('electricity: consumption = current − previous, previous auto-populated', () => {
  const { meter } = equip(admin, s1.id, { initialReading: 1000 });
  const r1 = electricity.create(admin, { site_id: s1.id, meter_id: meter.id, record_date: d(10), current_reading: '1120.5', recorded_by: 'A' });
  assert.equal(r1.previous_reading, 1000);
  assert.equal(r1.consumption_kwh, 120.5);
  const r2 = electricity.create(admin, { site_id: s1.id, meter_id: meter.id, record_date: d(9), current_reading: '1200', recorded_by: 'A' });
  assert.equal(r2.previous_reading, 1120.5);
  assert.equal(r2.consumption_kwh, 79.5);

  // Zero consumption is valid (and distinct from a missing entry)
  const r3 = electricity.create(admin, { site_id: s1.id, meter_id: meter.id, record_date: d(8), current_reading: '1200', recorded_by: 'A' });
  assert.equal(r3.consumption_kwh, 0);

  // Duplicate meter + date rejected
  rejects(() => electricity.create(admin, { site_id: s1.id, meter_id: meter.id, record_date: d(9), current_reading: '1300', recorded_by: 'A' }), /already exists/);
  // Lower than previous rejected (negative consumption)
  rejects(() => electricity.create(admin, { site_id: s1.id, meter_id: meter.id, record_date: d(7), current_reading: '1100', recorded_by: 'A' }), /lower than the previous/);
  // Future date rejected
  rejects(() => electricity.create(admin, { site_id: s1.id, meter_id: meter.id, record_date: time.addDays(today, 2), current_reading: '1300', recorded_by: 'A' }), /future/);
  // Non-numeric rejected
  rejects(() => electricity.create(admin, { site_id: s1.id, meter_id: meter.id, record_date: d(6), current_reading: 'abc', recorded_by: 'A' }), /must be a number/);
  // Meter from another site rejected
  rejects(() => electricity.create(admin, { site_id: s2.id, meter_id: meter.id, record_date: d(6), current_reading: '1300', recorded_by: 'A' }), /meter/i);
});

test('electricity: backdated entry, edit and delete keep the chain consistent', () => {
  const { meter } = equip(admin, s1.id, { initialReading: 0 });
  electricity.create(admin, { site_id: s1.id, meter_id: meter.id, record_date: d(10), current_reading: '100', recorded_by: 'A' });
  const late = electricity.create(admin, { site_id: s1.id, meter_id: meter.id, record_date: d(8), current_reading: '300', recorded_by: 'A' });
  assert.equal(late.consumption_kwh, 200);
  // Insert the missing day in between: later record must be recalculated
  electricity.create(admin, { site_id: s1.id, meter_id: meter.id, record_date: d(9), current_reading: '180', recorded_by: 'A' });
  const recalced = dbm.db().prepare('SELECT * FROM electricity_readings WHERE id = ?').get(late.id);
  assert.equal(recalced.previous_reading, 180);
  assert.equal(recalced.consumption_kwh, 120);
  // An edit that would make a later reading negative is rejected
  const mid = dbm.db().prepare('SELECT id FROM electricity_readings WHERE meter_id = ? AND record_date = ?').get(meter.id, d(9));
  rejects(() => electricity.update(admin, mid.id, { record_date: d(9), current_reading: '350', recorded_by: 'A' }), /lower than its previous/);
  // Soft delete → later reading uses the earlier one again; total for the meter is unchanged
  electricity.remove(admin, mid.id);
  const after = dbm.db().prepare('SELECT * FROM electricity_readings WHERE id = ?').get(late.id);
  assert.equal(after.previous_reading, 100);
  assert.equal(after.consumption_kwh, 200);
  const total = metrics.electricity([s1.id], d(10), d(8), { meterId: meter.id }).totalKwh;
  assert.equal(total, 300);
});

test('electricity: meter replacement event sets a new baseline and credits old-meter usage', () => {
  const { meter } = equip(admin, s2.id, { initialReading: 5000 });
  electricity.create(admin, { site_id: s2.id, meter_id: meter.id, record_date: d(5), current_reading: '5100', recorded_by: 'A' });
  // Non-admins cannot record events
  const u = makeUser('user', [s2.id]);
  assert.throws(() => electricity.createEvent(u, meter.id, { event_type: 'replacement', event_date: d(4), new_start_reading: '0', reason: 'x' }), /permission/);
  electricity.createEvent(admin, meter.id, { event_type: 'replacement', event_date: d(4), old_final_reading: '5130', new_start_reading: '0', reason: 'Meter burnt', new_serial_no: 'NEW-1' });
  const r = electricity.create(admin, { site_id: s2.id, meter_id: meter.id, record_date: d(4), current_reading: '20', recorded_by: 'A' });
  assert.equal(r.previous_reading, 0);
  assert.equal(r.pre_event_kwh, 30);
  assert.equal(r.consumption_kwh, 50);
  const next = electricity.create(admin, { site_id: s2.id, meter_id: meter.id, record_date: d(3), current_reading: '45', recorded_by: 'A' });
  assert.equal(next.consumption_kwh, 25);
  // Audit trail captured the event
  assert.ok(dbm.db().prepare("SELECT 1 FROM audit_log WHERE entity_type = 'meter_event' AND action = 'create'").get());
});

test('LPG: consumed = opening + received − closing, carry-forward, invalid balances', () => {
  const r1 = lpg.create(admin, { site_id: s1.id, record_date: d(5), opening: '200', received: '0', closing: '150', recorded_by: 'A' });
  assert.equal(r1.consumed, 50);
  assert.equal(r1.unit, 'kg');
  // Opening omitted → previous closing carried forward
  const r2 = lpg.create(admin, { site_id: s1.id, record_date: d(4), received: '100', closing: '210', recorded_by: 'A' });
  assert.equal(r2.opening_stock, 150);
  assert.equal(r2.consumed, 40);
  // Closing greater than opening + received → invalid
  rejects(() => lpg.create(admin, { site_id: s1.id, record_date: d(3), received: '0', closing: '500', recorded_by: 'A' }), /Invalid stock balance/);
  // Opening differs from previous closing → must explain in remarks, then flagged
  rejects(() => lpg.create(admin, { site_id: s1.id, record_date: d(3), opening: '200', closing: '180', recorded_by: 'A' }), /Remarks/);
  const r3 = lpg.create(admin, { site_id: s1.id, record_date: d(3), opening: '200', closing: '180', recorded_by: 'A', remarks: 'Recount' });
  assert.equal(r3.opening_mismatch, 1);
  // Duplicate
  rejects(() => lpg.create(admin, { site_id: s1.id, record_date: d(3), opening: '180', closing: '170', recorded_by: 'A' }), /already exists/);
  // First record without previous requires opening
  rejects(() => lpg.create(admin, { site_id: s3.id, record_date: d(3), closing: '10', recorded_by: 'A' }), /Opening stock is required/);
});

test('LPG: cylinder units are never combined with kilograms', () => {
  adminSvc.saveSite(admin, s3.id, { name: s3.name, is_active: '1', req_lpg: '1', lpg_unit: 'cylinder', lpg_cylinder_kg: '45.4' });
  const c = lpg.create(admin, { site_id: s3.id, record_date: d(2), opening: '10', received: '0', closing: '8', recorded_by: 'A' });
  assert.equal(c.unit, 'cylinder');
  assert.equal(c.consumed, 2);
  const m = metrics.lpg([s1.id, s3.id], d(10), today);
  assert.equal(m.cylinders, 2);
  assert.equal(m.kg, 50 + 40 + 20); // only kg-based records
  assert.equal(m.kgFromCylinders, 90.8);
  assert.equal(m.totalKg, 200.8);
});

test('generator: sessions spanning midnight are split by date; overlaps prevented', () => {
  const { gen1 } = equip(admin, s2.id);
  const day = d(6), next = d(5);
  const s = generator.create(admin, { site_id: s2.id, generator_id: gen1.id, start_at: `${day}T22:30`, stop_at: `${next}T02:00`, reason: 'Load-shedding', operator_name: 'Op' });
  assert.equal(generator.runtimeHours(s), 3.5);
  const split = time.splitByDate(s.start_at, s.stop_at);
  assert.equal(split.get(day), 1.5);
  assert.equal(split.get(next), 2);
  const m = metrics.generators([s2.id], day, day);
  assert.equal(m.hours, 1.5);
  assert.equal(metrics.generators([s2.id], next, next).hours, 2);
  assert.equal(metrics.generators([s2.id], day, next).hours, 3.5);
  // Overlap with existing session rejected
  rejects(() => generator.create(admin, { site_id: s2.id, generator_id: gen1.id, start_at: `${next}T01:00`, stop_at: `${next}T03:00`, reason: 'x', operator_name: 'Op' }), /overlaps/);
  // Back-to-back is fine
  generator.create(admin, { site_id: s2.id, generator_id: gen1.id, start_at: `${next}T02:00`, stop_at: `${next}T03:00`, reason: 'x', operator_name: 'Op' });
  // Stop before start rejected
  rejects(() => generator.create(admin, { site_id: s2.id, generator_id: gen1.id, start_at: `${d(4)}T10:00`, stop_at: `${d(4)}T09:00`, reason: 'x', operator_name: 'Op' }), /after the start/);
  // Running session: only one at a time, and it can be stopped
  const run = generator.create(admin, { site_id: s2.id, generator_id: gen1.id, start_at: `${d(1)}T08:00`, reason: 'Outage', operator_name: 'Op' });
  assert.equal(run.stop_at, null);
  rejects(() => generator.create(admin, { site_id: s2.id, generator_id: gen1.id, start_at: `${d(1)}T09:00`, reason: 'x', operator_name: 'Op' }), /running session|overlaps/);
  const stopped = generator.stop(admin, run.id, { stop_at: `${d(1)}T10:15` });
  assert.equal(generator.runtimeHours(stopped), 2.25);
});

test('diesel: per-hour figures, N/A for zero runtime, shared tank counted once', () => {
  const { tank, gen1, gen2 } = equip(admin, s3.id, { shared: true });
  const day = d(12);
  generator.create(admin, { site_id: s3.id, generator_id: gen1.id, start_at: `${day}T08:00`, stop_at: `${day}T12:00`, reason: 'x', operator_name: 'Op' });
  generator.create(admin, { site_id: s3.id, generator_id: gen2.id, start_at: `${day}T09:00`, stop_at: `${day}T10:00`, reason: 'x', operator_name: 'Op' });
  diesel.create(admin, { site_id: s3.id, tank_id: tank.id, record_date: day, opening: '500', received: '0', closing: '400', recorded_by: 'A' });
  diesel.create(admin, { site_id: s3.id, tank_id: tank.id, record_date: d(11), received: '0', closing: '400', recorded_by: 'A' });
  const m = metrics.diesel([s3.id], day, day);
  assert.equal(m.litres, 100); // one shared-tank record, not one per generator
  assert.equal(m.records[0].runtime_hours, 5); // combined runtime of both generators
  assert.equal(m.records[0].l_per_hour, 20);
  const z = metrics.diesel([s3.id], d(11), d(11));
  assert.equal(z.records[0].consumed_l, 0);
  assert.equal(z.records[0].l_per_hour, null); // rendered "N/A"
  assert.equal(z.perHour, null);
  // A generator cannot be attached to someone else's individual tank
  const other = equip(admin, s3.id);
  assert.throws(() => adminSvc.saveGenerator(admin, null, { site_id: String(s3.id), name: 'Intruder', tank_id: String(other.tank.id) }), /already feeds/);
});

test('maintenance: next date from frequency, history preserved, admin override, month-end clamp', () => {
  const item = maintenance.createItem(admin, { site_id: s1.id, name: 'Kitchen hood duct', frequency_value: '1', frequency_unit: 'months', last_completed_date: '2026-01-31' });
  let task = dbm.db().prepare("SELECT * FROM maintenance_tasks WHERE item_id = ? AND status = 'open'").get(item.id);
  assert.equal(task.scheduled_date, '2026-02-28'); // Jan 31 + 1 month clamps to Feb 28
  assert.equal(maintenance.displayStatus(task, '2026-03-05'), 'Overdue');
  assert.equal(maintenance.displayStatus(task, '2026-02-25', 7), 'Due');
  assert.equal(maintenance.displayStatus(task, '2026-02-01', 7), 'Scheduled');

  const u = makeUser('user', [s1.id]);
  // Users may complete but not override the next date
  assert.throws(() => maintenance.complete(u, task.id, { completion_date: d(3), completed_by_name: 'Vendor', next_date_override: today }), /Only an admin/);
  const r = maintenance.complete(u, task.id, { completion_date: d(3), completed_by_name: 'Vendor' });
  const nextTask = maintenance.getTask(r.nextTaskId);
  assert.equal(nextTask.scheduled_date, time.addMonths(d(3), 1));
  assert.equal(nextTask.last_completed_date, d(3));
  assert.equal(maintenance.getTask(task.id).status, 'completed'); // history kept
  // Admin override on completion
  const r2 = maintenance.complete(admin, nextTask.id, { completion_date: d(1), completed_by_name: 'Vendor', next_date_override: time.addDays(today, 10) });
  const t3 = maintenance.getTask(r2.nextTaskId);
  assert.equal(t3.scheduled_date, time.addDays(today, 10));
  assert.equal(t3.schedule_overridden, 1);
  assert.equal(maintenance.listTasks([s1.id], { status: 'all', itemId: item.id }).length, 3);
  // Completing twice is rejected
  assert.throws(() => maintenance.complete(admin, task.id, { completion_date: d(1), completed_by_name: 'V' }), /already completed/);
});

test('bills: payment status, outstanding balance, duplicates and comparison', () => {
  const { meter } = equip(admin, s2.id, { initialReading: 0, initialDate: '2026-05-01' });
  const base = { site_id: s2.id, meter_id: meter.id, billing_month: '2026-06', period_start: '2026-06-01', period_end: '2026-06-30', billed_units: '300', amount_pkr: '15000' };
  const b = bills.create(admin, { ...base }, null);
  assert.equal(b.payment_status, 'Unpaid');
  assert.equal(b.outstanding, 15000);
  const p = bills.update(admin, b.id, { ...base, amount_paid: '6000', payment_date: '2026-07-10' }, null);
  assert.equal(p.payment_status, 'Partially Paid');
  assert.equal(p.outstanding, 9000);
  const f = bills.update(admin, b.id, { ...base, amount_paid: '15000', payment_date: '2026-07-12' }, null);
  assert.equal(f.payment_status, 'Paid');
  assert.equal(f.outstanding, 0);
  rejects(() => bills.update(admin, b.id, { ...base, amount_paid: '16000', payment_date: '2026-07-12' }, null), /cannot exceed/);
  rejects(() => bills.update(admin, b.id, { ...base, amount_paid: '100' }, null), /Payment date is required/);
  rejects(() => bills.create(admin, { ...base }, null), /already exists/);
  rejects(() => bills.create(admin, { ...base, billing_month: '2026-07', period_start: '2026-06-15', period_end: '2026-07-14' }, null), /overlaps/);
  assert.equal(f.category, 'site');

  // Comparison: incomplete without boundary readings, comparable with both
  assert.equal(bills.compare(f).status, 'No data');
  electricity.create(admin, { site_id: s2.id, meter_id: meter.id, record_date: '2026-06-01', current_reading: '100', recorded_by: 'A' });
  electricity.create(admin, { site_id: s2.id, meter_id: meter.id, record_date: '2026-06-15', current_reading: '250', recorded_by: 'A' });
  let c = bills.compare(f);
  assert.equal(c.comparable, false);
  assert.match(c.issues.join(' '), /period end/);
  electricity.create(admin, { site_id: s2.id, meter_id: meter.id, record_date: '2026-06-30', current_reading: '390', recorded_by: 'A' });
  c = bills.compare(f);
  assert.equal(c.comparable, true);
  assert.equal(c.recorded_kwh, 290);
  assert.equal(c.variance_kwh, 10);
});

test('period locks block create, edit and delete for everyone', () => {
  const { meter } = equip(admin, s1.id, { initialReading: 0, initialDate: '2026-04-01' });
  const r = electricity.create(admin, { site_id: s1.id, meter_id: meter.id, record_date: '2026-04-10', current_reading: '50', recorded_by: 'A' });
  adminSvc.lockPeriod(admin, { month: '2026-04', site_id: String(s1.id) });
  assert.throws(() => electricity.create(admin, { site_id: s1.id, meter_id: meter.id, record_date: '2026-04-11', current_reading: '60', recorded_by: 'A' }), /locked/);
  assert.throws(() => electricity.update(admin, r.id, { record_date: '2026-04-10', current_reading: '55', recorded_by: 'A' }), /locked/);
  assert.throws(() => electricity.remove(admin, r.id), /locked/);
  // Unlocked months still work; an edit that would ripple into a locked month is blocked
  assert.throws(() => adminSvc.lockPeriod(admin, { month: time.monthOf(today) }), /completed months/);
});
