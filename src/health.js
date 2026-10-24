'use strict';

// ============================================================================
// Health derivation — Mr.Who API
// ----------------------------------------------------------------------------
// Rules copied from the implementation plan (workspace/messenger_app/
// implementation_plan.md, sections C.1 and D):
//
//  - Every value here is derived ONLY from real fields returned by Meta's
//    Graph API (the phone-number object and the WABA object). Nothing is
//    invented, simulated, or defaulted to a "good" value.
//  - Health Score 0-100 is an ESTIMATE with a fixed formula:
//        quality rating    Green +50 / Yellow +30 / Red +10
//        account review    Approved +20 / Pending +10 / Rejected +0
//        delivery health   up to +20 from the 7-day failure rate
//        recent API errors up to +10
//    The delivery and error components need message-status / error records
//    (a Phase 3 data source — this backend sends nothing and stores no
//    message statuses yet), so those components are UNAVAILABLE here.
//    Per the plan's gate, the headline score is shown only when quality
//    rating + review status + delivery data all exist. Until then the
//    score is null ("Not enough data yet") — but the real components we
//    do have are always reported, so the derivation is never hidden.
//  - Ban Risk is an ESTIMATE with the plan's rule mapping, always served
//    together with the limitations disclaimer below.
// ============================================================================

const BAN_RISK_DISCLAIMER =
  'This is an estimate based on the signals Meta shares (quality rating, ' +
  'account standing, recent delivery failures). Meta does not publish ban ' +
  'predictions, and no estimate can guarantee an account will or will not ' +
  'be restricted.';

const SCORE_NOTE_NO_DATA =
  'Not assessed — no live Meta data has been retrieved for this account yet.';
const SCORE_NOTE_PARTIAL =
  'Not enough data yet — a score is shown only when quality rating, account ' +
  'review status and delivery data are all available. Delivery data appears ' +
  'once messages are sent through this service and their statuses are ' +
  'recorded (Phase 3). The real score components retrieved so far are ' +
  'listed in healthScoreComponents.';

function norm(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().toUpperCase() : null;
}

// The all-Unknown shape used whenever no live read has succeeded.
function unknownHealth() {
  return {
    healthStatus: 'Unknown',
    healthScore: null,
    healthScoreComponents: {
      qualityRating: null,
      accountReview: null,
      deliveryHealth: null,
      recentApiErrors: null,
    },
    healthScoreNote: SCORE_NOTE_NO_DATA,
    banRisk: 'Unknown',
    banRiskDisclaimer: BAN_RISK_DISCLAIMER,
    warnings: [],
  };
}

// phone: Graph phone-number object (or null)
// waba:  Graph WABA object (or null)
function deriveHealth(phone, waba) {
  const quality = norm(phone && phone.quality_rating); // GREEN/YELLOW/RED/UNKNOWN
  const phoneStatus = norm(phone && phone.status); // CONNECTED/DISCONNECTED/RESTRICTED/...
  const codeStatus = norm(phone && phone.code_verification_status); // VERIFIED/...
  const review = norm(waba && waba.account_review_status); // APPROVED/PENDING/REJECTED

  const qualityKnown = quality === 'GREEN' || quality === 'YELLOW' || quality === 'RED';

  // ---- Score components (real inputs only) --------------------------------
  const components = {
    qualityRating: qualityKnown ? { GREEN: 50, YELLOW: 30, RED: 10 }[quality] : null,
    accountReview:
      review === 'APPROVED' ? 20 : review === 'PENDING' ? 10 : review === 'REJECTED' ? 0 : null,
    deliveryHealth: null, // Phase 3 data source (message statuses in DB)
    recentApiErrors: null, // Phase 3 data source (API error log)
  };
  const allComponentsPresent =
    components.qualityRating !== null &&
    components.accountReview !== null &&
    components.deliveryHealth !== null &&
    components.recentApiErrors !== null;
  const healthScore = allComponentsPresent
    ? components.qualityRating +
      components.accountReview +
      components.deliveryHealth +
      components.recentApiErrors
    : null;

  // ---- Health status (plan mapping) ---------------------------------------
  let healthStatus = 'Unknown';
  if (phone) {
    if (quality === 'RED' || review === 'REJECTED' || phoneStatus === 'RESTRICTED') {
      healthStatus = 'Critical';
    } else if (phoneStatus && phoneStatus !== 'CONNECTED') {
      healthStatus = 'Disconnected';
    } else if (quality === 'YELLOW' || review === 'PENDING') {
      healthStatus = 'Warning';
    } else if (quality === 'GREEN' && review === 'APPROVED' && phoneStatus === 'CONNECTED') {
      healthStatus = 'Healthy';
    }
  }

  // ---- Ban risk (ESTIMATE, plan rules) -------------------------------------
  let banRisk = 'Unknown';
  if (quality === 'RED' || phoneStatus === 'RESTRICTED' || review === 'REJECTED') {
    banRisk = 'High';
  } else if (quality === 'YELLOW' || review === 'PENDING') {
    banRisk = 'Medium';
  } else if (quality === 'GREEN' && review === 'APPROVED') {
    banRisk = 'Low';
  }

  // ---- Warnings — each generated only from an actual signal ----------------
  const warnings = [];
  if (quality === 'YELLOW') {
    warnings.push({
      signal: 'quality_rating',
      message:
        'Quality rating is Yellow — slow down marketing sends and review message content before sending more.',
    });
  }
  if (quality === 'RED') {
    warnings.push({
      signal: 'quality_rating',
      message:
        'Quality rating is Red — this number is at serious risk of restriction. Pause campaigns and review recent sends.',
    });
  }
  if (quality === 'UNKNOWN') {
    warnings.push({
      signal: 'quality_rating',
      message:
        'Meta reports the quality rating as UNKNOWN — there is not enough sending history on this number to rate it yet.',
    });
  }
  if (review === 'PENDING') {
    warnings.push({
      signal: 'account_review_status',
      message:
        'Account review is pending in Meta — complete business verification in Meta Business Settings to finish it.',
    });
  }
  if (review === 'REJECTED') {
    warnings.push({
      signal: 'account_review_status',
      message:
        'Meta rejected this account\u2019s review — resolve it in Meta Business Settings before relying on this number.',
    });
  }
  if (phoneStatus && phoneStatus !== 'CONNECTED') {
    warnings.push({
      signal: 'status',
      message: `WhatsApp reports this number's status as ${phoneStatus} — it is not fully connected.`,
    });
  }
  if (codeStatus && codeStatus !== 'VERIFIED') {
    warnings.push({
      signal: 'code_verification_status',
      message: 'Code verification is not complete for this number.',
    });
  }

  return {
    healthStatus,
    healthScore,
    healthScoreComponents: components,
    healthScoreNote: healthScore === null ? SCORE_NOTE_PARTIAL : 'Estimate — see healthScoreComponents for the inputs used.',
    banRisk,
    banRiskDisclaimer: BAN_RISK_DISCLAIMER,
    warnings,
  };
}

module.exports = { deriveHealth, unknownHealth, BAN_RISK_DISCLAIMER };
