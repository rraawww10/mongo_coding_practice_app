'use strict';

const crypto = require('crypto');

/** AES-256-GCM encryption for credentials stored at rest (Atlas connection strings). */
function encrypt(plainText, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

function decrypt(payload, hexKey) {
  const [version, iv, tag, data] = String(payload).split(':');
  if (version !== 'v1') throw new Error('Unsupported credential format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

const randomPassword = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

module.exports = { encrypt, decrypt, randomPassword };
