'use strict';

// Auth routes: POST /auth/signup, POST /auth/login
// Passwords are bcrypt-hashed (bcryptjs) and never stored or logged in
// plain text. There is deliberately NO request-body logging anywhere in
// this server.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken } = require('../auth');

const router = express.Router();

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name || null, createdAt: user.created_at };
}

function validEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

router.post('/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!validEmail(email)) {
      return res.status(400).json({ error: 'invalid_email', message: 'A valid email address is required.' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 8 characters.' });
    }
    const cleanEmail = email.trim().toLowerCase();
    const existing = await db.get('SELECT id FROM users WHERE email = ?', [cleanEmail]);
    if (existing) {
      return res.status(409).json({ error: 'email_taken', message: 'An account with this email already exists.' });
    }
    const passwordHash = bcrypt.hashSync(password, 10);
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO users (email, password_hash, name, created_at) VALUES (?, ?, ?, ?)',
      [cleanEmail, passwordHash, typeof name === 'string' && name.trim() ? name.trim() : null, now]
    );
    const user = await db.get('SELECT * FROM users WHERE id = ?', [result.lastID]);
    return res.status(201).json({ user: publicUser(user), token: signToken(user) });
  } catch (e) {
    console.error('[auth/signup]', e.message);
    return res.status(500).json({ error: 'server_error', message: 'Signup failed.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!validEmail(email) || typeof password !== 'string') {
      return res.status(400).json({ error: 'invalid_request', message: 'Email and password are required.' });
    }
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    // Same response for unknown email and wrong password — no enumeration.
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Email or password is incorrect.' });
    }
    return res.json({ user: publicUser(user), token: signToken(user) });
  } catch (e) {
    console.error('[auth/login]', e.message);
    return res.status(500).json({ error: 'server_error', message: 'Login failed.' });
  }
});

module.exports = router;
