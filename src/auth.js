import crypto from 'node:crypto';

const SID = 'pv_sid';
const FLASH = 'pv_flash';
const DAY = 24 * 60 * 60 * 1000;

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip broken cookie */ }
  }
  return out;
}

export function makeAuth(db, { secureCookies = false } = {}) {
  const cookieBase = `Path=/; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}`;
  const q = {
    create: db.prepare('INSERT INTO sessions (id, kind, subject_id, expires_at) VALUES (?, ?, ?, ?)'),
    get: db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?'),
    del: db.prepare('DELETE FROM sessions WHERE id = ?'),
    delFor: db.prepare('DELETE FROM sessions WHERE kind = ? AND subject_id = ?'),
    delPush: db.prepare('DELETE FROM push_subs WHERE kind = ? AND subject_id = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    driver: db.prepare('SELECT * FROM drivers WHERE id = ?'),
    user: db.prepare('SELECT * FROM users WHERE id = ? AND active = 1')
  };

  function startSession(res, kind, id) {
    const sid = crypto.randomBytes(32).toString('hex');
    const ttl = (kind === 'driver' ? 60 : 14) * DAY;
    q.create.run(sid, kind, id, Date.now() + ttl);
    res.append('Set-Cookie', `${SID}=${sid}; ${cookieBase}; Max-Age=${Math.floor(ttl / 1000)}`);
  }
  function endSession(req, res) {
    if (req.sid) q.del.run(req.sid);
    res.append('Set-Cookie', `${SID}=; ${cookieBase}; Max-Age=0`);
  }
  // Signed out everywhere (new password, disabled account): their phones stop getting notifications too.
  const endAllFor = (kind, id) => { q.delFor.run(kind, id); q.delPush.run(kind, id); };

  function flash(res, text, tone = 'ok') {
    res.append('Set-Cookie', `${FLASH}=${encodeURIComponent(JSON.stringify({ text, tone }))}; ${cookieBase}; Max-Age=60`);
  }

  let lastPurge = 0;
  function middleware(req, res, next) {
    const c = parseCookies(req.headers.cookie);
    if (c[FLASH]) {
      try { req.flash = JSON.parse(c[FLASH]); } catch { /* ignore */ }
      res.append('Set-Cookie', `${FLASH}=; ${cookieBase}; Max-Age=0`);
    }
    if (Date.now() - lastPurge > 3600e3) { q.purge.run(Date.now()); lastPurge = Date.now(); }
    const s = c[SID] && q.get.get(c[SID], Date.now());
    if (s) {
      req.sid = s.id;
      if (s.kind === 'driver') req.driver = q.driver.get(s.subject_id) || null;
      else req.user = q.user.get(s.subject_id) || null;
    }
    next();
  }

  return { middleware, startSession, endSession, endAllFor, flash };
}

/** Simple in-memory brute-force guard: 8 failed attempts lock the key for 10 minutes. */
export function makeLimiter({ max = 8, windowMs = 10 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    blocked(key) {
      const h = hits.get(key);
      if (!h) return false;
      if (Date.now() - h.first > windowMs) { hits.delete(key); return false; }
      return h.n >= max;
    },
    fail(key) {
      const h = hits.get(key);
      if (!h || Date.now() - h.first > windowMs) hits.set(key, { n: 1, first: Date.now() });
      else h.n++;
    },
    reset(key) { hits.delete(key); }
  };
}
