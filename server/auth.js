const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TOKEN_DIR = path.join(os.homedir(), '.antigravity-browser-operator');
const TOKEN_FILE = path.join(TOKEN_DIR, 'token');

/**
 * Retrieves the existing security token or generates a new cryptographically secure one.
 * Priority:
 * 1. process.env.ANTIGRAVITY_AUTH_TOKEN
 * 2. ~/.antigravity-browser-operator/token
 */
function getOrCreateToken() {
  if (process.env.ANTIGRAVITY_AUTH_TOKEN && process.env.ANTIGRAVITY_AUTH_TOKEN.trim()) {
    return process.env.ANTIGRAVITY_AUTH_TOKEN.trim();
  }

  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (existing.length >= 16) {
        return existing;
      }
    }
  } catch (err) {
    console.error('[Auth] Warning: Could not read token file:', err.message);
  }

  // Generate a cryptographically secure 64-character hex token (256-bit entropy)
  const newToken = crypto.randomBytes(32).toString('hex');

  try {
    if (!fs.existsSync(TOKEN_DIR)) {
      fs.mkdirSync(TOKEN_DIR, { recursive: true });
    }
    fs.writeFileSync(TOKEN_FILE, newToken, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('[Auth] Warning: Could not save token file:', err.message);
  }

  return newToken;
}

/**
 * Validates a candidate token against the system token using timing-safe comparison.
 */
function validateToken(candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  const token = getOrCreateToken();
  const validBuf = Buffer.from(token, 'utf8');
  const candBuf = Buffer.from(candidate.trim(), 'utf8');

  if (validBuf.length !== candBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(validBuf, candBuf);
}

module.exports = {
  getOrCreateToken,
  validateToken,
  TOKEN_DIR,
  TOKEN_FILE,
};
