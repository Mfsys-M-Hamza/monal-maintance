'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { time, makeUser, sites, client } = require('./helpers');
const { createApp } = require('../src/app');
const demo = require('../src/services/demo');
const reports = require('../src/services/reports');
const metrics = require('../src/services/metrics');
const exporters = require('../src/services/exporters');
const access = require('../src/lib/access');

const app = createApp({ dbPath: process.env.DATABASE_PATH });
const admin = makeUser('admin');
demo.seed(admin);
const allIds = access.allowedSiteIds(admin);
const lastMonth = time.addMonthsToMonth(time.monthOf(time.today()), -1);
const [s1] = sites();

const sectionTotal = (doc, id, key) => doc.sections.find((s) => s.id === id).totals[key];
const sumRows = (doc, id, key) => Math.round(doc.sections.find((s) => s.id === id).rows.reduce((a, r) => a + (r[key] || 0), 0) * 100) / 100;

test('monthly report totals equal dashboard/metrics totals and the sum of rows', async () => {
  const doc = reports.monthlyReport(admin, { site: 'all', month: lastMonth });
  const from = time.monthStart(lastMonth), to = time.monthEnd(lastMonth);
  const m = metrics.summary(allIds, from, to);
  assert.equal(sectionTotal(doc, 'daily', 'kwh'), m.electricity.totalKwh);
  assert.equal(sectionTotal(doc, 'daily', 'diesel'), m.diesel.litres);
  assert.equal(sectionTotal(doc, 'daily', 'gen'), m.generators.hours);
  assert.equal(sectionTotal(doc, 'sites', 'bill_amount'), m.bills.amount);
  // Site-wise rows add up to the all-sites totals
  assert.ok(Math.abs(sumRows(doc, 'sites', 'diesel_l') - m.diesel.litres) < 0.01);
  assert.ok(Math.abs(sumRows(doc, 'sites', 'elec_site') + sumRows(doc, 'sites', 'elec_acc') - m.electricity.totalKwh) < 0.01);
  assert.ok(Math.abs(sumRows(doc, 'bills', 'amount_pkr') - m.bills.amount) < 0.01);
  assert.ok(Math.abs(sumRows(doc, 'bills', 'outstanding') - m.bills.outstanding) < 0.01);
  assert.ok(Math.abs(sumRows(doc, 'daily', 'kwh') - m.electricity.totalKwh) < 0.05);

  // Dashboard API for "last month" reports the same numbers
  const c = await client(app);
  try {
    await c.login(admin.username);
    const dash = await (await c.request('/api/dashboard?preset=last_month')).json();
    assert.equal(dash.totals.electricity_kwh, m.electricity.totalKwh);
    assert.equal(dash.totals.diesel_l, m.diesel.litres);
    assert.equal(dash.totals.generator_hours, m.generators.hours);
    assert.equal(dash.totals.bills_pkr, m.bills.amount);
    assert.equal(dash.totals.outstanding_pkr, m.bills.outstanding);
  } finally { await c.close(); }
});

test('daily report: generator allocation across dates sums to the period total', () => {
  const from = time.addDays(time.today(), -10), to = time.addDays(time.today(), -1);
  const doc = reports.dailyReport(admin, { site: 'all', from, to });
  const gen = metrics.generators(allIds, from, to);
  assert.ok(Math.abs(sumRows(doc, 'generator_daily', 'hours') - gen.hours) < 0.05);
  assert.equal(sectionTotal(doc, 'electricity', 'consumption_kwh'), metrics.electricity(allIds, from, to).totalKwh);
  assert.ok(Math.abs(sumRows(doc, 'electricity', 'consumption_kwh') - sectionTotal(doc, 'electricity', 'consumption_kwh')) < 0.01);
  // Missing entries are listed separately and completeness is reported
  assert.ok(doc.sections.find((s) => s.id === 'missing'));
  assert.ok(doc.kpis.find((k) => k.label === 'Data completeness'));
});

test('percentage change is N/A when the previous period is zero or unavailable', () => {
  assert.equal(metrics.pctChange(100, 0), null);
  assert.equal(metrics.pctChange(100, null), null);
  assert.equal(metrics.pctChange(150, 100), 50);
  const doc = reports.monthlyReport(admin, { site: 'all', month: '2020-01' });
  const cmp = doc.sections.find((s) => s.id === 'comparison');
  assert.ok(cmp.rows.every((r) => r.pct === null));
});

test('exports (CSV, Excel, PDF) carry the same figures, title, period and filters', async () => {
  const q = { site: String(s1.id), month: lastMonth };
  const doc = reports.monthlyReport(admin, q);
  const kwh = sectionTotal(doc, 'daily', 'kwh');

  const csv = exporters.toCsv(doc);
  assert.match(csv, /Monthly Utilities & Maintenance Report/);
  assert.match(csv, new RegExp(`Reporting period: ${time.formatMonth(lastMonth)}`));
  assert.match(csv, new RegExp(`Site: ${s1.name}`));
  const dailyBlock = csv.split('Daily breakdown')[1];
  const totalLine = dailyBlock.split('\r\n').find((l) => l.startsWith('TOTAL'));
  assert.equal(Number(totalLine.split(',')[1]), kwh);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await exporters.toXlsx(doc));
  const sheet = wb.worksheets.find((w) => w.name.startsWith('Daily breakdown'));
  let xlsxTotal = null;
  sheet.eachRow((row) => { if (row.getCell(1).value === 'TOTAL') xlsxTotal = row.getCell(2).value; });
  assert.equal(xlsxTotal, kwh);
  assert.equal(wb.worksheets[0].getCell('A1').value, doc.title);

  const pdf = await exporters.toPdf(doc);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 5000);

  // HTTP export endpoints respect filters and permissions
  const user = makeUser('user', [s1.id]);
  const c = await client(app);
  try {
    await c.login(user.username);
    const r = await c.request(`/reports/monthly?site=${s1.id}&month=${lastMonth}&format=xlsx`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /monthly-report_/);
    const p = await c.request(`/reports/monthly?site=${s1.id}&month=${lastMonth}&format=pdf`);
    assert.equal(p.headers.get('content-type'), 'application/pdf');
  } finally { await c.close(); }
});

test('demo data is labelled and fully removable without touching sites', () => {
  const before = sites().length;
  assert.ok(demo.demoCounts().electricity > 0);
  demo.remove(admin);
  const counts = demo.demoCounts();
  assert.ok(Object.values(counts).every((n) => n === 0));
  assert.equal(sites().length, before);
});
