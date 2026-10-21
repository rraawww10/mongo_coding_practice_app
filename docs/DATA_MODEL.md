# Data model

Four kinds of database live on the platform's MongoDB. Three of them are generated; only the
application database holds anything you cannot recreate with `npm run seed`.

| Database | Configured by | Lifetime | Contents |
|---|---|---|---|
| `practice_platform` | `APP_DB_NAME` | permanent | Users, connections, workspaces, questions, assignments, attempts, query history, audit log |
| `mongodb_practice` | `TEMPLATE_DB_NAME` | permanent | The canonical practice dataset. Read-only master; every workspace is cloned from it |
| `mp_ws_<userId>` | `WORKSPACE_DB_PREFIX` | per student | One private copy of the dataset. The database a student's queries actually run against |
| `mp_ws_eval_*` | — | seconds | Grading sandbox. Created per submission, dropped afterwards |

Students who connect their own MongoDB Atlas cluster use a database there in place of
`mp_ws_<userId>`; the other three are unaffected.

---

## 1. The practice dataset

Defined in [`backend/src/provisioning/sampleData.js`](../backend/src/provisioning/sampleData.js).
Five collections, 68 documents. Every `_id` is a **fixed, derived ObjectId** (`65a1…` for students,
`65a2…` products, `65a3…` orders, `65a4…` employees, `65a5…` courses), which is what makes seeding
idempotent and grading deterministic — expected results are computed by running the reference
solution against this exact data.

These five names are the entire collection allowlist. Nothing else is queryable.

### `students` — 12 documents

```js
{
  _id:      ObjectId("65a1…"),
  name:     "Aarav Sharma",
  email:    "aarav.sharma@example.com",   // unique
  age:      20,
  course:   "Full Stack Development",     // 4 values: Full Stack Development,
  score:    78,                           //   Data Science, Cloud Computing, Cyber Security
  isActive: true                          // 9 active, 3 inactive
}
```

Ages 18–26, scores 47–95. Good for comparison operators, projection and sorting.

### `products` — 16 documents

```js
{
  _id:      ObjectId("65a2…"),
  name:     "Laptop Pro 14",   // unique
  category: "Electronics",     // Electronics (6), Books (3), Furniture (3),
  price:    89999,             //   Clothing (2), Sports (2)
  stock:    12,                // one product is out of stock (0)
  rating:   4.7,
  isActive: true
}
```

Prices 799–89999 — a wide spread, so `$gt`/`$lt`, `sort().limit()` and `$group` averages give
distinguishable answers.

### `orders` — 16 documents

The only collection with nested arrays, and the one the `$unwind`, `$lookup` and array questions
use.

```js
{
  _id:         ObjectId("65a3…"),
  orderId:     "ORD1001",                 // unique
  studentId:   ObjectId("65a1…"),         // → students._id
  products: [                             // 1–2 line items, embedded
    { productId: ObjectId("65a2…"), name: "Wireless Mouse", price: 799, quantity: 1 }
  ],
  totalAmount: 2397,                      // computed from the line items at seed time
  status:      "delivered",               // delivered | shipped | pending | cancelled
  createdAt:   ISODate("2024-01-05T10:15:00Z")
}
```

Dates span January–June 2024, which is what the `$month`/date-grouping questions rely on.

### `employees` — 12 documents

```js
{
  _id:        ObjectId("65a4…"),
  name:       "Neha Kapoor",
  department: "Engineering",   // Engineering, Marketing, Sales, HR, Finance
  salary:     1450000,
  experience: 6,
  skills:     ["JavaScript", "Node.js", "MongoDB"],   // array — $in, $all, $size, multikey index
  isActive:   true
}
```

### `courses` — 12 documents

```js
{
  _id:          ObjectId("65a5…"),
  title:        "MongoDB Basics",   // unique
  category:     "Databases",        // Databases, Backend, Frontend, DevOps, Data Science
  duration:     12,                 // hours
  price:        1999,
  level:        "beginner",         // beginner | intermediate | advanced
  isPublished:  true                // 9 published, 3 not
}
```

### Indexes

Created on the template **and on every workspace clone**, so `explain()` and index-aware questions
behave the same everywhere.

| Collection | Index | Notes |
|---|---|---|
| `students` | `{ email: 1 }` | unique |
| `students` | `{ course: 1, score: -1 }` | compound |
| `products` | `{ category: 1, price: -1 }` | compound |
| `products` | `{ name: 1 }` | |
| `orders` | `{ orderId: 1 }` | unique |
| `orders` | `{ status: 1, createdAt: -1 }` | compound |
| `orders` | `{ studentId: 1 }` | |
| `employees` | `{ department: 1, salary: -1 }` | compound |
| `employees` | `{ skills: 1 }` | multikey |
| `courses` | `{ category: 1, level: 1 }` | compound |
| `courses` | `{ title: 1 }` | unique |

---

## 2. The application database (`practice_platform`)

Students never reach this database — it is outside the collection allowlist, and the query path
derives its database from the session rather than the request.

### `users`

```js
{
  _id, name, email,                  // email unique
  passwordHash,                      // bcrypt, BCRYPT_ROUNDS
  role: "student" | "instructor" | "admin",
  practiceDisabled: false,           // instructor can suspend practice access
  allowSelfReset: true,              // instructor can withhold the Reset DB button
  createdAt, updatedAt
}
```

`role` is read from this record on **every** request. The JWT is proof of identity only, never of
authority.

### `connections` — one per user (unique on `userId`)

```js
{
  userId,
  mode:   "local" | "atlas",
  status: "connected" | "error",
  host,                              // "local-simulation", or the Atlas hostname
  database, usernameHint,            // safe-to-display fields
  encryptedUri: { iv, tag, data },   // AES-256-GCM; null for local. Never returned by the API
  presentCollections: [...],         // which of the five practice collections exist
  missingCollections: [...],
  warnings: [...],
  lastError, lastTestedAt, connectedAt
}
```

The plaintext connection string exists only in memory, inside `ConnectionManager`. No endpoint
returns it and the logger redacts every `mongodb://`/`mongodb+srv://` string it is given.

### `workspaces` — one per user (unique on `userId`)

```js
{ userId,
  mode:   "local" | "atlas",
  dbName: "mp_ws_<userId>",          // or the student's own Atlas database
  status: "ready" | "needs_initialization",
  dbUser,                            // only when WORKSPACE_DB_USERS=true
  resetCount, initializedAt, lastResetAt, createdAt, updatedAt }
```

### `questions`

Seeded from [`backend/src/questions/questionBank.js`](../backend/src/questions/questionBank.js);
`questionId` is unique.

```js
{
  questionId: "Q001",
  title, topic, description, requirements,
  difficulty: "beginner" | "intermediate" | "advanced",
  points: 10 | 20 | 30,              // derived from difficulty
  collection: "students",
  kind: "read" | "write",
  allowedOperations: ["find", "findOne", "aggregate", "countDocuments", "distinct"],
  ordered: false,                    // true when the question is about sort order
  ignoreFields: ["_id"],

  // server-only — stripped from every student-facing response
  solution:    "db.students.find({ isActive: true })",
  verifyQuery: "…",                  // write questions: did the intended change happen?
  scopeQuery:  "…"                   // write questions: did anything else change?
}
```

**26 questions** across 15 topics — `find()` basics, comparison operators, projection, sorting and
limiting, logical operators, arrays and nested documents, counting and distinct, `$group`, `$unwind`,
`$lookup`, date aggregation, multi-stage pipelines, insert, update and delete. 14 beginner,
8 intermediate, 4 advanced; 22 read and 4 write. Maximum score **420 points**.

### `assignments`

`{ studentId, questionId, assignedAt, assignedBy }`, unique on the pair. Questions with
`assignToAll: true` (all 26, by default) are assigned at seed time.

### `attempts`

```js
{ userId, questionId, questionTitle, attemptNumber, query,
  status: "passed" | "failed" | "error",
  passed: true,
  score, maxScore,
  testResults: [{ name, passed, message }],
  error, durationMs, createdAt }
```

Every submission is kept. Progress counts the **best** score per question.

### `query_history`

```js
{ userId, userEmail, query, collection, operation,
  ok, errorCode, resultCount, durationMs, createdAt }
```

Both successes and failures, including blocked queries. `GET /api/query/history` returns the last 50.

### `audit_logs` — append-only

```js
{ action, outcome: "success" | "denied",
  actorId, actorEmail, actorRole,
  targetUserId, details, createdAt }
```

Admin actions, registrations, denied resets and blocked queries. Nothing in the API updates or
deletes these.

### Application indexes

Created by `MongoManager.ensureAppIndexes()` at startup:

```
users            { email: 1 } unique · { role: 1 }
workspaces       { userId: 1 } unique
connections      { userId: 1 } unique
questions        { questionId: 1 } unique
assignments      { studentId: 1, questionId: 1 } unique
attempts         { userId: 1, questionId: 1, createdAt: -1 }
query_history    { userId: 1, createdAt: -1 }
audit_logs       { createdAt: -1 } · { targetUserId: 1, createdAt: -1 }
```

---

## 3. Lifecycle

```
npm run seed
  └─ seedTemplate()        mongodb_practice ← sampleData + indexes      (idempotent)
  └─ seedQuestions()       practice_platform.questions ← questionBank   (idempotent)
  └─ ensureInstructor()    practice_platform.users ← INSTRUCTOR_*       (idempotent)

student registers
  └─ users row

first visit to Coding Practice  (POST /api/workspace/ensure)
  └─ connections row (mode: local)
  └─ mp_ws_<userId> ← clone of mongodb_practice, with indexes
  └─ optional MongoDB user with readWrite on mp_ws_<userId> only
       (WORKSPACE_DB_USERS=true)

student runs a query        → mp_ws_<userId>, logged to query_history
student clicks Reset DB     → mp_ws_<userId> restored from the template
student submits an answer   → mp_ws_eval_<id> created, graded, dropped
                              → attempts row
```

### Resetting

| Command | Effect |
|---|---|
| `npm run reset-db` | Restores the **template** database |
| `npm --prefix backend run reset-db -- --student <email>` | Restores one student's workspace |
| `npm --prefix backend run reset-db -- --all-workspaces` | Restores every workspace |

Resets replace documents in the five practice collections. They do not touch `practice_platform`,
so users, attempts, scores and the audit log survive.

---

## 4. Changing the data

Edit [`sampleData.js`](../backend/src/provisioning/sampleData.js) and re-run `npm run seed`, then
`npm run reset-db -- --all-workspaces` to push the change into existing workspaces.

Two rules keep grading deterministic:

1. **Keep `_id` values fixed and derived.** Random ObjectIds would make re-seeding create duplicates
   and would break `ordered` questions.
2. **Re-run the tests.** `backend/tests/integration/evaluation.test.js` executes every reference
   solution against the dataset; if a data change makes a question ambiguous or empty, that suite
   fails. See [`TESTING.md`](TESTING.md).
