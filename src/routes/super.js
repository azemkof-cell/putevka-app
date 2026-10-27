import bcrypt from 'bcryptjs';
import { toInt, toKop, parseDate, fRub } from '../util.js';
import { dayKey } from '../time.js';
import * as C from '../views/common.js';
import * as S from '../views/super.js';
import { parse1C } from '../money.js';
import { servicesAdmin } from '../views/services.js';
import { PayError } from '../payments.js';

export default function superRoutes(app, { db, auth, billing, payments, platform, fail, baseUrl, UserError }) {
  const needSuper = (req, res, next) => {
    if (!req.user) return res.redirect('/login?staff=1');
    if (req.user.role !== 'super') return res.redirect('/p');
    next();
  };
  const page = (req, res, { title, body, active }, code = 200) =>
    res.status(code).type('html').send(C.staffPage({ title, body, active, user: req.user, park: null, flash: req.flash, nav: S.superNav({ pending: db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending' AND method = 'invoice'").get().n + db.prepare("SELECT COUNT(*) AS n FROM bank_docs WHERE status = 'unmatched'").get().n }) }));
  const log = (parkId, req, action, details = '') =>
    db.prepare('INSERT INTO audit (park_id, at, who, action, details) VALUES (?, ?, ?, ?, ?)').run(parkId, new Date().toISOString(), req.user.name, action, details);
  const getPark = (id) => db.prepare('SELECT * FROM parks WHERE id = ?').get(id);
  const month = () => dayKey('Europe/Moscow').slice(0, 7);

  app.get('/s', needSuper, (req, res) => {
    const m = month();
    const qs = String(req.query.q || '').trim().toLowerCase();
    const tariffs = new Map(db.prepare('SELECT * FROM tariffs').all().map((t) => [t.id, t]));
    const drivers = new Map(db.prepare('SELECT park_id, COUNT(*) AS n FROM drivers GROUP BY park_id').all().map((r) => [r.park_id, r.n]));
    const sheets = new Map(db.prepare('SELECT park_id, COUNT(*) AS n FROM sheets WHERE substr(issued_at, 1, 7) = ? AND cancelled_at IS NULL GROUP BY park_id').all(m).map((r) => [r.park_id, r.n]));
    const rows = db.prepare('SELECT * FROM parks ORDER BY id DESC').all()
      .filter((p) => !qs || [p.name, p.city, p.inn, p.phone, p.contact, String(p.id)].some((x) => String(x).toLowerCase().includes(qs)))
      .map((p) => ({ p, tariff: tariffs.get(p.tariff_id), access: billing.access(p), drivers: drivers.get(p.id) || 0, sheetsMonth: sheets.get(p.id) || 0 }));
    const revenueMonth = -db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger WHERE kind IN ('sheet','refund','monthly') AND substr(at, 1, 7) = ?").get(m).s;
    const totals = { sheetsMonth: [...sheets.values()].reduce((a, b) => a + b, 0), drivers: [...drivers.values()].reduce((a, b) => a + b, 0), revenueMonth };
    page(req, res, { title: 'Таксопарки', active: 'parks', body: S.parksPage({ rows, q: req.query.q || '', totals }) });
  });

  app.get('/s/parks/:id', needSuper, (req, res) => {
    const p = getPark(toInt(req.params.id));
    if (!p) return page(req, res, { title: 'Не найдено', body: C.errorBody(404, 'Парк не найден.', '/s') }, 404);
    page(req, res, { title: p.name, active: 'parks', body: S.parkDetail({
      p, tariff: billing.tariff(p.tariff_id), access: billing.access(p),
      tariffs: db.prepare('SELECT * FROM tariffs ORDER BY personal, per_sheet').all(),
      owners: db.prepare("SELECT * FROM users WHERE park_id = ? AND role = 'owner' AND active = 1").all(p.id),
      ledger: db.prepare('SELECT * FROM ledger WHERE park_id = ? ORDER BY id DESC LIMIT 100').all(p.id),
      stats: {
        drivers: db.prepare('SELECT COUNT(*) AS n FROM drivers WHERE park_id = ?').get(p.id).n,
        sheetsMonth: db.prepare('SELECT COUNT(*) AS n FROM sheets WHERE park_id = ? AND substr(issued_at, 1, 7) = ? AND cancelled_at IS NULL').get(p.id, month()).n
      }
    }) });
  });

  app.post('/s/parks/:id/money', needSuper, (req, res) => {
    const p = getPark(toInt(req.params.id));
    if (!p) return res.redirect('/s');
    const amount = toKop(req.body.amount);
    if (!amount) { auth.flash(res, 'Введите сумму, например 5000 или -150,50.', 'bad'); return res.redirect(`/s/parks/${p.id}`); }
    const comment = String(req.body.comment || '').trim().slice(0, 200) || (amount > 0 ? 'Пополнение баланса' : 'Списание');
    if (amount > 0) payments.manual({ parkId: p.id, amount, comment, by: req.user.name });
    else db.transaction(() => { billing.post(p.id, amount, 'adjust', comment, req.user.name); log(p.id, req, 'Списание', fRub(amount)); })();
    auth.flash(res, `${amount > 0 ? 'Зачислено' : 'Списано'} ${fRub(Math.abs(amount))}.`);
    res.redirect(`/s/parks/${p.id}`);
  });

  app.post('/s/parks/:id/tariff', needSuper, (req, res) => {
    const p = getPark(toInt(req.params.id));
    const t = billing.tariff(toInt(req.body.tariff_id));
    if (!p || !t || (t.personal && t.id !== p.tariff_id)) { auth.flash(res, 'Тариф не найден.', 'bad'); return res.redirect(p ? `/s/parks/${p.id}` : '/s'); }
    db.prepare('UPDATE parks SET tariff_id = ? WHERE id = ?').run(t.id, p.id);
    log(p.id, req, 'Назначен тариф', t.name);
    billing.renew(p.id);
    auth.flash(res, `Парку назначен тариф «${t.name}».`);
    res.redirect(`/s/parks/${p.id}`);
  });

  app.post('/s/parks/:id/personal', needSuper, (req, res) => {
    const p = getPark(toInt(req.params.id));
    if (!p) return res.redirect('/s');
    const perSheet = toKop(req.body.per_sheet), monthly = toKop(req.body.monthly || '0');
    if (perSheet === null || perSheet < 0 || monthly === null || monthly < 0) { auth.flash(res, 'Цены — неотрицательные числа.', 'bad'); return res.redirect(`/s/parks/${p.id}`); }
    const note = String(req.body.note || '').trim().slice(0, 200);
    const cur = billing.tariff(p.tariff_id);
    db.transaction(() => {
      if (cur?.personal) db.prepare('UPDATE tariffs SET per_sheet = ?, monthly = ?, note = ? WHERE id = ?').run(perSheet, monthly, note, cur.id);
      else {
        const id = db.prepare('INSERT INTO tariffs (name, per_sheet, monthly, trial_days, personal, note) VALUES (?, ?, ?, 0, 1, ?)').run(`Свой: ${p.name}`, perSheet, monthly, note).lastInsertRowid;
        db.prepare('UPDATE parks SET tariff_id = ? WHERE id = ?').run(id, p.id);
      }
      log(p.id, req, 'Свой тариф', `${fRub(perSheet)} за лист, ${fRub(monthly)} в месяц`);
    })();
    billing.renew(p.id);
    auth.flash(res, 'Свой тариф сохранён.');
    res.redirect(`/s/parks/${p.id}`);
  });

  app.post('/s/parks/:id/trial', needSuper, (req, res) => {
    const p = getPark(toInt(req.params.id));
    if (!p) return res.redirect('/s');
    const until = parseDate(req.body.trial_until);
    const paid = req.body.paid_until === undefined ? p.paid_until : parseDate(req.body.paid_until);
    db.prepare('UPDATE parks SET trial_until = ?, paid_until = ? WHERE id = ?').run(until, paid, p.id);
    log(p.id, req, 'Сроки доступа', `пробный: ${until || 'нет'}, оплачено до: ${paid || 'нет'}`);
    billing.renew(p.id);
    auth.flash(res, 'Сроки доступа сохранены.');
    res.redirect(`/s/parks/${p.id}`);
  });

  app.post('/s/parks/:id/block', needSuper, (req, res) => {
    const p = getPark(toInt(req.params.id));
    if (!p) return res.redirect('/s');
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    db.prepare("UPDATE parks SET status = 'blocked', block_reason = ? WHERE id = ?").run(reason, p.id);
    log(p.id, req, 'Парк заблокирован', reason);
    auth.flash(res, 'Парк заблокирован: новые листы не выписываются.', 'bad');
    res.redirect(`/s/parks/${p.id}`);
  });
  app.post('/s/parks/:id/unblock', needSuper, (req, res) => {
    const p = getPark(toInt(req.params.id));
    if (!p) return res.redirect('/s');
    db.prepare("UPDATE parks SET status = 'active', block_reason = '' WHERE id = ?").run(p.id);
    log(p.id, req, 'Парк разблокирован');
    auth.flash(res, 'Парк снова работает.');
    res.redirect(`/s/parks/${p.id}`);
  });
  app.post('/s/parks/:id/owner-password', needSuper, (req, res) => {
    const p = getPark(toInt(req.params.id));
    if (!p) return res.redirect('/s');
    const pass = String(req.body.password || '');
    const u = db.prepare("SELECT * FROM users WHERE park_id = ? AND role = 'owner' AND active = 1 ORDER BY id LIMIT 1").get(p.id);
    if (!u || pass.length < 8) { auth.flash(res, 'Пароль не короче 8 знаков.', 'bad'); return res.redirect(`/s/parks/${p.id}`); }
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(pass, 10), u.id);
    auth.endAllFor('user', u.id);
    log(p.id, req, 'Сброшен пароль владельца', u.login);
    auth.flash(res, `Пароль владельца (${u.login}) изменён.`);
    res.redirect(`/s/parks/${p.id}`);
  });

  /* ---------- tariffs ---------- */
  function readTariff(b) {
    const t = { name: String(b.name || '').trim().slice(0, 80), per_sheet: toKop(b.per_sheet), monthly: toKop(b.monthly || '0'),
      trial_days: Math.min(365, Math.max(0, toInt(b.trial_days) ?? 0)), note: String(b.note || '').trim().slice(0, 200) };
    if (!t.name) throw new UserError('Укажите название тарифа.');
    if (t.per_sheet === null || t.per_sheet < 0 || t.monthly === null || t.monthly < 0) throw new UserError('Цены — неотрицательные числа.');
    return t;
  }
  app.get('/s/tariffs', needSuper, (req, res) => {
    const counts = new Map(db.prepare('SELECT tariff_id, COUNT(*) AS n FROM parks GROUP BY tariff_id').all().map((r) => [r.tariff_id, r.n]));
    page(req, res, { title: 'Тарифы', active: 'tariffs', body: S.tariffsPage({ tariffs: db.prepare('SELECT * FROM tariffs ORDER BY personal, is_default DESC, per_sheet').all(), counts }) });
  });
  app.post('/s/tariffs', needSuper, (req, res) => {
    try {
      const t = readTariff(req.body);
      db.prepare('INSERT INTO tariffs (name, per_sheet, monthly, trial_days, note) VALUES (@name, @per_sheet, @monthly, @trial_days, @note)').run(t);
      auth.flash(res, 'Тариф создан.');
      res.redirect('/s/tariffs');
    } catch (e) { fail(req, res, e, '/s/tariffs'); }
  });
  app.get('/s/tariffs/:id', needSuper, (req, res) => {
    const t = billing.tariff(toInt(req.params.id));
    if (!t || t.personal) return res.redirect('/s/tariffs');
    page(req, res, { title: t.name, active: 'tariffs', body: S.tariffEdit({ t }) });
  });
  app.post('/s/tariffs/:id', needSuper, (req, res) => {
    try {
      const id = toInt(req.params.id);
      if (!billing.tariff(id)) throw new UserError('Тариф не найден.');
      db.prepare('UPDATE tariffs SET name=@name, per_sheet=@per_sheet, monthly=@monthly, trial_days=@trial_days, note=@note WHERE id=@id').run({ ...readTariff(req.body), id });
      auth.flash(res, 'Тариф сохранён.');
      res.redirect('/s/tariffs');
    } catch (e) { fail(req, res, e, '/s/tariffs'); }
  });
  app.post('/s/tariffs/:id/default', needSuper, (req, res) => {
    const t = billing.tariff(toInt(req.params.id));
    if (t && !t.personal) db.transaction(() => { db.prepare('UPDATE tariffs SET is_default = 0').run(); db.prepare('UPDATE tariffs SET is_default = 1 WHERE id = ?').run(t.id); })();
    auth.flash(res, 'Основной тариф изменён. Его получат новые парки.');
    res.redirect('/s/tariffs');
  });
  app.post('/s/tariffs/:id/apply-all', needSuper, (req, res) => {
    const t = billing.tariff(toInt(req.params.id));
    if (!t || t.personal) return res.redirect('/s/tariffs');
    const all = req.body.personal_too === '1';
    const r = db.prepare(`UPDATE parks SET tariff_id = ? ${all ? '' : 'WHERE tariff_id NOT IN (SELECT id FROM tariffs WHERE personal = 1)'}`).run(t.id);
    auth.flash(res, `Тариф «${t.name}» назначен ${r.changes} парк(ам).`);
    res.redirect('/s/tariffs');
  });

  /* ---------- payments ---------- */
  app.get('/s/payments', needSuper, (req, res) => {
    const filter = ['pending', 'succeeded', 'all'].includes(req.query.f) ? req.query.f : 'pending';
    const where = filter === 'all' ? '' : 'WHERE pm.status = ?';
    const rows = db.prepare(`SELECT pm.*, p.name AS park FROM payments pm JOIN parks p ON p.id = pm.park_id ${where} ORDER BY pm.id DESC LIMIT 300`).all(...(filter === 'all' ? [] : [filter]));
    const counts = { pending: db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'").get().n };
    page(req, res, { title: 'Платежи', active: 'payments', body: S.paymentsPage({ rows, filter, counts, mode: payments.mode }) });
  });
  app.post('/s/payments/:id/paid', needSuper, (req, res) => {
    const p = payments.get(toInt(req.params.id));
    const amount = toKop(req.body.amount);
    if (!p || p.status !== 'pending' || !amount || amount <= 0) { auth.flash(res, 'Проверьте сумму.', 'bad'); return res.redirect('/s/payments'); }
    payments.credit(p.id, amount, req.user.name);
    auth.flash(res, `Зачислено ${fRub(amount)} по счёту № ${p.invoice_no}.`);
    res.redirect('/s/payments');
  });
  app.post('/s/payments/:id/cancel', needSuper, (req, res) => {
    if (payments.cancel(toInt(req.params.id))) auth.flash(res, 'Платёж отменён.');
    res.redirect('/s/payments');
  });
  app.get('/s/invoice/:id', needSuper, async (req, res, next) => {
    try {
      const p = payments.get(toInt(req.params.id));
      if (!p || !p.invoice_no) return res.redirect('/s/payments');
      res.type('html').send(await app.locals.invoiceHtml(p, getPark(p.park_id), '/s/payments', baseUrl(req)));
    } catch (e) { next(e); }
  });

  const unmatched = () => db.prepare("SELECT * FROM bank_docs WHERE status = 'unmatched' ORDER BY id DESC").all();
  const parksList = () => db.prepare('SELECT id, name, inn FROM parks ORDER BY name').all();
  app.get('/s/statement', needSuper, (req, res) => page(req, res, { title: 'Выписка', active: 'payments', body: S.statementPage({ result: null, unmatched: unmatched(), parks: parksList() }) }));
  app.post('/s/statement', needSuper, (req, res) => {
    const docs = parse1C(req.body.text);
    if (!docs.length) { auth.flash(res, 'В тексте не нашлось платёжных документов. Нужна выписка в формате 1С (1CClientBankExchange).', 'bad'); return res.redirect('/s/statement'); }
    const result = payments.importStatement(docs, { by: req.user.name, account: platform.get().reqAccount || '' });
    page(req, res, { title: 'Выписка', active: 'payments', body: S.statementPage({ result, unmatched: unmatched(), parks: parksList() }) });
  });
  app.post('/s/statement/:id/assign', needSuper, (req, res) => {
    try { payments.assignDoc(toInt(req.params.id), toInt(req.body.park_id), req.user.name); auth.flash(res, 'Платёж зачислен парку.'); }
    catch (e) { if (!(e instanceof PayError)) throw e; auth.flash(res, e.message, 'bad'); }
    res.redirect('/s/statement');
  });
  app.post('/s/statement/:id/ignore', needSuper, (req, res) => {
    db.prepare("UPDATE bank_docs SET status = 'ignored' WHERE id = ? AND status = 'unmatched'").run(toInt(req.params.id));
    res.redirect('/s/statement');
  });

  /* ---------- services of the platform's own signers ---------- */
  const svcCities = () => [...new Set(db.prepare("SELECT svc_city FROM users WHERE service = 1 AND role = 'dispatcher' AND active = 1 AND tech_cert <> '' AND svc_city <> ''").all().map((r) => r.svc_city))];
  app.get('/s/services', needSuper, (req, res) => {
    const staff = db.prepare('SELECT * FROM users WHERE service = 1 ORDER BY active DESC, role, name').all();
    page(req, res, { title: 'Услуги', active: 'services', body: servicesAdmin({ s: platform.get(), staff, cities: svcCities() }) });
  });
  app.post('/s/services', needSuper, (req, res) => {
    const b = req.body;
    const med = toKop(b.svcMedPrice), mech = toKop(b.svcMechPrice);
    if (med === null || med < 0 || mech === null || mech < 0) { auth.flash(res, 'Цены — неотрицательные числа.', 'bad'); return res.redirect('/s/services'); }
    platform.set({ svcMedOn: b.svcMedOn === '1' ? '1' : '0', svcMedPrice: med, svcMedNote: String(b.svcMedNote || '').slice(0, 400),
      svcMechOn: b.svcMechOn === '1' ? '1' : '0', svcMechPrice: mech, svcMechNote: String(b.svcMechNote || '').slice(0, 400) });
    auth.flash(res, 'Услуги сохранены.');
    res.redirect('/s/services');
  });
  app.post('/s/services/staff', needSuper, (req, res) => {
    try {
      const b = req.body;
      const name = String(b.name || '').trim().slice(0, 150), login = String(b.login || '').trim(), pass = String(b.password || '');
      const role = b.kind === 'mech' ? 'dispatcher' : 'medic';
      if (!name || !String(b.svc_org || '').trim()) throw new UserError('Укажите ФИО и организацию.');
      if (!/^[a-zA-Z0-9._-]{3,60}$/.test(login)) throw new UserError('Логин — от 3 латинских букв, цифр или знаков . _ -');
      if (pass.length < 8) throw new UserError('Пароль не короче 8 знаков.');
      if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) throw new UserError('Такой логин уже занят.');
      if (role === 'medic' && !String(b.svc_lic || '').trim()) throw new UserError('Для медработника укажите лицензию медорганизации.');
      if (role === 'dispatcher' && !String(b.tech_cert || '').trim()) throw new UserError('Механику нужен номер аттестата контролёра техсостояния.');
      db.prepare(`INSERT INTO users (park_id, login, name, role, pass_hash, service, svc_org, svc_lic, svc_city, tech_cert)
        VALUES (NULL, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(login, name, role, bcrypt.hashSync(pass, 10), String(b.svc_org).trim().slice(0, 150),
        String(b.svc_lic || '').trim().slice(0, 80), String(b.svc_city || '').trim().slice(0, 80), role === 'dispatcher' ? String(b.tech_cert).trim().slice(0, 60) : '');
      auth.flash(res, 'Исполнитель добавлен. Он входит по логину и подключает свою подпись сам.');
      res.redirect('/s/services');
    } catch (e) { fail(req, res, e, '/s/services'); }
  });
  app.post('/s/services/staff/:id/toggle', needSuper, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND service = 1').get(toInt(req.params.id));
    if (u) { db.prepare('UPDATE users SET active = ? WHERE id = ?').run(u.active ? 0 : 1, u.id); if (u.active) auth.endAllFor('user', u.id); }
    res.redirect('/s/services');
  });
  app.locals.svcCities = svcCities;

  app.get('/s/platform', needSuper, (req, res) => page(req, res, { title: 'Настройки', active: 'platform', body: S.platformPage({ s: platform.get() }) }));
  app.post('/s/platform', needSuper, (req, res) => {
    const b = req.body, t = (k, n = 200) => String(b[k] || '').trim().slice(0, n);
    platform.set({ payInfo: t('payInfo', 1000), supportPhone: t('supportPhone', 40), supportEmail: t('supportEmail', 120), signupOpen: b.signupOpen === '1' ? '1' : '0',
      reqName: t('reqName'), reqInn: t('reqInn').replace(/\D/g, ''), reqKpp: t('reqKpp').replace(/\D/g, ''), reqOgrn: t('reqOgrn').replace(/\D/g, '').slice(0, 15), legalDate: parseDate(b.legalDate), reqAccount: t('reqAccount').replace(/\D/g, ''),
      reqBank: t('reqBank'), reqBic: t('reqBic').replace(/\D/g, ''), reqCorr: t('reqCorr').replace(/\D/g, ''), reqAddr: t('reqAddr', 300),
      reqVat: ['none', '5', '7', '10', '22'].includes(b.reqVat) ? b.reqVat : 'none' });
    auth.flash(res, 'Настройки сохранены.');
    res.redirect('/s/platform');
  });
}
