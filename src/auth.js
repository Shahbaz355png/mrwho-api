'use strict';

// JWT session auth for the Mr.Who API backend.
// The signing secret comes from the JWT_SECRET environment variable. If it
// is not set we fall back to an obvious development placeholder and warn —
// set JWT_SECRET in any real deployment.

const jwt = require('jsonwebtoken');

let warned = false;
function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!warned) {
    warned = true;
    console.warn(
      '[mrwho-backend] WARNING: JWT_SECRET is not set — using an insecure development placeholder. Set JWT_SECRET before any real deployment.'
    );
  }
  return 'dev-only-insecure-secret-change-me';
}

function signToken(user) {
  return jwt.sign({ sub: String(user.id), email: user.email }, jwtSecret(), {
    expiresIn: '30d',
  });
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'unauthorized', message: 'A Bearer session token is required.' });
  }
  try {
    const payload = jwt.verify(match[1], jwtSecret());
    req.user = { id: Number(payload.sub), email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ error: 'unauthorized', message: 'Session token is invalid or expired.' });
  }
}

module.exports = { signToken, authRequired };
