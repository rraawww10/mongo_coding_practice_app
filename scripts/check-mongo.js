'use strict';

/** Exit 0 if a MongoDB for tests is usable (MONGODB_TEST_URI or mongodb-memory-server). */
const path = require('path');

const backend = path.resolve(__dirname, '..', 'backend');
const { createMongoClient } = require(path.join(backend, 'src', 'db', 'createClient'));

(async () => {
  if (process.env.MONGODB_TEST_URI) {
    const client = createMongoClient(process.env.MONGODB_TEST_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const info = await client.db('admin').command({ buildInfo: 1 });
    await client.close();
    console.log(`using MONGODB_TEST_URI (MongoDB ${info.version})`);
    return;
  }
  const { MongoMemoryServer } = require(path.join(backend, 'node_modules', 'mongodb-memory-server'));
  const server = await MongoMemoryServer.create();
  const client = createMongoClient(server.getUri());
  await client.connect();
  const info = await client.db('admin').command({ buildInfo: 1 });
  await client.close();
  await server.stop();
  console.log(`local mongod ${info.version} via mongodb-memory-server`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
