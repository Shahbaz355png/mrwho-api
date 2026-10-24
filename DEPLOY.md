# Mr.Who API — Deployment Guide (Phase 4)

**Chosen host: Render** — one Web Service running this backend, which also
serves the production frontend build. One process, one port, one HTTPS
domain for the whole product.

Why Render / why one service:

- The previous official WhatsApp server (`~/workspace/xsolution-server-official`)
  already used this exact pattern (`render.yaml`, Node runtime,
  `sync: false` secrets) — we reuse what the project already knows.
- The Facebook JS SDK (Embedded Signup / coexistence connect flow) needs
  the page's domain on Meta's allowlist. A **single domain** for page +
  API keeps that to one entry: the frontend production build calls
  same-origin `/api/...` paths, and this server mounts the API under
  `/api` *and* serves the build itself (see "How it fits together").
- Render gives HTTPS automatically, which Meta requires.

---

## How it fits together

```
https://<your-domain>/            → frontend build (Express static)
https://<your-domain>/api/...     → this backend's API (same process)
https://<your-domain>/healthz     → {"ok":true}
```

- Backend: `npm start` → `node src/server.js`, listens on `PORT`
  (Render sets `PORT`; default 4000 locally).
- The server serves the frontend when `FRONTEND_DIST` points at the
  build output (or when a `./frontend-dist/` folder with `index.html`
  sits in this backend folder). SPA routes fall back to `index.html`;
  API paths never do. With no build present (local dev), nothing changes:
  `/` returns the JSON info object and the API also answers at its root
  paths (`/auth/...`, `/plans`, `/wa/...`) exactly as before.
- Frontend: `npm run build` with **`VITE_API_BASE` unset** compiles the
  API base as same-origin `"/api"`. (Setting `VITE_API_BASE` is only for
  a split deployment where the API lives on a different origin.)

---

## Deploy steps (Render)

### 1. Prepare the deploy folder

The deploy repo/root is **this backend folder** (`render.yaml` sits here,
same as the old project). The frontend build must be inside it:

```bash
# Build the frontend (production, same-origin /api — do NOT set VITE_API_BASE)
cd ~/workspace/mrwho-starter/coexistence
npm install
npm run build

# Copy the build into the backend folder as frontend-dist/
cp -r dist ~/workspace/mrwho-backend/frontend-dist
```

Rebuild + re-copy `frontend-dist/` whenever the frontend changes, then
redeploy. (Alternatively set the `FRONTEND_DIST` env var to any other
folder that holds the build.)

### 2. Create the service

- Push this folder (including `render.yaml` and `frontend-dist/`) to a
  Git repo, then in **Render**: **New → Blueprint** → pick the repo
  (Render reads `render.yaml`: service `mrwho-api`, `npm install`,
  `npm start`), **or** **New → Web Service** with Runtime **Node**,
  Build Command `npm install`, Start Command `npm start`.
- `render.yaml` already pins `NODE_VERSION=24` — required, because the
  DB layer uses Node's built-in `node:sqlite`.

### 3. Set the environment variables

In **Render → mrwho-api → Environment**. `sync: false` entries in
`render.yaml` appear as empty fields waiting for the owner's values —
**paste secrets only here, in the Render dashboard. Never into chat,
code, git, or this file.**

| Variable | Where the value comes from |
|---|---|
| `PORT` | Set automatically by Render. Nothing to do. |
| `NODE_VERSION` | Already `24` in `render.yaml`. |
| `FRONTEND_DIST` | Already `frontend-dist` in `render.yaml` (step 1). |
| `JWT_SECRET` | `generateValue: true` in `render.yaml` — Render creates it. (Or the owner pastes any long random string.) |
| `META_APP_ID` | `2275308129993062` — the **mr who api** app. Public identifier (Meta app → App settings → Basic). Safe to type anywhere. |
| `META_APP_SECRET` | Meta app → **App settings → Basic → App Secret → Show** (Facebook may ask for the account password). **Owner pastes it into the Render env dashboard only.** Needed for the Embedded Signup code exchange; without it, captures stay `pending_verification` and the server honestly reports the exchange as `not_configured`. |
| `WA_SYSTEM_TOKEN` | The owner's **permanent system-user token** (system user **Mr Who**, permissions `whatsapp_business_messaging` + `whatsapp_business_management`). It currently exists **only in the Secure Vault connector** (`custom.meta-whatsapp`) — it is not in any file. The owner places a copy into the Render env dashboard (from Meta Business Settings → Users → System users → Mr Who, or by generating the token value again there). Without it, health checks honestly report **"Unknown / Not assessed"**. |
| `PHONE_NUMBER_ID` | Optional reference value: `1305546892647401` (the +1 555-354-6581 test number, from the app's WhatsApp → API Setup screen). The backend reads IDs per account row; this is for tooling/docs. |
| `WABA_ID` | Optional reference value: `1599434671636923` ("ChatBoosts", same screen). Same note as above. |
| `DB_PATH` | Optional. Default `./data/mrwho.db`. ⚠️ **Render's filesystem is ephemeral** — the SQLite file is lost on redeploy/restart unless a **Render Disk** is attached. For real data: add a Disk (e.g. mount path `/var/data`) and set `DB_PATH=/var/data/mrwho.db`. Fine to skip for the first smoke deployment. |

### 4. Deploy

Render deploys on push (Blueprint/Web Service default) or via
**Manual Deploy → Deploy latest commit**. Watch the logs for:

```
[mrwho-backend] serving frontend build from .../frontend-dist
[mrwho-backend] listening on port ...
```

### 5. Facebook-side settings on the deployed domain (owner, in the Meta app)

Do these **after** the first deploy, using the real domain
(e.g. `mrwho-api.onrender.com`, or a custom domain if one is attached).
Both are in **developers.facebook.com → mr who api**:

1. **Facebook Login for Business → Settings** → *Allowed domains for
   the JavaScript SDK*: add the deployed domain
   (`https://<deployed-domain>`) and save. Without this, the Facebook
   popup refuses to open on the live site ("domain not allowed").
2. **App settings → Basic**:
   - **App Domains:** add the bare domain (`<deployed-domain>`,
     no `https://`, no path).
   - **Website → Site URL:** `https://<deployed-domain>/`.
   Save changes.

(The `config_id` for the connect flow — Configuration **"Mr Who
Connect"**, ID `2214557442474878` — is already compiled into the
frontend; nothing to change there.)

---

## Post-deploy smoke checklist

Run through in order; all were verified locally in production mode
(2026-10-23) and should behave identically on Render:

- [ ] `GET https://<domain>/healthz` → `{"ok":true}`
      (also `/api/healthz` → `{"ok":true}`)
- [ ] `GET https://<domain>/` → the Mr.Who API app loads (not JSON);
      a deep link like `/dashboard` also loads the app (SPA fallback).
- [ ] `GET https://<domain>/api/plans` → the three tiers
      (Starter Rs 3,000 · Business Rs 5,000 · Premium Rs 10,000).
- [ ] In the app: **Create account** with a fresh email → succeeds and
      lands signed in (proves DB + JWT on the server).
- [ ] **Settings → Plans & subscriptions** lists the tiers from the
      server; "Choose plan" creates a `Pending payment` row
      (no real checkout in this phase).
- [ ] **WhatsApp API screen → Connect your WhatsApp** → the Facebook
      popup **opens** (proves the FB SDK initialised and the domain is
      allowlisted — step 5.1; a "domain not allowed" error means that
      step is missing or the domain is mistyped).
- [ ] After the owner connects a number and clicks **Check connection /
      health**: with `WA_SYSTEM_TOKEN` set (step 3), the panel shows
      Meta's real fields (status / quality / tier / review). Before the
      token is set it must say **Unknown / Not assessed** — that is the
      honest pre-configuration state, not an error.

## Notes / limits

- **Backups:** the whole product state is the one SQLite file (`DB_PATH`).
  On a Render Disk it persists; back it up before major upgrades.
- **App Review gate (unchanged):** the owner's own number can complete
  the connect flow while the app is in Development mode. Onboarding
  *external clients'* numbers still needs Tech Provider completion +
  App Review Advanced Access for the two WhatsApp permissions
  (see `~/workspace/messenger_app/coexistence_onboarding_plan.md` §2/§8).
- **Local dev is unchanged:** backend `npm start` on :4000 with the API
  at root paths; frontend `npm run dev` on :5173 defaulting to
  `http://localhost:4000`.
