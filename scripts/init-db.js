'use strict';
// Creates the SQLite database (if missing), applies the schema and seeds the seven project sites.
const config = require('../src/config');
const { init, db, close } = require('../src/db');

init(config.databasePath);
const sites = db().prepare('SELECT name FROM sites ORDER BY id').all().map((s) => s.name);
const admins = db().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
console.log(`Database ready at ${config.databasePath}`);
console.log(`Sites: ${sites.join(', ')}`);
if (!admins) console.log('Next: create the first admin with  npm run create-admin');
close();
