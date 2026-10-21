# Backend — API server

Node.js 18+ · Express 5 · native MongoDB driver 7 · CommonJS.

The API that grades MongoDB queries. Its one hard requirement: student query text is **never
executed as JavaScript**. Everything in `src/query/` exists to honour that.

```bash
npm install
npm run setup:env     # writes ../backend/.env with generated secrets
npm run mongo:local   # terminal 1 — a real mongod, no Docker
npm run seed          # template data + question bank + instructor account
npm run dev           # http://localhost:4000
```

Full instructions: [`../docs/SETUP.md`](../docs/SETUP.md).

---

## Layout

```
src/
  server.js        the only file that listens on a port
  bootstrap.js     config → MongoManager → services → optional seed → shutdown()
  app.js           createServices() + createApp(): middleware chain and route mounting
  config.js        reads .env, coerces, validates; assertConfig() throws CONFIG_INVALID

  routes/
    studentRoutes.js  /api/me, dashboard, connection, workspace, query, questions, progress
    adminRoutes.js    /api/admin/* — instructor and admin operations
    schemas.js        zod schemas for every request body

  middleware/
    index.js          authenticate · validate · rateLimit · errorHandler

  auth/
    authService.js    register, login, bcrypt, JWT, ensureInstructor, publicUser

  query/                           ← the security-critical path
    parser.js         recursive-descent parser for a data-only grammar
    validator.js      allowlists: collections, operations, stages, update operators
    executor.js       driver dispatch, timeouts, result caps, error translation

  questions/
    questionBank.js       the 26 seed questions, with server-only reference solutions
    questionService.js    listing, assignment, submission
    evaluationService.js  grading in a disposable sandbox

  connections/
    connectionManager.js  Atlas URI validation, AES-256-GCM, pooled clients, idle sweep

  provisioning/
    provisioningService.js  seed template, clone workspaces, per-workspace DB users, sandboxes
    sampleData.js           the canonical dataset and its indexes

  services/
    workspaceService.js  façade over connections + provisioning; resolves the target database
    progressService.js   attempts, best score, completion
    auditService.js      append-only audit log

  db/
    mongo.js          MongoManager: admin/query clients, appDb, ensureAppIndexes, ping
    createClient.js   the driver-client factory (the seam tests replace)

  utils/
    canonical.js      result normalization and comparison for grading
    crypto.js         AES-256-GCM helpers
    errors.js         typed HTTP errors
    logger.js         levelled logging; redacts every mongodb:// URI

scripts/
  setup-env.js    generate backend/.env with real secrets  (--force to overwrite)
  local-mongo.js  start a real mongod without Docker       (MONGO_LOCAL_PORT)
  seed.js         seed template dataset, questions, instructor
  reset.js        restore template / one student / all workspaces
  health.js       hit /api/health and print the result

tests/
  unit/           mocks only, no database
  integration/    real throw-away mongod per file
  e2e/            the full workflow over HTTP via Supertest
  helpers/        mongo lifecycle, service-graph context, test env vars
```

---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Start with `node --watch` |
| `npm start` | Start without auto-reload |
| `npm run setup:env` | Generate `.env` (`-- --force` to overwrite an existing one) |
| `npm run mongo:local` | Run a real `mongod` on 127.0.0.1:27017 (`MONGO_LOCAL_PORT` to change) |
| `npm run seed` | Template dataset + questions + instructor account. Idempotent |
| `npm run reset-db` | Restore the template database |
| `npm run reset-db -- --student <email>` | Restore one student's workspace |
| `npm run reset-db -- --all-workspaces` | Restore every workspace |
| `npm run health` | Check `/api/health` |
| `npm run test:unit` / `test:integration` / `test:e2e` | One suite |
| `npm test` | All backend suites through the repo-level runner |
| `npm run test:coverage` | Coverage into `coverage/` |

---

## Composition

Services are constructed once and injected — no module-level singletons — so scripts and tests build
the same object graph without starting a server.

```js
const { bootstrap } = require('./src/bootstrap');

const services = await bootstrap({ seed: true });
// services: config, mongo, executor, provisioning, connections, evaluation,
//           auth, questions, progress, audit, workspaces, shutdown()

const app = createApp(services);   // src/app.js
```

`bootstrap()` accepts `overrides` (config), `seed` (ensure template/questions/instructor) and
`clientFactory` — the seam that lets tests substitute a fake driver client for failures that cannot
be produced locally, such as network timeouts.

---

## Request pipeline

```
helmet → cors → express.json(limit) → rateLimit → authenticate → validate(zod) → handler → errorHandler
```

* **`authenticate`** verifies the JWT and then **reloads the user from the database**. The role used
  for authorization comes from that record, never from the token, so a demotion takes effect on the
  next request.
* **`validate`** uses the zod schemas in `routes/schemas.js`; failures become `400 VALIDATION_ERROR`
  naming the field.
* **`rateLimit`** maintains three in-memory buckets (auth, query, connection), keyed per user when
  authenticated and per IP otherwise. Per-process — see the limitation note in
  [`../docs/SECURITY.md`](../docs/SECURITY.md).
* **`errorHandler`** maps typed errors onto `{ error: { code, message, line?, column? } }`.
  Unrecognised errors become a generic `500`; the real stack is logged, redacted.

Routes stay thin — the work belongs in a service.

---

## The query path

`parser.js → validator.js → executor.js`, described fully in
[`../docs/ARCHITECTURE.md §4`](../docs/ARCHITECTURE.md) and justified in
[`../docs/SECURITY.md`](../docs/SECURITY.md). The rules when touching these files:

* **Nothing reaches `eval`, `Function`, `vm` or a shell.** The parser produces a plain description
  of an operation; the executor dispatches it to a typed driver call.
* **Every list is positive.** Collections, operations, chain modifiers, pipeline stages and update
  operators are allowlists. If you add a capability, add it to the list *and* to
  `tests/unit/validator.test.js`.
* **Anything you block needs a test proving it stays blocked.** That suite is the regression net
  for the sandbox.
* **The target database never comes from the request.** `WorkspaceService.resolveDb(userId)` derives
  it from the session. Do not add a code path that trusts a `database` field.

---

## Adding a question

1. Append a `q({ … })` entry to `src/questions/questionBank.js`:

   ```js
   q({
     questionId: 'Q027',
     title: 'Courses under 2000',
     topic: 'Comparison operators',
     difficulty: 'beginner',          // sets points: 10 / 20 / 30
     collection: 'courses',
     description: 'Find every course priced below 2000.',
     requirements: 'Return complete documents. Order does not matter.',
     solution: 'db.courses.find({ price: { $lt: 2000 } })',
   })
   ```

   Defaults supplied by `q()`: `kind: 'read'`, `ordered: false`, `ignoreFields: ['_id']`,
   `allowedOperations: [find, findOne, aggregate, countDocuments, distinct]`, `assignToAll: true`.

   For a write question add `kind: 'write'`, `verifyQuery` (did the intended change happen?) and
   `scopeQuery` (did anything else change?).

2. `npm run seed` — idempotent; `questionId` is the unique key.
3. `npm run test:integration` — `tests/integration/evaluation.test.js` executes **every** reference
   solution against the dataset, so a new question is covered automatically. A question whose
   expected result is empty or ambiguous fails the suite, which is the point.

Expected results are never hand-written: they are computed by running `solution` against a pristine
copy of the dataset and cached. They cannot drift from the seed data.

`solution`, `verifyQuery` and `scopeQuery` are server-only and are stripped from every
student-facing response. Only `/api/admin/questions` returns them.

---

## Changing the practice dataset

Edit `src/provisioning/sampleData.js`, then `npm run seed` and
`npm run reset-db -- --all-workspaces` to push the change into existing workspaces. Keep `_id`
values fixed and derived — random ObjectIds break idempotent seeding and ordered questions. See
[`../docs/DATA_MODEL.md`](../docs/DATA_MODEL.md).

---

## Configuration

Every variable is documented in [`.env.example`](.env.example), with a summary table in
[`../docs/SETUP.md`](../docs/SETUP.md). `config.js` validates on load and `server.js` turns a
`CONFIG_INVALID` error into instructions rather than a stack trace.

`.env` is git-ignored. `.env.example` holds placeholders only — never a real credential.

---

## Tests

```bash
npm run test:unit          # 100, mocks only
npm run test:integration   # 161, real mongod
npm run test:e2e           # 16, over HTTP
```

Reuse a running MongoDB with `MONGODB_TEST_URI=mongodb://127.0.0.1:27017`. Details, including how
Atlas failures are simulated and why the query timeout is tested twice, are in
[`../docs/TESTING.md`](../docs/TESTING.md).

---

## Conventions

* CommonJS, `'use strict'` at the top of every file.
* Errors are typed and carry a stable `code`; the HTTP status lives with the error, not the route.
* Nothing logs a connection string — `logger.redact()` handles any object you hand it, but do not
  rely on it as a substitute for not logging secrets.
* Services take their dependencies in the constructor. If a new service needs another, wire it in
  `createServices()`.
