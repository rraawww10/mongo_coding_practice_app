'use strict';

const os = require('os');
const { MongoClient } = require('mongodb');

/**
 * Single place where MongoClient instances are created. Supplying the `os` runtime adapter
 * explicitly avoids the driver's dynamic `import('os')`, which is unavailable inside some
 * sandboxed runtimes (e.g. the Jest VM).
 */
function createMongoClient(uri, options = {}) {
  return new MongoClient(uri, { runtimeAdapters: { os }, ...options });
}

module.exports = { createMongoClient };
