'use strict';

/**
 * Central configuration. Every value can be supplied through environment
 * variables (see ../.env.example). `loadConfig(overrides)` lets tests build
 * isolated configurations without touching process.env.
 */
const path = require('path');

require('dotenv').config({ path: process.env.DOTENV_PATH || path.join(__dirname, '..', '.env'), quiet: true });

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};
const list = (value, fallback) =>
  value === undefined || value === ''
    ? fallback
    : String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

function loadConfig(overrides = {}) {
  const env = process.env;
  const config = {
    env: env.NODE_ENV || 'development',
    port: int(env.PORT, 4000),
    corsOrigin: list(env.CORS_ORIGIN, ['http://localhost:5173']),

    // Two separate MongoDB identities: provisioning/administration vs. student query execution.
    mongoAdminUri: env.MONGODB_ADMIN_URI || 'mongodb://127.0.0.1:27017',
    mongoQueryUri: env.MONGODB_QUERY_URI || '',
    appDbName: env.APP_DB_NAME || 'practice_platform',
    templateDbName: env.TEMPLATE_DB_NAME || 'mongodb_practice',
    workspaceDbPrefix: env.WORKSPACE_DB_PREFIX || 'mp_ws_',
    // When true, every workspace gets its own MongoDB user that only has readWrite on that one
    // database, and student queries run with that user (requires a MongoDB with auth enabled).
    workspaceDbUsers: bool(env.WORKSPACE_DB_USERS, false),

    jwtSecret: env.JWT_SECRET || '',
    jwtExpiresIn: env.JWT_EXPIRES_IN || '8h',
    bcryptRounds: int(env.BCRYPT_ROUNDS, 10),
    // 32 bytes, hex encoded. Used to encrypt stored Atlas connection strings (AES-256-GCM).
    credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY || '',

    requestBodyLimit: env.REQUEST_BODY_LIMIT || '16kb',
    queryMaxLength: int(env.QUERY_MAX_LENGTH, 4000),
    queryMaxResults: int(env.QUERY_MAX_RESULTS, 100),
    queryTimeoutMs: int(env.QUERY_TIMEOUT_MS, 3000),
    queryRateLimitPerMinute: int(env.QUERY_RATE_LIMIT_PER_MIN, 60),
    authRateLimitPerMinute: int(env.AUTH_RATE_LIMIT_PER_MIN, 30),

    atlasAllowedHostSuffixes: list(env.ATLAS_ALLOWED_HOST_SUFFIXES, ['.mongodb.net']),
    atlasConnectTimeoutMs: int(env.ATLAS_CONNECT_TIMEOUT_MS, 8000),
    atlasIdleCloseMs: int(env.ATLAS_IDLE_CLOSE_MS, 10 * 60 * 1000),

    instructorEmail: env.INSTRUCTOR_EMAIL || 'instructor@practice.local',
    instructorPassword: env.INSTRUCTOR_PASSWORD || '',
    instructorName: env.INSTRUCTOR_NAME || 'Course Instructor',

    logLevel: env.LOG_LEVEL || 'info',
    ...overrides,
  };
  return config;
}

function assertConfig(config) {
  const problems = [];
  if (!config.jwtSecret || config.jwtSecret.length < 32) problems.push('JWT_SECRET must be set (at least 32 characters).');
  if (!/^[0-9a-f]{64}$/i.test(config.credentialEncryptionKey || '')) {
    problems.push('CREDENTIAL_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  }
  if (!/^[a-z0-9_]{1,20}$/i.test(config.workspaceDbPrefix)) problems.push('WORKSPACE_DB_PREFIX must be alphanumeric/underscore.');
  if (problems.length) {
    const err = new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    err.code = 'CONFIG_INVALID';
    throw err;
  }
  return config;
}

module.exports = { loadConfig, assertConfig };
