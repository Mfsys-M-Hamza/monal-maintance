'use strict';
// Small HTML helpers used by EJS views for consistent, accessible form controls.
const time = require('./time');
const fmt = require('./format');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function attrs(o) {
  return Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`)).join('');
}

function wrap({ name, label, hint, errors = {}, required, cls = '' }, control) {
  const err = errors[name];
  return `<div class="field ${cls}${err ? ' has-error' : ''}">
    <label for="f-${esc(name)}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
    ${control}
    ${hint ? `<small class="hint" id="h-${esc(name)}">${hint}</small>` : ''}
    ${err ? `<small class="error-text" id="e-${esc(name)}" role="alert">${esc(err)}</small>` : ''}
  </div>`;
}

function described(o) {
  return [o.hint ? `h-${o.name}` : '', o.errors && o.errors[o.name] ? `e-${o.name}` : ''].filter(Boolean).join(' ') || undefined;
}

function input(o) {
  const { name, type = 'text', value, required, readonly, step, min, max, placeholder, inputmode, autocomplete, unit, dataset = {} } = o;
  const data = Object.fromEntries(Object.entries(dataset).map(([k, v]) => [`data-${k}`, v]));
  const el = `<input${attrs({ id: `f-${name}`, name, type, value: value ?? '', required, readonly, step, min, max, placeholder, inputmode, autocomplete,
    'aria-invalid': o.errors && o.errors[name] ? 'true' : undefined, 'aria-describedby': described(o), ...data })}>`;
  return wrap(o, unit ? `<div class="input-unit">${el}<span>${esc(unit)}</span></div>` : el);
}

function select(o) {
  const { name, options = [], value, required, placeholder, multiple, dataset = {} } = o;
  const data = Object.fromEntries(Object.entries(dataset).map(([k, v]) => [`data-${k}`, v]));
  const values = Array.isArray(value) ? value.map(String) : [String(value ?? '')];
  const opts = (placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : '') +
    options.map((op) => `<option value="${esc(op.value)}"${values.includes(String(op.value)) ? ' selected' : ''}${op.disabled ? ' disabled' : ''}>${esc(op.label)}</option>`).join('');
  return wrap(o, `<select${attrs({ id: `f-${name}`, name, required, multiple, 'aria-invalid': o.errors && o.errors[name] ? 'true' : undefined, 'aria-describedby': described(o), ...data })}>${opts}</select>`);
}

function textarea(o) {
  const { name, value, rows = 2, required, placeholder } = o;
  return wrap(o, `<textarea${attrs({ id: `f-${name}`, name, rows, required, placeholder, 'aria-describedby': described(o) })}>${esc(value)}</textarea>`);
}

function checkbox({ name, label, checked, hint }) {
  return `<label class="check"><input type="checkbox" name="${esc(name)}" value="1"${checked ? ' checked' : ''}> <span>${esc(label)}</span>${hint ? ` <small class="hint">${esc(hint)}</small>` : ''}</label>`;
}

function badge(text, kind) {
  const map = { Overdue: 'danger', Due: 'warn', Scheduled: 'info', Completed: 'ok', Paid: 'ok', 'Partially Paid': 'warn', Unpaid: 'danger',
    Running: 'live', Comparable: 'ok', Incomplete: 'warn', 'No data': 'muted', Active: 'ok', Inactive: 'muted', Locked: 'muted' };
  return `<span class="badge badge-${kind || map[text] || 'muted'}">${esc(text)}</span>`;
}

function pagination(base, query, page, pages) {
  if (pages <= 1) return '';
  const link = (p) => {
    const q = new URLSearchParams({ ...query, page: String(p) });
    return `${base}?${q.toString()}`;
  };
  const items = [];
  const push = (p, label = p, current = false) => items.push(current ? `<span class="page current" aria-current="page">${label}</span>` : `<a class="page" href="${esc(link(p))}">${label}</a>`);
  if (page > 1) push(page - 1, '‹ Prev');
  for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) push(p, p, p === page);
  if (page < pages) push(page + 1, 'Next ›');
  return `<nav class="pagination" aria-label="Pagination">${items.join('')}<span class="page-info">Page ${page} of ${pages}</span></nav>`;
}

function siteOptions(sites, { activeOnly = false } = {}) {
  return sites.filter((s) => !activeOnly || s.is_active).map((s) => ({ value: s.id, label: s.name + (s.is_active ? '' : ' (inactive)') }));
}

function auditValue(v) {
  if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
  return esc(typeof v === 'object' ? JSON.stringify(v) : v);
}

module.exports = { esc, input, select, textarea, checkbox, badge, pagination, siteOptions, auditValue, time, fmt };
