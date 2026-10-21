# Architecture

How the platform is put together, and why. Companion documents: [`DATA_MODEL.md`](DATA_MODEL.md)
for what is stored, [`SECURITY.md`](SECURITY.md) for why the query path looks the way it does,
[`API.md`](API.md) for the endpoint contracts.

---

## 1. The shape of the system

```
┌──────────────────────────────┐
│  Browser — React 18 + Vite   │
│  /login /register            │
│  /dashboard                  │
│  /connection                 │
│  /practice/:questionId       │
└──────────────┬───────────────┘
               │  fetch('/api/…'), Authorization: Bearer <JWT>
               │  (Vite dev server proxies /api → :4000)
┌──────────────▼───────────────────────────────────────────────┐
│  API — Node.js + Express 5 (backend/src)                     │
│                                                              │
│  app.js        helmet → cors → json(limit) → rate limit      │
│                → authenticate → validate(zod) → route        │
│                → errorHandler                                │
│                                                              │
│  routes/       studentRoutes.js · adminRoutes.js             │
│  auth/         authService.js       bcrypt + JWT             │
│  connections/  connectionManager.js pooled clients, crypto   │
│  provisioning/ provisioningService.js, sampleData.js         │
│  services/     workspaceService · progressService · audit    │
│  query/        parser.js → validator.js → executor.js        │
│  questions/    questionBank · questionService · evaluation   │
│  db/           mongo.js (MongoManager), createClient.js      │
└──────────────┬───────────────────────────────────────────────┘
               │  native MongoDB driver 7
┌──────────────▼───────────────────────────────────────────────┐
│  MongoDB                                                     │
│   practice_platform   application data                       │
│   mongodb_practice    template dataset (read-only master)    │
│   mp_ws_<userId>      one private workspace per student      │
│   mp_ws_eval_*        short-lived grading sandboxes          │
│                                                              │
│  …or the student's own Atlas database, in place of mp_ws_*   │
└──────────────────────────────────────────────────────────────┘
```

The API process is stateless apart from two in-memory caches: the pooled MongoDB clients held by
`ConnectionManager`, and the rate-limit counters in `middleware/index.js`. Both are per-process,
which is the reason rate limiting is documented as a single-instance feature.

---

## 2. Composition root

Services are constructed once and injected, so that scripts and tests can build the same object
graph without an HTTP server.

* `src/config.js` — reads `backend/.env` through `dotenv`, coerces and validates every variable.
  `assertConfig()` throws `CONFIG_INVALID` with a readable list of what is missing.
* `src/bootstrap.js` — `bootstrap({ seed })` loads config, connects `MongoManager`, ensures the
  application indexes, calls `createServices()`, optionally seeds, and attaches a `shutdown()`
  that closes pooled clients and the driver.
* `src/app.js` — `createServices({ config, mongo, clientFactory })` builds the service graph;
  `createApp(services)` mounts middleware and routes onto an Express app.
* `src/server.js` — the only file that listens on a port. It translates the two common startup
  failures (`CONFIG_INVALID`, unreachable MongoDB) into instructions instead of a stack trace.

`clientFactory` is the seam that lets tests substitute a fake driver client for network failures
that cannot be reproduced locally (timeouts, Atlas IP access-list denial).

---

## 3. Request lifecycle

Every `/api` request passes through the same chain, defined in `app.js`:

1. **`helmet()`** — security headers; `x-powered-by` is disabled.
2. **`cors({ origin: config.corsOrigin })`** — credentials are off; the browser only ever sends a
   bearer token.
3. **`express.json({ limit: config.requestBodyLimit })`** — oversized bodies fail as
   `413 PAYLOAD_TOO_LARGE` before any handler runs.
4. **Rate limiting** — three independent in-memory buckets: `auth` (login/register),
   `query` (execute/submit) and `connection`. Keyed per user when authenticated, per IP otherwise.
5. **`authenticate(auth)`** — verifies the JWT, then **reloads the user from the database**. The
   role used for authorization comes from that record, never from the token payload, so a role
   change takes effect on the next request.
6. **`validate(schema)`** — zod schemas in `routes/schemas.js`. Failures become
   `400 VALIDATION_ERROR` with the offending field.
7. **Route handler** — thin; the work lives in a service.
8. **`errorHandler`** — maps typed errors (`QuerySyntaxError`, `QueryValidationError`,
   `QueryExecutionError`, `ConnectionError`, `HttpError`) onto `{ error: { code, message, … } }`
   and the right status. Anything unrecognised becomes a `500` with a generic message; the real
   stack is logged, redacted.

`/api/health` sits ahead of authentication and reports `200`/`503` from a driver ping.

---

## 4. The query path

This is the core of the platform, and the one place where untrusted text meets a database.
Student queries are **never executed as JavaScript** — no `eval`, no `Function`, no `vm`.

```
query text
   │
   ▼  parser.js — hand-written recursive-descent parser
       Accepts only: db.<collection>.<op>(args).<chain>()
       Values: object, array, string, number, boolean, null, /regex/,
               ISODate(), new Date(), ObjectId(), NumberInt/Long/Decimal()
       Rejects: JS keywords (function, this, eval, require, …), `__proto__`,
                more than one statement, nesting deeper than maxDepth (24)
       Errors:  QuerySyntaxError with line + column
   │
   ▼  validator.js — allowlists, not denylists
       Collections : students, products, orders, employees, courses
       Operations  : find, findOne, countDocuments, distinct, aggregate,
                     insertOne, insertMany, updateOne, updateMany,
                     deleteOne, deleteMany
       find chain  : sort, limit, skip, projection/project, pretty, toArray, count
       Stages      : a fixed allowlist; $out, $merge, $currentOp and friends are
                     rejected, including when nested inside $facet
       Operators   : $where, $function, $accumulator rejected anywhere in the tree
       Joins       : $lookup / $graphLookup / $unionWith may only target an
                     allowlisted collection in the same database
       Updates     : update-operator form only ($set, $inc, …) — no whole-document
                     replacement
       Size        : MAX_NODES 2000, MAX_INSERT_DOCS 50, limit ≤ QUERY_MAX_RESULTS
       Errors:  QueryValidationError with a specific code (403 for forbidden,
                400 for malformed)
   │
   ▼  executor.js — driver dispatch
       prepare()      parse + validate, enforce QUERY_MAX_LENGTH
       withTimeout()  maxTimeMS on the cursor *and* a wall-clock race, so a
                      hung driver cannot outlive QUERY_TIMEOUT_MS
       dispatch()     one branch per allowed operation; results capped at
                      QUERY_MAX_RESULTS and flagged `truncated`
       Driver errors are translated into stable codes (DUPLICATE_KEY,
       QUERY_TIMEOUT, QUERY_FAILED) by translateDriverError()
   │
   ▼  the database chosen by the server
```

**The database is never taken from the request.** `WorkspaceService.resolveDb(userId)` derives it
from the authenticated user: the student's `mp_ws_<userId>` database, or — when the student has
connected Atlas — the database named in their stored connection. A `database` field in the request
body that names anything else is rejected with `403 FORBIDDEN_DATABASE`.

---

## 5. Connections and workspaces

`WorkspaceService` is the façade the routes talk to; it coordinates `ConnectionManager` (where the
data lives) and `ProvisioningService` (what is in it).

### Two modes

| Mode | Where the student's data lives | Who owns it |
|---|---|---|
| `local` (default) | `mp_ws_<userId>` on the platform's MongoDB | the platform |
| `atlas` | a database in the student's own Atlas cluster | the student |

### Connecting

* `connectLocal(userId)` — the zero-configuration path. Records a `local` connection.
* `connectAtlas(userId, input)` — validates the URI shape, checks the host against
  `ATLAS_ALLOWED_HOST_SUFFIXES`, refuses admin-level users, **tests the connection against the real
  cluster**, and only then encrypts (AES-256-GCM, `CREDENTIAL_ENCRYPTION_KEY`) and stores it. The
  previous connection is replaced only on success, so a failed attempt never leaves a student
  disconnected.
* Pooled clients are keyed per user, closed on `disconnect`, on replacement, and by `sweepIdle()`
  after `ATLAS_IDLE_CLOSE_MS`.

Connection strings never leave the server. The API returns a *safe view* — `mode`, `status`,
`host`, `database`, `usernameHint`, `missingCollections`, `warnings`, `lastError` — and the logger
redacts every `mongodb://` and `mongodb+srv://` URI it is handed.

### Provisioning

* `seedTemplate()` writes the canonical dataset into `mongodb_practice` with its indexes. It is
  idempotent: fixed `_id` values make re-seeding a no-op rather than a duplicate.
* `initializeLocalWorkspace(userId)` clones the template into `mp_ws_<userId>`. With
  `WORKSPACE_DB_USERS=true` it also calls `createWorkspaceDbUser()`, giving that workspace its own
  MongoDB user with `readWrite` **on that database only** — so MongoDB enforces isolation as well
  as the application.
* `resetLocalWorkspace(userId)` restores the original documents for one student; no other
  workspace is touched.
* On Atlas, nothing is written without explicit `confirm`, and only the five practice collections
  are ever created. The platform never assumes it may administer the student's cluster.

`POST /api/workspace/ensure` is the one-call bootstrap the IDE uses on first load: connect locally
if there is no connection, initialize if the workspace is not ready, and do nothing otherwise.

---

## 6. Grading

`EvaluationService.evaluate(question, queryText)`:

1. **Build test cases** — `buildTestCases(question)` derives them from the question definition:
   result shape, field set, ordering, and for write questions the target change plus a
   no-collateral-damage check.
2. **Compute the expected result once** — by running the instructor's reference `solution` against
   a pristine copy of the dataset, then caching it. Expected output is never hand-written, so it
   cannot drift from the seed data.
3. **Run the student's query in a throw-away sandbox** — `provisioning.createSandbox()` makes an
   `mp_ws_eval_*` database seeded from the template. The student's own workspace is never used for
   grading, so a destructive answer cannot damage their work, and grading is unaffected by whatever
   they changed while practising.
4. **Compare** — `utils/canonical.js`:
   * `normalize()` gives a stable, type-aware form (ObjectId, Date, Decimal, nested arrays).
   * `stripFields()` drops `ignoreFields` (`_id` by default).
   * `compareResults()` ignores document order unless the question sets `ordered: true`; arrays
     *inside* documents are always compared in order.
5. **Write questions** additionally run `verifyQuery` (did the intended change happen?) and
   `scopeQuery` (did anything else change?) and compare both against the reference outcome.
6. **Score** — every attempt is recorded; the best score counts. The sandbox is dropped afterwards.

---

## 7. Frontend composition

* `main.jsx` mounts `<AuthProvider>` → `<BrowserRouter>` → `<App/>`.
* `auth/AuthContext.jsx` holds the session. The JWT lives in `sessionStorage` under
  `mp_session_token`; nothing else about the student is cached in the browser, and connection
  strings and passwords are never stored client-side.
* `api/client.js` is the only module that calls `fetch`. It attaches the bearer token, parses the
  error envelope into an `ApiError` (carrying `code`, `line`, `column`), turns a network failure
  into `NETWORK_ERROR` with a human message, and routes `401` to a registered handler that logs the
  user out.
* `components/AppShell.jsx` is the authenticated layout (top bar + `<Outlet/>`); `RequireAuth` in
  `App.jsx` guards it.
* `pages/PracticePage.jsx` is the three-column IDE and the largest component:
  `QuestionList` (left) · description (middle) · `CodeEditor` + results (right), with
  `CollectionsDrawer` sliding in from the right edge and `MongoDocuments` / `JsonView` rendering
  documents in the three Atlas-style views.

See [`../frontend/README.md`](../frontend/README.md) for the component-by-component tour.

---

## 8. Design decisions worth knowing

| Decision | Why |
|---|---|
| Hand-written parser instead of a sandboxed JS runtime | A sandbox is a containment problem that never ends; a parser that only understands data has no code path to escape from. |
| Allowlists everywhere | A denylist is a list of the attacks someone already thought of. |
| Expected results computed from the reference solution | Hand-written fixtures drift from seed data; computed ones cannot. |
| Grading in a disposable sandbox | Decouples the grade from whatever the student did to their own workspace. |
| Database chosen server-side from the session | Removes tenant selection from the attack surface entirely. |
| Services injected, not imported as singletons | Scripts and tests build the same graph without a server or a port. |
| `local` and `atlas` behind one `WorkspaceService` | Routes do not branch on mode; one place to reason about both. |
