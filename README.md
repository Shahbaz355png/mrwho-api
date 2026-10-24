# Mr.Who API — Backend (Phase 2)

Node.js (Express) + SQLite server for the **Mr.Who API** app: user accounts,
WhatsApp account records, embedded-signup capture, real Meta health checks,
and plans/subscriptions. Built per `workspace/messenger_app/implementation_plan.md`
and `workspace/messenger_app/coexistence_onboarding_plan.md`.

**Honesty rules (enforced in code, from the project spec):**

- No health value is ever invented. A health score/status is derived **only**
  from real fields returned by Meta's Graph API. Missing inputs render as
  `"Unknown"` / `null` with an explanation — never a placeholder number.
- A captured WhatsApp account is stored as **`pending_verification`** and is
  only shown as connected after a live Meta read succeeds.
- Tokens and secrets live **only** in server environment variables. Nothing
  secret is stored in this repo, returned to the frontend, or logged.

---

## Repository layout

- **Root** — the deployable project: the Node.js backend (Express + SQLite).
  In production it also serves the built frontend from `frontend-dist/`, so
  the whole app runs as one service on one domain (see `DEPLOY.md`).
- **`src/`** — backend source (auth, plans/subscriptions, WhatsApp account
  records, embedded-signup capture, real Meta health checks).
- **`frontend-dist/`** — production build of the React app, served by the
  backend. Rebuilt from `frontend/` (see `frontend/README_INTEGRATION.md`).
- **`frontend/`** — the React frontend source.
- **`render.yaml` / `DEPLOY.md`** — Render deploy config and step-by-step
  go-live notes. Secrets live only in server environment variables, set in
  the host dashboard — never in this repo.

## Run it

```bash
cd ~/workspace/mrwho-backend
npm install
cp .env.example .env   # fill in values locally; see below
npm start              # listens on PORT (default 4000)
```

Without any `.env`, the server still runs: signup/login/plans/capture all
work, and health checks honestly report **"Unknown / Not assessed"** because
no WhatsApp token is configured. That is the expected state until
`WA_SYSTEM_TOKEN` is set.

### Environment variables (names only — see `.env.example`)

| Variable | Used for |
|---|---|
| `PORT` | Listen port (default 4000) |
| `JWT_SECRET` | Signs login session tokens. A development placeholder + warning is used if unset — set this for any real deployment |
| `DB_PATH` | SQLite file path (default `./data/mrwho.db`) |
| `META_APP_ID` | Meta app ID ("mr who api") — public identifier |
| `META_APP_SECRET` | Meta app secret — **server-side only**, needed for the embedded-signup code exchange |
| `WA_SYSTEM_TOKEN` | Permanent system-user token (whatsapp_business_messaging + whatsapp_business_management) used for the real health reads |
| `PHONE_NUMBER_ID`, `WABA_ID` | Reference IDs from the Meta console (docs/tooling; the backend reads IDs per account row) |
| `FRONTEND_DIST` | Production only: folder with the frontend build — the server then serves the app at `/` and the API under `/api` on one port. See **DEPLOY.md** |

### SQLite driver note

This code was built in an environment where both `better-sqlite3` and
`sqlite3` fail to install (native build / prebuild-download errors), so the
DB layer uses Node's built-in **`node:sqlite`** (`DatabaseSync`, Node 24) —
same SQLite engine, same single-file DB. `src/db.js` exposes an async
`run/get/all` interface so swapping in `better-sqlite3` later touches only
that one file.

---

## Endpoints

### Auth

| Method & path | Auth | Notes |
|---|---|---|
| `POST /auth/signup` | — | `{ email, password (>= 8 chars), name? }` → `201 { user, token }`. Password stored as a bcrypt hash; never logged. Duplicate email → `409` |
| `POST /auth/login` | — | `{ email, password }` → `{ user, token }`. One generic error for unknown email / wrong password |

Send the session token as `Authorization: Bearer <token>` on all routes below.

### Plans & subscriptions (no real payments in this phase)

| Method & path | Auth | Notes |
|---|---|---|
| `GET /plans` | — | The three tiers: **Starter Rs 3,000/mo · Business Rs 5,000/mo · Premium Rs 10,000/mo** (seeded in `src/db.js`) |
| `GET /subscriptions` | ✔ | The caller's subscription rows (an empty list is normal) |
| `POST /subscriptions` | ✔ | `{ planId }` or `{ plan: "starter" \| "business" \| "premium" }` → creates a row with status **`pending_payment`**. Nothing is charged |

### WhatsApp accounts & health

| Method & path | Auth | Notes |
|---|---|---|
| `POST /wa/connect/capture` | ✔ | Embedded-signup handoff — see below |
| `GET /wa/accounts` | ✔ | Caller's accounts with last known real fields + latest health result (`Unknown` until a check succeeds) |
| `POST /wa/accounts/:id/check` | ✔ | Runs the real health check — see below |

#### `POST /wa/connect/capture`

Accepts exactly what the frontend `EmbeddedSignup.jsx`
(`~/workspace/mrwho-starter/coexistence/src/`) captures from Meta's
Embedded Signup window:

```json
{ "waba_id": "…", "phone_number_id": "…", "code": "…", "label": "optional" }
```

(camelCase `wabaId` / `phoneNumberId` are accepted too.) The row is stored
as **`pending_verification`** — captured IDs alone never mark an account
connected. If a `code` is present **and** `META_APP_ID` + `META_APP_SECRET`
are configured, the server attempts the finishing steps against Graph
v21.0: exchange the code (`GET /oauth/access_token`) and subscribe the app
to the WABA (`POST /{waba_id}/subscribed_apps`). The response reports each
step's outcome (`not_configured` / `succeeded` / `failed`). The exchanged
token is used in memory for the subscription call and is **not** persisted
or returned; per-account token storage (encrypted at rest) is a later
phase. Every capture is logged in `health_checks` with `check_type =
'onboarding'`.

#### `POST /wa/accounts/:id/check`

Performs the real Graph v21.0 reads with `WA_SYSTEM_TOKEN`:

- `GET /{phone_number_id}?fields=display_phone_number,verified_name,quality_rating,status,code_verification_status,messaging_limit_tier`
- `GET /{waba_id}?fields=name,account_review_status,timezone_id,currency`

(the same field sets the verified `wa.py` connector helper uses). Results
update the account row and are appended to the `health_checks` log.

Derived health (implementation plan §D — all from the real fields above):

- **Health status:** Healthy / Warning / Critical / Disconnected / Unknown
  by the plan's signal mapping.
- **Ban risk:** Low / Medium / High / Unknown by the plan's rules, always
  returned with the limitations disclaimer: *"This is an estimate based on
  the signals Meta shares (quality rating, account standing, recent
  delivery failures). Meta does not publish ban predictions, and no
  estimate can guarantee an account will or will not be restricted."*
- **Health score 0–100 (estimate):** formula components are quality rating
  (Green 50 / Yellow 30 / Red 10) + account review (Approved 20 / Pending
  10 / Rejected 0) + delivery health (up to 20) + recent API errors (up to
  10). The delivery/error components need message-status records — a
  **Phase 3** data source this backend does not have yet — so per the
  plan's gate the headline `healthScore` stays `null` ("Not enough data
  yet") until all inputs exist. The real components retrieved **are**
  returned in `healthScoreComponents` so nothing is hidden.

If `WA_SYSTEM_TOKEN` is not configured, the account has no Phone Number
ID, or Meta rejects the read, the endpoint returns `assessed: false` with
the plain reason and the all-Unknown health object — and still logs the
attempt in `health_checks` (with `success = 0`) and updates
`last_checked_at`.

---

## Database tables

`users` (id, email unique, password_hash, name, created_at) ·
`whatsapp_accounts` (user_id, label, phone_number, phone_number_id,
waba_id, provider, status, verified_name, quality_rating, messaging_tier,
account_review_status, last_checked_at, timestamps) ·
`plans` (code, name, price_pkr, period, features, sort) ·
`subscriptions` (user_id, plan_id, status, started_at,
current_period_end, created_at) ·
`health_checks` (account_id, user_id, check_type manual/onboarding,
success, phone/quality/tier/review snapshots, derived health_status /
health_score / ban_risk, error, detail, created_at).

Schema + plan seeding live in `src/db.js`; the file DB is created on boot.

---

## What is real vs coded-but-untested

**Real and verified** (boot + curl tested at build time): signup/login
with bcrypt + JWT, plans list, subscription create/list, capture →
pending account, accounts list, and the check endpoint's honest
Unknown path (no token configured).

**Coded but NOT live-tested:**

- The Graph health reads themselves — the code path is identical in shape
  to the verified `wa.py` connector reads, but this server has not yet run
  with a real `WA_SYSTEM_TOKEN` in its environment (the working token
  lives in the Secure Vault connector, not in a file here).
- The embedded-signup code exchange + `subscribed_apps` calls — **no Meta
  app secret exists in our files**, so they cannot have been exercised.
  They activate only when `META_APP_ID` / `META_APP_SECRET` are set in
  the server environment, and the capture response reports their real
  outcome when they run.

**Not in this phase:** message sending, webhook receiver + status
persistence (the delivery-data source the score needs), scheduler /
automatic monitoring, per-account token storage, payments, Tech Provider
App Review (external-client onboarding gate).

---

## How this plugs into the frontend later

- The Phase 1 frontend (`~/workspace/mrwho-starter/`) currently keeps
  accounts in `localStorage` with `Pending connection` / `Unknown`
  placeholders. Phase 2 wiring: signup/login screens call `/auth/*` and
  store the JWT; the account table reads `GET /wa/accounts` (same field
  names: label, phoneNumber, status, qualityRating, lastCheckedAt).
- `EmbeddedSignup.jsx` already merges its two capture channels into one
  snapshot `{ wabaId, phoneNumberId, code }` via its `onCaptured` prop —
  the caller will POST that snapshot to `/wa/connect/capture` with the
  user's Bearer token, then offer "Check now" → `POST /wa/accounts/:id/check`.
- The WhatsApp API health screen maps directly onto the check response:
  `health.healthStatus`, `health.banRisk` (+ disclaimer), account status,
  quality rating, messaging tier, and `lastCheckedAt`.
