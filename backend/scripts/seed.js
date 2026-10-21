'use strict';

/**
 * Initializes the `mongodb_practice` template database, indexes, the question bank and the
 * instructor account. Safe to run any number of times (no duplicates are created).
 */
const { bootstrap, seedAll } = require('../src/bootstrap');

(async () => {
  const services = await bootstrap();
  try {
    const result = await seedAll(services);
    console.log(`Seeded database "${services.config.templateDbName}":`);
    for (const [name, s] of Object.entries(result.template)) {
      console.log(`  ${name.padEnd(10)} total=${String(s.total).padStart(3)}  newly inserted=${s.upserted}  already present=${s.matched}`);
    }
    console.log(`Questions: ${result.questions.count}`);
    console.log(result.instructor ? `Instructor/admin account: ${result.instructor}` : 'INSTRUCTOR_PASSWORD not set - instructor account not created.');
  } finally {
    await services.shutdown();
  }
})().catch((err) => {
  console.error(`Seed failed: ${require('../src/utils/logger').redactString(err.message)}`);
  process.exit(1);
});
