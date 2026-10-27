import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { normPhone, fPhone } from '../util.js';
import { dayKey, validTz } from '../time.js';
import { DEFAULT_PARK_SETTINGS } from '../db.js';
import { sheetStatus } from '../service.js';
import * as C from '../views/common.js';
import * as P from '../views/public.js';
import * as L from '../views/legal.js';

export default function publicRoutes(app, { db, auth, billing, epd, platform, rev, limiter, ipLimiter, signupLimiter }) {
  const page = (res, opts, code = 200) => res.status(code).type('html').send(C.publicPage(opts));
  const home = (req) => (req.user ? (req.user.role === 'super' ? '/s' : req.user.service ? '/x' : '/p') : req.driver ? '/d' : null);
  const tickets = new Map(); // driver chooses a park when one phone works in several parks

  app.get('/', (req, res) => {
    const h = home(req);
    if (h) return res.redirect(h);
    const tariff = db.prepare('SELECT * FROM tariffs WHERE is_default = 1 ORDER BY id LIMIT 1').get();
    page(res, { title: 'Путевые листы для такси', body: P.landing({ tariff, tariffs: db.prepare('SELECT * FROM tariffs WHERE personal = 0').all(), services: platform.get() }), flash: req.flash });
  });

  /* ---------- login ---------- */
  app.get('/login', (req, res) => {
    const h = home(req);
    if (h) return res.redirect(h);
    page(res, { title: 'Вход', body: P.loginBody({ tab: req.query.staff ? 'staff' : 'driver' }), flash: req.flash });
  });

  app.post('/login/driver', (req, res) => {
    const phone = normPhone(req.body.phone);
    const pin = String(req.body.pin || '');
    const key = 'd:' + phone;
    if (limiter.blocked(key) || ipLimiter.blocked(req.ip)) return page(res, { title: 'Вход', body: P.loginBody({ error: 'Слишком много попыток. Подождите 10 минут.', phone: req.body.phone }) }, 429);
    const matches = db.prepare('SELECT d.*, p.name AS park_name FROM drivers d JOIN parks p ON p.id = d.park_id WHERE d.phone = ?').all(phone)
      .filter((d) => bcrypt.compareSync(pin, d.pin_hash));
    if (!matches.length) {
      limiter.fail(key); ipLimiter.fail(req.ip);
      return page(res, { title: 'Вход', body: P.loginBody({ error: 'Неверный телефон или пароль.', phone: req.body.phone }) }, 401);
    }
    limiter.reset(key);
    if (matches.length === 1) {
      auth.startSession(res, 'driver', matches[0].id);
      return res.redirect('/d');
    }
    const ticket = crypto.randomBytes(16).toString('hex');
    tickets.set(ticket, { ids: matches.map((d) => d.id), exp: Date.now() + 5 * 60e3 });
    page(res, { title: 'Выберите парк', body: P.loginBody({ ticket, choices: matches.map((d) => ({ driverId: d.id, name: d.park_name })) }) });
  });
  app.post('/login/driver/pick', (req, res) => {
    const t = tickets.get(String(req.body.ticket || ''));
    const id = Number(req.body.driver);
    if (!t || t.exp < Date.now() || !t.ids.includes(id)) return res.redirect('/login');
    tickets.delete(String(req.body.ticket));
    auth.startSession(res, 'driver', id);
    res.redirect('/d');
  });

  app.post('/login/staff', (req, res) => {
    const login = String(req.body.login || '').trim();
    const key = 'u:' + login.toLowerCase();
    if (limiter.blocked(key) || ipLimiter.blocked(req.ip)) return page(res, { title: 'Вход', body: P.loginBody({ tab: 'staff', error: 'Слишком много попыток. Подождите 10 минут.', login }) }, 429);
    const u = db.prepare('SELECT * FROM users WHERE login = ? AND active = 1').get(login);
    if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.pass_hash)) {
      limiter.fail(key); ipLimiter.fail(req.ip);
      return page(res, { title: 'Вход', body: P.loginBody({ tab: 'staff', error: 'Неверный логин или пароль.', login }) }, 401);
    }
    limiter.reset(key);
    auth.startSession(res, 'user', u.id);
    res.redirect(u.role === 'super' ? '/s' : u.service ? '/x' : '/p');
  });

  app.post('/logout', (req, res) => { auth.endSession(req, res); res.redirect('/login'); });

  /* ---------- signup ---------- */
  const signupOpen = () => platform.get().signupOpen !== '0';
  app.get('/signup', (req, res) => {
    if (!signupOpen()) return page(res, { title: 'Подключение', body: C.errorBody(403, 'Подключение новых парков временно закрыто. Свяжитесь с нами.') }, 403);
    const t = db.prepare('SELECT * FROM tariffs WHERE is_default = 1 ORDER BY id LIMIT 1').get();
    page(res, { title: 'Подключить таксопарк', body: P.signupBody({ trialDays: t?.trial_days || 0 }) });
  });
  app.post('/signup', (req, res) => {
    if (!signupOpen()) return res.redirect('/signup');
    const b = req.body;
    const v = {
      park: String(b.park || '').trim().slice(0, 120), city: String(b.city || '').trim().slice(0, 80), tz: validTz(b.tz) ? b.tz : 'Europe/Moscow',
      inn: String(b.inn || '').replace(/\D/g, ''), name: String(b.name || '').trim().slice(0, 120), phone: normPhone(b.phone),
      email: String(b.email || '').trim().slice(0, 120), login: String(b.login || '').trim()
    };
    const pass = String(b.password || '');
    const t = db.prepare('SELECT * FROM tariffs WHERE is_default = 1 ORDER BY id LIMIT 1').get();
    const again = (error, code = 400) => page(res, { title: 'Подключить таксопарк', body: P.signupBody({ v: { ...v, phone: b.phone }, error, trialDays: t?.trial_days || 0 }) }, code);
    if (signupLimiter.blocked(req.ip)) return again('Слишком много регистраций с этого адреса. Попробуйте через час.', 429);
    if (!v.park || !v.city || !v.name) return again('Заполните название парка, город и ваше ФИО.');
    if (v.inn && !/^\d{10}(\d{2})?$/.test(v.inn)) return again('ИНН — 10 или 12 цифр.');
    if (v.phone.length !== 11) return again('Телефон должен содержать 11 цифр.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return again('Проверьте адрес эл. почты.');
    if (!/^[a-zA-Z0-9._-]{3,60}$/.test(v.login)) return again('Логин — от 3 латинских букв, цифр или знаков . _ -');
    if (pass.length < 8) return again('Пароль не короче 8 знаков.');
    if (b.agree !== '1') return again('Примите условия договора-оферты и дайте согласие на обработку персональных данных.');
    if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(v.login)) return again('Такой логин уже занят.');
    signupLimiter.fail(req.ip);
    const terms = billing.newParkTerms();
    const userId = db.transaction(() => {
      const parkId = db.prepare(`INSERT INTO parks (name, inn, contact, phone, email, city, tz, tariff_id, trial_until, billed_month, settings)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(v.park, v.inn, v.name, v.phone, v.email, v.city, v.tz, terms.tariffId,
        billing.trialUntil(v.tz, terms.trialDays), dayKey(v.tz).slice(0, 7), JSON.stringify({ ...DEFAULT_PARK_SETTINGS, dispPhone: fPhone(v.phone) })).lastInsertRowid;
      db.prepare('INSERT INTO carriers (park_id, name, inn, phone) VALUES (?, ?, ?, ?)').run(parkId, v.park, v.inn, fPhone(v.phone));
      const uid = db.prepare("INSERT INTO users (park_id, login, name, role, pass_hash) VALUES (?, ?, ?, 'owner', ?)").run(parkId, v.login, v.name, bcrypt.hashSync(pass, 10)).lastInsertRowid;
      db.prepare('INSERT INTO audit (park_id, at, who, action, details) VALUES (?, ?, ?, ?, ?)').run(parkId, new Date().toISOString(), v.name, 'Парк подключён', v.park);
      return uid;
    })();
    auth.startSession(res, 'user', userId);
    auth.flash(res, 'Кабинет создан. Начните с перевозчика, машин и водителей.');
    res.redirect('/p');
  });

  /* ---------- QR verification ---------- */
  app.get('/c/:token', (req, res) => {
    res.set('X-Robots-Tag', 'noindex');
    const s = db.prepare('SELECT * FROM sheets WHERE token = ?').get(String(req.params.token));
    if (!s) return page(res, { title: 'Проверка листа', bare: true, body: P.checkNotFound() }, 404);
    const park = db.prepare('SELECT * FROM parks WHERE id = ?').get(s.park_id);
    page(res, { title: `Лист № ${s.no}`, bare: true, body: P.checkBody({ s, st: sheetStatus(s, park.tz), park, titles: s.epl ? epd.titlesOf(s.id) : null }) });
  });

  /* ---------- legal documents ---------- */
  app.get('/privacy', (req, res) => page(res, { title: 'Политика обработки персональных данных', body: L.privacyBody({ s: platform.get() }) }));
  app.get('/offer', (req, res) => page(res, { title: 'Договор-оферта', body: L.offerBody({ s: platform.get(), services: platform.get(),
    tariffs: db.prepare('SELECT * FROM tariffs WHERE personal = 0 ORDER BY is_default DESC, per_sheet DESC').all() }) }));

  app.get('/offline', (req, res) => res.type('html').send(P.offlineHtml()));

  app.get('/api/rev', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const parkId = req.driver?.park_id ?? req.user?.park_id;
    if (!parkId) return res.status(req.user ? 200 : 401).json({ rev: '' });
    res.json({ rev: rev(parkId) });
  });
}
