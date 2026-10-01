'use strict';
// Asia/Karachi helpers. Pakistan Standard Time is a fixed UTC+05:00 with no DST,
// so local date-times convert to instants with a constant offset.

const TZ = 'Asia/Karachi';
const OFFSET = '+05:00';
const DAY_MS = 86400000;

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isValidDateTime(s) {
  return typeof s === 'string' && DATETIME_RE.test(s) && isValidDate(s.slice(0, 10)) &&
    Number(s.slice(11, 13)) < 24 && Number(s.slice(14, 16)) < 60;
}

function isValidMonth(s) {
  return typeof s === 'string' && MONTH_RE.test(s) && isValidDate(s + '-01');
}

/** Today's calendar date in Karachi, 'YYYY-MM-DD'. */
function today(now = new Date()) {
  return dateFmt.format(now);
}

/** Current Karachi local date-time 'YYYY-MM-DDTHH:MM'. */
function nowLocal(now = new Date()) {
  return `${dateFmt.format(now)}T${timeFmt.format(now)}`;
}

/** Karachi local 'YYYY-MM-DDTHH:MM' -> epoch ms. */
function localToMs(s) {
  return Date.parse(`${s}:00${OFFSET}`);
}

/** Karachi date 'YYYY-MM-DD' -> epoch ms at 00:00 Karachi. */
function dateStartMs(d) {
  return Date.parse(`${d}T00:00:00${OFFSET}`);
}

function addDays(d, n) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function addMonths(d, n) {
  const [y, m, day] = d.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function diffDays(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}

/** Inclusive list of dates from a to b. */
function dateRange(a, b) {
  const out = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}

function monthOf(d) {
  return d.slice(0, 7);
}

function monthStart(m) {
  return `${m}-01`;
}

function monthEnd(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

function addMonthsToMonth(m, n) {
  return addMonths(m + '-01', n).slice(0, 7);
}

/** List of months 'YYYY-MM' touched by [from, to]. */
function monthsBetween(from, to) {
  const out = [];
  for (let m = monthOf(from); m <= monthOf(to); m = addMonthsToMonth(m, 1)) out.push(m);
  return out;
}

/**
 * Split a session [startLocal, stopLocal) into hours per Karachi calendar date.
 * stopLocal null => running; elapsed is counted up to `nowMs`.
 * Returns Map(date -> hours).
 */
function splitByDate(startLocal, stopLocal, nowMs = Date.now()) {
  const result = new Map();
  let s = localToMs(startLocal);
  const e = stopLocal ? localToMs(stopLocal) : Math.max(s, nowMs);
  let d = startLocal.slice(0, 10);
  while (s < e) {
    const nextMidnight = dateStartMs(addDays(d, 1));
    const segEnd = Math.min(e, nextMidnight);
    result.set(d, (result.get(d) || 0) + (segEnd - s) / 3600000);
    s = segEnd;
    d = addDays(d, 1);
  }
  return result;
}

function formatDate(d) {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[Number(m) - 1]} ${y}`;
}

function formatDateTime(s) {
  if (!s) return '';
  return `${formatDate(s.slice(0, 10))} ${s.slice(11, 16)}`;
}

/** ISO UTC timestamp -> Karachi display. */
function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${formatDate(dateFmt.format(d))} ${timeFmt.format(d)}`;
}

function formatMonth(m) {
  if (!m) return '';
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
}

/** Resolve a dashboard preset into {from, to, label}. */
function resolvePreset(preset, from, to, now = new Date()) {
  const t = today(now);
  switch (preset) {
    case 'today': return { preset, from: t, to: t, label: 'Today' };
    case 'yesterday': { const y = addDays(t, -1); return { preset, from: y, to: y, label: 'Yesterday' }; }
    case 'last_month': {
      const m = addMonthsToMonth(monthOf(t), -1);
      return { preset, from: monthStart(m), to: monthEnd(m), label: 'Last month' };
    }
    case 'custom':
      if (isValidDate(from) && isValidDate(to) && from <= to) return { preset, from, to, label: 'Custom range' };
      // fall through to this month on invalid input
    default: {
      const m = monthOf(t);
      return { preset: 'this_month', from: monthStart(m), to: t, label: 'This month' };
    }
  }
}

module.exports = {
  TZ, OFFSET, isValidDate, isValidDateTime, isValidMonth, today, nowLocal, localToMs, dateStartMs,
  addDays, addMonths, diffDays, dateRange, monthOf, monthStart, monthEnd, addMonthsToMonth, monthsBetween,
  splitByDate, formatDate, formatDateTime, formatTimestamp, formatMonth, resolvePreset,
};
