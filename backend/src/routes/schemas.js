'use strict';

const { z } = require('zod');
const { PRACTICE_COLLECTIONS } = require('../provisioning/sampleData');
const { SUPPORTED_OPERATIONS } = require('../query/validator');

const register = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters.').max(80),
  email: z.string().trim().max(254).email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(128),
});

const login = z.object({
  email: z.string().trim().min(1, 'Email is required.').max(254),
  password: z.string().min(1, 'Password is required.').max(128),
});

const connection = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('local') }),
  z.object({
    mode: z.literal('atlas'),
    connectionUrl: z.string().trim().min(1, 'Connection URL is required.').max(600),
    username: z.string().trim().max(100).optional(),
    password: z.string().max(200).optional(),
    database: z.string().trim().max(64).optional(),
  }),
], { error: () => ({ message: "mode must be 'local' or 'atlas'." }) });

const initialize = z.object({ confirm: z.boolean().optional() }).default({});

const execute = z.object({
  query: z.string().max(100000),
  collection: z.string().max(120).optional(),
  database: z.string().max(120).optional(),
});

const submit = z.object({ query: z.string().max(100000) });

const access = z
  .object({ practiceDisabled: z.boolean().optional(), allowSelfReset: z.boolean().optional() })
  .refine((v) => v.practiceDisabled !== undefined || v.allowSelfReset !== undefined, 'Provide practiceDisabled or allowSelfReset.');

const createQuestion = z.object({
  questionId: z.string().regex(/^[A-Z][A-Z0-9_-]{1,19}$/, 'questionId must be like Q101.').optional(),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(5).max(2000),
  requirements: z.string().max(1000).optional(),
  topic: z.string().max(60).optional(),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
  collection: z.enum(PRACTICE_COLLECTIONS),
  kind: z.enum(['read', 'write']).optional(),
  allowedOperations: z.array(z.enum(SUPPORTED_OPERATIONS)).min(1),
  solution: z.string().min(5).max(4000),
  verifyQuery: z.string().max(4000).optional(),
  scopeQuery: z.string().max(4000).optional(),
  ordered: z.boolean().optional(),
  ignoreFields: z.array(z.string().max(60)).max(10).optional(),
  points: z.number().int().min(1).max(100).optional(),
  assignToAll: z.boolean().optional(),
});

const assign = z
  .object({
    studentIds: z.array(z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid student id.')).max(500).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.all || (v.studentIds && v.studentIds.length > 0), 'Provide studentIds or all: true.');

module.exports = { register, login, connection, initialize, execute, submit, access, createQuestion, assign };
