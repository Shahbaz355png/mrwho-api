'use strict';

// ============================================================================
// Minimal Meta Graph API client (v21.0) for the Mr.Who API backend.
//
// Secrets policy: every credential comes from ENVIRONMENT VARIABLES ONLY
// (see .env.example). Nothing is hardcoded, read from files, or logged.
// Tokens are never returned to any frontend caller — they are used here,
// server-side, and only Meta's response data travels onward.
// ============================================================================

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const TIMEOUT_MS = 15000;

const PHONE_FIELDS =
  'display_phone_number,verified_name,quality_rating,status,code_verification_status,messaging_limit_tier';
const WABA_FIELDS = 'name,account_review_status,timezone_id,currency';

async function graphRequest(pathWithQuery, { method = 'GET', token, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GRAPH_BASE}${pathWithQuery}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = (data && data.error) || {};
      return {
        ok: false,
        status: res.status,
        error: {
          message: err.message || `Meta Graph API returned HTTP ${res.status}`,
          code: err.code ?? null,
          type: err.type ?? null,
        },
        data,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: {
        message:
          e && e.name === 'AbortError'
            ? 'Meta Graph API request timed out'
            : `Could not reach Meta Graph API: ${e && e.message ? e.message : 'network error'}`,
        code: null,
        type: 'NetworkError',
      },
      data: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Real reads — the same field sets the verified connector helper (wa.py)
// uses against this API version.
function readPhoneNumber(phoneNumberId, token) {
  return graphRequest(`/${encodeURIComponent(phoneNumberId)}?fields=${PHONE_FIELDS}`, { token });
}

function readWaba(wabaId, token) {
  return graphRequest(`/${encodeURIComponent(wabaId)}?fields=${WABA_FIELDS}`, { token });
}

// ============================================================================
// Embedded Signup finishing steps — CODED BUT NOT LIVE-TESTED.
//
// There is no Meta app secret in any of our files today, so in the current
// environment these functions are never reached (the capture route checks
// the env config first and honestly reports "not configured"). They are
// written against the documented flow (implementation/coexistence plans):
//   1. GET /oauth/access_token?client_id&client_secret&code  (code exchange)
//   2. POST /{waba_id}/subscribed_apps                        (webhook sub)
// The exchanged token is used in-memory for step 2 and then discarded by
// this function; persisting per-account tokens (encrypted at rest) is a
// later phase. Verification reads in this backend use WA_SYSTEM_TOKEN.
// ============================================================================

async function exchangeCodeForToken({ appId, appSecret, code }) {
  const qs = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
  // The OAuth endpoint takes no Bearer token; the app secret in the query
  // is the credential. It is never logged.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GRAPH_BASE}/oauth/access_token?${qs.toString()}`, {
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || !data || !data.access_token) {
      const err = (data && data.error) || {};
      return {
        ok: false,
        error: {
          message: err.message || `Code exchange failed (HTTP ${res.status})`,
          code: err.code ?? null,
          type: err.type ?? null,
        },
        token: null,
      };
    }
    return { ok: true, error: null, token: data.access_token };
  } catch (e) {
    return {
      ok: false,
      error: { message: `Could not reach Meta Graph API: ${e && e.message}`, code: null, type: 'NetworkError' },
      token: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function subscribeAppToWaba(wabaId, token) {
  return graphRequest(`/${encodeURIComponent(wabaId)}/subscribed_apps`, {
    method: 'POST',
    token,
    body: {},
  });
}

module.exports = {
  GRAPH_BASE,
  readPhoneNumber,
  readWaba,
  exchangeCodeForToken,
  subscribeAppToWaba,
};
