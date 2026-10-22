# MongoDB Coding Practice Platform

Students practise MongoDB queries in a browser IDE: questions on the left, the question description
in the middle, the code playground on the right, and a **Show collections** drawer that displays the
documents being queried exactly as MongoDB does. Each student gets an **isolated copy** of the
`mongodb_practice` database — either on the platform's local MongoDB (simulation mode) or in their
own MongoDB Atlas database. Submissions are graded automatically.

There is **one dashboard** — the student's. The platform has no instructor UI; the admin REST API is
still there for scripted administration (see [`docs/API.md`](docs/API.md)).

* **Frontend:** React 18 + Vite — [`frontend/`](frontend/README.md)
* **Backend:** Node.js + Express 5 + native MongoDB driver 7 — [`backend/`](backend/README.md)
* **Local database:** a real `mongod`, started without Docker via `mongodb-memory-server`, *or* Docker Compose
* **Tests:** 297 — Jest + Supertest (backend unit / integration / e2e), Vitest + Testing Library (frontend)

No Atlas account is needed to run, develop or test anything.

---

## Documentation

| Document | Covers |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Installing, configuring and running — three paths, every variable |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it works: request flow, the query pipeline, workspaces, grading |
| [`docs/API.md`](docs/API.md) | The REST API — every endpoint, body, response and error code |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Databases, collections, the sample data, the question bank |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, the control answering each threat, known limitations |
| [`docs/TESTING.md`](docs/TESTING.md) | Running, reading and extending the test suites |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Fixing what will not start |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Changing the code: conventions, rules, adding a question |
| [`backend/README.md`](backend/README.md) · [`frontend/README.md`](frontend/README.md) | Working inside one half |
| [`HANDOVER.md`](HANDOVER.md) | Handing the project over, or demoing it in five minutes |

---

## 1. Quick start

Requires Node.js 18+ (20 LTS recommended). The first run downloads a `mongod` binary (~100 MB,
cached in `~/.cache/mongodb-binaries`).

```bash
git clone https://github.com/rraawww10/mongo_coding_practice_app.git
cd mongo_coding_practice_app

npm run install:all          # 1. install backend + frontend dependencies
npm run setup:env            # 2. create backend/.env with generated secrets (prints the instructor login)

npm run mongo:local          # 3. local MongoDB on 127.0.0.1:27017   (terminal 1, keep running)
#   or, with Docker:  docker compose up -d mongo   (then set MONGODB_ADMIN_URI, see docs/SETUP.md)

npm run seed                 # 4. initialize the dataset, question bank and instructor account
npm run dev:backend          # 5. API on http://localhost:4000       (terminal 2)
npm run dev:frontend         # 6. UI  on http://localhost:5173       (terminal 3)
npm run health               # 7. check application health
```

Every `npm run …` command is identical on Linux, macOS and Windows PowerShell. On PowerShell, step
7 can also be `Invoke-RestMethod http://localhost:4000/api/health`.

Open <http://localhost:5173> and register as a student. That is the whole setup: the first visit to
**Coding Practice** connects you to the local simulation and fills your private workspace
automatically. The **Database** page is only needed to point the platform at your own MongoDB Atlas
database instead.

Docker, an existing MongoDB, and the full configuration reference: [`docs/SETUP.md`](docs/SETUP.md).

---

## 2. Every command

| # | Task | Command |
|---|------|---------|
| 1 | Install dependencies | `npm run install:all` |
| 2 | Start local MongoDB (no Docker) | `npm run mongo:local` |
| 2b | Start MongoDB with Docker | `docker compose up -d mongo` |
| 3 | Configure environment | `npm run setup:env` |
| 4 | Start backend | `npm run dev:backend` (`npm run start:backend` without auto-reload) |
| 5 | Start frontend | `npm run dev:frontend` |
| 6 | Initialize sample databases | `npm run seed` (safe to run repeatedly) |
| 7 | Unit tests | `npm run test:unit` |
| 8 | Integration tests | `npm run test:integration` |
| 9 | End-to-end tests | `npm run test:e2e` |
| – | Frontend tests | `npm run test:frontend` |
| 10 | **All tests + summary** | `npm test` |
| 11 | Coverage report | `npm run test:coverage` → `test-reports/coverage/` |
| 12 | Reset practice databases | `npm run reset-db` · all workspaces: `npm --prefix backend run reset-db -- --all-workspaces` · one student: `npm --prefix backend run reset-db -- --student s@x.com` |
| 13 | Health check | `npm run health` or `curl http://localhost:4000/api/health` |
| – | Production build of UI | `npm run build` |

Using an already-running MongoDB for the tests (for example the Docker one):

```bash
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test                 # bash
```
```powershell
$env:MONGODB_TEST_URI="mongodb://127.0.0.1:27017"; npm test          # PowerShell
```

### What `npm test` does

`scripts/run-all-tests.js` checks prerequisites first (Node version, installed dependencies, and a
usable MongoDB). It then runs backend unit, backend integration, backend e2e and frontend tests, and
prints a summary:

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

Exit code `0` = all passed, `1` = failures (each failing test is listed), `2` = **missing
prerequisite** — the script stops with `PREREQUISITE MISSING: …` and tells you how to fix it, so
integration tests are never skipped silently. The single skipped test is the optional real-Atlas
test. Details: [`docs/TESTING.md`](docs/TESTING.md).

---

## 3. Configuration

`backend/.env` is generated by `npm run setup:env` and git-ignored.
[`backend/.env.example`](backend/.env.example) documents every variable (placeholders only); the
full table is in [`docs/SETUP.md`](docs/SETUP.md#configuration-reference). The ones that matter most:

| Variable | Purpose |
|---|---|
| `MONGODB_ADMIN_URI` | Provisioning identity (seeding, workspaces, users, audit logs). Local default `mongodb://127.0.0.1:27017` |
| `MONGODB_QUERY_URI` | Optional separate, lower-privileged identity for student queries |
| `WORKSPACE_DB_USERS` | `true` = every workspace gets its own MongoDB user with `readWrite` on **that database only** (needs an auth-enabled MongoDB, e.g. Docker) |
| `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` | Session signing; AES-256-GCM key for stored Atlas connection strings |
| `INSTRUCTOR_EMAIL`, `INSTRUCTOR_PASSWORD` | Admin account created by `npm run seed` |
| `QUERY_MAX_RESULTS`, `QUERY_TIMEOUT_MS`, `QUERY_MAX_LENGTH`, `REQUEST_BODY_LIMIT`, `QUERY_RATE_LIMIT_PER_MIN` | Query sandbox limits |
| `ATLAS_ALLOWED_HOST_SUFFIXES` | Hosts a student may connect the server to (default `.mongodb.net`; prevents pointing the server at internal hosts) |

---

## 4. Features

**Coding practice (the main screen), in three columns:**

* **Left** – the 26 questions grouped by topic, each showing points and a completion tick.
* **Middle** – the description of the selected question: what to return, which collection it uses,
  the allowed operations and the test cases it will be graded against. Collapsible, so the
  playground can take the full width.
* **Right** – the code playground: a syntax-highlighted, line-numbered editor with adjustable font
  size, Ctrl+Enter, **Run**, **Submit** and **Reset DB**, over a results panel with *Query Results*
  (documents, errors with line/column, empty and truncated states) and *Test Results* (per-test-case
  pass/fail).
* **Show collections** – the purple tab on the right edge of the playground opens the collection
  browser, modelled on the **Atlas Data Explorer**: one tab per collection (the question's own
  collection first), *Documents* / *Schema* tabs, the `db.<collection>.find({})` namespace line, the
  result range, and Atlas' three view modes — **list** (a bordered card per document,
  `ObjectId("…")` and `ISODate("…")` in red, strings green, numbers blue, nested values collapsed
  behind a caret as `Array` / `Object`), **{ } JSON** (Extended JSON, as Atlas shows it) and
  **▦ table** (fields as columns). Query results use the same list rendering.

**The rest:** registration/login · one dashboard (score, completion, attempts, topics and submission
history) · database page (local simulation or Atlas, with step-by-step Atlas instructions, a masked
password field, an admin-credential warning, test/disconnect/replace) · workspaces that are created
and filled on first use.

### Data model at a glance

| Database | Contents |
|---|---|
| `mongodb_practice` | Template dataset: students (12), products (16), orders (16, nested `products` arrays, 4 statuses), employees (12), courses (12), with indexes. Fixed `_id`s make it deterministic |
| `mp_ws_<studentId>` | One private workspace per student, cloned from the canonical data |
| `practice_platform` | Application data: users, connections (encrypted), workspaces, questions, assignments, attempts, query_history, audit_logs |
| `mp_ws_eval_*` | Short-lived grading sandboxes, dropped after each submission |

Full schemas, index list and lifecycle: [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).

---

## 5. Security design

Full threat model and the test backing each control: [`docs/SECURITY.md`](docs/SECURITY.md).

* **No code execution.** Queries are parsed by a hand-written parser
  (`backend/src/query/parser.js`) that understands data literals only. Nothing goes through `eval`,
  `Function` or `vm`, and server-side JavaScript operators (`$where`, `$function`, `$accumulator`)
  are rejected.
* **Allowlists** (`validator.js`): 5 collections, 11 operations, 21 aggregation stages, and update
  operators only. `$lookup`, `$graphLookup` and `$unionWith` may target allowlisted collections in
  the same database only. `$out`, `$merge`, `$currentOp` and similar stages are blocked, including
  when nested inside `$facet`.
* **Tenant isolation:** the database is always derived from the authenticated user on the server. A
  `database` field naming anything else returns `403`. With `WORKSPACE_DB_USERS=true`, MongoDB
  itself also enforces isolation: each workspace user only has `readWrite` on its own database
  (tested).
* **Separate identities:** provisioning uses `MONGODB_ADMIN_URI`; queries use per-workspace users or
  `MONGODB_QUERY_URI`.
* **Limits:** max result count, `maxTimeMS` plus a wall-clock timeout, query length and body size
  limits, nesting/complexity limits, and per-student rate limits.
* **Atlas credentials:** validated server-side, tested before saving, encrypted at rest
  (AES-256-GCM), never returned in responses or written to logs (the logger redacts every
  `mongodb://` URI). Admin-level users (`atlasAdmin`, `root`, …) are refused. Only allowlisted hosts
  are accepted. Pooled clients are closed on disconnect, on replacement and when idle. The platform
  never assumes it may administer the cluster: it reads only the named database, and creates
  collections there only after explicit confirmation.
* **RBAC** is checked on the backend for every admin route. The role comes from the database, not
  from the token. Admin actions, denied resets and blocked queries are written to an append-only
  audit log.
* Passwords are hashed with bcrypt. Login errors don't reveal whether an account exists. `helmet`
  and CORS are configured.

---

## 6. Tests

292 tests across four suites. Layout, how the environment is arranged for each kind, and how Atlas
failures are simulated: [`docs/TESTING.md`](docs/TESTING.md).

| Area | File(s) | Tests |
|---|---|---|
| Parser / validator / comparison / crypto / logger / RBAC / rate limiting (mocks) | `backend/tests/unit/*` | 100 |
| A. Authentication | `tests/integration/auth.test.js` | 19 |
| B. MongoDB connection | `tests/integration/connection.test.js` | 20 |
| C. Provisioning (incl. one-call bootstrap and the collection browser) | `tests/integration/provisioning.test.js` | 12 |
| D. Query execution | `tests/integration/query.test.js` | 56 |
| E. Question evaluation | `tests/integration/evaluation.test.js` | 40 (incl. every reference solution) |
| F. Instructor controls | `tests/integration/admin.test.js` | 10 |
| Least-privilege DB users | `tests/integration/leastPrivilege.test.js` | 3 |
| Real Atlas (optional) | `tests/integration/atlas.optional.test.js` | 1 (skipped unless configured) |
| G. End-to-end workflow over HTTP | `tests/e2e/workflow.test.js` | 16 |
| Frontend (API client, database page, IDE states, collection browser) | `frontend/src/test/*` | 15 |

---

## 7. Troubleshooting

The common ones; the rest, with explanations, are in
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

| Symptom | Fix |
|---|---|
| `PREREQUISITE MISSING: MongoDB is not available` | The first run needs internet to download `mongod`. Otherwise start MongoDB (`npm run mongo:local` or `docker compose up -d mongo`) and set `MONGODB_TEST_URI=mongodb://127.0.0.1:27017` |
| `Invalid configuration: JWT_SECRET…` on start | Run `npm run setup:env` (creates `backend/.env`) |
| `Cannot reach MongoDB` on API start | Start MongoDB first (`npm run mongo:local`) and check `MONGODB_ADMIN_URI` |
| Port 27017 busy | Another MongoDB is running. Use it, or `MONGO_LOCAL_PORT=27018 npm run mongo:local` (PowerShell: `$env:MONGO_LOCAL_PORT=27018; npm run mongo:local`) and update `MONGODB_ADMIN_URI` |
| Instructor login fails | Check `INSTRUCTOR_PASSWORD` in `backend/.env` (quote values containing `#`), then `npm run seed` to apply it |
| UI shows "Cannot reach the server" | The backend isn't running on port 4000, or `VITE_API_PROXY` points elsewhere |
| Atlas `NETWORK_ACCESS_DENIED` / `TIMEOUT` | Add the API server's public IP under Atlas → Security → Network Access |
| Atlas `AUTH_FAILED` | Use a *database user* (Atlas → Database Access), not your Atlas account login |
| Atlas `HOST_NOT_ALLOWED` | The host must end with `.mongodb.net` (configurable via `ATLAS_ALLOWED_HOST_SUFFIXES`) |
| `WORKSPACE_NOT_READY` in the IDE | Reload the Coding Practice page — it provisions the workspace automatically. If it persists, check that `MONGODB_ADMIN_URI` can create databases |
| Docker: `permission denied … docker.sock` | Add your user to the `docker` group, or use `npm run mongo:local`, which needs no Docker |

---

## 8. Known limitations

* Docker Compose was written and YAML-validated but **not run** in the build environment (no Docker
  daemon access or compose plugin there). The no-Docker path (`npm run mongo:local`) is the one that
  was exercised.
* The real-Atlas test is optional and needs your own test cluster. Atlas behaviour without one is
  covered by an auth-enabled local `mongod` and by mocked network failures.
* Rate limiting is in-memory (per API process). Use a shared store (e.g. Redis) behind a load
  balancer.
* The query language covers the common shell subset listed in [`docs/API.md`](docs/API.md) (no
  `forEach`, cursor iteration, `bulkWrite`, `findOneAndUpdate` or shell helpers such as `printjson`).
* Without `WORKSPACE_DB_USERS=true`, isolation in local mode is enforced by the application layer
  (validator plus server-chosen database). Turn it on with an auth-enabled MongoDB (as in Docker
  Compose) to have MongoDB enforce it too.
* Session tokens live in `sessionStorage`; consider httpOnly cookies + CSRF protection for
  production.
* End-to-end tests drive the real HTTP API exactly as the UI does. A browser-automation suite
  (Playwright) is not included; the UI flow was checked manually with headless Chrome.
