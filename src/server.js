'use strict';
const config = require('./config');
const { createApp } = require('./app');
const { db } = require('./db');

const app = createApp();
const admins = db().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").get().n;

app.listen(config.port, () => {
  console.log(`Utilities & Maintenance Management System running on http://localhost:${config.port}`);
  console.log(`Database: ${config.databasePath}`);
  if (!admins) console.log('No admin account exists yet. Create one with:  npm run create-admin');
});
