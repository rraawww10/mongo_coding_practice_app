'use strict';

const { bootstrap } = require('./bootstrap');
const { createApp } = require('./app');
const logger = require('./utils/logger');

async function main() {
  const services = await bootstrap({ seed: true });
  const app = createApp(services);
  const server = app.listen(services.config.port, () => {
    logger.info(`API listening on http://localhost:${services.config.port}`);
  });
  const stop = async (signal) => {
    logger.info(`Received ${signal}, shutting down`);
    server.close();
    await services.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((err) => {
  if (err.code === 'CONFIG_INVALID') {
    console.error(`\n${err.message}\n\nCopy backend/.env.example to backend/.env and fill in the values.\n`);
  } else if (/ECONNREFUSED|Server selection/i.test(err.message)) {
    console.error('\nCannot reach MongoDB. Start it first:\n  npm run mongo:local     (no Docker needed)\n  docker compose up -d mongo\n');
  } else {
    console.error(logger.redactString(err.stack || err.message));
  }
  process.exit(1);
});
