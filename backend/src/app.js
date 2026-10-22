'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const schemas = require('./routes/schemas');
const { authenticate, validate, rateLimit, errorHandler } = require('./middleware');
const { AuthService } = require('./auth/authService');
const { ConnectionManager } = require('./connections/connectionManager');
const { ProvisioningService } = require('./provisioning/provisioningService');
const { QueryExecutor } = require('./query/executor');
const { EvaluationService } = require('./questions/evaluationService');
const { QuestionService } = require('./questions/questionService');
const { ProgressService } = require('./services/progressService');
const { AuditService } = require('./services/auditService');
const { WorkspaceService } = require('./services/workspaceService');
const { studentRoutes } = require('./routes/studentRoutes');
const { adminRoutes } = require('./routes/adminRoutes');
const { notFound } = require('./utils/errors');

/** Wires services together. Exposed separately so scripts and tests can reuse them. */
function createServices({ config, mongo, clientFactory }) {
  const executor = new QueryExecutor({
    maxResults: config.queryMaxResults,
    timeoutMs: config.queryTimeoutMs,
    maxLength: config.queryMaxLength,
  });
  const provisioning = new ProvisioningService({ mongo, config });
  const connections = new ConnectionManager({ config, mongo, clientFactory });
  const evaluation = new EvaluationService({ provisioning, executor });
  return {
    config,
    mongo,
    executor,
    provisioning,
    connections,
    evaluation,
    auth: new AuthService({ mongo, config }),
    questions: new QuestionService({ mongo, executor, evaluation }),
    progress: new ProgressService({ mongo }),
    audit: new AuditService({ mongo }),
    workspaces: new WorkspaceService({ mongo, config, provisioning, connections }),
  };
}

function createApp(services) {
  const { config, auth, audit, mongo } = services;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: false }));
  app.use(express.json({ limit: config.requestBodyLimit }));

  const limiters = {
    auth: rateLimit({ max: config.authRateLimitPerMinute, name: 'login attempts' }),
    query: rateLimit({ max: config.queryRateLimitPerMinute, name: 'queries' }),
    connection: rateLimit({ max: 20, name: 'connection attempts' }),
  };
  services.limiters = limiters;

  app.get('/api/health', async (_req, res) => {
    const dbUp = await mongo.ping();
    res.status(dbUp ? 200 : 503).json({
      status: dbUp ? 'ok' : 'degraded',
      database: dbUp ? 'up' : 'down',
      mode: 'local-simulation+atlas',
      uptimeSeconds: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
  });

  // ---- public auth -------------------------------------------------------------------------
  app.post('/api/auth/register', limiters.auth, validate(schemas.register), async (req, res) => {
    const user = await auth.register(req.body, 'student');
    await audit.record({ actor: { id: user._id, email: user.email, role: 'student' }, action: 'auth.register', targetUserId: user._id });
    const { token } = await auth.login(req.body);
    res.status(201).json({ token, user: AuthService.publicUser(user) });
  });

  app.post('/api/auth/login', limiters.auth, validate(schemas.login), async (req, res) => {
    res.json(await auth.login(req.body));
  });

  // ---- authenticated -----------------------------------------------------------------------
  const requireAuth = authenticate(auth);
  app.use('/api/admin', requireAuth, adminRoutes(services));
  app.use('/api', requireAuth, studentRoutes(services));

  app.use('/api', (_req, _res, next) => next(notFound('ROUTE_NOT_FOUND', 'API route not found.')));

  // Single-service deployments: serve the built UI (frontend/dist) from the same origin.
  const uiDir = path.join(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(path.join(uiDir, 'index.html'))) {
    app.use(express.static(uiDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(uiDir, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}

module.exports = { createApp, createServices };
