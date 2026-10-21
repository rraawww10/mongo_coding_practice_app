'use strict';

const logger = require('../utils/logger');

/** Append-only audit log for administrative and security-relevant actions. */
class AuditService {
  constructor({ mongo }) {
    this.mongo = mongo;
  }

  async record({ actor, action, targetUserId = null, details = {}, outcome = 'success' }) {
    const entry = {
      action,
      outcome,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      actorRole: actor?.role ?? 'system',
      targetUserId,
      details: logger.redact(details),
      createdAt: new Date(),
    };
    await this.mongo.collection('audit_logs').insertOne(entry);
    logger.info(`audit:${action}`, { actorId: entry.actorId && String(entry.actorId), outcome });
    return entry;
  }

  async list({ targetUserId, action, limit = 100 } = {}) {
    const filter = {};
    if (targetUserId) filter.targetUserId = targetUserId;
    if (action) filter.action = action;
    return this.mongo
      .collection('audit_logs')
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 500))
      .toArray();
  }
}

module.exports = { AuditService };
