'use strict';

/**
 * Starts a real, persistent local MongoDB server without Docker (uses the mongod binary
 * downloaded by mongodb-memory-server). Data is kept in backend/.mongo-data.
 *
 *   npm run mongo:local                # port 27017
 *   MONGO_LOCAL_PORT=27018 npm run mongo:local
 */
const fs = require('fs');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

async function main() {
  const port = Number(process.env.MONGO_LOCAL_PORT || 27017);
  const dbPath = path.resolve(__dirname, '..', '.mongo-data');
  fs.mkdirSync(dbPath, { recursive: true });
  const server = await MongoMemoryServer.create({
    instance: { port, dbPath, storageEngine: 'wiredTiger', ip: '127.0.0.1' },
  });
  console.log(`\nLocal MongoDB is running at ${server.getUri()}`);
  console.log(`Data directory: ${dbPath}`);
  console.log('Press Ctrl+C to stop.\n');
  const stop = async () => {
    await server.stop({ doCleanup: false });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(`Failed to start local MongoDB: ${err.message}`);
  if (/EADDRINUSE|already in use/i.test(err.message)) console.error('Port is busy. Is MongoDB already running? Set MONGO_LOCAL_PORT to use another port.');
  process.exit(1);
});
