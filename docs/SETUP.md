# Setup

Three ways to run the platform. Pick one:

| Path | When | MongoDB comes from |
|---|---|---|
| [**A — No Docker**](#a--no-docker-recommended) | Default. Nothing to install beyond Node | `mongodb-memory-server` downloads and runs a real `mongod` |
| [**B — Docker Compose**](#b--docker-compose) | You want authentication and per-workspace DB users | `mongo:7.0` container |
| [**C — Your own MongoDB**](#c--an-existing-mongodb) | You already run MongoDB | whatever you have |

**Prerequisites for all three:** Node.js 18+ (20 LTS recommended) and npm. Check with `node -v`.

---

## A — No Docker (recommended)

The first run downloads a `mongod` binary (~100 MB) into `~/.cache/mongodb-binaries`
(`%LOCALAPPDATA%` on Windows). That is the only step needing internet; afterwards the platform runs
offline.

### 1. Install dependencies

```bash
cd mongodb-practice-platform
npm run install:all
```

### 2. Create the configuration

```bash
npm run setup:env
```

This writes `backend/.env` with a freshly generated `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` and
instructor password, and **prints the instructor login** — note it down. The file is git-ignored;
never commit it. An existing `backend/.env` is left alone; pass
`npm --prefix backend run setup:env -- --force` to regenerate it.

Prefer to do it by hand? Copy the template and fill it in:

```bash
cp backend/.env.example backend/.env          # bash
```
```powershell
Copy-Item backend\.env.example backend\.env   # PowerShell
```

You must then set `JWT_SECRET` (32+ characters), `CREDENTIAL_ENCRYPTION_KEY` (64 hex characters)
and `INSTRUCTOR_PASSWORD`. Generate the two secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"         # CREDENTIAL_ENCRYPTION_KEY
```

> If a value contains `#`, quote it — `INSTRUCTOR_PASSWORD="Pa#ss"` — or dotenv treats the rest of
> the line as a comment.

### 3. Start MongoDB — terminal 1

```bash
npm run mongo:local
```

Leave it running. It listens on `127.0.0.1:27017`. If that port is taken:

```bash
MONGO_LOCAL_PORT=27018 npm run mongo:local                  # bash
```
```powershell
$env:MONGO_LOCAL_PORT=27018; npm run mongo:local            # PowerShell
```

…and set `MONGODB_ADMIN_URI=mongodb://127.0.0.1:27018` in `backend/.env`.

### 4. Seed, then start the API — terminal 2

```bash
npm run seed            # template dataset + 26 questions + instructor account
npm run dev:backend     # http://localhost:4000, restarts on file changes
```

`npm run seed` is idempotent — running it again never creates duplicates. Use
`npm run start:backend` instead of `dev:backend` if you do not want auto-reload.

### 5. Start the UI — terminal 3

```bash
npm run dev:frontend    # http://localhost:5173
```

### 6. Check it works

```bash
npm run health
```
```powershell
Invoke-RestMethod http://localhost:4000/api/health
```

Expected: `{ status: 'ok', database: 'up', … }`.

Open <http://localhost:5173> and register as a student. The first visit to **Coding Practice**
connects you to the local simulation and fills your private workspace automatically — there is
nothing else to configure.

---

## B — Docker Compose

`docker-compose.yml` starts MongoDB 7 **with authentication enabled** and creates a non-root
`practice_admin` user from `docker/mongo-init/`. This is the setup that supports
`WORKSPACE_DB_USERS=true`, where MongoDB itself enforces workspace isolation.

### Database only

```bash
docker compose up -d mongo
```

Then point the backend at it in `backend/.env`:

```
MONGODB_ADMIN_URI=mongodb://practice_admin:<password>@127.0.0.1:27017/?authSource=admin
WORKSPACE_DB_USERS=true
```

…and continue from step 4 of path A (`npm run seed`, `npm run dev:backend`, `npm run dev:frontend`).

### Everything in containers

```bash
docker compose --profile app up -d
```

This also runs the API (port 4000) and the UI (port 5173) in containers, with
`WORKSPACE_DB_USERS=true` already set.

### Changing the passwords

The compose file ships **development placeholders**. Override them in a `.env` file at the
repository root:

```
MONGO_ROOT_USER=root
MONGO_ROOT_PASSWORD=<choose-one>
PLATFORM_ADMIN_USER=practice_admin
PLATFORM_ADMIN_PASSWORD=<choose-one>
JWT_SECRET=<32+ characters>
CREDENTIAL_ENCRYPTION_KEY=<64 hex characters>
INSTRUCTOR_EMAIL=instructor@practice.local
INSTRUCTOR_PASSWORD=<choose-one>
```

> Docker Compose was written and YAML-validated but **not executed** in the build environment —
> no Docker daemon was available there. Path A is the exercised one.

---

## C — An existing MongoDB

Set `MONGODB_ADMIN_URI` in `backend/.env` to your instance and skip `npm run mongo:local`:

```
MONGODB_ADMIN_URI=mongodb://user:password@host:27017/?authSource=admin
```

The identity needs rights to create databases, create collections and build indexes (the platform
provisions `mongodb_practice`, `practice_platform` and one database per student). For
`WORKSPACE_DB_USERS=true` it additionally needs `userAdminAnyDatabase`, since it creates a MongoDB
user per workspace.

To keep student queries on a lower-privileged identity, also set `MONGODB_QUERY_URI`.

For the test suites, point them at the same instance:

```bash
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test                 # bash
```
```powershell
$env:MONGODB_TEST_URI="mongodb://127.0.0.1:27017"; npm test          # PowerShell
```

---

## Configuration reference

Every variable is documented in [`backend/.env.example`](../backend/.env.example). The ones that
matter most:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | API port |
| `CORS_ORIGIN` | `http://localhost:5173` | Origin allowed to call the API |
| `MONGODB_ADMIN_URI` | `mongodb://127.0.0.1:27017` | Provisioning identity: seeding, workspaces, users, audit log |
| `MONGODB_QUERY_URI` | *(empty)* | Optional lower-privileged identity for student queries |
| `WORKSPACE_DB_USERS` | `false` | `true` → one MongoDB user per workspace with `readWrite` on that database only. Needs an auth-enabled MongoDB |
| `APP_DB_NAME` | `practice_platform` | Application database |
| `TEMPLATE_DB_NAME` | `mongodb_practice` | Template dataset |
| `WORKSPACE_DB_PREFIX` | `mp_ws_` | Prefix for per-student databases |
| `JWT_SECRET` | *(required)* | Session signing key, 32+ characters |
| `JWT_EXPIRES_IN` | `8h` | Session lifetime |
| `CREDENTIAL_ENCRYPTION_KEY` | *(required)* | AES-256-GCM key for stored Atlas URIs, 64 hex characters |
| `BCRYPT_ROUNDS` | `10` | Password hashing cost |
| `INSTRUCTOR_EMAIL` / `INSTRUCTOR_PASSWORD` | *(required)* | Admin account created by `npm run seed` |
| `QUERY_MAX_RESULTS` | `500` | Result cap per query (the IDE pages results 20 at a time) |
| `QUERY_TIMEOUT_MS` | `3000` | Query timeout |
| `QUERY_MAX_LENGTH` | `4000` | Maximum query text length |
| `REQUEST_BODY_LIMIT` | `16kb` | Maximum request body |
| `QUERY_RATE_LIMIT_PER_MIN` | `60` | Queries per student per minute |
| `AUTH_RATE_LIMIT_PER_MIN` | `30` | Login/register attempts per minute |
| `ATLAS_ALLOWED_HOST_SUFFIXES` | `.mongodb.net` | Hosts a student may point the server at |
| `ATLAS_IDLE_CLOSE_MS` | `600000` | Close idle pooled Atlas clients after this long |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

The frontend needs no configuration in development — Vite proxies `/api` to `http://localhost:4000`.
Override with `VITE_API_PROXY` (dev) or `VITE_API_URL` (production builds, when the API is on a
different origin). See [`frontend/.env.example`](../frontend/.env.example).

---

## Everyday commands

| Task | Command |
|---|---|
| Install everything | `npm run install:all` |
| Generate `backend/.env` | `npm run setup:env` |
| Start local MongoDB | `npm run mongo:local` |
| Seed template, questions, instructor | `npm run seed` |
| Start API (auto-reload) | `npm run dev:backend` |
| Start API (plain) | `npm run start:backend` |
| Start UI | `npm run dev:frontend` |
| Production build of the UI | `npm run build` → `frontend/dist/` |
| Health check | `npm run health` |
| All tests | `npm test` |
| Reset the template database | `npm run reset-db` |
| Reset one student | `npm --prefix backend run reset-db -- --student <email>` |
| Reset every workspace | `npm --prefix backend run reset-db -- --all-workspaces` |

Every `npm run …` command is identical on Linux, macOS and Windows PowerShell.

---

## Connecting MongoDB Atlas (optional)

Students may practise against their own Atlas database instead of the local simulation. In the UI,
open **Database** and follow the on-screen steps. In short:

1. Atlas → **Database Access** → create a database user with the **`readWrite`** role on your
   practice database. Administrator users are refused by the platform.
2. Atlas → **Network Access** → add the IP of the machine running the API.
3. Atlas → **Connect** → *Drivers* → copy the `mongodb+srv://…` string.
4. Paste it into the Database page with the password and database name.

The platform tests the connection before saving it, encrypts it at rest, and never returns it. It
only reads the database you name, and creates the five practice collections there only after you
confirm.

---

## Next

* Something will not start → [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)
* How it works → [`ARCHITECTURE.md`](ARCHITECTURE.md)
* Running the tests → [`TESTING.md`](TESTING.md)
