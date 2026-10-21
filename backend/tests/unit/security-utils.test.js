'use strict';

const logger = require('../../src/utils/logger');
const { encrypt, decrypt } = require('../../src/utils/crypto');

const KEY = 'ab'.repeat(32);

describe('logger redaction', () => {
  test('redacts connection strings inside messages and metadata', () => {
    const lines = [];
    const remove = logger.addSink((line) => lines.push(line));
    logger.error('failed mongodb+srv://alice:s3cret@cluster0.abc.mongodb.net/db', {
      uri: 'mongodb://bob:pw@host/db',
      nested: { note: 'see mongodb://carol:pw2@h:27017' },
      password: 'hunter2',
    });
    remove();
    const out = lines.join('\n');
    expect(out).not.toMatch(/s3cret|alice|bob|pw2|hunter2|carol/);
    expect(out).toContain('[REDACTED]');
  });
});

describe('credential encryption', () => {
  test('round-trips and produces non-deterministic ciphertext', () => {
    const uri = 'mongodb+srv://u:p@cluster0.x.mongodb.net/practice';
    const c1 = encrypt(uri, KEY);
    const c2 = encrypt(uri, KEY);
    expect(c1).not.toEqual(c2);
    expect(c1).not.toContain('cluster0');
    expect(decrypt(c1, KEY)).toBe(uri);
  });

  test('detects tampering', () => {
    const c = encrypt('secret', KEY).split(':');
    c[3] = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(c.join(':'), KEY)).toThrow();
  });
});
