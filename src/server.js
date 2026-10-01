'use strict';
const config = require('./config');
const { createApp } = require('./app');
const { db, nowIso } = require('./db');
const { hashPassword, passwordPolicyError } = require('./lib/passwords');
const { audit } = require('./lib/audit');

const app = createApp();

// Optional first-run bootstrap for hosts without shell access (e.g. Render, Railway):
// if no admin exists and ADMIN_USERNAME / ADMIN_PASSWORD are set, create that admin once.
// Remove the variables after the first successful sign-in.
function bootstrapAdmin() {
  const admins = db().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  if (admins) return true;
  const { ADMIN_USERNAME: username, ADMIN_PASSWORD: password, ADMIN_NAME: name } = process.env;
  if (!username || !password) return false;
  const err = passwordPolicyError(password);
  if (err || !/^[a-zA-Z0-9._-]{3,50}$/.test(username)) {
    console.error(`Admin bootstrap skipped: ${err || 'invalid ADMIN_USERNAME'}`);
    return false;
  }
  const ts = nowIso();
  const id = db().prepare(`INSERT INTO users (username, full_name, password_hash, role, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', 1, ?, ?)`).run(username, name || 'Administrator', hashPassword(password), ts, ts).lastInsertRowid;
  audit({ entityType: 'user', entityId: Number(id), action: 'create', reason: 'Bootstrapped from environment variables', after: { username, role: 'admin' } });
  console.log(`First admin "${username}" created from environment variables. They must change the password at first sign-in.`);
  return true;
}

const hasAdmin = bootstrapAdmin();

app.listen(config.port, () => {
  console.log(`Utilities & Maintenance Management System running on http://localhost:${config.port}`);
  console.log(`Database: ${config.databasePath}`);
  if (!hasAdmin) console.log('No admin account exists yet. Create one with:  npm run create-admin  (or set ADMIN_USERNAME / ADMIN_PASSWORD)');
});
