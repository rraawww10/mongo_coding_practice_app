# Troubleshooting

Grouped by where the failure shows up. Each entry says what the message means, not just what to
type.

---

## Startup

### `Invalid configuration: JWT_SECRET must be at least 32 characters…`

`backend/.env` is missing or incomplete. The API refuses to start with a weak signing key rather
than starting insecurely.

```bash
npm run setup:env       # generates backend/.env with real secrets
```

The error lists every variable that is wrong, so fix them all in one pass.

### `Cannot reach MongoDB`

The API started, found its configuration, and could not open a connection.

```bash
npm run mongo:local                 # terminal 1 — leave it running
# or
docker compose up -d mongo
```

If MongoDB *is* running, check `MONGODB_ADMIN_URI` in `backend/.env` — most often the port is wrong
after a `MONGO_LOCAL_PORT` change, or the Docker setup needs credentials:

```
MONGODB_ADMIN_URI=mongodb://practice_admin:<password>@127.0.0.1:27017/?authSource=admin
```

### Port 27017 is already in use

Another MongoDB is running. Either point the platform at it (set `MONGODB_ADMIN_URI`), or move
ours:

```bash
MONGO_LOCAL_PORT=27018 npm run mongo:local               # bash
```
```powershell
$env:MONGO_LOCAL_PORT=27018; npm run mongo:local         # PowerShell
```

Then set `MONGODB_ADMIN_URI=mongodb://127.0.0.1:27018` in `backend/.env`.

### Port 4000 or 5173 is already in use

```bash
# find the process
lsof -i :4000                                      # macOS / Linux
```
```powershell
Get-NetTCPConnection -LocalPort 4000 | Select-Object OwningProcess
```

Or change the port: `PORT=4100` in `backend/.env` (then set `VITE_API_PROXY=http://localhost:4100`
for the UI), and `npx vite --port 5174` for the frontend.

### The first run hangs for a long time

`mongodb-memory-server` is downloading a `mongod` binary (~100 MB) into `~/.cache/mongodb-binaries`
(`%LOCALAPPDATA%` on Windows). It happens once; afterwards everything runs offline. If you have no
internet, use Docker or an existing MongoDB — see [`SETUP.md`](SETUP.md) paths B and C.

### `npm run setup:env` says the file already exists

By design — it will not clobber your configuration. Regenerate with `npm --prefix backend run
setup:env -- --force`, but note that a new `CREDENTIAL_ENCRYPTION_KEY` makes every stored Atlas
connection undecryptable and a new `JWT_SECRET` invalidates every session, so students will have to
reconnect and log in again.

---

## Logging in

### Instructor login fails

The instructor account is created by `npm run seed` from `INSTRUCTOR_EMAIL` and
`INSTRUCTOR_PASSWORD` in `backend/.env`.

1. Check the values. **Quote any password containing `#`** — `INSTRUCTOR_PASSWORD="Pa#ss"` —
   otherwise dotenv treats the rest of the line as a comment and the real password is the part
   before the `#`.
2. Re-run `npm run seed` to apply a changed password.

### `Invalid email or password` for an account you know exists

The same message is returned for an unknown email and a wrong password, on purpose — the endpoint
does not confirm which accounts exist. Check the password, or register again with a different
email.

### Logged out unexpectedly

Sessions expire after `JWT_EXPIRES_IN` (default 8h), and the token lives in `sessionStorage`, so
closing the tab ends the session. A `401` from any endpoint logs the UI out immediately.

---

## The UI

### "Cannot reach the server"

The browser could not reach the API at all. Either `npm run dev:backend` is not running, or the
Vite proxy points elsewhere. Confirm the API directly:

```bash
curl http://localhost:4000/api/health
```
```powershell
Invoke-RestMethod http://localhost:4000/api/health
```

If that works but the UI still fails, check `VITE_API_PROXY` and restart the Vite dev server —
Vite reads proxy configuration only at startup.

### CORS errors in the browser console

`CORS_ORIGIN` in `backend/.env` must match the origin the UI is served from, exactly, including the
port. Default: `http://localhost:5173`.

### `WORKSPACE_NOT_READY` in the IDE

The practice workspace has not been created yet. Normally `POST /api/workspace/ensure` does this
automatically on the first visit to **Coding Practice**; reload the page to retry. If it keeps
failing, the provisioning identity cannot create databases — check `MONGODB_ADMIN_URI` and that the
user has rights to create databases and indexes. An instructor can also provision it:

```
POST /api/admin/students/<id>/initialize
```

### `PRACTICE_DISABLED`

An instructor has suspended practice access for that student
(`PATCH /api/admin/students/:id/access` with `practiceDisabled: false` re-enables it).

### `RESET_NOT_ALLOWED` when clicking Reset DB

Self-reset is turned off for that student (`allowSelfReset`). An instructor can reset on their
behalf with `POST /api/admin/students/:id/reset`, or re-enable self-reset through
`PATCH /api/admin/students/:id/access`.

### The question list is empty

Questions are seeded and assigned by `npm run seed`. Run it, then reload.

---

## Writing queries

### `JS_NOT_ALLOWED`, `FORBIDDEN_OPERATOR`, `UNSUPPORTED_OPERATION`

Working as intended. Student queries are parsed as data, never executed as JavaScript, and only an
allowlist of collections, operations and pipeline stages is accepted. The message names what was
rejected. See [`SECURITY.md`](SECURITY.md) for the rationale and [`API.md`](API.md#query-language)
for the supported subset.

Common surprises:

| You wrote | Why it fails |
|---|---|
| `db.products.find().forEach(…)` | Cursor iteration is not supported — use `.toArray()` or just `find()` |
| `db.products.find({ $where: "…" })` | Server-side JavaScript is blocked everywhere |
| `db.users.find({})` | Only `students`, `products`, `orders`, `employees`, `courses` are queryable |
| `db.products.updateOne(f, { name: "x" })` | Updates must use operators: `{ $set: { name: "x" } }` |
| `db.products.aggregate([{ $out: "copy" }])` | `$out` and `$merge` would write outside the sandbox |
| Two statements in one box | One statement per request |

### `EXCESSIVE_RESULTS` / results marked `truncated`

`limit()` above `QUERY_MAX_RESULTS` (default 100) is rejected; a query without an explicit limit is
capped at that number and flagged `truncated`. Raise `QUERY_MAX_RESULTS` in `backend/.env` if you
need more.

### `QUERY_TIMEOUT`

The query exceeded `QUERY_TIMEOUT_MS` (default 3000). Usually an unindexed `$lookup` or a pipeline
that fans out. Narrow it with `$match` first, or raise the limit for a teaching example.

### `429 Too many requests`

`QUERY_RATE_LIMIT_PER_MIN` (default 60) or `AUTH_RATE_LIMIT_PER_MIN` (default 30). Counters are
in-memory and reset each minute; restarting the API clears them too.

### `INVALID_SYNTAX` with a line and column

The parser reports exactly where it stopped. The usual causes are an unclosed `{`, `(` or quote, or
a trailing comma.

---

## MongoDB Atlas

All of these come back as a code plus an actionable message on the Database page.

| Code | Meaning | Fix |
|---|---|---|
| `AUTH_FAILED` | Wrong database-user credentials | Use a **database user** (Atlas → Database Access), not your Atlas account login. Re-type the password rather than pasting the `<password>` placeholder |
| `NETWORK_ACCESS_DENIED` / `TIMEOUT` | The cluster refused the connection | Atlas → Network Access → add the public IP of the machine running the **API**, not the browser's |
| `HOST_NOT_ALLOWED` | The hostname is not allowlisted | It must end with `.mongodb.net` (configurable via `ATLAS_ALLOWED_HOST_SUFFIXES`) |
| `HOST_NOT_FOUND` | DNS failed | Check for a typo in the cluster hostname |
| `ADMIN_CREDENTIALS_NOT_ALLOWED` | The user has administrator rights | Create a user with **`readWrite` on your practice database only**. The platform refuses cluster-wide rights by design |
| `INVALID_URL` | The connection string could not be parsed | Copy it again from Atlas → Connect → *Drivers* |
| `INVALID_DATABASE` | The database name is missing or illegal | Supply a plain database name, not a path |
| `DATABASE_UNAVAILABLE` | The server is reachable but the database is not | Check the database name and the user's rights on it |

Nothing is stored until the connection has been tested successfully, so a failed attempt leaves
your previous connection working.

---

## Tests

See [`TESTING.md` §7](TESTING.md#7-when-a-suite-will-not-run). The short version:

| Message | Fix |
|---|---|
| `PREREQUISITE MISSING: MongoDB is not available` | Needs internet on first run, or set `MONGODB_TEST_URI` to a running instance |
| `PREREQUISITE MISSING: backend dependencies are not installed` | `npm run install:all` |
| `PREREQUISITE MISSING: Node.js …` | Node 18+ required |

---

## Docker

### `permission denied … /var/run/docker.sock`

Add your user to the `docker` group (`sudo usermod -aG docker $USER`, then log out and in), or skip
Docker entirely — `npm run mongo:local` needs no daemon.

### The `mongo` container starts but the API cannot authenticate

The init script in `docker/mongo-init/` runs **only on an empty data volume**. If you changed
`PLATFORM_ADMIN_PASSWORD` after the first start, the old user is still in the volume:

```bash
docker compose down -v        # deletes the volume — all local practice data is lost
docker compose up -d mongo
```

### General note

Docker Compose here was written and YAML-validated but never executed in the build environment. If
something in it is wrong, the no-Docker path (`npm run mongo:local`) is the tested one.

---

## Resetting things

| Goal | Command |
|---|---|
| Restore the template dataset | `npm run reset-db` |
| Restore one student's workspace | `npm --prefix backend run reset-db -- --student <email>` |
| Restore every workspace | `npm --prefix backend run reset-db -- --all-workspaces` |
| Re-seed questions and the instructor account | `npm run seed` (idempotent) |
| Start completely over | Drop `practice_platform`, `mongodb_practice` and every `mp_ws_*` database, then `npm run seed` |

Resets only touch the five practice collections. Users, attempts, scores and the audit log live in
`practice_platform` and survive.

---

## Still stuck

1. `npm run health` — is the API up and is its database reachable?
2. Set `LOG_LEVEL=debug` in `backend/.env` and restart the API. Logs redact every connection string,
   so they are safe to share.
3. `npm test` — if the suites pass, the problem is in configuration or data rather than in the code.
