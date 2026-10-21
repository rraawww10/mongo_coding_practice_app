'use strict';

// Tests never read a developer's backend/.env and never use real Atlas credentials.
process.env.NODE_ENV = 'test';
process.env.DOTENV_PATH = '/nonexistent/.env';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'silent';
