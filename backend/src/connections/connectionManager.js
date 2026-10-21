'use strict';

const { createMongoClient } = require('../db/createClient');
const { default: ConnectionString } = require('mongodb-connection-string-url');
const { encrypt, decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

class ConnectionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
    this.status = status;
  }
}

const RESERVED_DATABASES = new Set(['admin', 'local', 'config']);
const DB_NAME_RE = /^[A-Za-z0-9_-]{1,38}$/;
// Roles that indicate an administrator-level login, which students must not hand to the platform.
const ADMIN_ROLES = new Set([
  'root', 'atlasAdmin', 'userAdminAnyDatabase', 'dbAdminAnyDatabase', 'clusterAdmin', 'clusterManager',
  'userAdmin', 'restore', 'backup', '__system',
]);

const ERROR_MESSAGES = {
  INVALID_URL: 'The connection URL is not valid. It must start with mongodb+srv:// (or mongodb://), e.g. mongodb+srv://<username>@cluster0.abcde.mongodb.net/',
  MISSING_CREDENTIALS: 'A database username and password are required. Create a database user in Atlas under Security → Database Access.',
  HOST_NOT_ALLOWED: 'This host is not an allowed MongoDB Atlas cluster address (expected something like cluster0.xxxxx.mongodb.net).',
  INVALID_DATABASE: 'Provide the name of the practice database to use (letters, numbers, - or _). admin, local and config are not allowed.',
  AUTH_FAILED: 'Authentication failed: the database username or password is incorrect. Check the user under Atlas → Security → Database Access (this is not your Atlas account password).',
  HOST_NOT_FOUND: 'The cluster hostname could not be found. Copy the connection string again from Atlas → Connect → Drivers and check for typos.',
  TIMEOUT: 'The connection timed out. Check that the cluster is running and that your network allows outbound connections on port 27017.',
  NETWORK_ACCESS_DENIED: 'The cluster refused the connection. Add the platform server\'s IP address under Atlas → Security → Network Access (IP Access List).',
  DATABASE_UNAVAILABLE: 'The database server is unavailable or refused the connection. Make sure the cluster is running and try again.',
  ADMIN_CREDENTIALS_NOT_ALLOWED: 'This database user has administrator privileges. Create a dedicated user with the "readWrite" role on your practice database only.',
  NOT_AUTHORIZED: 'The database user cannot access the requested database. Grant it the readWrite role on that database.',
  CONNECTION_FAILED: 'Could not connect to the database. Verify the connection string and try again.',
};

const connErr = (code, status = 400) => new ConnectionError(code, ERROR_MESSAGES[code], status);

/** Maps raw driver errors to actionable, non-sensitive connection errors. */
function classifyConnectionError(err) {
  if (err instanceof ConnectionError) return err;
  const text = `${err?.name || ''} ${err?.message || ''} ${err?.cause?.message || ''} ${err?.code || ''} ${err?.codeName || ''}`;
  if (err?.code === 18 || /authentication failed|bad auth|auth failed|AuthenticationFailed/i.test(text)) return connErr('AUTH_FAILED', 401);
  if (/whitelist|access list|IP address|not allowed to access/i.test(text)) return connErr('NETWORK_ACCESS_DENIED', 403);
  if (/ENOTFOUND|EAI_AGAIN|querySrv|getaddrinfo|ENODATA|ESERVFAIL|queryTxt/i.test(text)) return connErr('HOST_NOT_FOUND', 400);
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(text)) return connErr('DATABASE_UNAVAILABLE', 503);
  if (/timed out|timeout|ETIMEDOUT|Server selection/i.test(text)) return connErr('TIMEOUT', 504);
  if (err?.code === 13 || /not authorized|Unauthorized/i.test(text)) return connErr('NOT_AUTHORIZED', 403);
  if (err?.name === 'MongoParseError' || /Invalid scheme|URI|Invalid connection string/i.test(text)) return connErr('INVALID_URL', 400);
  return connErr('CONNECTION_FAILED', 502);
}

class ConnectionManager {
  constructor({ config, mongo, clientFactory } = {}) {
    this.config = config;
    this.mongo = mongo;
    this.clientFactory = clientFactory || createMongoClient;
    this.pool = new Map(); // key -> { client, lastUsed }
    this.sweeper = setInterval(() => this.sweepIdle().catch(() => {}), 60 * 1000);
    this.sweeper.unref?.();
  }

  // -------------------------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------------------------

  /**
   * Validates student input and returns the full connection string (kept server-side only)
   * plus safe descriptive fields that may be shown to the student.
   */
  validateAtlasInput({ connectionUrl, username, password, database } = {}) {
    if (typeof connectionUrl !== 'string' || !connectionUrl.trim()) throw connErr('INVALID_URL');
    let cs;
    try {
      cs = new ConnectionString(connectionUrl.trim().replace(/<password>|<db_password>/gi, 'placeholder'));
    } catch {
      throw connErr('INVALID_URL');
    }
    if (!['mongodb', 'mongodb+srv'].includes(cs.protocol.replace(':', ''))) throw connErr('INVALID_URL');
    if (!cs.hosts.length) throw connErr('INVALID_URL');

    const user = (username ?? '').trim() || decodeURIComponent(cs.username || '');
    const urlPassword = decodeURIComponent(cs.password || '');
    const pass = password || (urlPassword && urlPassword !== 'placeholder' ? urlPassword : '');
    if (!user || !pass) throw connErr('MISSING_CREDENTIALS');

    const hostnames = cs.hosts.map((h) => h.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase());
    const allowed = this.config.atlasAllowedHostSuffixes.map((s) => s.toLowerCase());
    const ok = hostnames.every((h) => allowed.some((suffix) => h === suffix.replace(/^\./, '') || h.endsWith(suffix)));
    if (!ok) throw connErr('HOST_NOT_ALLOWED');

    const dbName = (database ?? '').trim() || cs.pathname.replace(/^\//, '');
    if (!dbName || !DB_NAME_RE.test(dbName) || RESERVED_DATABASES.has(dbName)) throw connErr('INVALID_DATABASE');

    cs.username = encodeURIComponent(user);
    cs.password = encodeURIComponent(pass);
    cs.pathname = `/${dbName}`;
    return {
      uri: cs.toString(),
      host: hostnames[0],
      database: dbName,
      usernameHint: `${user.slice(0, 2)}***`,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Testing connections
  // -------------------------------------------------------------------------------------------

  clientOptions(extra = {}) {
    return {
      serverSelectionTimeoutMS: this.config.atlasConnectTimeoutMs,
      connectTimeoutMS: this.config.atlasConnectTimeoutMs,
      maxPoolSize: 5,
      minPoolSize: 0,
      maxIdleTimeMS: 60000,
      appName: 'mongodb-practice-platform',
      ...extra,
    };
  }

  /**
   * Connects, authenticates, checks privileges and inspects the target database.
   * Does NOT create, modify or drop anything in the student's cluster.
   */
  async testAtlasConnection(uri, database, requiredCollections) {
    const client = this.clientFactory(uri, this.clientOptions());
    try {
      await client.connect();
      const db = client.db(database);
      await db.command({ ping: 1 });
      const status = await db.command({ connectionStatus: 1, showPrivileges: false }).catch(() => null);
      const roles = status?.authInfo?.authenticatedUserRoles || [];
      if (roles.some((r) => ADMIN_ROLES.has(r.role))) throw connErr('ADMIN_CREDENTIALS_NOT_ALLOWED', 400);
      const warnings = [];
      if (roles.some((r) => /AnyDatabase$/.test(r.role))) {
        warnings.push('This user can access every database in the cluster. For safety, create a user limited to your practice database.');
      }
      const collections = (await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray())
        .map((c) => c.name)
        .filter((n) => !n.startsWith('system.'));
      const present = requiredCollections.filter((c) => collections.includes(c));
      const missing = requiredCollections.filter((c) => !collections.includes(c));
      return { ok: true, presentCollections: present, missingCollections: missing, warnings };
    } catch (err) {
      const classified = classifyConnectionError(err);
      logger.warn('Atlas connection test failed', { code: classified.code, cause: err });
      throw classified;
    } finally {
      await client.close().catch(() => {});
    }
  }

  async testLocalConnection() {
    const ok = await this.mongo.ping();
    if (!ok) throw connErr('DATABASE_UNAVAILABLE', 503);
    return { ok: true };
  }

  // -------------------------------------------------------------------------------------------
  // Stored connections (encrypted at rest; never returned to clients)
  // -------------------------------------------------------------------------------------------

  encryptUri(uri) {
    return encrypt(uri, this.config.credentialEncryptionKey);
  }

  decryptUri(payload) {
    return decrypt(payload, this.config.credentialEncryptionKey);
  }

  /** Public, non-sensitive view of a stored connection. */
  static publicView(conn) {
    if (!conn) return { mode: null, status: 'not_configured' };
    return {
      mode: conn.mode,
      status: conn.status,
      host: conn.host || null,
      database: conn.database || null,
      usernameHint: conn.usernameHint || null,
      presentCollections: conn.presentCollections || [],
      missingCollections: conn.missingCollections || [],
      warnings: conn.warnings || [],
      lastTestedAt: conn.lastTestedAt || null,
      lastError: conn.lastError || null,
      connectedAt: conn.connectedAt || null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Pooled clients
  // -------------------------------------------------------------------------------------------

  async getPooledClient(key, uri, options) {
    const entry = this.pool.get(key);
    if (entry && entry.uriFingerprint === uri.length + uri.slice(-12)) {
      entry.lastUsed = Date.now();
      return entry.client;
    }
    if (entry) await this.release(key);
    const client = this.clientFactory(uri, this.clientOptions(options));
    await client.connect();
    this.pool.set(key, { client, lastUsed: Date.now(), uriFingerprint: uri.length + uri.slice(-12) });
    return client;
  }

  /** Db handle for an Atlas-mode student (their own cluster, their own database). */
  async getAtlasDb(userId, connection) {
    const uri = this.decryptUri(connection.encryptedUri);
    try {
      const client = await this.getPooledClient(`atlas:${userId}`, uri);
      return client.db(connection.database);
    } catch (err) {
      throw classifyConnectionError(err);
    }
  }

  /**
   * Db handle for a local workspace using the least-privileged identity available:
   * a per-workspace user (WORKSPACE_DB_USERS=true) or the shared query user.
   */
  async getLocalWorkspaceDb(workspace) {
    if (this.config.workspaceDbUsers && workspace.dbUser) {
      const cs = new ConnectionString(this.config.mongoAdminUri);
      cs.username = encodeURIComponent(workspace.dbUser.username);
      cs.password = encodeURIComponent(decrypt(workspace.dbUser.encryptedPassword, this.config.credentialEncryptionKey));
      cs.searchParams.set('authSource', workspace.dbName);
      const client = await this.getPooledClient(`ws:${workspace.dbName}`, cs.toString(), { maxPoolSize: 3 });
      return client.db(workspace.dbName);
    }
    return this.mongo.queryClient.db(workspace.dbName);
  }

  async release(key) {
    const entry = this.pool.get(key);
    if (!entry) return;
    this.pool.delete(key);
    await entry.client.close().catch(() => {});
  }

  async disconnectUser(userId) {
    await this.release(`atlas:${userId}`);
  }

  async sweepIdle() {
    const cutoff = Date.now() - this.config.atlasIdleCloseMs;
    for (const [key, entry] of this.pool) {
      if (entry.lastUsed < cutoff) await this.release(key);
    }
  }

  async closeAll() {
    clearInterval(this.sweeper);
    await Promise.all([...this.pool.keys()].map((k) => this.release(k)));
  }
}

module.exports = { ConnectionManager, ConnectionError, classifyConnectionError, ERROR_MESSAGES };
