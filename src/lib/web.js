'use strict';
const crypto = require('node:crypto');
const session = require('express-session');
const multer = require('multer');
const config = require('../config');
const { db } = require('../db');
const access = require('./access');
const { HttpError, ValidationError } = require('./errors');

// ---------------- Session store (SQLite) ----------------

class SqliteStore extends session.Store {
  constructor() {
    super();
    this.timer = setInterval(() => {
      try { db().prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); } catch { /* db closed */ }
    }, 15 * 60 * 1000);
    this.timer.unref();
  }
  get(sid, cb) {
    try {
      const row = db().prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + config.sessionMaxAgeMs;
      db().prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires')
        .run(sid, JSON.stringify(sess), expires);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { db().prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

function sessionMiddleware() {
  return session({
    name: 'umms.sid',
    secret: config.sessionSecret,
    store: new SqliteStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: config.sessionMaxAgeMs },
  });
}

// ---------------- CSRF (synchronizer token) ----------------

function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const isMultipart = (req.get('content-type') || '').startsWith('multipart/form-data');
  // Multipart bodies are parsed later by multer, so those forms carry the token in the query string.
  const sent = req.get('x-csrf-token') || (req.body && req.body._csrf) || (isMultipart ? req.query._csrf : undefined);
  const expected = Buffer.from(req.session.csrfToken);
  const given = Buffer.from(String(sent || ''));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return next(new HttpError(403, 'Your form session has expired. Please reload the page and try again.'));
  }
  next();
}

// ---------------- Auth ----------------

function loadUser(req, res, next) {
  res.locals.currentUser = null;
  if (req.session && req.session.userId) {
    const u = db().prepare('SELECT id, username, full_name, email, role, is_active, must_change_password FROM users WHERE id = ?').get(req.session.userId);
    if (!u || !u.is_active) {
      return req.session.destroy(() => (isApi(req) ? res.status(401).json({ error: 'Session ended.' }) : res.redirect('/login')));
    }
    req.user = u;
    res.locals.currentUser = u;
    res.locals.isAdmin = u.role === 'admin';
    res.locals.userSites = access.accessibleSites(u);
  }
  next();
}

const isApi = (req) => req.originalUrl.startsWith('/api/');

function requireAuth(req, res, next) {
  if (!req.user) {
    if (isApi(req)) return res.status(401).json({ error: 'Authentication required.' });
    req.session.returnTo = req.method === 'GET' ? req.originalUrl : undefined;
    return res.redirect('/login');
  }
  if (req.user.must_change_password && !req.path.startsWith('/account/password') && req.path !== '/logout') {
    if (isApi(req)) return res.status(403).json({ error: 'You must change your password before continuing.' });
    return res.redirect('/account/password');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return next(new HttpError(403, 'Administrator access required.'));
  next();
}

// ---------------- Login throttling ----------------

const attempts = new Map();
const WINDOW = 15 * 60 * 1000, MAX_FAILS = 5;
function throttleKey(ip, username) { return `${ip}|${String(username || '').toLowerCase()}`; }
function isThrottled(ip, username) {
  const a = attempts.get(throttleKey(ip, username));
  return !!a && a.count >= MAX_FAILS && Date.now() - a.first < WINDOW;
}
function recordFailure(ip, username) {
  const k = throttleKey(ip, username);
  const a = attempts.get(k);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(k, { count: 1, first: Date.now() });
  else a.count++;
}
function clearFailures(ip, username) { attempts.delete(throttleKey(ip, username)); }

// ---------------- Helpers ----------------

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

/** Single optional file field; converts multer errors into validation errors. */
function singleFile(field) {
  const mw = upload.single(field);
  return (req, res, next) => mw(req, res, (err) => {
    if (err) return next(new ValidationError(err.code === 'LIMIT_FILE_SIZE' ? `File is too large (max ${config.maxUploadBytes / 1048576} MB).` : 'File upload failed.', { [field]: 'Upload failed.' }));
    next();
  });
}

/** Wrap async/sync handlers so thrown errors reach the error handler. */
const h = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.catch === 'function') r.catch(next);
  } catch (e) { next(e); }
};

function flash(req, type, message) {
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ type, message });
}

function ctx(req) {
  return { ip: req.ip };
}

/** router.param guard: only numeric IDs match ':id' routes. */
function numericParam(req, res, next, id) {
  return /^\d+$/.test(id) ? next() : next('route');
}

module.exports = { numericParam, sessionMiddleware, csrf, loadUser, requireAuth, requireAdmin, isThrottled, recordFailure, clearFailures, singleFile, h, flash, ctx, isApi };
