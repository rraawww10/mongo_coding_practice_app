# Handover: MongoDB Coding Practice Platform

## What this is (one paragraph)

This is a web app where students practise MongoDB queries in an online code editor. Each student gets
a **private copy** of a practice database (students, products, orders, employees and courses). They
write queries such as `db.products.find({ price: { $gt: 1000 } })`, see the results, and submit
answers to 26 practice questions that are **graded automatically**. The screen is in three columns —
questions, description, code playground — and a **Show collections** drawer shows the documents being
queried in MongoDB's own format. There is one dashboard, the student's: no instructor UI (the admin REST
API is still available for scripted administration). Everything runs locally with no MongoDB Atlas
account. Students can optionally connect their own Atlas database instead.

## Tech stack

| Part | Technology | Folder |
|---|---|---|
| UI | React + Vite | `frontend/` |
| API | Node.js + Express | `backend/src/` |
| Database | MongoDB (a local `mongod`, no Docker needed) | started by `npm run mongo:local` |
| Tests | Jest + Supertest (backend), Vitest (frontend) | `backend/tests/`, `frontend/src/test/` |

## Where the documentation is

| Question | Document |
|---|---|
| How do I install and configure it? | [`docs/SETUP.md`](docs/SETUP.md) |
| How does it work inside? | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| What are the endpoints? | [`docs/API.md`](docs/API.md) |
| What is in the database? | [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) |
| Is it safe, and how do you know? | [`docs/SECURITY.md`](docs/SECURITY.md) |
| How do I run and extend the tests? | [`docs/TESTING.md`](docs/TESTING.md) |
| It will not start | [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) |
| How do I change the code? | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

Index of everything: [`docs/README.md`](docs/README.md).

---

## 1. First-time setup (once)

Needs **Node.js 18+**. The first run downloads MongoDB (~100 MB), so internet access is required once.

```bash
cd mongodb-practice-platform
npm run install:all      # installs backend + frontend packages
npm run setup:env        # creates backend/.env and PRINTS THE INSTRUCTOR LOGIN — note it down
```

The instructor email and password are stored in `backend/.env` (`INSTRUCTOR_EMAIL`, `INSTRUCTOR_PASSWORD`).
Never commit or share that file.

## 2. Run the app (3 terminals)

| Terminal | Command | Leave it running? |
|---|---|---|
| 1 | `npm run mongo:local` | yes (this is the database) |
| 2 | `npm run seed`, then `npm run dev:backend` | yes (API on port 4000) |
| 3 | `npm run dev:frontend` | yes (website on port 5173) |

Open **http://localhost:5173**.
`npm run seed` is only needed the first time, but running it again is safe because it never creates duplicates.
To check that the API is up, run `npm run health`.

The commands are the same on Windows PowerShell.

## 3. Run the tests

```bash
npm test
```

You don't need to start anything first, because the tests start their own temporary MongoDB.
Expected ending:

```
✓ backend unit               100   0   0   100
✓ backend integration        160   0   1   161
✓ backend e2e                 16   0   0    16
✓ frontend                    15   0   0    15
  TOTAL                      291   0   1   292
RESULT: ALL TESTS PASSED
```

* The **1 skipped** test is the optional real-Atlas test. It is normal, and only runs if `ATLAS_TEST_URI` and `ATLAS_TEST_DB` are set.
* Run one part only: `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`, `npm run test:frontend`.
* Coverage report: `npm run test:coverage` (output in `test-reports/coverage/`).
* If it says `PREREQUISITE MISSING`, read the message. Usually MongoDB couldn't be downloaded (no internet).

---

## 4. 5-minute demo script

1. Go to http://localhost:5173 → *Create an account*. You land on **Coding Practice**; the connection and the
   private workspace are created for you.
2. In the left column open **Sorting and limiting → Five most expensive products**. The middle column explains
   the task; the breadcrumb and points update.
3. Click **SHOW COLLECTIONS** on the right edge → the `products` tab opens first (it is the question's
   collection), laid out like the Atlas Data Explorer. Switch between the list, **{ }** JSON and **▦** table
   views; expand a nested `Array` / `Object`; the **Schema** tab lists every field and its type. Close it again
   with **HIDE COLLECTIONS**.
4. Type `db.products.find().sort({ price: -1 }).limit(5)` → **Run** (or Ctrl+Enter) → *Query Results* lists the
   5 documents, with the count and duration next to the buttons.
5. Type something broken, e.g. `db.products.find({ price: ` → **Run** → red error panel showing line and column.
6. Fix it → **Submit** → **Test Results** shows green **Passed · 10/10** with each test case ticked.
7. Submit a wrong answer (e.g. `.sort({ price: 1 })`) → **Not quite**, showing which check failed.
8. Delete some documents, then **Reset DB** → your workspace is back to the original data.
9. Collapse the description with **‹** to give the playground the full width; the **DESCRIPTION** tab brings it back.
10. **Dashboard** (top bar) → score, completion, modules and the submission history.

**Security demo (optional):** in the IDE, try `db.students.find({ $where: "1" })` or
`db.system.users.find({})`. Both are blocked with a clear message and logged.

---

## 5. How to explain what was done (talking points)

1. **Goal:** students practise MongoDB safely, and answers are checked automatically.
2. **Isolation:** every student has their own database copy (`mp_ws_<studentId>`). One student's
   deletes or updates never affect anyone else. Reset restores the original data.
3. **Safe query execution:** student queries are **never run as JavaScript**. A custom parser
   (`backend/src/query/parser.js`) reads only MongoDB query syntax. A validator (`validator.js`)
   allows only 5 collections and safe operations, and blocks dangerous ones (`$where`, `$out`,
   `$merge`, `drop`, system collections, other databases). There are also limits on result size,
   execution time, query length and requests per minute.
4. **Automatic grading:** a submission runs in a temporary copy of the data, and its result is compared with the
   instructor's reference solution. Order is ignored unless the question needs it. Nested documents and
   arrays are compared exactly. Write questions also check that nothing else changed. Every attempt
   and score is saved, and the best score counts.
5. **Atlas support:** students can connect their own Atlas database. The URL is checked, tested,
   **encrypted** on the server, and never sent back to the browser or written to logs. Admin-level
   Atlas users are refused.
6. **Roles:** student, instructor and admin, checked on the server for every request.
7. **Quality:** 292 automated tests cover every scenario in the original requirements (auth,
   connections, provisioning, queries, grading, instructor tools and a full end-to-end workflow).
   `npm test` runs them all and prints a pass/fail summary.

## 6. Where things are

| Need to change… | Look at |
|---|---|
| Practice questions | `backend/src/questions/questionBank.js` (then `npm run seed`) |
| Sample data | `backend/src/provisioning/sampleData.js` |
| Which queries are allowed | `backend/src/query/validator.js` |
| Limits (timeout, max results, rate) | `backend/.env` |
| API endpoints | `backend/src/routes/` and `docs/API.md` |
| Pages | `frontend/src/pages/` (`PracticePage.jsx` is the three-column screen) |
| Playground, collection browser, question rail | `frontend/src/components/` |
| Look and feel | `frontend/src/styles.css` |
| Full documentation | `README.md`, then [`docs/`](docs/README.md) |

## 7. Known limitations

* The Docker Compose file was written but not tested, because Docker wasn't available on the build machine. Use `npm run mongo:local` instead.
* Real Atlas connections were simulated in tests; to test against a real cluster, set `ATLAS_TEST_URI` and `ATLAS_TEST_DB`.
* Rate limiting is in memory, so it applies per API server process.

## 8. Common problems

| Problem | Fix |
|---|---|
| `Invalid configuration: JWT_SECRET…` | Run `npm run setup:env` |
| `Cannot reach MongoDB` | Start terminal 1 (`npm run mongo:local`) first |
| Website says "Cannot reach the server" | The backend (terminal 2) isn't running |
| Instructor login fails | Check `INSTRUCTOR_PASSWORD` in `backend/.env`, then run `npm run seed` |
| IDE says "Workspace not ready" | Reload Coding Practice — it provisions the workspace itself. If it persists, check `MONGODB_ADMIN_URI` |
| Port 27017 busy | Another MongoDB is already running; stop it or see README §7 |
