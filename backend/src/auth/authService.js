'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { conflict, unauthorized, forbidden } = require('../utils/errors');

const ROLES = ['student', 'instructor', 'admin'];

class AuthService {
  constructor({ mongo, config }) {
    this.mongo = mongo;
    this.config = config;
  }

  get users() {
    return this.mongo.collection('users');
  }

  static publicUser(u) {
    if (!u) return null;
    return {
      id: String(u._id),
      name: u.name,
      email: u.email,
      role: u.role,
      practiceDisabled: Boolean(u.practiceDisabled),
      allowSelfReset: u.allowSelfReset !== false,
      createdAt: u.createdAt,
    };
  }

  async register({ name, email, password }, role = 'student') {
    if (!ROLES.includes(role)) throw new Error(`Invalid role ${role}`);
    const normalized = email.trim().toLowerCase();
    const doc = {
      name: name.trim(),
      email: normalized,
      passwordHash: await bcrypt.hash(password, this.config.bcryptRounds || 10),
      role,
      practiceDisabled: false,
      allowSelfReset: true,
      createdAt: new Date(),
    };
    try {
      const { insertedId } = await this.users.insertOne(doc);
      return { ...doc, _id: insertedId };
    } catch (err) {
      if (err.code === 11000) throw conflict('EMAIL_TAKEN', 'An account with this email already exists.');
      throw err;
    }
  }

  async login({ email, password }) {
    const user = await this.users.findOne({ email: String(email).trim().toLowerCase() });
    // Same error for unknown email and wrong password to avoid account enumeration.
    const ok = user && (await bcrypt.compare(String(password), user.passwordHash));
    if (!ok) throw unauthorized('Invalid email or password.');
    if (user.accountDisabled) throw forbidden('ACCOUNT_DISABLED', 'This account has been disabled.');
    await this.users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    return { token: this.sign(user), user: AuthService.publicUser(user) };
  }

  sign(user) {
    return jwt.sign({ sub: String(user._id), role: user.role }, this.config.jwtSecret, {
      expiresIn: this.config.jwtExpiresIn,
      issuer: 'mongodb-practice-platform',
    });
  }

  async verify(token) {
    let payload;
    try {
      payload = jwt.verify(token, this.config.jwtSecret, { issuer: 'mongodb-practice-platform' });
    } catch {
      throw unauthorized('Session is invalid or has expired. Please log in again.');
    }
    if (!ObjectId.isValid(payload.sub)) throw unauthorized();
    const user = await this.users.findOne({ _id: new ObjectId(payload.sub) });
    if (!user) throw unauthorized('Account no longer exists.');
    if (user.accountDisabled) throw forbidden('ACCOUNT_DISABLED', 'This account has been disabled.');
    return user;
  }

  /** Creates or updates the instructor account defined in the environment (idempotent). */
  async ensureInstructor({ name, email, password, role = 'instructor' }) {
    if (!password) return null;
    const normalized = email.toLowerCase();
    const existing = await this.users.findOne({ email: normalized });
    if (existing) {
      await this.users.updateOne(
        { _id: existing._id },
        { $set: { role, name, passwordHash: await bcrypt.hash(password, this.config.bcryptRounds || 10) } },
      );
      return { ...existing, role };
    }
    return this.register({ name, email: normalized, password }, role);
  }
}

module.exports = { AuthService, ROLES };
