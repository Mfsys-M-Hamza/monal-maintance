'use strict';
const { ValidationError } = require('./errors');
const time = require('./time');

/**
 * Field-by-field parser for request bodies. Collects every error so forms can show
 * all problems at once, then `done()` throws a ValidationError if anything failed.
 */
function parse(body = {}) {
  const errors = {};
  const raw = (name) => {
    const v = body[name];
    if (v === undefined || v === null) return '';
    return Array.isArray(v) ? v : String(v).trim();
  };
  const fail = (name, msg) => { if (!errors[name]) errors[name] = msg; return null; };

  return {
    errors,
    fail,
    str(name, { required = false, max = 500, label = name } = {}) {
      const v = raw(name);
      if (Array.isArray(v)) return fail(name, `${label} is invalid.`);
      if (!v) return required ? fail(name, `${label} is required.`) : null;
      if (v.length > max) return fail(name, `${label} must be at most ${max} characters.`);
      return v;
    },
    num(name, { required = false, min = null, max = null, label = name, integer = false } = {}) {
      const v = raw(name);
      if (v === '' ) return required ? fail(name, `${label} is required.`) : null;
      if (Array.isArray(v) || !/^-?\d+(\.\d+)?$/.test(v)) return fail(name, `${label} must be a number.`);
      const n = Number(v);
      if (!Number.isFinite(n)) return fail(name, `${label} must be a number.`);
      if (integer && !Number.isInteger(n)) return fail(name, `${label} must be a whole number.`);
      if (min !== null && n < min) return fail(name, `${label} must be at least ${min}.`);
      if (max !== null && n > max) return fail(name, `${label} must be at most ${max}.`);
      return n;
    },
    id(name, { required = true, label = name } = {}) {
      const v = raw(name);
      if (v === '') return required ? fail(name, `${label} is required.`) : null;
      if (Array.isArray(v) || !/^\d+$/.test(v)) return fail(name, `${label} is invalid.`);
      return Number(v);
    },
    ids(name) {
      const v = body[name];
      const list = v === undefined ? [] : Array.isArray(v) ? v : [v];
      return list.filter((x) => /^\d+$/.test(String(x))).map(Number);
    },
    date(name, { required = true, label = name, notFuture = false } = {}) {
      const v = raw(name);
      if (v === '') return required ? fail(name, `${label} is required.`) : null;
      if (!time.isValidDate(v)) return fail(name, `${label} must be a valid date.`);
      if (notFuture && v > time.today()) return fail(name, `${label} cannot be in the future.`);
      return v;
    },
    datetime(name, { required = true, label = name } = {}) {
      const v = raw(name);
      if (v === '') return required ? fail(name, `${label} is required.`) : null;
      const s = typeof v === 'string' ? v.slice(0, 16) : v;
      if (!time.isValidDateTime(s)) return fail(name, `${label} must be a valid date and time.`);
      return s;
    },
    month(name, { required = true, label = name } = {}) {
      const v = raw(name);
      if (v === '') return required ? fail(name, `${label} is required.`) : null;
      if (!time.isValidMonth(v)) return fail(name, `${label} must be a valid month.`);
      return v;
    },
    oneOf(name, values, { required = true, label = name, fallback = null } = {}) {
      const v = raw(name);
      if (v === '') return required ? fail(name, `${label} is required.`) : fallback;
      if (!values.includes(v)) return fail(name, `${label} is invalid.`);
      return v;
    },
    bool(name) {
      const v = raw(name);
      return v === '1' || v === 'on' || v === 'true' ? 1 : 0;
    },
    done(message = 'Please correct the highlighted fields.') {
      if (Object.keys(errors).length) throw new ValidationError(message, errors);
    },
  };
}

/** Round to fixed decimals to avoid floating point noise (e.g. 0.1 + 0.2). */
function round(n, dp = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return n;
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

module.exports = { parse, round };
