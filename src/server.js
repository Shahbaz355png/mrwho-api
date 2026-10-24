'use strict';

// Mr.Who API — Phase 2 backend entry point.
// Express + SQLite. See README.md for the endpoint list and what is real
// vs coded-but-untested.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const db = require('./db');
const authRoutes = require('./routes/auth');
const billingRoutes = require('./routes/billing');
const waRoutes = require('./routes/wa');

const app = express();

app.use(cors());
app.use(express.json({ limit: '256kb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});
app.get('/api/healthz', (_req, res) => {
  res.json({ ok: true });
});

// API routes. Mounted at the root (local-dev shape, unchanged) AND under
// /api — the production frontend build calls same-origin "/api/..." paths
// when this server serves the build itself (see DEPLOY.md).
app.use('/auth', authRoutes);
app.use('/api/auth', authRoutes);
app.use('/', billingRoutes); // GET /plans, GET+POST /subscriptions
app.use('/api', billingRoutes); // GET /api/plans, GET+POST /api/subscriptions
app.use('/wa', waRoutes);
app.use('/api/wa', waRoutes);

// ---------------------------------------------------------------------------
// Production: serve the frontend build from the same process/port.
// Enabled when FRONTEND_DIST points at the build output (absolute, or
// relative to this backend folder) or when a ./frontend-dist folder with an
// index.html exists next to package.json. Local dev is unaffected: with no
// build present, nothing below is registered and "/" keeps returning the
// JSON info object.
// ---------------------------------------------------------------------------
const BACKEND_ROOT = path.join(__dirname, '..');
const DEFAULT_DIST = path.join(BACKEND_ROOT, 'frontend-dist');
const FRONTEND_DIST = process.env.FRONTEND_DIST
  ? path.resolve(BACKEND_ROOT, process.env.FRONTEND_DIST)
  : fs.existsSync(path.join(DEFAULT_DIST, 'index.html'))
    ? DEFAULT_DIST
    : null;

if (FRONTEND_DIST) {
  if (fs.existsSync(path.join(FRONTEND_DIST, 'index.html'))) {
    app.use(express.static(FRONTEND_DIST));
    // SPA fallback: any GET that is not an API path gets the app shell.
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (/^\/(api|auth|wa|plans|subscriptions|healthz)(\/|$)/.test(req.path)) {
        return next();
      }
      return res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
    });
    console.log(`[mrwho-backend] serving frontend build from ${FRONTEND_DIST}`);
  } else {
    console.warn(
      `[mrwho-backend] FRONTEND_DIST is set (${FRONTEND_DIST}) but no index.html was found there — frontend not served.`
    );
  }
}

app.get('/', (_req, res) => {
  res.json({ name: 'Mr.Who API backend', phase: 2, status: 'ok' });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'No such route.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: 'Request body must be valid JSON.' });
  }
  console.error('[server]', err && err.message);
  return res.status(500).json({ error: 'server_error', message: 'Unexpected server error.' });
});

const PORT = Number(process.env.PORT) || 4000;

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[mrwho-backend] listening on port ${PORT} (db: ${db.DB_PATH})`);
      if (!process.env.WA_SYSTEM_TOKEN) {
        console.log(
          '[mrwho-backend] WA_SYSTEM_TOKEN not set — health checks will honestly report "Unknown / Not assessed" until it is configured.'
        );
      }
    });
  })
  .catch((e) => {
    console.error('[mrwho-backend] database init failed:', e.message);
    process.exit(1);
  });
