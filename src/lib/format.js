'use strict';
const time = require('./time');

function num(v, dp = 2, { signed = false } = {}) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  const s = n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return signed && n > 0 ? `+${s}` : s;
}

function pkr(v, withPrefix = false) {
  const s = num(v, 0) === null ? null : Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return s === null ? null : withPrefix ? `PKR ${s}` : s;
}

function pct(v, { signed = true } = {}) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  return `${signed && v > 0 ? '+' : ''}${Number(v).toFixed(1)}%`;
}

/** Format a report cell according to its column definition. */
function cell(colDef, value) {
  const empty = colDef.na !== undefined ? colDef.na : colDef.type === 'text' ? '' : '—';
  if (value === null || value === undefined || value === '') return empty;
  switch (colDef.type) {
    case 'num': return num(value, colDef.dp ?? 2, { signed: colDef.signed }) ?? empty;
    case 'int': return num(value, 0) ?? empty;
    case 'pkr': return pkr(value) ?? empty;
    case 'pct': return pct(value, { signed: false }) ?? empty;
    case 'date': return time.formatDate(value);
    case 'datetime': return time.formatDateTime(value);
    default: return String(value);
  }
}

function kpiValue(k) {
  if (k.value === null || k.value === undefined) return 'N/A';
  if (k.type === 'pkr') return pkr(k.value, true);
  return num(k.value, k.dp ?? 2);
}

module.exports = { num, pkr, pct, cell, kpiValue };
