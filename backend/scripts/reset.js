'use strict';

/**
 * Restores practice data to the original dataset.
 *
 *   npm run reset-db                         # reset the mongodb_practice template database
 *   npm run reset-db -- --all-workspaces     # ...and every student's local workspace
 *   npm run reset-db -- --student a@b.com    # only that student's workspace
 */
const { bootstrap } = require('../src/bootstrap');

const args = process.argv.slice(2);
const studentEmail = args.includes('--student') ? args[args.indexOf('--student') + 1] : null;

(async () => {
  const services = await bootstrap();
  const { provisioning, mongo, config } = services;
  try {
    if (studentEmail) {
      const user = await mongo.collection('users').findOne({ email: studentEmail.toLowerCase(), role: 'student' });
      if (!user) throw new Error(`No student with email ${studentEmail}`);
      const r = await provisioning.resetLocalWorkspace(user._id);
      console.log(`Reset workspace ${r.dbName} for ${studentEmail}`);
    } else {
      const summary = await provisioning.resetTemplate();
      console.log(`Reset "${config.templateDbName}":`, Object.entries(summary).map(([k, v]) => `${k}=${v.total}`).join(', '));
      if (args.includes('--all-workspaces')) {
        const wss = await mongo.collection('workspaces').find({ mode: 'local' }).toArray();
        for (const ws of wss) {
          // eslint-disable-next-line no-await-in-loop
          await provisioning.resetLocalWorkspace(ws.userId);
          console.log(`Reset workspace ${ws.dbName}`);
        }
        console.log(`${wss.length} workspace(s) reset.`);
      }
    }
  } finally {
    await services.shutdown();
  }
})().catch((err) => {
  console.error(`Reset failed: ${require('../src/utils/logger').redactString(err.message)}`);
  process.exit(1);
});
