'use strict';
// Demonstration data. Every demo row is flagged is_demo = 1 and can be removed in one step
// (Admin → Demo data, or `npm run demo:remove`). The seven project sites are real configuration
// and are never removed.
const crypto = require('node:crypto');
const { db, tx, nowIso, getSetting, setSetting } = require('../db');
const { hashPassword } = require('../lib/passwords');
const { audit } = require('../lib/audit');
const { round } = require('../lib/validate');
const time = require('../lib/time');
const attachments = require('./attachments');
const electricity = require('./electricity');
const { HttpError } = require('../lib/errors');

const DAYS = 75;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function isSeeded() {
  return !!getSetting('demo_seeded_at');
}

function demoCounts() {
  const d = db();
  const n = (t) => d.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE is_demo = 1`).get().n;
  return {
    users: n('users'), meters: n('meters'), generators: n('generators'), tanks: n('diesel_tanks'), electricity: n('electricity_readings'),
    lpg: n('lpg_records'), sessions: n('generator_sessions'), diesel: n('diesel_records'), maintenance: n('maintenance_tasks'), bills: n('bills'),
  };
}

/** Seed demo data. Returns { demoUser: {username, password} }. */
function seed(actor = null) {
  if (isSeeded()) throw new HttpError(409, 'Demo data is already loaded. Remove it first to reseed.');
  const rand = rng(20261001);
  const between = (a, b) => a + rand() * (b - a);
  const today = time.today();
  const start = time.addDays(today, -DAYS);
  const yesterday = time.addDays(today, -1);
  const ts = nowIso();
  const d = db();
  const sites = d.prepare('SELECT * FROM sites ORDER BY id').all();
  const by = actor ? actor.id : null;
  const demoPassword = 'Demo-' + crypto.randomBytes(6).toString('base64url') + '9';

  return tx(() => {
    // Demo user limited to two sites (password generated at seed time, shown once).
    const uid = Number(d.prepare(`INSERT INTO users (username, full_name, email, password_hash, role, is_demo, created_at, updated_at)
      VALUES ('demo.user', 'Demo Site Supervisor', NULL, ?, 'user', 1, ?, ?)`).run(hashPassword(demoPassword), ts, ts).lastInsertRowid);
    for (const s of sites.slice(0, 2)) d.prepare('INSERT INTO user_sites (user_id, site_id) VALUES (?, ?)').run(uid, s.id);

    const insMeter = d.prepare(`INSERT INTO meters (site_id, name, location, account_ref, serial_no, initial_reading, initial_date, is_demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
    const insReading = d.prepare(`INSERT INTO electricity_readings (site_id, meter_id, record_date, previous_reading, current_reading, consumption_kwh, recorded_by, remarks, is_demo, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
    const insTank = d.prepare(`INSERT INTO diesel_tanks (site_id, name, tank_type, capacity_l, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`);
    const insGen = d.prepare(`INSERT INTO generators (site_id, name, capacity_kva, tank_id, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`);
    const insSession = d.prepare(`INSERT INTO generator_sessions (site_id, generator_id, operating_date, start_at, stop_at, opening_hour_meter, closing_hour_meter, reason, operator_name, remarks, is_demo, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
    const insDiesel = d.prepare(`INSERT INTO diesel_records (site_id, tank_id, record_date, opening_l, received_l, closing_l, consumed_l, recorded_by, is_demo, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
    const insLpg = d.prepare(`INSERT INTO lpg_records (site_id, record_date, unit, cylinder_kg, opening_stock, received_stock, closing_stock, consumed, recorded_by, is_demo, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`);

    sites.forEach((site, si) => {
      const staff = ['Imran Khan', 'Bilal Ahmed', 'Usman Ali', 'Asad Mehmood', 'Hamza Tariq', 'Faisal Iqbal', 'Zeeshan Raza'][si % 7];
      const scale = 0.6 + si * 0.15;
      // A site using LPG cylinders (to demonstrate unit handling).
      if (si === 2) d.prepare("UPDATE sites SET lpg_unit = 'cylinder', lpg_cylinder_kg = 45.4 WHERE id = ?").run(site.id);
      const lpgUnit = si === 2 ? 'cylinder' : 'kg';

      // Meters: main site meter + accommodation meter (most sites)
      const meters = [];
      const m1 = Number(insMeter.run(site.id, 'Main Meter', 'site', `0412${si}0${1000 + si * 37}`, `SN-M${si}01`, round(between(20000, 90000), 0), start, ts, ts).lastInsertRowid);
      meters.push({ id: m1, base: 380 * scale });
      if (si !== 6) {
        const m2 = Number(insMeter.run(site.id, 'Staff Accommodation', 'accommodation', `0412${si}1${2000 + si * 41}`, `SN-A${si}01`, round(between(5000, 30000), 0), start, ts, ts).lastInsertRowid);
        meters.push({ id: m2, base: 95 * scale });
      }
      for (const m of meters) {
        let prev = d.prepare('SELECT initial_reading FROM meters WHERE id = ?').get(m.id).initial_reading;
        for (let i = 1; i <= DAYS; i++) {
          const date = time.addDays(start, i);
          if (date > yesterday && rand() < 0.5) continue; // some of today not yet entered
          if (rand() < 0.03) continue; // occasional missed day
          const kwh = round(m.base * between(0.75, 1.25) * (new Date(date).getUTCDay() === 0 ? 1.2 : 1), 1);
          const cur = round(prev + kwh, 1);
          insReading.run(site.id, m.id, date, prev, cur, round(cur - prev, 3), staff, null, by, ts, by, ts);
          prev = cur;
        }
        electricity.recalcChain(m.id);
      }

      // Diesel tanks & generators
      const gens = [];
      if (si === 0) {
        const shared = Number(insTank.run(site.id, 'Main Diesel Tank', 'shared', 2000, ts, ts).lastInsertRowid);
        gens.push({ id: Number(insGen.run(site.id, 'Generator 1 (500 kVA)', 500, shared, ts, ts).lastInsertRowid), tank: shared, rate: 55 });
        gens.push({ id: Number(insGen.run(site.id, 'Generator 2 (250 kVA)', 250, shared, ts, ts).lastInsertRowid), tank: shared, rate: 30 });
      } else {
        const tank = Number(insTank.run(site.id, 'Day Tank', 'individual', 1000, ts, ts).lastInsertRowid);
        gens.push({ id: Number(insGen.run(site.id, `Generator 1 (${150 + si * 25} kVA)`, 150 + si * 25, tank, ts, ts).lastInsertRowid), tank, rate: 18 + si * 3 });
      }
      // Generator sessions (load-shedding outages), some crossing midnight
      const tankRuntime = {};
      for (const g of gens) {
        let hm = round(between(1200, 5000), 1);
        for (let i = 1; i <= DAYS; i++) {
          const date = time.addDays(start, i);
          if (date > yesterday) break;
          const outages = rand() < 0.35 ? 0 : rand() < 0.6 ? 1 : 2;
          let earliest = 0;
          for (let k = 0; k < outages; k++) {
            const startMin = Math.max(earliest, Math.floor(between(k === 0 ? 6 * 60 : 15 * 60, k === 0 ? 13 * 60 : 22 * 60)));
            const dur = Math.floor(between(45, rand() < 0.15 ? 360 : 180));
            const s = `${date}T${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`;
            const endMs = time.localToMs(s) + dur * 60000;
            const e = time.nowLocal(new Date(endMs));
            if (e.slice(0, 10) > yesterday) continue;
            const hours = round(dur / 60, 2);
            insSession.run(site.id, g.id, date, s, e, hm, round(hm + hours, 1), rand() < 0.8 ? 'WAPDA load-shedding' : 'Grid voltage fluctuation', staff, null, by, ts, by, ts);
            hm = round(hm + hours, 1);
            for (const [dd, h] of time.splitByDate(s, e)) tankRuntime[`${g.tank}|${dd}`] = (tankRuntime[`${g.tank}|${dd}`] || 0) + h * g.rate / 1;
            earliest = startMin + dur + 30;
            if (earliest >= 23 * 60) break;
          }
        }
      }
      // Diesel daily records per tank (consumption follows runtime)
      for (const tankId of [...new Set(gens.map((g) => g.tank))]) {
        let stock = 800;
        for (let i = 1; i <= DAYS; i++) {
          const date = time.addDays(start, i);
          if (date > yesterday) break;
          if (rand() < 0.02) continue;
          const used = round((tankRuntime[`${tankId}|${date}`] || 0) * between(0.95, 1.05), 1);
          const received = stock - used < 300 ? 600 : 0;
          const closing = round(stock + received - used, 1);
          insDiesel.run(site.id, tankId, date, stock, received, closing, round(stock + received - closing, 3), staff, by, ts, by, ts);
          stock = closing;
        }
      }
      // LPG daily
      let lpgStock = lpgUnit === 'kg' ? 400 : 10;
      for (let i = 1; i <= DAYS; i++) {
        const date = time.addDays(start, i);
        if (date > yesterday && rand() < 0.6) continue;
        if (rand() < 0.03) continue;
        const used = lpgUnit === 'kg' ? round(between(25, 70) * scale, 1) : (rand() < 0.6 ? 1 : 2);
        const received = lpgStock - used < (lpgUnit === 'kg' ? 120 : 3) ? (lpgUnit === 'kg' ? 450 : 10) : 0;
        const closing = round(lpgStock + received - used, 1);
        insLpg.run(site.id, date, lpgUnit, lpgUnit === 'cylinder' ? 45.4 : null, lpgStock, received, closing, round(lpgStock + received - closing, 3), staff, by, ts, by, ts);
        lpgStock = closing;
      }

      // Maintenance items with history
      const items = [
        ['Kitchen exhaust hood & duct', 1, 'months', 'CleanAir Services'],
        ['AHU supply duct — dining hall', 3, 'months', 'CleanAir Services'],
        ['Tandoor area extraction duct', 2, 'weeks', 'In-house maintenance'],
      ];
      for (const [name, fv, fu, who] of items) {
        const itemId = Number(d.prepare(`INSERT INTO maintenance_items (site_id, name, category, frequency_value, frequency_unit, assigned_to, is_demo, created_by, created_at, updated_at)
          VALUES (?, ?, 'Duct cleaning', ?, ?, ?, 1, ?, ?, ?)`).run(site.id, name, fv, fu, who, by, ts, ts).lastInsertRowid);
        const nextOf = (dt) => (fu === 'weeks' ? time.addDays(dt, fv * 7) : time.addMonths(dt, fv));
        let last = time.addDays(start, -Math.floor(between(0, 20)));
        let sched = nextOf(last);
        while (sched < time.addDays(today, -(si % 3) * 6)) {
          const done = time.addDays(sched, Math.floor(between(-1, 3)));
          if (done > yesterday) break;
          d.prepare(`INSERT INTO maintenance_tasks (item_id, site_id, last_completed_date, scheduled_date, assigned_to, status, completion_date, completed_by_name, remarks, is_demo, created_by, created_at, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, 'Cleaned and inspected', 1, ?, ?, ?, ?)`).run(itemId, site.id, last, sched, who, done, who, by, ts, by, ts);
          last = done;
          sched = nextOf(done);
        }
        d.prepare(`INSERT INTO maintenance_tasks (item_id, site_id, last_completed_date, scheduled_date, assigned_to, is_demo, created_by, created_at, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(itemId, site.id, last, sched, who, by, ts, by, ts);
      }

      // Bills for the last two complete months, per meter
      for (const m of meters) {
        const meter = d.prepare('SELECT * FROM meters WHERE id = ?').get(m.id);
        for (const back of [2, 1]) {
          const month = time.addMonthsToMonth(time.monthOf(today), -back);
          const ps = time.monthStart(month) < start ? time.addDays(start, 1) : time.monthStart(month);
          const pe = time.monthEnd(month);
          const rec = d.prepare('SELECT COALESCE(SUM(consumption_kwh),0) AS k FROM electricity_readings WHERE meter_id = ? AND record_date > ? AND record_date <= ? AND deleted_at IS NULL').get(m.id, ps, pe).k;
          const units = Math.round(rec * between(0.97, 1.06));
          const amount = Math.round(units * between(52, 62));
          const paid = back === 2 ? amount : rand() < 0.4 ? Math.round(amount * 0.5) : rand() < 0.5 ? amount : 0;
          d.prepare(`INSERT INTO bills (site_id, meter_id, category, account_ref, billing_month, period_start, period_end, billed_units, amount_pkr, due_date, amount_paid, payment_date, remarks, is_demo, created_by, created_at, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?)`).run(site.id, m.id, meter.location, meter.account_ref, month, ps, pe, units, amount,
            time.addDays(time.monthEnd(month), 14), paid, paid ? time.addDays(time.monthEnd(month), Math.floor(between(3, 12))) > yesterday ? yesterday : time.addDays(time.monthEnd(month), Math.floor(between(3, 12))) : null, by, ts, by, ts);
        }
      }
    });
    setSetting('demo_seeded_at', ts);
    audit({ entityType: 'demo', action: 'seed', user: actor, after: demoCounts() });
    return { demoUser: { username: 'demo.user', password: demoPassword } };
  });
}

/** Remove all demo-flagged data. Refuses if real records depend on demo configuration. */
function remove(actor = null) {
  const d = db();
  const dependents = d.prepare(`SELECT
      (SELECT COUNT(*) FROM electricity_readings r JOIN meters m ON m.id = r.meter_id WHERE m.is_demo = 1 AND r.is_demo = 0) +
      (SELECT COUNT(*) FROM bills b JOIN meters m ON m.id = b.meter_id WHERE m.is_demo = 1 AND b.is_demo = 0) +
      (SELECT COUNT(*) FROM generator_sessions s JOIN generators g ON g.id = s.generator_id WHERE g.is_demo = 1 AND s.is_demo = 0) +
      (SELECT COUNT(*) FROM diesel_records r JOIN diesel_tanks t ON t.id = r.tank_id WHERE t.is_demo = 1 AND r.is_demo = 0) +
      (SELECT COUNT(*) FROM maintenance_tasks t JOIN maintenance_items i ON i.id = t.item_id WHERE i.is_demo = 1 AND t.is_demo = 0) +
      (SELECT COUNT(*) FROM generators g JOIN diesel_tanks t ON t.id = g.tank_id WHERE t.is_demo = 1 AND g.is_demo = 0) AS n`).get().n;
  if (dependents > 0) {
    throw new HttpError(409, `${dependents} real record(s) were entered against demo meters, generators, tanks or maintenance items. Remove or reassign them before removing demo data.`);
  }
  const counts = demoCounts();
  return tx(() => {
    // Files attached to demo bills/tasks
    const files = d.prepare(`SELECT a.* FROM attachments a WHERE a.is_demo = 1
      OR (a.owner_type = 'bill' AND a.owner_id IN (SELECT id FROM bills WHERE is_demo = 1))
      OR (a.owner_type = 'maintenance_task' AND a.owner_id IN (SELECT id FROM maintenance_tasks WHERE is_demo = 1))`).all();
    for (const f of files) d.prepare('DELETE FROM attachments WHERE id = ?').run(f.id);
    d.exec(`
      DELETE FROM bills WHERE is_demo = 1;
      DELETE FROM maintenance_tasks WHERE is_demo = 1 OR item_id IN (SELECT id FROM maintenance_items WHERE is_demo = 1);
      DELETE FROM maintenance_items WHERE is_demo = 1;
      DELETE FROM diesel_records WHERE is_demo = 1;
      DELETE FROM generator_sessions WHERE is_demo = 1;
      DELETE FROM generators WHERE is_demo = 1;
      DELETE FROM diesel_tanks WHERE is_demo = 1;
      DELETE FROM lpg_records WHERE is_demo = 1;
      DELETE FROM electricity_readings WHERE is_demo = 1;
      DELETE FROM meter_events WHERE is_demo = 1 OR meter_id IN (SELECT id FROM meters WHERE is_demo = 1);
      DELETE FROM meters WHERE is_demo = 1;
      DELETE FROM sessions WHERE json_extract(sess, '$.userId') IN (SELECT id FROM users WHERE is_demo = 1);
      DELETE FROM user_sites WHERE user_id IN (SELECT id FROM users WHERE is_demo = 1);
      DELETE FROM settings WHERE key = 'demo_seeded_at';
    `);
    // Demo users who entered real records are kept (deactivated) so record authorship survives.
    for (const u of d.prepare('SELECT id FROM users WHERE is_demo = 1').all()) {
      d.exec('SAVEPOINT del_user');
      try {
        d.prepare('DELETE FROM users WHERE id = ?').run(u.id);
        d.exec('RELEASE del_user');
      } catch {
        d.exec('ROLLBACK TO del_user; RELEASE del_user');
        d.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(u.id);
      }
    }
    d.prepare("UPDATE sites SET lpg_unit = 'kg' WHERE lpg_unit = 'cylinder' AND id NOT IN (SELECT DISTINCT site_id FROM lpg_records)").run();
    for (const f of files) attachments.removeFile(f.stored_name);
    audit({ entityType: 'demo', action: 'remove', user: actor, before: counts });
    return counts;
  });
}

module.exports = { seed, remove, isSeeded, demoCounts };
