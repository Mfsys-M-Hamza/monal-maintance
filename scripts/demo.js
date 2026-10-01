'use strict';
// npm run demo:seed   — load clearly-labelled demonstration data
// npm run demo:remove — remove every demo row (real data is untouched)
const config = require('../src/config');
const { init, close } = require('../src/db');
const demo = require('../src/services/demo');

init(config.databasePath);
const cmd = process.argv[2];
try {
  if (cmd === 'seed') {
    const r = demo.seed(null);
    console.log('Demo data loaded:', demo.demoCounts());
    console.log(`Demo site user (limited to two sites): ${r.demoUser.username} / ${r.demoUser.password}`);
    console.log('This password is shown only once. Remove all demo data with: npm run demo:remove');
  } else if (cmd === 'remove') {
    console.log('Removed demo data:', demo.remove(null));
  } else {
    console.log('Usage: node scripts/demo.js seed|remove');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  close();
}
