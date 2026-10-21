# Security model

The platform takes untrusted text from students and runs it against a database. That is the whole
threat, and everything below exists to answer it. This document states the threats, the control for
each, and the limitations that remain.

Scope: this is a teaching platform designed to be safe to run on a classroom server or a laptop.
Section 7 lists what would need hardening before exposing it to the open internet.

---

## 1. Threats and controls

| # | Threat | Control | Where |
|---|---|---|---|
| T1 | Student executes arbitrary JavaScript on the server | No query is ever evaluated as code. A hand-written parser accepts data literals only | `query/parser.js` |
| T2 | Server-side JS through MongoDB itself (`$where`, `$function`, `$accumulator`) | Rejected anywhere in the query tree | `query/validator.js` |
| T3 | Student reads or writes another student's data | The target database is derived from the session, never from the request. Optionally enforced by MongoDB too | `services/workspaceService.js`, `WORKSPACE_DB_USERS` |
| T4 | Student reads application data (password hashes, other users, audit log) | Five-collection allowlist; `system.*` and application collections rejected | `query/validator.js` |
| T5 | Student escapes to another database via `$lookup` / `$graphLookup` / `$unionWith` | Join targets must be allowlisted collections in the same database | `query/validator.js` |
| T6 | Student writes data out of the sandbox (`$out`, `$merge`) | Stage allowlist, checked recursively — including inside `$facet` | `query/validator.js` |
| T7 | Denial of service by expensive query | `maxTimeMS` + wall-clock race, result cap, query-length cap, body-size cap, node-count cap, per-student rate limit | `query/executor.js`, `middleware/index.js` |
| T8 | Prototype pollution via crafted object keys | `__proto__` is rejected as an object key at parse time | `query/parser.js` |
| T9 | Atlas credentials stolen from the database or logs | AES-256-GCM at rest, never returned by any endpoint, every URI redacted in logs | `connections/connectionManager.js`, `utils/logger.js` |
| T10 | Platform used to reach internal hosts (SSRF) | Connection hosts must match `ATLAS_ALLOWED_HOST_SUFFIXES` (default `.mongodb.net`) | `connections/connectionManager.js` |
| T11 | Platform given admin rights on a student's cluster | Admin-level database users (`atlasAdmin`, `root`, …) are refused; nothing is written without explicit `confirm` | `connections/connectionManager.js` |
| T12 | Privilege escalation via a forged or stale token | Role is read from the database on every request, never from the token payload | `middleware/index.js` |
| T13 | Credential stuffing / account enumeration | bcrypt hashing, rate-limited auth, identical error for unknown email and wrong password | `auth/authService.js` |
| T14 | Destructive answer wrecks a student's work or their grade | Submissions are graded in a disposable sandbox database | `questions/evaluationService.js` |
| T15 | Administrative action goes unrecorded | Append-only audit log for admin actions, denied resets and blocked queries | `services/auditService.js` |

---

## 2. Why a parser instead of a sandbox

The obvious way to run `db.products.find({ price: { $gt: 1000 } })` is to evaluate it — in `vm`,
in a worker, in a container. Every one of those is a containment problem: the runtime is a general
language, and the job becomes enumerating the ways out of it.

`backend/src/query/parser.js` is a recursive-descent parser for a deliberately small grammar:

```
statement := 'db' '.' collection '.' operation '(' args? ')' chain*
chain     := '.' modifier '(' args? ')'
value     := object | array | string | number | boolean | 'null'
           | regex | ISODate(…) | new Date(…) | ObjectId(…)
           | NumberInt(…) | NumberLong(…) | NumberDecimal(…)
```

There is no production for a function, an operator, a variable reference or a second statement.
JavaScript keywords (`function`, `this`, `eval`, `require`, `process`, `constructor`, …) are
rejected explicitly rather than merely failing to parse, so the error message is honest. Nesting
beyond 24 levels and `__proto__` as an object key are refused. Syntax errors carry line and column, which
is what the IDE highlights.

Nothing reaches `eval`, `Function`, `vm`, or a shell. The parser's output is a plain description of
an operation and its arguments; `executor.js` dispatches it to a typed driver call.

---

## 3. Allowlists, not denylists

A denylist enumerates the attacks someone already thought of. Every list in `validator.js` is
positive:

```
collections   students, products, orders, employees, courses
read ops      find, findOne, countDocuments, distinct, aggregate
write ops     insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany
find chain    sort, limit, skip, projection, project, pretty, toArray, count
stages        a fixed allowlist of pipeline stages
updates       update-operator form only ($set, $inc, $push, …)
```

Anything outside a list is refused with a specific code (`FORBIDDEN_COLLECTION`,
`UNSUPPORTED_OPERATION`, `UNSUPPORTED_STAGE`, `FORBIDDEN_OPERATOR`, `FORBIDDEN_DATABASE`), a `403`
or `400` status, and a message that tells the student what is allowed instead.

Two details that are easy to get wrong and are tested:

* The operator scan is **recursive over the whole tree**, so `$where` buried inside
  `$and → $elemMatch → …` is caught.
* The stage allowlist is applied **inside `$facet`** too, so `$facet: { x: [{ $out: … }] }` fails.

Updates must use operators. Whole-document replacement is refused, because
`updateOne(filter, { arbitrary: "doc" })` is a silent data-loss footgun in a teaching context.

---

## 4. Tenant isolation

Two independent layers.

**Application layer (always on).** The database is never read from the request body.
`WorkspaceService.resolveDb(userId)` looks up the authenticated user's workspace and returns
`mp_ws_<userId>` — or, for an Atlas student, the database recorded in their stored connection. A
`database` field naming anything else returns `403 FORBIDDEN_DATABASE`.

**Database layer (opt-in).** With `WORKSPACE_DB_USERS=true` and an authentication-enabled MongoDB,
`createWorkspaceDbUser()` creates one MongoDB user per workspace with `readWrite` scoped to that
database only, and student queries run as that user. A bug in the validator would then still be
contained by MongoDB's own authorization. This is covered by
`backend/tests/integration/leastPrivilege.test.js`, which asserts that a workspace user is refused
on another workspace's database.

Provisioning and query execution use separate identities: `MONGODB_ADMIN_URI` creates and resets
databases; `MONGODB_QUERY_URI` (or the per-workspace user) runs student queries.

Grading adds a third boundary: each submission runs in a fresh `mp_ws_eval_*` database that is
dropped afterwards, so a `deleteMany({})` answer destroys nothing that matters and cannot be used
to influence another attempt.

---

## 5. Credentials

**Student passwords** are hashed with bcrypt at `BCRYPT_ROUNDS` (default 10). Login returns the
same `401` message for an unknown email and a wrong password, so the endpoint does not confirm
which accounts exist. Registration and login share a rate-limit bucket.

**Atlas connection strings** are handled as follows:

1. Parsed and validated (`mongodb-connection-string-url`), host checked against
   `ATLAS_ALLOWED_HOST_SUFFIXES`.
2. Refused if the user looks administrative (`atlasAdmin`, `root`, `dbAdminAnyDatabase`, …) — the
   platform does not want, and will not accept, cluster-wide rights.
3. **Tested against the real cluster** before anything is stored. A failure leaves the previous
   connection in place rather than disconnecting the student.
4. Encrypted with AES-256-GCM under `CREDENTIAL_ENCRYPTION_KEY` (32 bytes, 64 hex characters) and
   stored as `{ iv, tag, data }`. Decrypted only in memory, only to open a client.
5. Never returned by any endpoint. `GET /api/connection` returns `host`, `database` and a
   `usernameHint` — never the URI, never the password.
6. `utils/logger.js` redacts every `mongodb://` and `mongodb+srv://` string in any message, error
   or metadata object it is handed, so a stack trace cannot leak one.

**Session tokens** are JWTs signed with `JWT_SECRET` (minimum 32 characters), expiring after
`JWT_EXPIRES_IN` (default 8h). The browser keeps the token in `sessionStorage` and nothing else —
no connection string or database password is ever stored client-side.

**Server secrets** live in `backend/.env`, which is git-ignored. `npm run setup:env` generates
`JWT_SECRET` and `CREDENTIAL_ENCRYPTION_KEY` with `crypto.randomBytes`. `backend/.env.example`
contains placeholders only.

---

## 6. Limits, HTTP hardening and auditing

| Limit | Variable | Default | Failure |
|---|---|---|---|
| Request body | `REQUEST_BODY_LIMIT` | `16kb` | `413 PAYLOAD_TOO_LARGE` |
| Query text | `QUERY_MAX_LENGTH` | `4000` | `413 QUERY_TOO_LARGE` |
| Result documents | `QUERY_MAX_RESULTS` | `100` | `400 EXCESSIVE_RESULTS`, or capped and flagged `truncated` |
| Execution time | `QUERY_TIMEOUT_MS` | `3000` | `408 QUERY_TIMEOUT` |
| Queries per student | `QUERY_RATE_LIMIT_PER_MIN` | `60` | `429` |
| Auth attempts | `AUTH_RATE_LIMIT_PER_MIN` | `30` | `429` |
| Connection attempts | — | 20/min | `429` |
| Parse tree nodes | — | 2000 | `400 QUERY_TOO_COMPLEX` |
| Documents per insert | — | 50 | `400 INVALID_ARGUMENT` |

The timeout is enforced twice: `maxTimeMS` on the cursor, and a wall-clock race in
`executor.withTimeout()` so that a driver that never returns cannot hold a request open.

`helmet()` sets the standard security headers and `x-powered-by` is disabled. CORS is restricted to
`CORS_ORIGIN` with credentials off. Role checks run on the server for every admin route; the role
comes from the database record, so demoting a user takes effect on their next request rather than
when their token expires.

The audit log (`practice_platform.audit_logs`) is append-only — no endpoint updates or deletes it —
and records admin actions, registrations, denied resets and blocked queries with actor, outcome,
target and redacted details.

---

## 7. Known limitations

These are deliberate trade-offs for a teaching platform, not oversights. Address them before
exposing the platform to untrusted networks.

* **Rate limiting is in-memory**, so limits apply per API process. Behind a load balancer, move the
  counters to a shared store such as Redis.
* **Tokens live in `sessionStorage`**, which is readable by any script on the origin. A production
  deployment should use httpOnly cookies with CSRF protection.
* **Without `WORKSPACE_DB_USERS=true`**, isolation rests on the application layer alone. Turn it on
  with an authentication-enabled MongoDB (the Docker Compose setup provides one) so MongoDB
  enforces it as well.
* **No account lockout or CAPTCHA.** Rate limiting slows credential stuffing; it does not stop a
  patient attacker.
* **No TLS termination** is included. Run the API behind a reverse proxy with HTTPS.
* **`ATLAS_ALLOWED_HOST_SUFFIXES` is the SSRF boundary.** Widening it to accept arbitrary hosts
  re-opens T10; if you must, restrict egress at the network level instead.
* **Docker Compose was written and YAML-validated but never run** in the build environment. The
  no-Docker path (`npm run mongo:local`) is the exercised one.

---

## 8. Verifying the controls

Each control above has tests. See [`TESTING.md`](TESTING.md) for how to run them.

```bash
npm run test:unit          # parser, validator, crypto, logger redaction, RBAC, rate limiting
npm run test:integration   # auth, connections, query blocking, least-privilege DB users
npm run test:e2e           # the full workflow over HTTP
```

Specifically:

| Control | Test |
|---|---|
| T1, T2, T4, T5, T6, T8 | `tests/unit/parser.test.js`, `tests/unit/validator.test.js`, `tests/integration/query.test.js` |
| T3 | `tests/integration/leastPrivilege.test.js`, `tests/integration/query.test.js` |
| T7 | `tests/unit/executor.test.js` (mocked hanging driver) and `tests/integration/query.test.js` (real `mongod` with the `maxTimeAlwaysTimeOut` fail point) |
| T9, T10, T11 | `tests/unit/security-utils.test.js`, `tests/integration/connection.test.js` (against an auth-enabled `mongod`) |
| T12, T13 | `tests/unit/middleware.test.js`, `tests/integration/auth.test.js` |
| T14 | `tests/integration/evaluation.test.js` |
| T15 | `tests/integration/admin.test.js` |

You can try the blocked paths by hand in the IDE. Both of these are refused with an explanation and
written to the audit log:

```js
db.students.find({ $where: "1 == 1" })
db.system.users.find({})
```

---

## 9. Reporting a problem

This is coursework, not a service with a security team. If you find a flaw in the query sandbox,
open an issue describing the query that escapes it, or fix it with a regression test in
`backend/tests/unit/validator.test.js` — see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
Do not include real credentials in an issue.
