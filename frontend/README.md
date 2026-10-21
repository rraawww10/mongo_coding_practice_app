# Frontend — React UI

React 18 · Vite 5 · React Router 6 · Vitest + Testing Library. No UI framework, no state library,
no CSS-in-JS — plain components and one stylesheet.

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api to http://localhost:4000
```

The backend must be running (`npm run dev:backend` from the repository root). Full instructions:
[`../docs/SETUP.md`](../docs/SETUP.md).

---

## Layout

```
index.html           Vite entry
vite.config.js       dev server (port 5173), /api proxy, Vitest config
src/
  main.jsx           AuthProvider → BrowserRouter → App
  App.jsx            routes and the RequireAuth guard
  styles.css         the entire stylesheet — CSS custom properties on :root

  auth/
    AuthContext.jsx  session state; useAuth()

  api/
    client.js        the only module that calls fetch

  components/
    AppShell.jsx         authenticated layout: top bar, nav, user menu, <Outlet/>
    QuestionList.jsx     left column — questions grouped by topic, points, completion ticks
    CodeEditor.jsx       syntax-highlighted, line-numbered editor; Ctrl+Enter to run
    CollectionsDrawer.jsx  the "Show collections" panel, modelled on the Atlas Data Explorer
    MongoDocuments.jsx   Atlas-style rendering: list / { } JSON / ▦ table views
    JsonView.jsx         collapsible JSON display
    ui.jsx               Spinner, Alert, ErrorAlert, Badge, Stat, useApi, fmtDate

  pages/
    AuthPages.jsx      LoginPage, RegisterPage
    Dashboard.jsx      score, completion, modules, submission history
    ConnectionPage.jsx local simulation vs Atlas, with step-by-step Atlas instructions
    PracticePage.jsx   the three-column IDE — the main screen

  test/
    setup.js, helpers.jsx, client.test.js,
    ConnectionPage.test.jsx, PracticePage.test.jsx
```

---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server on 5173 with HMR |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the built bundle |
| `npm test` | Vitest, single run |
| `npm run test:coverage` | Vitest with coverage |

---

## Routes

| Path | Component | Guard |
|---|---|---|
| `/login`, `/register` | `AuthPages.jsx` | Redirects to `/practice` when already signed in |
| `/practice`, `/practice/:questionId` | `PracticePage.jsx` | `RequireAuth` |
| `/dashboard` | `Dashboard.jsx` | `RequireAuth` |
| `/connection` | `ConnectionPage.jsx` | `RequireAuth` |
| anything else | redirect to `/practice` or `/login` | |

`RequireAuth` (in `App.jsx`) renders a spinner while the session is being restored, then either the
children or a redirect to `/login`. Authenticated routes are nested inside `AppShell`, which
supplies the top bar and an `<Outlet/>`.

There is no instructor UI. The admin REST API exists for scripted administration — see
[`../docs/API.md`](../docs/API.md).

---

## State and data

No Redux, no React Query. Three mechanisms, and that is all:

**`AuthContext`** holds the session: `{ user, loading, login, register, logout }` via `useAuth()`.
On mount it restores the token from `sessionStorage` and calls `/api/me`. It registers the client's
unauthorized handler, so any `401` logs the user out everywhere at once.

**`useApi(loader, deps)`** in `components/ui.jsx` is the data-fetching hook: it returns
`{ data, error, loading, reload }`, and cancels in-flight requests on unmount.

**Local `useState`** for everything else. Pages own their own form and view state.

---

## The API client

`src/api/client.js` is the only place that calls `fetch`. Everything else imports
`get` / `post` / `patch` / `del`.

```js
import { get, post, ApiError } from '../api/client.js';

const { questions } = await get('/api/questions');
try {
  await post(`/api/questions/${id}/submit`, { query });
} catch (err) {
  if (err instanceof ApiError && err.code === 'INVALID_SYNTAX') {
    // err.line and err.column point at the problem
  }
}
```

It attaches `Authorization: Bearer <token>`, unwraps the `{ error: { code, message, line, column } }`
envelope into an `ApiError`, turns an unreachable server into
`ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Is the backend running?')`, and routes
`401` to the handler `AuthContext` registered.

**What the browser stores:** the JWT, in `sessionStorage` under `mp_session_token`. Nothing else.
Connection strings and database passwords are sent to the backend once and never cached in
`localStorage`, `sessionStorage` or a cookie.

---

## The practice screen

`PracticePage.jsx` is the largest component and the one worth reading first. Three columns:

**Left — `QuestionList`.** The assigned questions grouped by topic, each with its points and a
completion tick. Selecting one pushes `/practice/:questionId`.

**Middle — the description.** What to return, which collection, the allowed operations and the test
cases the answer will be graded against. Collapsible with **‹**, so the playground can take the
full width; the **DESCRIPTION** tab brings it back.

**Right — the playground.** `CodeEditor` (syntax highlighting, line numbers, adjustable font size,
Ctrl+Enter to run) over a results panel with two tabs:

* *Query Results* — documents, or an error with line and column, or the empty / truncated state.
* *Test Results* — per-test-case pass/fail after **Submit**.

**Show collections** — the tab on the right edge opens `CollectionsDrawer`, modelled on the Atlas
Data Explorer: one tab per collection with the question's own collection first, *Documents* and
*Schema* tabs, the `db.<collection>.find({})` namespace line, the result range, and the three Atlas
view modes rendered by `MongoDocuments.jsx`:

| View | Rendering |
|---|---|
| **list** | A bordered card per document. `ObjectId("…")` and `ISODate("…")` in red, strings green, numbers blue; nested values collapsed behind a caret as `Array` / `Object` |
| **{ } JSON** | Extended JSON, as Atlas shows it |
| **▦ table** | Fields as columns |

Query results reuse the same list rendering, so what a student sees while browsing and what they
see after running a query look alike.

On first load the page calls `POST /api/workspace/ensure`, which connects to the local simulation
and initializes the private workspace if needed — so a new student lands on a working IDE with
nothing to configure.

---

## Styling

One stylesheet, `src/styles.css` (~340 lines), with design tokens as CSS custom properties on
`:root`:

```css
--bg --panel --ink --muted --line --line-soft      /* surfaces and text */
--brand --brand-dark --brand-soft --brand-ink      /* purple accent      */
--mongo --ok --ok-bg --bad --bad-bg --warn --warn-bg
--editor-bg --editor-head --editor-gutter --editor-ink
--radius
```

Change a token rather than a rule when you want to re-theme. Class names are plain and semantic
(`.shell`, `.topbar`, `.panel`, `.editor`); there is no utility framework and no preprocessor.

---

## Configuration

Development needs none — Vite proxies `/api` to `http://localhost:4000`.

| Variable | When |
|---|---|
| `VITE_API_PROXY` | Dev server: the API is on a different port |
| `VITE_API_URL` | Production build: the API is on a different origin |

See [`.env.example`](.env.example). Vite reads proxy settings at startup only — restart the dev
server after changing them.

---

## Tests

```bash
npm test                                   # 15 tests
npx vitest                                 # watch mode
npx vitest run src/test/PracticePage.test.jsx
```

jsdom environment, configured in `vite.config.js`. `src/test/setup.js` loads jest-dom matchers;
`src/test/helpers.jsx` renders a component inside the router and auth context with a stubbed API.

| File | Covers |
|---|---|
| `PracticePage.test.jsx` | Run, submit, error states, the collections drawer |
| `client.test.js` | Token handling, error envelope, network failure, 401 |
| `ConnectionPage.test.jsx` | Local vs Atlas, validation, masked password field |

Tests assert on what the user sees — roles, labels and text — not on implementation details. More
in [`../docs/TESTING.md`](../docs/TESTING.md).

---

## Conventions

* Function components and hooks only.
* `.jsx` for files containing JSX, `.js` otherwise.
* Every network call goes through `api/client.js`. Nothing else calls `fetch`.
* Errors reach the user as an `Alert` or `ErrorAlert` with the message the API returned — the
  backend writes actionable messages, so do not replace them with a generic one.
* New styles are classes in `styles.css`, not inline `style` props.
