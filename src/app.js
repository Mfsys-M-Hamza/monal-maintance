'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const dbm = require('./db');
const web = require('./lib/web');
const ui = require('./lib/ui');
const time = require('./lib/time');
const fmt = require('./lib/format');
const { HttpError, ValidationError } = require('./lib/errors');

function createApp({ dbPath } = {}) {
  dbm.init(dbPath);
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use('/static', express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '7d' : 0 }));
  const chartJs = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js');
  app.get('/static/vendor/chart.umd.min.js', (req, res) => res.sendFile(chartJs, { maxAge: config.isProd ? '7d' : 0 }));
  app.use(express.urlencoded({ extended: true, limit: '200kb' }));
  app.use(express.json({ limit: '200kb' }));
  app.use(web.sessionMiddleware());
  app.use(web.loadUser);

  app.use((req, res, next) => {
    res.locals.ui = ui;
    res.locals.fmt = fmt;
    res.locals.time = time;
    res.locals.path = req.path;
    res.locals.query = req.query;
    res.locals.today = time.today();
    res.locals.demoSeeded = !!dbm.getSetting('demo_seeded_at');
    res.locals.flash = req.session.flash || [];
    if (req.session.flash) delete req.session.flash;
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(web.csrf);

  app.use(require('./routes/auth'));
  app.use('/api', web.requireAuth, require('./routes/api'));
  app.use(web.requireAuth);
  app.use(require('./routes/dashboard'));
  app.use('/electricity', require('./routes/electricity'));
  app.use('/lpg', require('./routes/lpg'));
  app.use('/generator', require('./routes/generator'));
  app.use('/diesel', require('./routes/diesel'));
  app.use('/maintenance', require('./routes/maintenance'));
  app.use('/bills', require('./routes/bills'));
  app.use('/records', require('./routes/records'));
  app.use('/reports', require('./routes/reports'));
  app.use('/files', require('./routes/files'));
  app.use('/admin', web.requireAdmin, require('./routes/admin'));

  app.use((req, res, next) => next(new HttpError(404, 'Page not found.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Something went wrong. Please try again.' : err.message;
    if (web.isApi(req) || req.get('accept') === 'application/json') {
      return res.status(status).json({ error: message, fields: err instanceof ValidationError ? err.fields : undefined });
    }
    res.status(status).render('errors/error', { title: status === 404 ? 'Not found' : 'Error', status, message });
  });

  return app;
}

module.exports = { createApp };
