import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { toInt, normPhone, normPlate, PLATE_RE, parseDate, shortName, plural, fRub } from '../util.js';
import { addDays, ruDay, validTz, fDate, fTime } from '../time.js';
import { parkSettings, DEFAULT_PARK_SETTINGS } from '../db.js';
import { sheetStatus, docProblems, TAKES_DAY, IS_ACTIVE, DAYS_AHEAD, STATUS } from '../service.js';
import * as C from '../views/common.js';
import * as V from '../views/park.js';
import { sheetDoc } from '../views/driver.js';
import * as BV from '../views/billing.js';
import * as EV from '../views/epl.js';
import { parkServices } from '../views/services.js';
import { notifyPage } from '../views/notify.js';
import { staffEvents } from '../push.js';
import { signRights, parseSignItems } from '../epd.js';
import { PayError } from '../payments.js';
import { gostPayload } from '../money.js';
import { qrSvg } from '../waybill.js';
import { toKop } from '../util.js';

const ORDER = { wait_med: 0, wait_tech: 1, returning: 2, line: 3, planned: 4, refused: 5, closed: 6, expired: 7, cancelled: 8 };

export default function parkRoutes(app, { db, auth, billing, payments, epd, push, svc, platform, rev, back, fail, wrap, list, withQr, baseUrl, UserError }) {
  const q = {
    park: db.prepare('SELECT * FROM parks WHERE id = ?'),
    drivers: db.prepare('SELECT * FROM drivers WHERE park_id = ? ORDER BY blocked, name'),
    driver: db.prepare('SELECT * FROM drivers WHERE id = ? AND park_id = ?'),
    driverByPhone: db.prepare('SELECT * FROM drivers WHERE park_id = ? AND phone = ?'),
    cars: db.prepare('SELECT * FROM cars WHERE park_id = ? ORDER BY active DESC, model, num'),
    car: db.prepare('SELECT * FROM cars WHERE id = ? AND park_id = ?'),
    carriers: db.prepare('SELECT * FROM carriers WHERE park_id = ? ORDER BY active DESC, name'),
    carrier: db.prepare('SELECT * FROM carriers WHERE id = ? AND park_id = ?'),
    medics: db.prepare("SELECT * FROM users WHERE park_id = ? AND role = 'medic' AND active = 1 ORDER BY name"),
    users: db.prepare('SELECT * FROM users WHERE park_id = ? ORDER BY active DESC, role, name'),
    sheet: db.prepare('SELECT * FROM sheets WHERE id = ? AND park_id = ?'),
    sheetsDay: db.prepare('SELECT * FROM sheets WHERE park_id = ? AND shift_date = ?'),
    sheetsRange: db.prepare('SELECT * FROM sheets WHERE park_id = ? AND shift_date BETWEEN ? AND ?'),
    log: db.prepare('INSERT INTO audit (park_id, at, who, action, details) VALUES (?, ?, ?, ?, ?)')
  };
  const audit = (req, action, details = '') => q.log.run(req.park.id, new Date().toISOString(), req.user.name, action, details);

  /** Staff of a park, optionally limited to some roles. Loads the park and settles the monthly fee. */
  const needPark = (...roles) => (req, res, next) => {
    const u = req.user;
    if (!u) return res.redirect('/login?staff=1');
    if (!u.park_id) return res.redirect(u.service ? '/x' : '/s');
    if (roles.length && !roles.includes(u.role)) {
      req.park = q.park.get(u.park_id);
      return page(req, res, { title: 'Нет доступа', body: C.errorBody(403, 'Этот раздел доступен другой роли.', '/p') }, 403);
    }
    billing.renew(u.park_id);
    req.park = q.park.get(u.park_id);
    req.tz = req.park.tz;
    req.pset = parkSettings(req.park);
    next();
  };
  const OPS = ['owner', 'dispatcher'];
  /** Blocks actions that create new work while the subscription is not paid. */
  const needPaid = (req, res, next) => {
    if (billing.access(req.park).state !== 'suspended') return next();
    auth.flash(res, req.user.role === 'owner' ? 'Подписка не продлена: пополните баланс, и доступ откроется сразу.' : 'Подписка не продлена. Попросите владельца парка пополнить баланс.', 'bad');
    res.redirect(req.user.role === 'owner' ? '/p/billing' : back(req, '/p'));
  };
  app.use(['/p/issue', '/p/issue-week'], (req, res, next) => (req.method === 'POST' ? needPark(...OPS)(req, res, () => needPaid(req, res, next)) : next()));
  for (const path of ['/p/drivers', '/p/cars', '/p/carriers']) {
    app.post(path, needPark(...OPS), needPaid, (req, res, next) => next());
  }


  function navCounts(req) {
    const { today } = svc.ctx(req.park.id);
    const sheets = q.sheetsRange.all(req.park.id, addDays(today, -2), today);
    let waiting = 0;
    for (const s of sheets) {
      const st = sheetStatus(s, req.tz);
      if (req.user.role === 'medic' ? st === 'wait_med' : ['wait_med', 'wait_tech', 'returning'].includes(st)) waiting++;
    }
    if (req.user.role === 'medic') return { waiting };
    const cars = q.cars.all(req.park.id), warn = svc.toWarn(req.pset);
    const driverIssues = q.drivers.all(req.park.id).filter((d) => !d.blocked && (docProblems({ driver: d, car: null, day: today, warnDays: warn }).errors.length || !d.car_id || !d.carrier_id)).length;
    const carIssues = cars.filter((c) => c.active && docProblems({ car: c, day: today, warnDays: warn }).errors.length).length;
    return { waiting, driverIssues, carIssues };
  }

  function page(req, res, { title, body, active }, code = 200) {
    const tariff = billing.tariff(req.park.tariff_id);
    res.status(code).type('html').send(C.staffPage({
      title, body, active, user: req.user, park: req.park, flash: req.flash, rev: rev(req.park.id),
      nav: V.parkNav(req.user, req.tz ? { ...navCounts(req), epl: req.pset.eplMode !== 'off', sign: req.pset.eplMode !== 'off' ? epd.count(req.user, req.park) : 0 } : {}),
      banner: V.parkBanner({ park: req.park, tariff, access: billing.access(req.park), user: req.user })
    }));
  }

  /* ================= Смены ================= */
  app.get('/p', needPark(), (req, res) => {
    const { today } = svc.ctx(req.park.id);
    const reqDay = parseDate(req.query.day);
    const day = reqDay && reqDay >= addDays(today, -1) && reqDay <= addDays(today, DAYS_AHEAD - 1) ? reqDay : today;
    let rows = q.sheetsDay.all(req.park.id, day);
    if (day === today) {
      const older = q.sheetsRange.all(req.park.id, addDays(today, -3), addDays(today, -1)).filter((s) => IS_ACTIVE(sheetStatus(s, req.tz)));
      rows = rows.concat(older);
    }
    rows.sort((a, b) => ORDER[sheetStatus(a, req.tz)] - ORDER[sheetStatus(b, req.tz)] || a.no.localeCompare(b.no));
    const counts = { line: 0, wait: 0, returning: 0 };
    for (const s of rows) { const st = sheetStatus(s, req.tz); if (st === 'line') counts.line++; if (st === 'wait_med' || st === 'wait_tech') counts.wait++; if (st === 'returning') counts.returning++; }

    let idle = [];
    if (OPS.includes(req.user.role)) {
      const busy = new Set(rows.filter((s) => s.shift_date === day && TAKES_DAY(sheetStatus(s, req.tz))).map((s) => s.driver_id));
      const warn = svc.toWarn(req.pset);
      idle = q.drivers.all(req.park.id).filter((d) => !d.blocked && !busy.has(d.id)).map((d) => {
        const car = d.car_id ? q.car.get(d.car_id, req.park.id) : null;
        const p = docProblems({ driver: d, car, day, warnDays: warn });
        const problems = !d.carrier_id ? 'нет перевозчика' : !car ? 'нет машины' : !car.active ? 'машина выведена' : p.errors[0] || '';
        return { d, car, problems };
      });
    }
    const setup = OPS.includes(req.user.role) ? {
      carriers: q.carriers.all(req.park.id).length, cars: q.cars.all(req.park.id).length,
      drivers: q.drivers.all(req.park.id).length, medics: q.medics.all(req.park.id).length,
      settings: !!req.pset.medOrg
    } : null;
    page(req, res, { title: 'Смены', active: 'today', body: V.todayPage({ user: req.user, park: req.park, tz: req.tz, today, day, rows, idle, medics: q.medics.all(req.park.id), counts, setup }) });
  });

  /** On an electronic waybill the marks are made only by signing (see «На подпись»), never by a plain button. */
  const paperOnly = (req, res, next) => {
    const s = q.sheet.get(toInt(req.params.id), req.park.id);
    if (s && s.epl) {
      auth.flash(res, 'Это электронный путевой лист: отметки ставятся подписанием в разделе «На подпись».', 'bad');
      return res.redirect(back(req, '/p'));
    }
    next();
  };
  app.post('/p/sheet/:id/med', needPark('owner', 'dispatcher', 'medic'), paperOnly, (req, res) => {
    try {
      const ok = req.body.ok === '1';
      svc.markMed(req.park.id, toInt(req.params.id), req.user, { ok, note: String(req.body.note || ''), medicId: toInt(req.body.medic) });
      auth.flash(res, ok ? 'Медосмотр отмечен.' : 'Водитель не допущен.', ok ? 'ok' : 'bad');
      res.redirect(back(req, '/p'));
    } catch (e) { fail(req, res, e, '/p'); }
  });
  app.post('/p/sheet/:id/tech', needPark(...OPS), paperOnly, (req, res) => {
    try {
      const ok = req.body.ok === '1';
      svc.markTech(req.park.id, toInt(req.params.id), req.user, { ok, note: String(req.body.note || ''), odo: toInt(req.body.odo) });
      auth.flash(res, ok ? 'Водитель выпущен на линию.' : 'Выпуск запрещён.', ok ? 'ok' : 'bad');
      res.redirect(back(req, '/p'));
    } catch (e) { fail(req, res, e, '/p'); }
  });
  app.post('/p/sheet/:id/accept', needPark(...OPS), paperOnly, (req, res) => {
    try { svc.accept(req.park.id, toInt(req.params.id), req.user, toInt(req.body.odo)); auth.flash(res, 'Машина принята, смена закрыта.'); res.redirect(back(req, '/p')); }
    catch (e) { fail(req, res, e, '/p'); }
  });
  app.post('/p/sheet/:id/cancel', needPark(...OPS), (req, res) => {
    try {
      const refund = svc.cancel(req.park.id, toInt(req.params.id), { by: req.user.name, reason: req.body.reason });
      auth.flash(res, refund ? `Лист аннулирован, ${fRub(refund)} вернулись на баланс.` : 'Лист аннулирован.');
      res.redirect(back(req, '/p'));
    } catch (e) { fail(req, res, e, '/p'); }
  });

  app.get('/p/sheet/:id', needPark(), wrap(async (req, res) => {
    const s = q.sheet.get(toInt(req.params.id), req.park.id);
    if (!s) return page(req, res, { title: 'Не найдено', body: C.errorBody(404, 'Такого листа нет.', '/p') }, 404);
    res.type('html').send(sheetDoc({ sheets: await withQr(req, [s]), back: back(req, '/p'), title: `Путевой лист № ${s.no}` }));
  }));

  app.get('/p/print', needPark(), wrap(async (req, res) => {
    const { today } = svc.ctx(req.park.id);
    const from = parseDate(req.query.day || req.query.from) || today;
    const to = parseDate(req.query.day || req.query.to) || from;
    const driverId = toInt(req.query.driver);
    const rows = q.sheetsRange.all(req.park.id, from, to)
      .filter((s) => (!driverId || s.driver_id === driverId) && !['cancelled', 'refused'].includes(sheetStatus(s, req.tz)))
      .sort((a, b) => a.shift_date.localeCompare(b.shift_date) || a.no.localeCompare(b.no)).slice(0, 400);
    res.type('html').send(sheetDoc({ sheets: await withQr(req, rows), back: back(req, '/p'), title: from === to ? `Листы на ${ruDay(from)}` : `Листы ${ruDay(from)}–${ruDay(to)}` }));
  }));

  /* ================= Неделя ================= */
  app.get('/p/week', needPark(...OPS), (req, res) => {
    const { today } = svc.ctx(req.park.id);
    const cars = new Map(q.cars.all(req.park.id).map((c) => [c.id, c]));
    const sheets = q.sheetsRange.all(req.park.id, today, addDays(today, DAYS_AHEAD - 1));
    page(req, res, { title: 'Неделя', active: 'week', body: V.weekPage({ tz: req.tz, today, drivers: q.drivers.all(req.park.id), sheets, cars,
      price: billing.tariff(req.park.tariff_id)?.per_sheet || 0, inTrial: billing.inTrial(req.park), warnDays: svc.toWarn(req.pset) }) });
  });

  const issueSummary = (res, ok, failed) => {
    if (!failed.length) return auth.flash(res, ok ? `Выписано ${ok} ${plural(ok, 'лист', 'листа', 'листов')}.` : 'Нечего выписывать.');
    const reasons = [...new Set(failed.map((f) => f.msg))].slice(0, 3).join(' ');
    auth.flash(res, `${ok ? `Выписано ${ok}. ` : ''}Не выписано ${failed.length}: ${reasons}`, ok ? 'warn' : 'bad');
  };

  app.post('/p/issue', needPark(...OPS), (req, res) => {
    const d = q.driver.get(toInt(req.body.driver), req.park.id);
    if (!d) { auth.flash(res, 'Водитель не найден.', 'bad'); return res.redirect(back(req, '/p')); }
    const r = svc.issueDays(req.park.id, d.id, list(req.body.days).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)), req.user.name);
    issueSummary(res, r.ok.length, r.failed.map((f) => ({ msg: `${ruDay(f.day)}: ${f.msg}` })));
    res.redirect(back(req, '/p'));
  });

  app.post('/p/issue-week', needPark(...OPS), (req, res) => {
    const { today } = svc.ctx(req.park.id);
    const days = Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(today, i));
    const taken = new Set(q.sheetsRange.all(req.park.id, today, days[days.length - 1])
      .filter((s) => TAKES_DAY(sheetStatus(s, req.tz))).map((s) => s.driver_id + '|' + s.shift_date));
    let ok = 0; const failed = [];
    for (const d of q.drivers.all(req.park.id).filter((x) => !x.blocked)) {
      const free = days.filter((day) => !taken.has(d.id + '|' + day));
      if (!free.length) continue;
      const r = svc.issueDays(req.park.id, d.id, free, req.user.name);
      ok += r.ok.length;
      failed.push(...r.failed.map((f) => ({ msg: `${shortName(d.name)}: ${f.msg}` })));
    }
    issueSummary(res, ok, failed);
    res.redirect('/p/week');
  });

  /* ================= Водители ================= */
  function driverRows(req) {
    const { today } = svc.ctx(req.park.id);
    const warn = svc.toWarn(req.pset);
    const cars = new Map(q.cars.all(req.park.id).map((c) => [c.id, c]));
    const carriers = new Map(q.carriers.all(req.park.id).map((c) => [c.id, c]));
    const sheets = q.sheetsRange.all(req.park.id, addDays(today, -3), today);
    return q.drivers.all(req.park.id).map((d) => {
      const car = cars.get(d.car_id) || null;
      const problems = docProblems({ driver: d, car, day: today, warnDays: warn });
      if (!d.carrier_id) problems.errors.unshift('Нет перевозчика');
      if (!car) problems.errors.unshift('Нет машины');
      const mine = sheets.filter((s) => s.driver_id === d.id).sort((a, b) => b.id - a.id);
      const act = mine.find((s) => IS_ACTIVE(sheetStatus(s, req.tz))) || mine.find((s) => s.shift_date === today);
      return { d, car, carrier: carriers.get(d.carrier_id), problems, todaySt: act ? sheetStatus(act, req.tz) : null };
    });
  }
  app.get('/p/drivers', needPark(...OPS), (req, res) => {
    const all = driverRows(req);
    const qs = String(req.query.q || '').trim().toLowerCase();
    const digits = qs.replace(/\D/g, '');
    const F = {
      all: () => true,
      bad: (r) => !r.d.blocked && r.problems.errors.length > 0,
      warn: (r) => !r.d.blocked && r.problems.warnings.length > 0,
      line: (r) => r.todaySt === 'line',
      free: (r) => !r.d.blocked && (!r.todaySt || !TAKES_DAY(r.todaySt)),
      blocked: (r) => !!r.d.blocked
    };
    const filter = F[req.query.f] ? req.query.f : 'all';
    const counts = Object.fromEntries(Object.keys(F).filter((k) => k !== 'all').map((k) => [k, all.filter(F[k]).length]));
    const listRows = all.filter(F[filter]).filter((r) => !qs || r.d.name.toLowerCase().includes(qs) || (digits.length >= 3 && r.d.phone.includes(digits)) || (r.car && normPlate(r.car.num).includes(normPlate(qs))));
    page(req, res, { title: 'Водители', active: 'drivers', body: V.driversPage({ list: listRows, filter, q: req.query.q || '', cars: q.cars.all(req.park.id), carriers: q.carriers.all(req.park.id), counts }) });
  });

  function readDriver(req) {
    const b = req.body;
    const d = {
      name: String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 150), phone: normPhone(b.phone), lic: String(b.lic || '').trim().slice(0, 30),
      lic_from: parseDate(b.lic_from), lic_to: parseDate(b.lic_to), cls: String(b.cls || 'B').trim().slice(0, 20) || 'B',
      snils: String(b.snils || '').trim().slice(0, 20), car_id: toInt(b.car_id), carrier_id: toInt(b.carrier_id)
    };
    if (d.name.split(' ').length < 2) throw new UserError('Укажите фамилию и имя полностью.');
    if (d.phone.length !== 11) throw new UserError('Телефон должен содержать 11 цифр, например +7 900 000-00-00.');
    if (!d.lic) throw new UserError('Укажите номер водительского удостоверения.');
    if (d.lic_from && d.lic_to && d.lic_to < d.lic_from) throw new UserError('Дата окончания ВУ раньше даты выдачи.');
    if (!d.carrier_id || !q.carrier.get(d.carrier_id, req.park.id)) throw new UserError('Выберите перевозчика. Если списка нет, добавьте перевозчика в разделе «Перевозчики».');
    if (d.car_id && !q.car.get(d.car_id, req.park.id)) d.car_id = null;
    return d;
  }
  const newPin = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const pinFrom = (v) => {
    const p = String(v || '').trim();
    if (!p) return newPin();
    if (p.length < 4 || p.length > 32) throw new UserError('Пароль водителя — от 4 до 32 знаков.');
    return p;
  };
  // A car belongs to one driver at a time: assigning moves it from the previous holder.
  const freeCar = (parkId, carId, exceptId) => { if (carId) db.prepare('UPDATE drivers SET car_id = NULL WHERE park_id = ? AND car_id = ? AND id <> ?').run(parkId, carId, exceptId); };

  app.post('/p/drivers', needPark(...OPS), (req, res) => {
    try {
      const d = readDriver(req);
      if (q.driverByPhone.get(req.park.id, d.phone)) throw new UserError('Водитель с таким телефоном уже есть.');
      const pin = pinFrom(req.body.pin);
      const id = db.transaction(() => {
        const r = db.prepare('INSERT INTO drivers (park_id, carrier_id, car_id, name, phone, pin_hash, lic, lic_from, lic_to, cls, snils) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(req.park.id, d.carrier_id, d.car_id, d.name, d.phone, bcrypt.hashSync(pin, 10), d.lic, d.lic_from, d.lic_to, d.cls, d.snils);
        freeCar(req.park.id, d.car_id, r.lastInsertRowid);
        audit(req, 'Добавил водителя', d.name);
        return r.lastInsertRowid;
      })();
      page(req, res, { title: 'Водитель добавлен', active: 'drivers', body: V.pinShown({ d: q.driver.get(id, req.park.id), pin, isNew: true }) });
    } catch (e) { fail(req, res, e, '/p/drivers'); }
  });
  app.get('/p/drivers/:id', needPark(...OPS), (req, res) => {
    const d = q.driver.get(toInt(req.params.id), req.park.id);
    if (!d) return page(req, res, { title: 'Не найдено', body: C.errorBody(404, 'Водитель не найден.', '/p/drivers') }, 404);
    const sheets = db.prepare('SELECT * FROM sheets WHERE driver_id = ? ORDER BY shift_date DESC, id DESC LIMIT 10').all(d.id);
    page(req, res, { title: d.name, active: 'drivers', body: V.driverCard({ d, cars: q.cars.all(req.park.id), carriers: q.carriers.all(req.park.id), sheets, tz: req.tz }) });
  });
  app.post('/p/drivers/:id', needPark(...OPS), (req, res) => {
    try {
      const id = toInt(req.params.id);
      if (!q.driver.get(id, req.park.id)) throw new UserError('Водитель не найден.');
      const d = readDriver(req);
      const other = q.driverByPhone.get(req.park.id, d.phone);
      if (other && other.id !== id) throw new UserError('Этот телефон уже у другого водителя.');
      db.transaction(() => {
        db.prepare('UPDATE drivers SET name=?, phone=?, lic=?, lic_from=?, lic_to=?, cls=?, snils=?, car_id=?, carrier_id=? WHERE id=? AND park_id=?')
          .run(d.name, d.phone, d.lic, d.lic_from, d.lic_to, d.cls, d.snils, d.car_id, d.carrier_id, id, req.park.id);
        freeCar(req.park.id, d.car_id, id);
        audit(req, 'Изменил водителя', d.name);
      })();
      auth.flash(res, 'Данные водителя сохранены. В уже выписанных листах они не меняются.');
      res.redirect('/p/drivers');
    } catch (e) { fail(req, res, e, '/p/drivers'); }
  });
  app.post('/p/drivers/:id/car', needPark(...OPS), (req, res) => {
    const d = q.driver.get(toInt(req.params.id), req.park.id);
    if (!d) return res.redirect('/p/drivers');
    const car = toInt(req.body.car_id) ? q.car.get(toInt(req.body.car_id), req.park.id) : null;
    db.transaction(() => {
      db.prepare('UPDATE drivers SET car_id = ? WHERE id = ?').run(car ? car.id : null, d.id);
      freeCar(req.park.id, car?.id, d.id);
      audit(req, 'Закрепил машину', `${d.name}: ${car ? car.num : 'без машины'}`);
    })();
    auth.flash(res, car ? `${shortName(d.name)} теперь на ${car.model} ${car.num}.` : `С ${shortName(d.name)} снята машина.`);
    res.redirect(back(req, '/p/drivers'));
  });
  app.post('/p/drivers/:id/block', needPark(...OPS), (req, res) => {
    const d = q.driver.get(toInt(req.params.id), req.park.id);
    if (!d) return res.redirect('/p/drivers');
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    db.prepare('UPDATE drivers SET blocked = 1, block_reason = ? WHERE id = ?').run(reason, d.id);
    audit(req, 'Заблокировал водителя', `${d.name}${reason ? ': ' + reason : ''}`);
    auth.flash(res, `${shortName(d.name)} заблокирован. Путевые листы ему недоступны.`, 'bad');
    res.redirect(back(req, '/p/drivers'));
  });
  app.post('/p/drivers/:id/unblock', needPark(...OPS), (req, res) => {
    const d = q.driver.get(toInt(req.params.id), req.park.id);
    if (!d) return res.redirect('/p/drivers');
    db.prepare("UPDATE drivers SET blocked = 0, block_reason = '' WHERE id = ?").run(d.id);
    audit(req, 'Разблокировал водителя', d.name);
    auth.flash(res, `${shortName(d.name)} снова может получать листы.`);
    res.redirect(back(req, '/p/drivers'));
  });
  app.post('/p/drivers/:id/pin', needPark(...OPS), (req, res) => {
    try {
      const d = q.driver.get(toInt(req.params.id), req.park.id);
      if (!d) return res.redirect('/p/drivers');
      const pin = pinFrom(req.body.pin);
      db.prepare('UPDATE drivers SET pin_hash = ? WHERE id = ?').run(bcrypt.hashSync(pin, 10), d.id);
      auth.endAllFor('driver', d.id);
      audit(req, 'Сменил пароль водителя', d.name);
      page(req, res, { title: 'Пароль изменён', active: 'drivers', body: V.pinShown({ d, pin, isNew: false }) });
    } catch (e) { fail(req, res, e, '/p/drivers'); }
  });

  /* ================= Машины ================= */
  function readCar(b) {
    const c = {
      model: String(b.model || '').trim().slice(0, 80), num: normPlate(b.num), reg: String(b.reg || '').replace(/\D/g, ''),
      odo: toInt(b.odo), garage: String(b.garage || '').trim().slice(0, 20), fuel: String(b.fuel || 'АИ-95').trim().slice(0, 30),
      sts: String(b.sts || '').trim().slice(0, 30), permit: String(b.permit || '').trim().slice(0, 40), permit_to: parseDate(b.permit_to),
      osago: String(b.osago || '').trim().slice(0, 40), osago_to: parseDate(b.osago_to), diag_to: parseDate(b.diag_to)
    };
    if (!c.model) throw new UserError('Укажите марку и модель.');
    if (!PLATE_RE.test(c.num)) throw new UserError('Госномер в формате А123ВС: буква, три цифры, две буквы (только А В Е К М Н О Р С Т У Х).');
    if (!/^\d{2,3}$/.test(c.reg)) throw new UserError('Регион — 2 или 3 цифры.');
    if (c.odo === null || c.odo < 0) throw new UserError('Укажите пробег числом.');
    return c;
  }
  app.get('/p/cars', needPark(...OPS), (req, res) => {
    const { today } = svc.ctx(req.park.id);
    const warn = svc.toWarn(req.pset);
    const drivers = q.drivers.all(req.park.id);
    const all = q.cars.all(req.park.id).map((c) => ({ c, driver: drivers.find((d) => d.car_id === c.id), problems: docProblems({ car: c, day: today, warnDays: warn }) }));
    const F = { all: () => true, bad: (r) => r.c.active && r.problems.errors.length > 0, warn: (r) => r.c.active && r.problems.warnings.length > 0, off: (r) => !r.c.active };
    const filter = F[req.query.f] ? req.query.f : 'all';
    const qs = normPlate(String(req.query.q || '').trim());
    const counts = { bad: all.filter(F.bad).length, warn: all.filter(F.warn).length, off: all.filter(F.off).length };
    const listRows = all.filter(F[filter]).filter((r) => !qs || r.c.num.includes(qs) || r.c.model.toUpperCase().includes(String(req.query.q).trim().toUpperCase()));
    page(req, res, { title: 'Машины', active: 'cars', body: V.carsPage({ list: listRows, filter, q: req.query.q || '', counts }) });
  });
  app.post('/p/cars', needPark(...OPS), (req, res) => {
    try {
      const c = readCar(req.body);
      if (db.prepare('SELECT 1 FROM cars WHERE park_id = ? AND num = ? AND reg = ?').get(req.park.id, c.num, c.reg)) throw new UserError('Машина с таким номером уже есть.');
      db.prepare(`INSERT INTO cars (park_id, model, num, reg, odo, garage, fuel, sts, permit, permit_to, osago, osago_to, diag_to)
        VALUES (@park_id, @model, @num, @reg, @odo, @garage, @fuel, @sts, @permit, @permit_to, @osago, @osago_to, @diag_to)`).run({ ...c, park_id: req.park.id });
      audit(req, 'Добавил машину', `${c.model} ${c.num}`);
      auth.flash(res, 'Машина добавлена.');
      res.redirect('/p/cars');
    } catch (e) { fail(req, res, e, '/p/cars'); }
  });
  app.get('/p/cars/:id', needPark(...OPS), (req, res) => {
    const c = q.car.get(toInt(req.params.id), req.park.id);
    if (!c) return page(req, res, { title: 'Не найдено', body: C.errorBody(404, 'Машина не найдена.', '/p/cars') }, 404);
    page(req, res, { title: c.model, active: 'cars', body: V.carCard({ c }) });
  });
  app.post('/p/cars/:id', needPark(...OPS), (req, res) => {
    try {
      const id = toInt(req.params.id);
      if (!q.car.get(id, req.park.id)) throw new UserError('Машина не найдена.');
      const c = readCar(req.body);
      const dup = db.prepare('SELECT id FROM cars WHERE park_id = ? AND num = ? AND reg = ?').get(req.park.id, c.num, c.reg);
      if (dup && dup.id !== id) throw new UserError('Машина с таким номером уже есть.');
      const active = req.body.active === '1' ? 1 : 0;
      if (!active) {
        const { today } = svc.ctx(req.park.id);
        const busy = db.prepare('SELECT * FROM sheets WHERE car_id = ? AND shift_date >= ?').all(id, addDays(today, -3)).find((s) => IS_ACTIVE(sheetStatus(s, req.tz)));
        if (busy) throw new UserError(`Машина сейчас по листу № ${busy.no}. Выведите её после закрытия смены.`);
      }
      db.transaction(() => {
        db.prepare(`UPDATE cars SET model=@model, num=@num, reg=@reg, odo=@odo, garage=@garage, fuel=@fuel, sts=@sts, permit=@permit, permit_to=@permit_to,
          osago=@osago, osago_to=@osago_to, diag_to=@diag_to, active=@active WHERE id=@id AND park_id=@park_id`).run({ ...c, active, id, park_id: req.park.id });
        if (!active) db.prepare('UPDATE drivers SET car_id = NULL WHERE car_id = ? AND park_id = ?').run(id, req.park.id);
        audit(req, 'Изменил машину', `${c.model} ${c.num}`);
      })();
      auth.flash(res, 'Машина сохранена.');
      res.redirect('/p/cars');
    } catch (e) { fail(req, res, e, '/p/cars'); }
  });

  /* ================= Перевозчики ================= */
  const readCarrier = (b) => {
    const c = { name: String(b.name || '').trim().slice(0, 200), inn: String(b.inn || '').replace(/\D/g, ''), ogrn: String(b.ogrn || '').replace(/\D/g, ''),
      addr: String(b.addr || '').trim().slice(0, 300), phone: String(b.phone || '').trim().slice(0, 40), reestr: String(b.reestr || '').trim().slice(0, 60) };
    if (!c.name) throw new UserError('Укажите наименование перевозчика.');
    if (c.inn && !/^\d{10}(\d{2})?$/.test(c.inn)) throw new UserError('ИНН — 10 или 12 цифр.');
    if (c.ogrn && !/^\d{13}(\d{2})?$/.test(c.ogrn)) throw new UserError('ОГРН — 13 цифр, ОГРНИП — 15.');
    return c;
  };
  app.get('/p/carriers', needPark(...OPS), (req, res) => {
    const drivers = q.drivers.all(req.park.id);
    page(req, res, { title: 'Перевозчики', active: 'carriers', body: V.carriersPage({ list: q.carriers.all(req.park.id).map((c) => ({ c, n: drivers.filter((d) => d.carrier_id === c.id).length })) }) });
  });
  app.post('/p/carriers', needPark(...OPS), (req, res) => {
    try {
      const c = readCarrier(req.body);
      db.prepare('INSERT INTO carriers (park_id, name, inn, ogrn, addr, phone, reestr) VALUES (@park_id, @name, @inn, @ogrn, @addr, @phone, @reestr)').run({ ...c, park_id: req.park.id });
      audit(req, 'Добавил перевозчика', c.name);
      auth.flash(res, 'Перевозчик добавлен.');
      res.redirect('/p/carriers');
    } catch (e) { fail(req, res, e, '/p/carriers'); }
  });
  app.get('/p/carriers/:id', needPark(...OPS), (req, res) => {
    const c = q.carrier.get(toInt(req.params.id), req.park.id);
    if (!c) return page(req, res, { title: 'Не найдено', body: C.errorBody(404, 'Перевозчик не найден.', '/p/carriers') }, 404);
    page(req, res, { title: c.name, active: 'carriers', body: V.carrierCard({ c }) });
  });
  app.post('/p/carriers/:id', needPark(...OPS), (req, res) => {
    try {
      const id = toInt(req.params.id);
      if (!q.carrier.get(id, req.park.id)) throw new UserError('Перевозчик не найден.');
      const c = readCarrier(req.body);
      db.prepare('UPDATE carriers SET name=@name, inn=@inn, ogrn=@ogrn, addr=@addr, phone=@phone, reestr=@reestr, active=@active WHERE id=@id AND park_id=@park_id')
        .run({ ...c, active: req.body.active === '1' ? 1 : 0, id, park_id: req.park.id });
      audit(req, 'Изменил перевозчика', c.name);
      auth.flash(res, 'Перевозчик сохранён. В уже выписанных листах реквизиты не меняются.');
      res.redirect('/p/carriers');
    } catch (e) { fail(req, res, e, '/p/carriers'); }
  });

  /* ================= Журнал ================= */
  function journalRows(req) {
    const { today } = svc.ctx(req.park.id);
    const from = parseDate(req.query.from) || addDays(today, -6);
    const to = parseDate(req.query.to) || addDays(today, DAYS_AHEAD - 1);
    const driverId = toInt(req.query.driver);
    const rows = q.sheetsRange.all(req.park.id, from, to).filter((s) => !driverId || s.driver_id === driverId)
      .sort((a, b) => b.shift_date.localeCompare(a.shift_date) || b.no.localeCompare(a.no)).slice(0, 5000);
    return { rows, from, to, driverId };
  }
  app.get('/p/journal', needPark(), (req, res) => {
    const j = journalRows(req);
    const totalKm = j.rows.reduce((a, s) => a + (s.odo_back != null && s.odo_out != null && !s.cancelled_at ? s.odo_back - s.odo_out : 0), 0);
    page(req, res, { title: 'Журнал', active: 'journal', body: V.journalPage({ ...j, totalKm, drivers: q.drivers.all(req.park.id), user: req.user, tz: req.tz }) });
  });
  app.get('/p/journal.csv', needPark(), (req, res) => {
    const { rows, from, to } = journalRows(req);
    const tz = req.tz;
    const cell = (v) => { const s = String(v ?? ''); return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const head = ['№', 'Дата смены', 'Перевозчик', 'Водитель', 'Машина', 'Госномер', 'Медосмотр', 'Медработник', 'Выезд', 'Одометр выезд', 'Возврат', 'Одометр возврат', 'Пробег, км', 'Статус', 'Стоимость, ₽'];
    const lines = rows.map((s) => {
      const sn = JSON.parse(s.snapshot);
      return [s.no, ruDay(s.shift_date), sn.carrier.name, sn.driver.name, sn.car.model, `${sn.car.num} ${sn.car.reg}`,
        s.med_status === 'ok' ? `${fDate(tz, s.med_at)} ${fTime(tz, s.med_at)}` : s.med_status === 'refused' ? 'не допущен' : '', s.med_by || '',
        s.tech_status === 'ok' ? `${fDate(tz, s.tech_at)} ${fTime(tz, s.tech_at)}` : '', s.odo_out ?? '',
        s.back_at ? `${fDate(tz, s.back_at)} ${fTime(tz, s.back_at)}` : '', s.odo_back ?? '',
        s.odo_back != null && s.odo_out != null ? s.odo_back - s.odo_out : '', STATUS[sheetStatus(s, tz)].label, (s.price / 100).toString().replace('.', ',')];
    });
    const csv = '﻿' + [head, ...lines].map((r) => r.map(cell).join(';')).join('\r\n');
    res.set('Content-Disposition', `attachment; filename="putevye-listy_${from}_${to}.csv"`).type('text/csv; charset=utf-8').send(csv);
  });

  /* ================= Сотрудники ================= */
  app.get('/p/staff', needPark('owner'), (req, res) => page(req, res, { title: 'Сотрудники', active: 'staff', body: V.staffPage({ users: q.users.all(req.park.id), me: req.user }) }));
  app.post('/p/staff', needPark('owner'), (req, res) => {
    try {
      const name = String(req.body.name || '').trim().slice(0, 150), login = String(req.body.login || '').trim(), pass = String(req.body.password || ''), role = String(req.body.role || '');
      if (!name) throw new UserError('Укажите ФИО.');
      if (!/^[a-zA-Z0-9._-]{3,60}$/.test(login)) throw new UserError('Логин — от 3 латинских букв, цифр или знаков . _ -');
      if (!['owner', 'dispatcher', 'medic'].includes(role)) throw new UserError('Выберите роль.');
      if (pass.length < 8) throw new UserError('Пароль не короче 8 знаков.');
      if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) throw new UserError('Такой логин уже занят.');
      db.prepare('INSERT INTO users (park_id, login, name, role, pass_hash) VALUES (?, ?, ?, ?, ?)').run(req.park.id, login, name, role, bcrypt.hashSync(pass, 10));
      audit(req, 'Добавил сотрудника', `${name} (${role})`);
      auth.flash(res, 'Сотрудник добавлен.');
      res.redirect('/p/staff');
    } catch (e) { fail(req, res, e, '/p/staff'); }
  });
  app.post('/p/staff/:id/toggle', needPark('owner'), (req, res) => {
    const id = toInt(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND park_id = ?').get(id, req.park.id);
    if (u && id !== req.user.id) {
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(u.active ? 0 : 1, id);
      if (u.active) auth.endAllFor('user', id);
      audit(req, u.active ? 'Отключил сотрудника' : 'Включил сотрудника', u.name);
    }
    res.redirect('/p/staff');
  });
  app.post('/p/staff/:id/password', needPark('owner'), (req, res) => {
    const id = toInt(req.params.id), pass = String(req.body.password || '');
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND park_id = ?').get(id, req.park.id);
    if (!u) return res.redirect('/p/staff');
    if (pass.length < 8) { auth.flash(res, 'Пароль не короче 8 знаков.', 'bad'); return res.redirect('/p/staff'); }
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(pass, 10), id);
    if (id !== req.user.id) auth.endAllFor('user', id);
    audit(req, 'Сменил пароль сотрудника', u.name);
    auth.flash(res, 'Пароль изменён.');
    res.redirect('/p/staff');
  });

  /* ================= Баланс и оплата ================= */
  const amountFrom = (b) => (b.amount === 'other' ? toKop(b.amount_other) : toKop(b.amount));
  app.get('/p/billing', needPark('owner'), (req, res) => {
    const { today } = svc.ctx(req.park.id);
    const p = req.park;
    let payer = {};
    try { payer = JSON.parse(p.payer || '{}'); } catch { /* empty */ }
    page(req, res, { title: 'Баланс', active: 'billing', body: BV.billingPage({
      park: p, tariff: billing.tariff(p.tariff_id), access: billing.access(p), estimate: billing.monthlyEstimate(p), tz: req.tz, mode: payments.mode, payer,
      monthSheets: db.prepare('SELECT COUNT(*) AS n FROM sheets WHERE park_id = ? AND substr(issued_at, 1, 7) = ? AND cancelled_at IS NULL').get(p.id, today.slice(0, 7)).n,
      ledger: db.prepare('SELECT * FROM ledger WHERE park_id = ? ORDER BY id DESC LIMIT 200').all(p.id),
      payments: db.prepare('SELECT * FROM payments WHERE park_id = ? ORDER BY id DESC LIMIT 50').all(p.id)
    }) });
  });
  app.post('/p/billing/pay', needPark('owner'), wrap(async (req, res) => {
    try {
      const url = await payments.startOnline({ park: req.park, amount: amountFrom(req.body), method: String(req.body.method || ''), returnUrl: `${baseUrl(req)}/p/billing/return/:id`, by: req.user.name });
      res.redirect(url);
    } catch (e) {
      if (!(e instanceof PayError)) throw e;
      auth.flash(res, e.message, 'bad'); res.redirect('/p/billing');
    }
  }));
  app.get('/p/billing/return/:id', needPark('owner'), wrap(async (req, res) => {
    let p = payments.get(toInt(req.params.id));
    if (!p || p.park_id !== req.park.id) return res.redirect('/p/billing');
    try { p = await payments.sync(p.id); } catch (e) { if (!(e instanceof PayError)) throw e; auth.flash(res, e.message, 'bad'); return res.redirect('/p/billing'); }
    if (p.status === 'succeeded') auth.flash(res, `Оплата прошла: ${fRub(p.paid_amount)} на балансе.`);
    else if (p.status === 'canceled') auth.flash(res, 'Оплата не прошла. Деньги не списаны, попробуйте ещё раз.', 'bad');
    else auth.flash(res, 'Ждём подтверждения от банка. Баланс обновится сам, обычно за минуту.', 'warn');
    res.redirect('/p/billing');
  }));
  app.post('/p/billing/:id/cancel', needPark('owner'), (req, res) => {
    const p = payments.get(toInt(req.params.id));
    if (p && p.park_id === req.park.id && payments.cancel(p.id)) auth.flash(res, p.invoice_no ? `Счёт № ${p.invoice_no} отменён.` : 'Платёж отменён.');
    res.redirect('/p/billing');
  });
  app.post('/p/billing/invoice', needPark('owner'), (req, res) => {
    try {
      const b = req.body;
      const payer = { name: String(b.p_name || '').trim().slice(0, 200), inn: String(b.p_inn || '').replace(/\D/g, ''), kpp: String(b.p_kpp || '').replace(/\D/g, '').slice(0, 9), addr: String(b.p_addr || '').trim().slice(0, 300) };
      const id = payments.createInvoice({ park: req.park, amount: amountFrom(b), payer, by: req.user.name });
      auth.flash(res, 'Счёт выставлен. Скачайте его и передайте в бухгалтерию.');
      res.redirect(`/p/billing/invoice/${id}`);
    } catch (e) {
      if (!(e instanceof PayError)) throw e;
      auth.flash(res, e.message, 'bad'); res.redirect('/p/billing');
    }
  });
  app.get('/p/billing/invoice/:id', needPark('owner'), wrap(async (req, res) => {
    const p = payments.get(toInt(req.params.id));
    if (!p || p.park_id !== req.park.id || !p.invoice_no) return res.redirect('/p/billing');
    res.type('html').send(await invoiceHtml(p, req.park, '/p/billing', baseUrl(req)));
  }));

  /** Shared with the platform cabinet. */
  async function invoiceHtml(p, park, backUrl, site) {
    const req = platform.get();
    const purpose = `Оплата по счёту № ${p.invoice_no} от ${BV.longDate(p.created_at, park.tz).replace(' г.', '')} за сервис «Путёвка», таксопарк № ${park.id}. ${req.reqVat && req.reqVat !== 'none' ? `В т.ч. ${BV.vatLine(p.amount, req.reqVat)[0].replace('В том числе ', '')} ${BV.vatLine(p.amount, req.reqVat)[1]}` : 'Без НДС'}`;
    const qr = req.reqAccount ? await qrSvg(gostPayload({ name: req.reqName, account: req.reqAccount, bank: req.reqBank, bic: req.reqBic, corr: req.reqCorr, inn: req.reqInn, kpp: req.reqKpp, sum: p.amount, purpose })) : '';
    return BV.invoiceDoc({ p, park, req, qr, purpose, tz: park.tz, back: backUrl, offerUrl: `${site}/offer` });
  }
  app.locals.invoiceHtml = invoiceHtml;

  /* ================= Электронные путевые листы: подписание ================= */
  const needEpl = (req, res, next) => {
    if (req.pset.eplMode === 'off') { auth.flash(res, 'Электронные путевые листы выключены. Владелец включает их в «Настройках».', 'bad'); return res.redirect('/p'); }
    next();
  };
  app.get('/p/me', needPark(), (req, res) => page(req, res, { title: 'Моя подпись', active: 'me', body: EV.mySignaturePage({ user: req.user, sandbox: epd.operator.sandbox }) }));
  app.post('/p/me', needPark(), wrap(async (req, res) => {
    const type = req.user.role === 'medic' ? 'ukep' : (['ukep', 'goskey'].includes(req.body.sig_type) ? req.body.sig_type : 'goskey');
    try {
      // the operator confirms the certificate exists and is issued to this very person
      const r = await epd.connectSignature(req.user, { type, cert: req.body.sig_cert });
      audit(req, 'Подключил подпись', `${r.type}, ${r.cert}`);
      auth.flash(res, 'Подпись подключена. Подписывать можете только вы.');
      res.redirect('/p/me');
    } catch (e) { fail(req, res, e, '/p/me'); }
  }));
  app.post('/p/staff/:id/tech', needPark('owner'), (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND park_id = ?').get(toInt(req.params.id), req.park.id);
    if (!u || !['owner', 'dispatcher'].includes(u.role)) { auth.flash(res, 'Аттестацию контролёра указывают диспетчеру или владельцу.', 'bad'); return res.redirect('/p/staff'); }
    const no = String(req.body.tech_cert || '').trim().slice(0, 60);
    db.prepare('UPDATE users SET tech_cert = ?, tech_cert_date = ? WHERE id = ?').run(no, parseDate(req.body.tech_cert_date), u.id);
    audit(req, no ? 'Внёс аттестацию контролёра' : 'Убрал аттестацию контролёра', `${u.name}${no ? ': ' + no : ''}`);
    auth.flash(res, no ? `${shortName(u.name)} может подписывать выпуск и приём машин.` : 'Аттестация убрана.');
    res.redirect('/p/staff');
  });

  app.get('/p/sign', needPark(), needEpl, (req, res) => {
    page(req, res, { title: 'На подпись', active: 'sign', body: EV.queuePage({ q: epd.queue(req.user, req.park), user: req.user, sandbox: epd.operator.sandbox, operatorName: epd.operator.name }) });
  });
  app.post('/p/sign', needPark(), needEpl, wrap(async (req, res) => {
    try {
      const items = parseSignItems(req.body);
      const id = await epd.startSession(req.user, req.park, items);
      res.redirect(`/p/sign/s/${id}`);
    } catch (e) { fail(req, res, e, '/p/sign'); }
  }));
  /** The signer confirms in their own app; this page asks the operator and moves on when the batch is signed. */
  app.get('/p/sign/s/:id', needPark(), wrap(async (req, res) => {
    try {
      const s = await epd.poll(toInt(req.params.id), req.user);
      if (s.status !== 'waiting') { const m = epd.summary(s); auth.flash(res, m.text, m.tone); return res.redirect('/p/sign'); }
      const items = JSON.parse(s.items);
      const sheets = new Map(items.map((it) => [it.sheetId, q.sheet.get(it.sheetId, req.park.id)]));
      page(req, res, { title: 'Подтверждение подписи', active: 'sign', body: EV.sessionPage({ s, items, sheets, sandbox: epd.operator.sandbox, user: req.user }) });
    } catch (e) { fail(req, res, e, '/p/sign'); }
  }));
  app.get('/p/sign/s/:id/state', needPark(), wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json({ status: (await epd.poll(toInt(req.params.id), req.user)).status }); }
    catch (e) { if (!(e instanceof UserError)) throw e; res.status(404).json({ status: 'unknown' }); }
  }));
  app.post('/p/sign/s/:id/confirm', needPark(), wrap(async (req, res) => {
    try {
      if (!epd.operator.sandbox) throw new UserError('Подтверждение приходит от оператора, страница обновится сама.');
      const r = epd.confirm(toInt(req.params.id), req.user);
      await epd.settle(req.park.id);
      const failed = r.failed.map((f) => `№ ${f.no}: ${f.msg}`).join('; ');
      auth.flash(res, `Подписано: ${r.done.length}.${failed ? ` Не подписано: ${failed}.` : ''}`, r.failed.length ? (r.done.length ? 'warn' : 'bad') : 'ok');
      res.redirect('/p/sign');
    } catch (e) { fail(req, res, e, '/p/sign'); }
  }));
  app.post('/p/sign/s/:id/cancel', needPark(), (req, res) => {
    try { epd.cancel(toInt(req.params.id), req.user); auth.flash(res, 'Подписание отменено.'); res.redirect('/p/sign'); }
    catch (e) { fail(req, res, e, '/p/sign'); }
  });
  void signRights;

  /* ================= Уведомления ================= */
  app.get('/p/notify', needPark(), (req, res) => page(req, res, { title: 'Уведомления', active: 'notify', body: notifyPage({
    events: staffEvents(req.user), off: push.offList(req.user), devices: push.devices('user', req.user.id), enabled: push.enabled, action: '/p/notify' }) }));
  app.post('/p/notify', needPark(), (req, res) => {
    const on = list(req.body.on);
    db.prepare('UPDATE users SET push_off = ? WHERE id = ? AND park_id = ?').run(Object.keys(staffEvents(req.user)).filter((k) => !on.includes(k)).join(','), req.user.id, req.park.id);
    auth.flash(res, 'Сохранено.');
    res.redirect('/p/notify');
  });

  /* ================= Настройки ================= */
  app.get('/p/settings', needPark('owner'), (req, res) => page(req, res, { title: 'Настройки', active: 'settings', body: V.settingsPage({ park: req.park, s: req.pset, operator: epd.operator })
    + parkServices({ s: platform.get(), set: req.pset, epl: req.pset.eplMode !== 'off', cities: app.locals.svcCities ? app.locals.svcCities() : [], park: req.park }) }));
  app.post('/p/services', needPark('owner'), (req, res) => {
    if (req.pset.eplMode === 'off') { auth.flash(res, 'Услуги исполнителей работают только с электронными листами.', 'bad'); return res.redirect('/p/settings#services'); }
    const p = platform.get();
    const next = { ...req.pset, svcMed: p.svcMedOn === '1' && req.body.svcMed === '1' ? '1' : '0', svcMech: p.svcMechOn === '1' && req.body.svcMech === '1' ? '1' : '0' };
    db.prepare('UPDATE parks SET settings = ? WHERE id = ?').run(JSON.stringify(next), req.park.id);
    audit(req, 'Услуги сервиса', `медосмотр: ${next.svcMed === '1' ? 'да' : 'нет'}, механик: ${next.svcMech === '1' ? 'да' : 'нет'}`);
    auth.flash(res, next.svcMed === '1' || next.svcMech === '1' ? 'Услуги подключены. Исполнители сервиса увидят ваши листы в своей очереди.' : 'Услуги отключены.');
    res.redirect('/p/settings#services');
  });
  app.post('/p/settings', needPark('owner'), (req, res) => {
    const b = req.body;
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) { auth.flash(res, 'Название не может быть пустым.', 'bad'); return res.redirect('/p/settings'); }
    const s = Object.fromEntries(Object.keys(DEFAULT_PARK_SETTINGS).map((k) => [k, String(b[k] ?? '').trim().slice(0, 600)]));
    s.warnDays = String(Math.min(90, Math.max(0, toInt(s.warnDays) ?? 14)));
    s.eplMode = ['off', 'sandbox', 'on'].includes(s.eplMode) ? s.eplMode : 'off';
    // services are switched on their own form; paper waybills cannot use them
    s.svcMed = s.eplMode === 'off' ? '0' : req.pset.svcMed;
    s.svcMech = s.eplMode === 'off' ? '0' : req.pset.svcMech;
    db.prepare('UPDATE parks SET name = ?, city = ?, inn = ?, tz = ?, settings = ? WHERE id = ?')
      .run(name, String(b.city || '').trim().slice(0, 80), String(b.inn || '').replace(/\D/g, '').slice(0, 12), validTz(b.tz) ? b.tz : req.park.tz, JSON.stringify(s), req.park.id);
    audit(req, 'Изменил настройки');
    auth.flash(res, 'Настройки сохранены. Новые листы выпишутся с ними.');
    res.redirect('/p/settings');
  });
}
