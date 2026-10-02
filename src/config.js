'use strict';
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

// Load .env if present (Node >= 20.12 built-in loader; no dependency needed).
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function resolvePath(p, fallback) {
  const v = p || fallback;
  return path.isAbsolute(v) ? v : path.join(ROOT, v);
}

const config = {
  root: ROOT,
  isProd,
  port: Number(env.PORT) || 3000,
  host: env.HOST || undefined, // e.g. 127.0.0.1 behind a reverse proxy
  databasePath: resolvePath(env.DATABASE_PATH, 'data/app.db'),
  uploadDir: resolvePath(env.UPLOAD_DIR, 'storage/uploads'),
  maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 5) * 1024 * 1024,
  sessionSecret: env.SESSION_SECRET || '',
  sessionMaxAgeMs: (Number(env.SESSION_HOURS) || 12) * 3600 * 1000,
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  trustProxy: env.TRUST_PROXY === 'true',
  timeZone: 'Asia/Karachi',
};

if (!config.sessionSecret) {
  if (isProd) {
    throw new Error('SESSION_SECRET must be set in production (use a long random string).');
  }
  // Development only: random per-process secret (sessions reset on restart).
  config.sessionSecret = require('node:crypto').randomBytes(32).toString('hex');
}

module.exports = config;
