'use strict';

// Plans & subscriptions.
//   GET  /plans          — public; the three Mr.Who tiers.
//   GET  /subscriptions  — the caller's subscription rows (may be empty).
//   POST /subscriptions  — creates a row in "pending_payment" status.
// No real payments exist in this phase; nothing here charges anyone.

const express = require('express');
const db = require('../db');
const { authRequired } = require('../auth');

const router = express.Router();

function publicPlan(row) {
  let features = [];
  try {
    features = JSON.parse(row.features || '[]');
  } catch {
    features = [];
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    pricePkr: row.price_pkr,
    period: row.period,
    features,
  };
}

function publicSubscription(row) {
  return {
    id: row.id,
    planId: row.plan_id,
    planCode: row.plan_code,
    planName: row.plan_name,
    pricePkr: row.price_pkr,
    status: row.status,
    startedAt: row.started_at,
    currentPeriodEnd: row.current_period_end,
    createdAt: row.created_at,
  };
}

const SUB_SELECT = `
  SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.price_pkr
  FROM subscriptions s JOIN plans p ON p.id = s.plan_id
`;

router.get('/plans', async (_req, res) => {
  try {
    const rows = await db.all('SELECT * FROM plans ORDER BY sort ASC, id ASC');
    return res.json({ plans: rows.map(publicPlan) });
  } catch (e) {
    console.error('[plans]', e.message);
    return res.status(500).json({ error: 'server_error', message: 'Could not load plans.' });
  }
});

router.get('/subscriptions', authRequired, async (req, res) => {
  try {
    const rows = await db.all(`${SUB_SELECT} WHERE s.user_id = ? ORDER BY s.created_at DESC`, [
      req.user.id,
    ]);
    return res.json({ subscriptions: rows.map(publicSubscription) });
  } catch (e) {
    console.error('[subscriptions/list]', e.message);
    return res.status(500).json({ error: 'server_error', message: 'Could not load subscriptions.' });
  }
});

router.post('/subscriptions', authRequired, async (req, res) => {
  try {
    const { planId, plan } = req.body || {};
    let planRow = null;
    if (Number.isInteger(planId)) {
      planRow = await db.get('SELECT * FROM plans WHERE id = ?', [planId]);
    } else if (typeof plan === 'string' && plan.trim()) {
      planRow = await db.get('SELECT * FROM plans WHERE code = ?', [plan.trim().toLowerCase()]);
    }
    if (!planRow) {
      return res.status(400).json({
        error: 'unknown_plan',
        message: 'Choose a plan by planId or plan code (starter, business, premium).',
      });
    }
    const now = new Date().toISOString();
    const result = await db.run(
      `INSERT INTO subscriptions (user_id, plan_id, status, started_at, current_period_end, created_at)
       VALUES (?, ?, 'pending_payment', NULL, NULL, ?)`,
      [req.user.id, planRow.id, now]
    );
    const row = await db.get(`${SUB_SELECT} WHERE s.id = ?`, [result.lastID]);
    return res.status(201).json({
      subscription: publicSubscription(row),
      note: 'Subscription created as "pending payment". No payment is taken in this phase.',
    });
  } catch (e) {
    console.error('[subscriptions/create]', e.message);
    return res.status(500).json({ error: 'server_error', message: 'Could not create subscription.' });
  }
});

module.exports = router;
