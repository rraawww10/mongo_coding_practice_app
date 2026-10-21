'use strict';

/**
 * Creates backend/.env from .env.example with freshly generated secrets.
 * Works the same on Linux, macOS and Windows PowerShell:  npm run setup:env
 * Refuses to overwrite an existing .env unless --force is given.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = path.resolve(__dirname, '..');
const target = path.join(dir, '.env');
if (fs.existsSync(target) && !process.argv.includes('--force')) {
  console.log('backend/.env already exists - leaving it unchanged (use --force to regenerate).');
  process.exit(0);
}
// No '#' (dotenv treats an unquoted # as a comment); value is quoted anyway.
const instructorPassword = `Instr-${crypto.randomBytes(9).toString('base64url')}`;
const env = fs
  .readFileSync(path.join(dir, '.env.example'), 'utf8')
  .replace('JWT_SECRET=<generate-a-long-random-secret>', `JWT_SECRET=${crypto.randomBytes(48).toString('base64url')}`)
  .replace('CREDENTIAL_ENCRYPTION_KEY=<64-hex-characters>', `CREDENTIAL_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`)
  .replace('INSTRUCTOR_PASSWORD=<choose-a-strong-password>', `INSTRUCTOR_PASSWORD="${instructorPassword}"`);
fs.writeFileSync(target, env, { mode: 0o600 });
console.log('Created backend/.env with generated secrets.');
console.log(`Instructor login: instructor@practice.local / ${instructorPassword}  (change INSTRUCTOR_PASSWORD in backend/.env if you like)`);
