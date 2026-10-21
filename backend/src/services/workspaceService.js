'use strict';

const { PRACTICE_COLLECTIONS } = require('../provisioning/sampleData');
const { AppError, badRequest } = require('../utils/errors');
const { ConnectionManager, classifyConnectionError } = require('../connections/connectionManager');

/**
 * Resolves which database a student works in and manages their connection record.
 * The database is ALWAYS derived from the authenticated user on the server; a client can
 * never choose another database by name.
 */
class WorkspaceService {
  constructor({ mongo, config, provisioning, connections }) {
    this.mongo = mongo;
    this.config = config;
    this.provisioning = provisioning;
    this.connections = connections;
  }

  get connectionsColl() {
    return this.mongo.collection('connections');
  }

  async getConnection(userId) {
    return this.connectionsColl.findOne({ userId });
  }

  // ---- connect / disconnect ------------------------------------------------------------------

  async connectLocal(userId) {
    await this.connections.testLocalConnection();
    await this.connections.disconnectUser(userId);
    const record = {
      userId,
      mode: 'local',
      status: 'connected',
      host: 'local-simulation',
      database: this.config.templateDbName,
      encryptedUri: null,
      lastTestedAt: new Date(),
      connectedAt: new Date(),
      lastError: null,
      presentCollections: PRACTICE_COLLECTIONS,
      missingCollections: [],
      warnings: [],
    };
    await this.connectionsColl.replaceOne({ userId }, record, { upsert: true });
    return record;
  }

  async connectAtlas(userId, input) {
    const { uri, host, database, usernameHint } = this.connections.validateAtlasInput(input);
    const test = await this.connections.testAtlasConnection(uri, database, PRACTICE_COLLECTIONS);
    await this.connections.disconnectUser(userId); // replace any previous pooled connection
    const record = {
      userId,
      mode: 'atlas',
      status: 'connected',
      host,
      database,
      usernameHint,
      encryptedUri: this.connections.encryptUri(uri),
      presentCollections: test.presentCollections,
      missingCollections: test.missingCollections,
      warnings: test.warnings,
      lastTestedAt: new Date(),
      connectedAt: new Date(),
      lastError: null,
    };
    await this.connectionsColl.replaceOne({ userId }, record, { upsert: true });
    // The workspace for an Atlas student is their own database; it is "ready" only when all
    // practice collections exist (or after they explicitly ask us to initialize them).
    await this.mongo.collection('workspaces').updateOne(
      { userId },
      {
        $set: {
          userId,
          mode: 'atlas',
          dbName: database,
          status: test.missingCollections.length ? 'needs_initialization' : 'ready',
          updatedAt: new Date(),
        },
        $unset: { dbUser: '' },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    return record;
  }

  async retest(userId) {
    const conn = await this.getConnection(userId);
    if (!conn) throw badRequest('NOT_CONNECTED', 'No database connection is configured yet.');
    try {
      if (conn.mode === 'local') {
        await this.connections.testLocalConnection();
      } else {
        const test = await this.connections.testAtlasConnection(
          this.connections.decryptUri(conn.encryptedUri),
          conn.database,
          PRACTICE_COLLECTIONS,
        );
        Object.assign(conn, { presentCollections: test.presentCollections, missingCollections: test.missingCollections, warnings: test.warnings });
      }
      Object.assign(conn, { status: 'connected', lastError: null, lastTestedAt: new Date() });
    } catch (err) {
      const e = classifyConnectionError(err);
      Object.assign(conn, { status: 'error', lastError: { code: e.code, message: e.message }, lastTestedAt: new Date() });
    }
    await this.connectionsColl.replaceOne({ userId }, conn);
    return conn;
  }

  async disconnect(userId) {
    await this.connections.disconnectUser(userId);
    const conn = await this.getConnection(userId);
    await this.connectionsColl.deleteOne({ userId });
    if (conn?.mode === 'atlas') await this.mongo.collection('workspaces').deleteOne({ userId, mode: 'atlas' });
    return { disconnected: Boolean(conn) };
  }

  // ---- workspace -----------------------------------------------------------------------------

  async getWorkspace(userId) {
    return this.mongo.collection('workspaces').findOne({ userId });
  }

  async requireConnection(userId) {
    const conn = await this.getConnection(userId);
    if (!conn || conn.status !== 'connected') {
      throw new AppError(409, 'NOT_CONNECTED', 'Connect to a database first (Connection page).');
    }
    return conn;
  }

  async initialize(userId, { confirm = false } = {}) {
    const conn = await this.requireConnection(userId);
    if (conn.mode === 'local') return this.provisioning.initializeLocalWorkspace(userId);
    if (!confirm) {
      throw badRequest(
        'CONFIRMATION_REQUIRED',
        `This will create or overwrite the collections ${PRACTICE_COLLECTIONS.join(', ')} in your Atlas database "${conn.database}". Send confirm: true to continue.`,
      );
    }
    const db = await this.connections.getAtlasDb(userId, conn);
    const summary = await this.provisioning.resetDatabase(db);
    await this.mongo.collection('workspaces').updateOne({ userId }, { $set: { status: 'ready', initializedAt: new Date(), lastResetAt: new Date() } });
    await this.connectionsColl.updateOne({ userId }, { $set: { presentCollections: PRACTICE_COLLECTIONS, missingCollections: [] } });
    return { dbName: conn.database, collections: summary };
  }

  async reset(userId) {
    const conn = await this.requireConnection(userId);
    if (conn.mode === 'local') return this.provisioning.resetLocalWorkspace(userId);
    return this.initialize(userId, { confirm: true });
  }

  /** Db handle for the student's own workspace. Throws if it is not ready. */
  async resolveDb(userId) {
    const conn = await this.requireConnection(userId);
    const ws = await this.getWorkspace(userId);
    if (!ws || ws.status !== 'ready' || ws.mode !== conn.mode) {
      throw new AppError(409, 'WORKSPACE_NOT_READY', 'Your practice workspace is not initialized yet. Initialize it from the Workspace page.');
    }
    if (ws.mode === 'local') {
      if (!this.provisioning.isWorkspaceDbName(ws.dbName)) throw new AppError(500, 'WORKSPACE_INVALID', 'Workspace configuration is invalid.');
      return { db: await this.connections.getLocalWorkspaceDb(ws), workspace: ws, connection: conn };
    }
    return { db: await this.connections.getAtlasDb(userId, conn), workspace: ws, connection: conn };
  }

  async describe(userId) {
    const conn = await this.getConnection(userId);
    const ws = await this.getWorkspace(userId);
    const base = {
      connection: ConnectionManager.publicView(conn),
      workspace: ws
        ? { mode: ws.mode, status: ws.status, initializedAt: ws.initializedAt || null, lastResetAt: ws.lastResetAt || null }
        : { status: 'not_initialized' },
      database: { name: this.config.templateDbName, label: 'mongodb_practice (your private copy)' },
      collections: [],
    };
    if (!ws || ws.status !== 'ready' || !conn || ws.mode !== conn.mode) return base;
    const { db } = await this.resolveDb(userId);
    base.collections = await Promise.all(
      PRACTICE_COLLECTIONS.map(async (name) => {
        const sample = await db.collection(name).findOne({}, { projection: { _id: 0 } });
        return { name, count: await db.collection(name).countDocuments(), fields: sample ? Object.keys(sample) : [] };
      }),
    );
    return base;
  }
}

module.exports = { WorkspaceService };
