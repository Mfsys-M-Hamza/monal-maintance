'use strict';
// Securely create an administrator account from the command line.
//   npm run create-admin
//   npm run create-admin -- --username ops.admin --name "Operations Admin"
// The password is entered interactively (hidden), or supplied via the ADMIN_PASSWORD
// environment variable for automated provisioning. Nothing is hardcoded.
const readline = require('node:readline');
const { init, db, nowIso, close } = require('../src/db');
const config = require('../src/config');
const { hashPassword, passwordPolicyError } = require('../src/lib/passwords');
const { audit } = require('../src/lib/audit');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else rl.output.write(''); };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

(async () => {
  init(config.databasePath);
  const username = arg('username') || (await ask('Admin username: '));
  const fullName = arg('name') || (await ask('Full name: '));
  if (!/^[a-zA-Z0-9._-]{3,50}$/.test(username || '')) { console.error('Invalid username (3–50 letters, numbers, . _ -).'); process.exit(1); }
  if (!fullName) { console.error('Full name is required.'); process.exit(1); }
  if (db().prepare('SELECT 1 FROM users WHERE username = ?').get(username)) { console.error(`User "${username}" already exists.`); process.exit(1); }

  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await ask('Password (min 10 chars, letters + numbers): ', { hidden: true });
    const confirm = await ask('Confirm password: ', { hidden: true });
    if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1); }
  }
  const err = passwordPolicyError(password);
  if (err) { console.error(err); process.exit(1); }

  const ts = nowIso();
  const id = db().prepare(`INSERT INTO users (username, full_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, 'admin', ?, ?)`)
    .run(username, fullName, hashPassword(password), ts, ts).lastInsertRowid;
  audit({ entityType: 'user', entityId: Number(id), action: 'create', reason: 'Created via create-admin CLI', after: { username, full_name: fullName, role: 'admin' } });
  console.log(`Admin "${username}" created. Sign in at http://localhost:${config.port}/login`);
  close();
})();
