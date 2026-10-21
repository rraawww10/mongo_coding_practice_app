'use strict';

const { createMongoClient } = require('./createClient');
const logger = require('../utils/logger');

/**
 * Owns the platform's own MongoDB connections:
 *  - adminClient: provisioning, seeding, application metadata (users, attempts, audit logs).
 *  - queryClient: executes student queries against local workspaces. In production this uses a
 *    separate, least-privileged MongoDB user (MONGODB_QUERY_URI). When WORKSPACE_DB_USERS is on,
 *    queries run with a per-workspace user instead (see connectionManager.getWorkspaceDb).
 */
class MongoManager {
  constructor(config) {
    this.config = config;
    this.adminClient = null;
    this.queryClient = null;
  }

  async connect() {
    const opts = { maxPoolSize: 20, serverSelectionTimeoutMS: 5000, appName: 'practice-platform-admin' };
    this.adminClient = createMongoClient(this.config.mongoAdminUri, opts);
    await this.adminClient.connect();
    if (this.config.mongoQueryUri && this.config.mongoQueryUri !== this.config.mongoAdminUri) {
      this.queryClient = createMongoClient(this.config.mongoQueryUri, { ...opts, appName: 'practice-platform-query' });
      await this.queryClient.connect();
    } else {
      this.queryClient = this.adminClient;
    }
    logger.info('Connected to platform MongoDB');
    return this;
  }

  get appDb() {
    return this.adminClient.db(this.config.appDbName);
  }

  collection(name) {
    return this.appDb.collection(name);
  }

  async ping() {
    try {
      await this.adminClient.db('admin').command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async ensureAppIndexes() {
    const db = this.appDb;
    await Promise.all([
      db.collection('users').createIndex({ email: 1 }, { unique: true }),
      db.collection('users').createIndex({ role: 1 }),
      db.collection('workspaces').createIndex({ userId: 1 }, { unique: true }),
      db.collection('connections').createIndex({ userId: 1 }, { unique: true }),
      db.collection('questions').createIndex({ questionId: 1 }, { unique: true }),
      db.collection('assignments').createIndex({ studentId: 1, questionId: 1 }, { unique: true }),
      db.collection('attempts').createIndex({ userId: 1, questionId: 1, createdAt: -1 }),
      db.collection('query_history').createIndex({ userId: 1, createdAt: -1 }),
      db.collection('audit_logs').createIndex({ createdAt: -1 }),
      db.collection('audit_logs').createIndex({ targetUserId: 1, createdAt: -1 }),
    ]);
  }

  async close() {
    if (this.queryClient && this.queryClient !== this.adminClient) await this.queryClient.close();
    if (this.adminClient) await this.adminClient.close();
    this.adminClient = null;
    this.queryClient = null;
  }
}

module.exports = { MongoManager };
