process.env.TZ = process.env.TZ || 'Europe/Moscow';

import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { makeAuth, makeLimiter } from './auth.js';
import { makeBilling } from './billing.js';
import { makeService, UserError } from './service.js';
import { qrSvg } from './waybill.js';
import * as C from './views/common.js';
import publicRoutes from './routes/public.js';
import driverRoutes from './routes/driver.js';
import parkRoutes from './routes/park.js';
import superRoutes from './routes/super.js';
import payRoutes from './routes/pay.js';
import serviceRoutes from './routes/service.js';
import { makePayments } from './payments.js';
import { makeEpd } from './epd.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({
  dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'putevka.db'),
  secureCookies = process.env.COOKIE_SECURE === '1',
  publicUrl = process.env.PUBLIC_URL || '',
  payments: payOpts = {},
  log = console.log
} = {}) {
  const db = openDb(dbFile);
  const auth = makeAuth(db, { secureCookies });
  const billing = makeBilling(db);
  const svc = makeService(db, billing);
  const payments = makePayments(db, billing, payOpts);

  // First start: create the platform administrator.
  if (!db.prepare("SELECT 1 FROM users WHERE role = 'super' LIMIT 1").get()) {
    const login = process.env.SUPER_LOGIN || 'root';
    const pass = process.env.SUPER_PASSWORD || crypto.randomBytes(9).toString('base64url');
    db.prepare("INSERT INTO users (park_id, login, name, role, pass_hash) VALUES (NULL, ?, ?, 'super', ?)")
      .run(login, process.env.SUPER_NAME || 'Администратор платформы', bcrypt.hashSync(pass, 10));
    log(`\n  Администратор платформы создан. Логин: ${login}  Пароль: ${process.env.SUPER_PASSWORD ? '(из SUPER_PASSWORD)' : pass}\n`);
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1');
  app.use((req, res, next) => {
    res.set({
      'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    });
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: '1h',
    setHeaders: (res, file) => { if (file.endsWith('sw.js')) res.set('Cache-Control', 'no-cache'); }
  }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(auth.middleware);

  // Same-origin check for every form post, on top of SameSite cookies.
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin') || req.get('referer');
    if (origin) {
      try { if (new URL(origin).host !== req.get('host')) return res.status(403).send('Запрос с чужого сайта отклонён.'); }
      catch { return res.status(403).send('Неверный источник запроса.'); }
    }
    next();
  });
  app.use((req, res, next) => { res.set('Cache-Control', 'private, no-cache'); next(); });

  const platform = {
    get: () => Object.fromEntries(db.prepare('SELECT key, value FROM platform').all().map((r) => [r.key, r.value])),
    set: (obj) => {
      const st = db.prepare('INSERT INTO platform (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [k, v] of Object.entries(obj)) st.run(k, String(v ?? ''));
    }
  };

  // Last audit row of the park works as a change counter for live refresh.
  const rev = (parkId) => String(db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM audit WHERE park_id = ?').get(parkId).m);

  const back = (req, fallback) => {
    const r = req.body?.back || req.get('referer');
    if (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//')) return r;
    try { const u = new URL(r); if (u.host === req.get('host')) return u.pathname + u.search; } catch { /* ignore */ }
    return fallback;
  };
  /** Turns a business-rule error into a flash message on the previous page. */
  const fail = (req, res, e, fallback) => {
    if (!(e instanceof UserError)) throw e;
    auth.flash(res, e.message, 'bad');
    res.redirect(back(req, fallback));
  };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const list = (v) => (Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v]);
  const baseUrl = (req) => publicUrl || `${req.protocol}://${req.get('host')}`;
  const withQr = (req, sheets) => Promise.all(sheets.map(async (s) => {
    const url = `${baseUrl(req)}/c/${s.token}`;
    return { s, url, qr: await qrSvg(url), titles: s.epl ? epd.titlesOf(s.id) : null };
  }));

  const epd = makeEpd(db, svc, { billing, platform });
  const ctx = { db, auth, billing, payments, epd, svc, platform, rev, back, fail, wrap, list, withQr, baseUrl, UserError,
    limiter: makeLimiter(), ipLimiter: makeLimiter({ max: 60 }), signupLimiter: makeLimiter({ max: 5, windowMs: 3600e3 }) };

  publicRoutes(app, ctx);
  driverRoutes(app, ctx);
  parkRoutes(app, ctx);
  superRoutes(app, ctx);
  payRoutes(app, ctx);
  serviceRoutes(app, ctx);

  app.use((req, res) => res.status(404).type('html').send(C.publicPage({ title: 'Не найдено', bare: true, body: C.errorBody(404, 'Проверьте адрес.') })));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).type('html').send(C.publicPage({ title: 'Ошибка', bare: true, body: C.errorBody(500, 'Что-то пошло не так. Попробуйте ещё раз.') }));
  });

  return { app, db, svc, billing, payments, epd };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app } = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Путёвка работает: http://localhost:${port}`));
}
