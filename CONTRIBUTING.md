# Contributing

## Getting set up

```bash
npm run install:all
npm run setup:env
npm run mongo:local      # terminal 1
npm run seed             # terminal 2
npm run dev:backend      # terminal 2
npm run dev:frontend     # terminal 3
npm test                 # should end with RESULT: ALL TESTS PASSED
```

Detail, Docker and Windows notes: [`docs/SETUP.md`](docs/SETUP.md). Read
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before changing anything structural.

Start `npm test` from a clean checkout before you change code. If it fails there, the problem is
your environment, not your change — see [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

---

## The rules that are not negotiable

These protect the one property the platform has to keep: a student can type anything into the
editor and nothing bad happens.

1. **Student query text is never executed as JavaScript.** No `eval`, no `Function`, no `vm`, no
   shelling out, no passing user text to a driver call that interprets it as code. The parser in
   `backend/src/query/parser.js` turns text into a description of an operation; the executor
   dispatches that to a typed driver call.
2. **Every list stays an allowlist.** Collections, operations, chain modifiers, pipeline stages and
   update operators. Never "allow everything except…".
3. **Anything you block needs a test that proves it stays blocked.**
   `backend/tests/unit/validator.test.js` is the regression net for the sandbox.
4. **The target database never comes from the request.** It is derived from the authenticated user
   in `WorkspaceService.resolveDb()`. Do not add a path that trusts a `database` field.
5. **No secret is ever logged or returned.** Connection strings, passwords and password hashes stay
   on the server. `logger.redact()` is a safety net, not permission to log them.
6. **`backend/.env` is never committed.** `.env.example` holds placeholders only. If you add a
   variable, document it there and in the table in [`docs/SETUP.md`](docs/SETUP.md).

Why each of these exists: [`docs/SECURITY.md`](docs/SECURITY.md).

---

## Making a change

1. Branch from `main`.
2. Make the change, with tests.
3. `npm test` — all four suites, green.
4. Update the docs that your change makes wrong (see the table below).
5. Commit with a message that says what changed and why.

### Which docs to update

| You changed | Also update |
|---|---|
| An endpoint, body or error code | [`docs/API.md`](docs/API.md) |
| An environment variable | `backend/.env.example` and the table in [`docs/SETUP.md`](docs/SETUP.md) |
| The query grammar, an allowlist or a limit | [`docs/SECURITY.md`](docs/SECURITY.md) and [`docs/API.md`](docs/API.md#query-language) |
| The sample data or a collection shape | [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) |
| How services fit together | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| A test suite's shape | [`docs/TESTING.md`](docs/TESTING.md) |
| A new failure mode users will hit | [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) |
| Backend structure or scripts | [`backend/README.md`](backend/README.md) |
| Frontend structure or components | [`frontend/README.md`](frontend/README.md) |

A doc that contradicts the code is worse than no doc. Numbers in the docs (test counts, question
counts, dataset sizes) are real — if your change moves one, move it in the docs too.

---

## Code style

No linter is configured; match the file you are editing.

**Backend** — CommonJS, `'use strict'` at the top. Errors are typed and carry a stable `code`; the
HTTP status belongs with the error, not with the route. Routes stay thin — logic lives in a
service. Services take dependencies in the constructor and are wired in `createServices()`; no
module-level singletons, because tests and scripts build the same graph.

**Frontend** — function components and hooks. `.jsx` when the file contains JSX. All network calls
go through `src/api/client.js`. New styles are classes in `src/styles.css`, using the existing
custom properties; no inline `style` props, no utility framework.

**Both** — comments explain *why*, not *what*. The code says what it does.

---

## Tests

| You added | Write |
|---|---|
| A query form, operator or stage | A unit test in `backend/tests/unit/validator.test.js` or `parser.test.js` |
| An endpoint | An integration test in the file for its area, built on `tests/helpers/context.js` |
| A practice question | Nothing — `tests/integration/evaluation.test.js` runs every reference solution automatically |
| A user-visible flow | An extension to `backend/tests/e2e/workflow.test.js` |
| A React component | A Vitest file in `frontend/src/test/`, using `helpers.jsx` |

Conventions: no `.skip` in a committed test — the only expected skip is the optional real-Atlas
one; no test depends on another file's state; database names come from `tests/helpers/mongo.js`,
never hard-coded.

Full picture, including how Atlas failures are simulated: [`docs/TESTING.md`](docs/TESTING.md).

---

## Adding a practice question

```js
// backend/src/questions/questionBank.js
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

Then `npm run seed` and `npm run test:integration`.

* `q()` supplies the defaults: `kind: 'read'`, `ordered: false`, `ignoreFields: ['_id']`, the five
  read operations, `assignToAll: true`.
* Set `ordered: true` only when the question is genuinely about sort order.
* Write questions need `kind: 'write'`, `verifyQuery` (did the intended change happen?) and
  `scopeQuery` (did anything else change?).
* Expected results are **computed** by running `solution` against a pristine dataset — never
  hand-written. A question whose result is empty or ambiguous fails the evaluation suite, which is
  the point.
* `solution`, `verifyQuery` and `scopeQuery` are server-only and never reach a student.

---

## Changing the practice dataset

Edit `backend/src/provisioning/sampleData.js`, then:

```bash
npm run seed
npm --prefix backend run reset-db -- --all-workspaces   # push it into existing workspaces
npm run test:integration                                 # every reference solution re-checked
```

Keep `_id` values fixed and derived (`65a1…` students, `65a2…` products, and so on). Random
ObjectIds break idempotent seeding and make ordered questions non-deterministic.

---

## Reporting a bug

Include what you expected, what happened, the exact error (the API's error `code` is the useful
part), and the steps to reproduce. **Never paste a real connection string, password or token** —
not in an issue, not in a log excerpt. If it concerns the query sandbox, include the query that
escapes it; a fix with a regression test in `validator.test.js` is even better.
