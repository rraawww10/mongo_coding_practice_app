'use strict';

const { getDataset, INDEXES, PRACTICE_COLLECTIONS } = require('./sampleData');
const { randomPassword, encrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

/**
 * Creates and resets practice databases. Runs with the *administrative* MongoDB identity;
 * student queries never use this code path.
 */
class ProvisioningService {
  constructor({ mongo, config }) {
    this.mongo = mongo;
    this.config = config;
  }

  workspaceDbName(userId) {
    return `${this.config.workspaceDbPrefix}${String(userId)}`;
  }

  isWorkspaceDbName(name) {
    return typeof name === 'string' && name.startsWith(this.config.workspaceDbPrefix);
  }

  /**
   * Idempotent seed: documents are upserted by their fixed _id, so running it repeatedly never
   * creates duplicates. Documents that are not part of the canonical dataset are left in place
   * unless `{ prune: true }` is passed (used by reset).
   */
  async seedDatabase(db, { prune = false } = {}) {
    const dataset = getDataset();
    const summary = {};
    for (const name of PRACTICE_COLLECTIONS) {
      const coll = db.collection(name);
      const docs = dataset[name];
      if (prune) await coll.deleteMany({ _id: { $nin: docs.map((d) => d._id) } });
      const result = await coll.bulkWrite(
        docs.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })),
        { ordered: true },
      );
      for (const idx of INDEXES[name]) await coll.createIndex(idx.key, idx.options);
      summary[name] = {
        upserted: result.upsertedCount,
        matched: result.matchedCount,
        total: await coll.countDocuments(),
      };
    }
    return summary;
  }

  /** Restores a database to exactly the canonical dataset (drops and recreates each collection). */
  async resetDatabase(db) {
    const dataset = getDataset();
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    const summary = {};
    for (const name of PRACTICE_COLLECTIONS) {
      if (existing.has(name)) await db.collection(name).drop();
      await db.collection(name).insertMany(dataset[name]);
      for (const idx of INDEXES[name]) await db.collection(name).createIndex(idx.key, idx.options);
      summary[name] = { total: dataset[name].length };
    }
    return summary;
  }

  async seedTemplate() {
    const db = this.mongo.adminClient.db(this.config.templateDbName);
    return this.seedDatabase(db);
  }

  async resetTemplate() {
    return this.resetDatabase(this.mongo.adminClient.db(this.config.templateDbName));
  }

  async describeDatabase(db) {
    const out = [];
    for (const name of PRACTICE_COLLECTIONS) {
      const coll = db.collection(name);
      // eslint-disable-next-line no-await-in-loop
      const [count, indexes] = await Promise.all([
        coll.countDocuments(),
        coll.indexes().catch(() => []),
      ]);
      out.push({ name, count, indexes: indexes.map((i) => i.name) });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Local per-student workspaces
  // ---------------------------------------------------------------------------------------------

  async getWorkspace(userId) {
    return this.mongo.collection('workspaces').findOne({ userId });
  }

  /** Creates (or re-creates) an isolated database for one student, seeded with the practice data. */
  async initializeLocalWorkspace(userId) {
    const dbName = this.workspaceDbName(userId);
    const db = this.mongo.adminClient.db(dbName);
    const summary = await this.resetDatabase(db);

    const update = {
      $set: { userId, mode: 'local', dbName, status: 'ready', initializedAt: new Date(), lastResetAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    };
    if (this.config.workspaceDbUsers) {
      const existing = await this.getWorkspace(userId);
      if (!existing?.dbUser || existing.dbName !== dbName) {
        update.$set.dbUser = await this.createWorkspaceDbUser(dbName);
      }
    }
    await this.mongo.collection('workspaces').updateOne({ userId }, update, { upsert: true });
    logger.info('Workspace initialized', { userId: String(userId), dbName });
    return { dbName, collections: summary };
  }

  /**
   * Least privilege: a MongoDB user that can only read/write its own workspace database.
   * Its password is generated server-side and stored encrypted.
   */
  async createWorkspaceDbUser(dbName) {
    const username = `${dbName}_user`;
    const password = randomPassword();
    const db = this.mongo.adminClient.db(dbName);
    try {
      await db.command({ dropUser: username });
    } catch {
      /* user did not exist */
    }
    await db.command({ createUser: username, pwd: password, roles: [{ role: 'readWrite', db: dbName }] });
    return { username, encryptedPassword: encrypt(password, this.config.credentialEncryptionKey) };
  }

  async resetLocalWorkspace(userId) {
    const ws = await this.getWorkspace(userId);
    if (!ws || ws.mode !== 'local') return this.initializeLocalWorkspace(userId);
    const summary = await this.resetDatabase(this.mongo.adminClient.db(ws.dbName));
    await this.mongo
      .collection('workspaces')
      .updateOne({ userId }, { $set: { status: 'ready', lastResetAt: new Date() }, $inc: { resetCount: 1 } });
    return { dbName: ws.dbName, collections: summary };
  }

  /** Temporary database used to grade submissions without touching the student's workspace. */
  async createSandbox(label) {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const name = `${this.config.workspaceDbPrefix}eval_${label}_${suffix}`.slice(0, 63);
    const db = this.mongo.adminClient.db(name);
    const dataset = getDataset();
    await Promise.all(PRACTICE_COLLECTIONS.map((c) => db.collection(c).insertMany(dataset[c])));
    return { db, drop: () => db.dropDatabase().catch(() => {}) };
  }
}

module.exports = { ProvisioningService };
