'use strict';

// WhatsApp account routes.
//   POST /wa/connect/capture      — embedded-signup handoff from the
//                                   frontend (EmbeddedSignup.jsx). Stores
//                                   the account as "pending_verification";
//                                   an account is NEVER marked connected
//                                   without a successful live Meta read.
//   GET  /wa/accounts             — the caller's accounts with last known
//                                   real fields + latest health result.
//   POST /wa/accounts/:id/check   — a real Graph API health check. With no
//                                   server token or no IDs it honestly
//                                   returns "Unknown / Not assessed" —
//                                   never an invented score or status.

const express = require('express');
const db = require('../db');
const { authRequired } = require('../auth');
const graph = require('../graph');
const { deriveHealth, unknownHealth } = require('../health');

const router = express.Router();
router.use(authRequired);

function nowIso() {
  return new Date().toISOString();
}

// The account shape the frontend consumes. Mirrors the Phase 1 frontend
// model (label, phoneNumber, connection/health/api status) and adds the
// real Meta fields as they become known. Nulls stay null — the UI renders
// them as "Unknown", per the project's honesty rules.
function publicAccount(row, latestCheck) {
  const health =
    latestCheck && latestCheck.success
      ? {
          healthStatus: latestCheck.health_status || 'Unknown',
          healthScore: latestCheck.health_score,
          banRisk: latestCheck.ban_risk || 'Unknown',
          assessedAt: latestCheck.created_at,
        }
      : { healthStatus: 'Unknown', healthScore: null, banRisk: 'Unknown', assessedAt: null };
  return {
    id: row.id,
    label: row.label,
    phoneNumber: row.phone_number,
    phoneNumberId: row.phone_number_id,
    wabaId: row.waba_id,
    provider: row.provider,
    status: row.status, // pending_verification | connected | disconnected | restricted
    verifiedName: row.verified_name,
    qualityRating: row.quality_rating,
    messagingTier: row.messaging_tier,
    accountReviewStatus: row.account_review_status,
    lastCheckedAt: row.last_checked_at,
    health,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function latestCheckFor(accountId) {
  return db.get(
    `SELECT * FROM health_checks WHERE account_id = ? AND check_type = 'manual'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [accountId]
  );
}

async function logCheck(accountId, userId, fields) {
  const f = fields || {};
  await db.run(
    `INSERT INTO health_checks
       (account_id, user_id, check_type, success, phone_status, quality_rating,
        messaging_tier, code_verification_status, account_review_status,
        health_status, health_score, ban_risk, error, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      accountId,
      userId,
      f.checkType || 'manual',
      f.success ? 1 : 0,
      f.phoneStatus ?? null,
      f.qualityRating ?? null,
      f.messagingTier ?? null,
      f.codeVerificationStatus ?? null,
      f.accountReviewStatus ?? null,
      f.healthStatus ?? null,
      f.healthScore ?? null,
      f.banRisk ?? null,
      f.error ?? null,
      f.detail ? JSON.stringify(f.detail) : null,
      nowIso(),
    ]
  );
}

// ---------------------------------------------------------------------------
// POST /wa/connect/capture
// Body (as captured by EmbeddedSignup.jsx; both naming styles accepted):
//   { waba_id | wabaId, phone_number_id | phoneNumberId, code,
//     label?, phone_number | phoneNumber?, provider? }
// The `code` is single-use and short-lived; it is used server-side only,
// never echoed back, never logged.
// ---------------------------------------------------------------------------
router.post('/connect/capture', async (req, res) => {
  try {
    const body = req.body || {};
    const wabaId = body.waba_id || body.wabaId || null;
    const phoneNumberId = body.phone_number_id || body.phoneNumberId || null;
    const code = typeof body.code === 'string' && body.code.trim() ? body.code.trim() : null;
    const label =
      typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null;
    const phoneNumber = body.phone_number || body.phoneNumber || null;
    const provider =
      typeof body.provider === 'string' && body.provider.trim()
        ? body.provider.trim()
        : 'meta_cloud_api';

    if (!wabaId && !phoneNumberId) {
      return res.status(400).json({
        error: 'missing_ids',
        message: 'waba_id and/or phone_number_id are required (they come from the embedded-signup session event).',
      });
    }

    // Upsert: match an existing pending account for this user by phone
    // number ID first, else by WABA ID, else insert a new row.
    let existing = null;
    if (phoneNumberId) {
      existing = await db.get(
        'SELECT * FROM whatsapp_accounts WHERE user_id = ? AND phone_number_id = ?',
        [req.user.id, phoneNumberId]
      );
    }
    if (!existing && wabaId) {
      existing = await db.get(
        'SELECT * FROM whatsapp_accounts WHERE user_id = ? AND waba_id = ?',
        [req.user.id, wabaId]
      );
    }

    let account;
    if (existing) {
      await db.run(
        `UPDATE whatsapp_accounts
           SET waba_id = COALESCE(?, waba_id),
               phone_number_id = COALESCE(?, phone_number_id),
               label = COALESCE(?, label),
               phone_number = COALESCE(?, phone_number),
               provider = ?,
               updated_at = ?
         WHERE id = ?`,
        [wabaId, phoneNumberId, label, phoneNumber, provider, nowIso(), existing.id]
      );
      account = await db.get('SELECT * FROM whatsapp_accounts WHERE id = ?', [existing.id]);
    } else {
      const ts = nowIso();
      const result = await db.run(
        `INSERT INTO whatsapp_accounts
           (user_id, label, phone_number, phone_number_id, waba_id, provider,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending_verification', ?, ?)`,
        [req.user.id, label, phoneNumber, phoneNumberId, wabaId, provider, ts, ts]
      );
      account = await db.get('SELECT * FROM whatsapp_accounts WHERE id = ?', [result.lastID]);
    }

    // ---- Embedded-signup finishing steps (code exchange + app
    // subscription). Coded against Graph v21.0 with env-only credentials;
    // NOT live-tested — no app secret exists in our environment today, so
    // unless META_APP_ID + META_APP_SECRET are set this reports
    // "not_configured" and the account simply stays pending verification.
    const onboarding = {
      codeReceived: Boolean(code),
      codeExchange: 'not_attempted',
      appSubscription: 'not_attempted',
      detail: null,
    };
    if (code) {
      const appId = process.env.META_APP_ID;
      const appSecret = process.env.META_APP_SECRET;
      if (!appId || !appSecret) {
        onboarding.codeExchange = 'not_configured';
        onboarding.detail =
          'A signup code was received, but META_APP_ID / META_APP_SECRET are not configured on the server, so the code was not exchanged. The code expires quickly; the account remains pending verification and can still be verified with the server system token via POST /wa/accounts/:id/check.';
      } else {
        const exchange = await graph.exchangeCodeForToken({ appId, appSecret, code });
        if (!exchange.ok) {
          onboarding.codeExchange = 'failed';
          onboarding.detail = `Code exchange failed: ${exchange.error.message}`;
        } else {
          onboarding.codeExchange = 'succeeded';
          if (wabaId) {
            const sub = await graph.subscribeAppToWaba(wabaId, exchange.token);
            onboarding.appSubscription = sub.ok ? 'succeeded' : 'failed';
            if (!sub.ok) {
              onboarding.detail = `App subscription to the WABA failed: ${sub.error.message}`;
            }
          } else {
            onboarding.appSubscription = 'skipped_no_waba_id';
          }
        }
      }
    }

    await logCheck(account.id, req.user.id, {
      checkType: 'onboarding',
      success: onboarding.codeExchange === 'succeeded',
      error:
        onboarding.codeExchange === 'failed' || onboarding.codeExchange === 'not_configured'
          ? onboarding.detail
          : null,
      detail: onboarding,
    });

    const latest = await latestCheckFor(account.id);
    return res.status(existing ? 200 : 201).json({
      account: publicAccount(account, latest),
      onboarding,
      note:
        'Stored as "pending verification". This account is only shown as connected after a live Meta check succeeds (POST /wa/accounts/:id/check) — captured IDs alone do not prove a connection.',
    });
  } catch (e) {
    console.error('[wa/capture]', e.message);
    return res.status(500).json({ error: 'server_error', message: 'Could not store the captured account.' });
  }
});

// ---------------------------------------------------------------------------
// GET /wa/accounts
// ---------------------------------------------------------------------------
router.get('/accounts', async (req, res) => {
  try {
    const rows = await db.all(
      'SELECT * FROM whatsapp_accounts WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    const accounts = [];
    for (const row of rows) {
      accounts.push(publicAccount(row, await latestCheckFor(row.id)));
    }
    return res.json({ accounts });
  } catch (e) {
    console.error('[wa/accounts]', e.message);
    return res.status(500).json({ error: 'server_error', message: 'Could not load accounts.' });
  }
});

// ---------------------------------------------------------------------------
// POST /wa/accounts/:id/check
// Performs the real Graph reads when WA_SYSTEM_TOKEN is configured and the
// account has IDs; otherwise answers honestly with Unknown / Not assessed.
// ---------------------------------------------------------------------------
router.post('/accounts/:id/check', async (req, res) => {
  try {
    const account = await db.get(
      'SELECT * FROM whatsapp_accounts WHERE id = ? AND user_id = ?',
      [Number(req.params.id), req.user.id]
    );
    if (!account) {
      return res.status(404).json({ error: 'not_found', message: 'No such WhatsApp account for this user.' });
    }

    const token = process.env.WA_SYSTEM_TOKEN;

    async function answerNotAssessed(reason, errorCode) {
      await logCheck(account.id, req.user.id, { success: false, error: errorCode });
      await db.run('UPDATE whatsapp_accounts SET last_checked_at = ?, updated_at = ? WHERE id = ?', [
        nowIso(),
        nowIso(),
        account.id,
      ]);
      const fresh = await db.get('SELECT * FROM whatsapp_accounts WHERE id = ?', [account.id]);
      return res.json({
        assessed: false,
        reason,
        account: publicAccount(fresh, await latestCheckFor(account.id)),
        health: unknownHealth(),
        lastCheckedAt: fresh.last_checked_at,
        lastSuccessfulCheckAt: null,
      });
    }

    if (!token) {
      return answerNotAssessed(
        'Not assessed — the server WhatsApp token (WA_SYSTEM_TOKEN) is not configured, so no live Meta read was attempted. Health values stay "Unknown" rather than guessed.',
        'server_token_not_configured'
      );
    }
    if (!account.phone_number_id) {
      return answerNotAssessed(
        'Not assessed — this account has no Phone Number ID yet, so there is nothing to read from Meta.',
        'missing_phone_number_id'
      );
    }

    // Real reads.
    const phoneRes = await graph.readPhoneNumber(account.phone_number_id, token);
    if (!phoneRes.ok) {
      return answerNotAssessed(
        `Not assessed — Meta rejected the read for this number: ${phoneRes.error.message} (code ${phoneRes.error.code ?? 'n/a'}). The token may not have access to this number's WhatsApp account yet.`,
        `graph_error_${phoneRes.error.code ?? phoneRes.status}`
      );
    }
    const phone = phoneRes.data || {};

    let waba = null;
    let wabaError = null;
    if (account.waba_id) {
      const wabaRes = await graph.readWaba(account.waba_id, token);
      if (wabaRes.ok) waba = wabaRes.data || {};
      else wabaError = wabaRes.error.message;
    }

    const health = deriveHealth(phone, waba);

    await logCheck(account.id, req.user.id, {
      success: true,
      phoneStatus: phone.status ?? null,
      qualityRating: phone.quality_rating ?? null,
      messagingTier: phone.messaging_limit_tier ?? null,
      codeVerificationStatus: phone.code_verification_status ?? null,
      accountReviewStatus: waba ? waba.account_review_status ?? null : null,
      healthStatus: health.healthStatus,
      healthScore: health.healthScore,
      banRisk: health.banRisk,
      error: wabaError ? `WABA read failed: ${wabaError}` : null,
      detail: { phone, waba },
    });

    const phoneStatusNorm = typeof phone.status === 'string' ? phone.status.toUpperCase() : null;
    const mappedStatus =
      phoneStatusNorm === 'CONNECTED'
        ? 'connected'
        : phoneStatusNorm === 'RESTRICTED'
          ? 'restricted'
          : phoneStatusNorm
            ? 'disconnected'
            : account.status;

    const checkedAt = nowIso();
    await db.run(
      `UPDATE whatsapp_accounts
         SET status = ?,
             verified_name = COALESCE(?, verified_name),
             phone_number = COALESCE(?, phone_number),
             quality_rating = ?,
             messaging_tier = ?,
             account_review_status = ?,
             last_checked_at = ?,
             updated_at = ?
       WHERE id = ?`,
      [
        mappedStatus,
        phone.verified_name ?? null,
        phone.display_phone_number ?? null,
        phone.quality_rating ?? null,
        phone.messaging_limit_tier ?? null,
        waba ? waba.account_review_status ?? null : account.account_review_status,
        checkedAt,
        checkedAt,
        account.id,
      ]
    );

    const fresh = await db.get('SELECT * FROM whatsapp_accounts WHERE id = ?', [account.id]);
    return res.json({
      assessed: true,
      account: publicAccount(fresh, await latestCheckFor(account.id)),
      phone: {
        displayPhoneNumber: phone.display_phone_number ?? null,
        verifiedName: phone.verified_name ?? null,
        status: phone.status ?? null,
        qualityRating: phone.quality_rating ?? null,
        codeVerificationStatus: phone.code_verification_status ?? null,
        messagingLimitTier: phone.messaging_limit_tier ?? null,
      },
      waba: waba
        ? { id: account.waba_id, name: waba.name ?? null, accountReviewStatus: waba.account_review_status ?? null }
        : null,
      ...(wabaError ? { wabaError } : {}),
      health,
      lastCheckedAt: checkedAt,
      lastSuccessfulCheckAt: checkedAt,
    });
  } catch (e) {
    console.error('[wa/check]', e.message);
    return res.status(500).json({ error: 'server_error', message: 'Health check failed.' });
  }
});

module.exports = router;
