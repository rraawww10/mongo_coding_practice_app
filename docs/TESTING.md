# Testing

292 automated tests across four suites. Nothing needs to be running first: the backend suites start
their own throw-away MongoDB.

```bash
npm test
```

```
══════════════════════════ TEST SUMMARY ══════════════════════════
Suite                     Passed  Failed  Skipped   Total     Time
✓ backend unit               100       0        0     100     1.5s
✓ backend integration        160       0        1     161     6.7s
✓ backend e2e                 16       0        0      16     2.3s
✓ frontend                    15       0        0      15     1.5s
──────────────────────────────────────────────────────────────────
  TOTAL                      291       0        1     292
RESULT: ALL TESTS PASSED
```

The one skipped test is the optional real-Atlas test. It runs only when you configure a test
cluster — see [§5](#5-optional-real-atlas-test). Nothing else is ever skipped silently.

---

## 1. Running them

| Command | Runs |
|---|---|
| `npm test` | Everything, with the summary above |
| `npm run test:unit` | Backend unit (mocks only, no database) |
| `npm run test:integration` | Backend integration (real `mongod`) |
| `npm run test:e2e` | Backend end-to-end over HTTP |
| `npm run test:frontend` | Vitest + Testing Library |
| `npm run test:coverage` | Everything, plus coverage into `test-reports/coverage/` |

All of these are wrappers around `scripts/run-all-tests.js`. You can call it directly:

```bash
node scripts/run-all-tests.js                   # everything
node scripts/run-all-tests.js --only unit,e2e   # a subset
node scripts/run-all-tests.js --coverage
```

**Exit codes:** `0` all passed · `1` test failures (each one is listed) · `2` a prerequisite is
missing. The runner checks the Node version, that dependencies are installed and that MongoDB can
be started *before* running anything, and stops with `PREREQUISITE MISSING: …` and a fix rather
than letting a suite fail confusingly.

JSON reports for every suite land in `test-reports/`.

### Using a MongoDB you already have

By default the integration and e2e suites launch their own `mongod` via `mongodb-memory-server`.
To reuse a running instance instead — which is faster, and the way to run them offline:

```bash
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test                 # bash
```
```powershell
$env:MONGODB_TEST_URI="mongodb://127.0.0.1:27017"; npm test          # PowerShell
```

### Running one file or one test

```bash
cd backend
npx jest --selectProjects integration tests/integration/query.test.js
npx jest --selectProjects unit -t "rejects \$where"

cd ../frontend
npx vitest run src/test/PracticePage.test.jsx
npx vitest            # watch mode
```

---

## 2. What each suite covers

### Backend unit — 100 tests, no database

| File | Tests | Covers |
|---|---|---|
| `tests/unit/validator.test.js` | 29 | Collection/operation/stage allowlists, forbidden operators, nested `$facet`, join targets, update operators, size caps |
| `tests/unit/connectionManager.test.js` | 27 | URI validation, host allowlist, admin-user refusal, encryption round-trip, pooled-client lifecycle, error classification |
| `tests/unit/parser.test.js` | 24 | Grammar, value literals, JS-keyword rejection, `__proto__`, depth limit, line/column in errors |
| `tests/unit/canonical.test.js` | 7 | Result normalization and comparison, ordered vs unordered, ignored fields |
| `tests/unit/executor.test.js` | 7 | Dispatch, result capping, the timeout race against a mocked hanging driver |
| `tests/unit/middleware.test.js` | 3 | Authentication, role checks, rate limiting |
| `tests/unit/security-utils.test.js` | 3 | AES-256-GCM helpers and logger redaction |

### Backend integration — 161 tests, real MongoDB

| File | Tests | Covers |
|---|---|---|
| `tests/integration/query.test.js` | 56 | Every supported operation against real data, plus every blocked path |
| `tests/integration/evaluation.test.js` | 40 | Grading, including **every reference solution in the question bank** |
| `tests/integration/connection.test.js` | 20 | Local and Atlas connection handling against a real, auth-enabled `mongod` |
| `tests/integration/auth.test.js` | 19 | Registration, login, tokens, rate limiting, enumeration resistance |
| `tests/integration/provisioning.test.js` | 12 | Seeding, workspace creation, one-call bootstrap, collection browser |
| `tests/integration/admin.test.js` | 10 | Instructor and admin routes, RBAC, audit log |
| `tests/integration/leastPrivilege.test.js` | 3 | A workspace DB user is refused on another workspace's database |
| `tests/integration/atlas.optional.test.js` | 1 | Real Atlas — skipped unless configured ([§5](#5-optional-real-atlas-test)) |

### Backend e2e — 16 tests

`tests/e2e/workflow.test.js` drives the real HTTP API through Supertest exactly as the browser
does: register → connect → workspace bootstrap → list questions → run a query → submit a wrong
answer → submit a correct one → reset → check progress.

### Frontend — 15 tests

| File | Tests | Covers |
|---|---|---|
| `src/test/PracticePage.test.jsx` | 7 | The three-column IDE: run, submit, error states, the collections drawer |
| `src/test/client.test.js` | 4 | API client: token handling, error envelope, network failure, 401 handling |
| `src/test/ConnectionPage.test.jsx` | 4 | Database page: local vs Atlas, validation, masked password |

---

## 3. How the environment is arranged

**Unit tests** use mocks only, including a fake driver client. They need no database and no network.

**Integration and e2e tests** each start a throw-away `mongod` (or use `MONGODB_TEST_URI`), with a
unique database name per test file that is dropped afterwards, so files cannot interfere with each
other. `tests/helpers/mongo.js` owns that lifecycle; `tests/helpers/context.js` builds the service
graph through `bootstrap()`, exactly as the server does; `tests/helpers/setupEnv.js` supplies the
required environment variables so tests never depend on your `backend/.env`.

**The "Atlas" side** is simulated by a second, **authentication-enabled** `mongod`. That makes the
interesting cases real rather than mocked: wrong password, admin user refused, replacing a
connection, encryption verified against a live server. An invalid hostname is real too (a `.invalid`
domain that genuinely fails DNS), as is an unreachable database (a closed port).

Two things cannot be reproduced locally and are mocked deliberately: **network timeouts** and
**Atlas IP access-list denial**. Both inject a fake driver client through the `clientFactory` seam.

**Query timeout is tested twice** — once with a mocked driver that never resolves, to prove the
wall-clock guard fires, and once against a real `mongod` using the `maxTimeAlwaysTimeOut` fail
point, to prove `maxTimeMS` is actually passed through.

---

## 4. Coverage

```bash
npm run test:coverage
```

HTML reports are written per suite:

```
test-reports/coverage/backend-unit/index.html
test-reports/coverage/backend-integration/index.html
test-reports/coverage/backend-e2e/index.html
test-reports/coverage/frontend/index.html
```

Coverage is collected from `backend/src/**` (excluding `server.js`, which only binds a port) and
`frontend/src/**`.

---

## 5. Optional: real Atlas test

`tests/integration/atlas.optional.test.js` is skipped unless both variables are set. It refuses any
database whose name contains `prod`, as a guard against pointing it somewhere real.

```bash
ATLAS_TEST_URI="mongodb+srv://<user>:<pw>@<test-cluster>.mongodb.net/" \
ATLAS_TEST_DB=practice_ci \
npm run test:integration
```

```powershell
$env:ATLAS_TEST_URI="mongodb+srv://<user>:<pw>@<test-cluster>.mongodb.net/"
$env:ATLAS_TEST_DB="practice_ci"
npm run test:integration
```

Use a **dedicated test cluster and database**. The test creates and drops the practice collections
in the database you name.

---

## 6. Writing tests

* **A new query form, operator or stage → a unit test.** Add it to `tests/unit/validator.test.js`
  or `tests/unit/parser.test.js`. Anything you *block* needs a test proving it stays blocked —
  that is the regression suite for the sandbox.
* **A new endpoint → an integration test** in the file for its area, using `tests/helpers/context.js`
  so you get the real service graph.
* **A new question → nothing extra.** `evaluation.test.js` iterates the whole question bank and
  executes every reference solution, so a new question is covered automatically — and a question
  with an ambiguous or empty expected result fails the suite.
* **A user-visible flow → extend `tests/e2e/workflow.test.js`.**
* **A React component → a Vitest file** in `frontend/src/test/`, with `helpers.jsx` for rendering
  inside the router and auth context.

Conventions: no `.skip` left in a committed test (the runner reports skips, and the only expected
one is the Atlas test); no test depends on another file's state; database names come from the
helper, never hard-coded.

---

## 7. When a suite will not run

| Message | Fix |
|---|---|
| `PREREQUISITE MISSING: MongoDB is not available` | The first run downloads `mongod` and needs internet. Otherwise start MongoDB yourself and set `MONGODB_TEST_URI` |
| `PREREQUISITE MISSING: backend dependencies are not installed` | `npm run install:all` |
| `PREREQUISITE MISSING: Node.js <version>` | Node 18+ required; 20 LTS recommended |
| Integration tests hang on the first run | The `mongod` download is in progress — give it a minute |
| Port conflicts | The suites use ephemeral ports; a stray `mongod` from a crashed run may linger — stop it |

More in [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).
