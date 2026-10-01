'use strict';
const express = require('express');
const { db, nowIso } = require('../db');
const { verifyPassword, DUMMY_HASH } = require('../lib/passwords');
const { audit } = require('../lib/audit');
const web = require('../lib/web');
const adminSvc = require('../services/admin');
const { ValidationError } = require('../lib/errors');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { title: 'Sign in', error: null, username: '' });
});

router.post('/login', web.h((req, res, next) => {
  const username = String(req.body.username || '').trim().slice(0, 50);
  const password = String(req.body.password || '');
  const fail = (msg) => res.status(401).render('auth/login', { title: 'Sign in', error: msg, username });
  if (web.isThrottled(req.ip, username)) return fail('Too many failed attempts. Please wait 15 minutes and try again.');
  const user = db().prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || !user.is_active) {
    web.recordFailure(req.ip, username);
    audit({ entityType: 'auth', action: 'login_failed', reason: `username: ${username}`, ip: req.ip });
    return fail(user && ok && !user.is_active ? 'This account has been deactivated. Contact an administrator.' : 'Invalid username or password.');
  }
  web.clearFailures(req.ip, username);
  const returnTo = req.session.returnTo;
  // Regenerate the session on login to prevent session fixation.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
    audit({ entityType: 'auth', entityId: user.id, action: 'login', user, ip: req.ip });
    const safe = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
    req.session.save(() => res.redirect(user.must_change_password ? '/account/password' : safe));
  });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('umms.sid');
    res.redirect('/login');
  });
});

router.get('/account/password', web.requireAuth, (req, res) => {
  res.render('auth/password', { title: 'Change password', errors: {}, error: null, forced: !!req.user.must_change_password });
});

router.post('/account/password', web.requireAuth, web.h((req, res) => {
  try {
    adminSvc.changeOwnPassword(req.user, req.body, web.ctx(req));
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    return res.status(422).render('auth/password', { title: 'Change password', errors: e.fields, error: e.message, forced: !!req.user.must_change_password });
  }
  web.flash(req, 'success', 'Your password has been changed.');
  res.redirect('/');
}));

module.exports = router;
