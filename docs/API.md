# REST API reference

Base URL: `http://localhost:4000` (the Vite dev server proxies `/api` from `http://localhost:5173`).

All request and response bodies are JSON. Authenticated routes need `Authorization: Bearer <token>`.
Errors always have the shape:

```json
{ "error": { "code": "INVALID_SYNTAX", "message": "Expected '}' ... (line 1, column 32)", "line": 1, "column": 32 } }
```

Connection strings, database usernames and passwords are **never** returned by any endpoint.

## Public

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/health` | – | `200 {status:"ok", database:"up"}` or `503` |
| POST | `/api/auth/register` | `{name, email, password}` | Creates a **student**. `201 {token, user}`. `409 EMAIL_TAKEN`, `400 VALIDATION_ERROR`. Rate limited. |
| POST | `/api/auth/login` | `{email, password}` | `200 {token, user}`; `401` for an unknown email or a wrong password (same message for both). Rate limited. |

## Student (any authenticated user)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/me` | – | Current user |
| GET | `/api/dashboard` | – | Progress summary, connection/workspace status, practice modules |
| GET | `/api/connection` | – | Safe connection view: `mode, status, host, database, usernameHint, missingCollections, warnings, lastError` |
| POST | `/api/connection` | `{mode:"local"}` or `{mode:"atlas", connectionUrl, username?, password?, database?}` | Validates, tests and stores the connection (Atlas URI encrypted with AES-256-GCM). Replaces the previous connection only on success. |
| POST | `/api/connection/test` | – | Re-tests the stored connection (`502` when it fails) |
| DELETE | `/api/connection` | – | Disconnects and closes the pooled client |
| GET | `/api/workspace` | – | Workspace status, collections, counts and fields |
| POST | `/api/workspace/ensure` | – | One-call bootstrap used by the IDE: connects to the local simulation when no connection exists and initializes the workspace when it is not ready. Idempotent — existing data is never overwritten. Atlas databases are reported, never written to without `confirm`. |
| POST | `/api/workspace/initialize` | `{confirm?: boolean}` | Local: creates the private workspace database. Atlas: needs `confirm:true`, and only touches the five practice collections |
| POST | `/api/workspace/reset` | – | Restores the original data (`403 RESET_NOT_ALLOWED` when the instructor has disabled self-reset) |
| GET | `/api/workspace/collections/:name/sample?limit=5&skip=0` | – | One page of a practice collection, sorted by `_id` (`limit` max 50, `skip` ≥ 0) plus `total`, `skip`, `limit` plus `fields[]` (`{name, types[]}`) for the schema view; powers *Show collections* in the IDE |
| POST | `/api/query/execute` | `{query, collection?, database?}` | Runs one validated query in the caller's own workspace (see below) |
| GET | `/api/query/history` | – | Last 50 executions |
| GET | `/api/questions` | – | Assigned questions without solutions, plus per-question progress |
| GET | `/api/questions/:id` | – | Question plus the student's attempts (`403` if not assigned) |
| POST | `/api/questions/:id/submit` | `{query}` | Grades the query in a temporary sandbox: `{status, passed, score, maxScore, attemptNumber, testResults[], output}` |
| GET | `/api/progress` | – | Totals and full submission history |

Practice endpoints return `403 PRACTICE_DISABLED` while an instructor has disabled the student's access.

### Query language

Students write MongoDB shell syntax, for example:

```js
db.products.find({ price: { $gt: 1000 } }, { name: 1, _id: 0 }).sort({ price: -1 }).limit(5)
db.orders.aggregate([{ $unwind: "$products" }, { $group: { _id: "$products.name", qty: { $sum: "$products.quantity" } } }])
db.products.updateOne({ name: "Wireless Mouse" }, { $set: { stock: 75 } })
```

* **Supported operations:** `find` (with `.sort() .limit() .skip() .count()`), `findOne`, `countDocuments`, `distinct`, `aggregate`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`.
* **Supported values:** objects, arrays, strings, numbers, booleans, `null`, regex literals, `ISODate()`, `new Date()`, `ObjectId()`, `NumberInt/Long/Decimal()`.
* **Collections:** `students, products, orders, employees, courses` only. `system.*`, application collections and other databases are rejected.
* **Blocked:** any JavaScript (`function`, `this`, `eval`, `require`, ...), `$where`, `$function`, `$accumulator`, `$out`, `$merge`, `$currentOp` and other admin stages, cross-database `$lookup`, and more than one statement per request.
* **Limits:** query text ≤ `QUERY_MAX_LENGTH` (`413 QUERY_TOO_LARGE`), request body ≤ `REQUEST_BODY_LIMIT` (`413 PAYLOAD_TOO_LARGE`), `limit()`/`$limit` ≤ `QUERY_MAX_RESULTS` (`400 EXCESSIVE_RESULTS`; output without an explicit limit is capped and flagged `truncated`), `maxTimeMS` plus a wall-clock guard of `QUERY_TIMEOUT_MS` (`408 QUERY_TIMEOUT`), and `QUERY_RATE_LIMIT_PER_MIN` per student (`429`).

Successful response:

```json
{ "ok": true, "database": "mongodb_practice", "collection": "products", "operation": "find",
  "resultType": "documents", "documents": [ ... ], "count": 5, "truncated": false, "durationMs": 3 }
```

`resultType` is one of `documents`, `document`, `value` (count/distinct) or `write` (acknowledgement in `value`).

Error codes: `EMPTY_QUERY, INVALID_SYNTAX, JS_NOT_ALLOWED, UNSUPPORTED_OPERATION, UNSUPPORTED_STAGE, INVALID_COLLECTION, FORBIDDEN_COLLECTION, FORBIDDEN_OPERATOR, FORBIDDEN_DATABASE, INVALID_PIPELINE, INVALID_ARGUMENT, EXCESSIVE_RESULTS, QUERY_TOO_COMPLEX, QUERY_TOO_LARGE, COLLECTION_MISMATCH, QUERY_TIMEOUT, DUPLICATE_KEY, QUERY_FAILED, NOT_CONNECTED, WORKSPACE_NOT_READY`.

### Connection error codes

`INVALID_URL, MISSING_CREDENTIALS, HOST_NOT_ALLOWED, INVALID_DATABASE, AUTH_FAILED, HOST_NOT_FOUND, TIMEOUT, NETWORK_ACCESS_DENIED, DATABASE_UNAVAILABLE, ADMIN_CREDENTIALS_NOT_ALLOWED, NOT_AUTHORIZED, CONNECTION_FAILED`. Each comes with an actionable message (for example, which Atlas screen to fix).

## Instructor / admin (`role` = `instructor` or `admin`; otherwise `403 FORBIDDEN_ROLE`)

> The platform has a single, student-facing UI. These endpoints have no screens; they remain for scripted
> administration (seeding, assigning questions, resets, audit export) with the instructor account created by `npm run seed`.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/admin/students` | – | Students with connection status, workspace status and score/completed/attempts |
| GET | `/api/admin/students/:id` | – | Detail with per-question progress |
| GET | `/api/admin/students/:id/attempts` | – | All submissions with test results |
| GET | `/api/admin/students/:id/query-history` | – | Executions, including errors |
| POST | `/api/admin/students/:id/initialize` | – | Creates the student's local workspace |
| POST | `/api/admin/students/:id/reset` | – | Restores the student's practice data (other students are untouched) |
| PATCH | `/api/admin/students/:id/access` | `{practiceDisabled?, allowSelfReset?}` | Disables/enables practice access |
| GET | `/api/admin/submissions?studentId&questionId&status` | – | Filterable submissions |
| GET | `/api/admin/query-history?studentId&ok=false` | – | All executions |
| GET | `/api/admin/questions` | – | All questions **including solutions** |
| POST | `/api/admin/questions` | see below | Creates a question; the reference solution is validated and executed in a sandbox first |
| POST | `/api/admin/questions/:id/assign` | `{studentIds:[...]}` or `{all:true}` | Assigns a question |
| GET | `/api/admin/datasets` | – | Template database collections, counts and indexes |
| POST | `/api/admin/datasets/seed` | – | Idempotent seed |
| POST | `/api/admin/datasets/reset` | – | Restores the template database |
| GET | `/api/admin/audit-logs?studentId&action` | – | Append-only audit history |
| POST | `/api/admin/instructors` | `{name,email,password}` | **admin only**: creates an instructor |

Create-question body:

```json
{
  "title": "Cheap courses", "description": "Find courses cheaper than 2000.", "requirements": "Complete documents.",
  "difficulty": "beginner", "collection": "courses", "allowedOperations": ["find"],
  "solution": "db.courses.find({ price: { $lt: 2000 } })", "ordered": false, "assignToAll": false
}
```

Write questions also need `kind: "write"`, `verifyQuery` (checks the changed data) and `scopeQuery` (checks that nothing else changed).
