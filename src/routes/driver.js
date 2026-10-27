import { toInt, plural } from '../util.js';
import { addDays, ruDay } from '../time.js';
import { parkSettings } from '../db.js';
import { sheetStatus, docProblems, IS_ACTIVE, DAYS_AHEAD } from '../service.js';
import * as C from '../views/common.js';
import * as D from '../views/driver.js';
import { notifyPage } from '../views/notify.js';
import { EVENTS } from '../push.js';

export default function driverRoutes(app, { db, auth, billing, svc, push, rev, fail, wrap, list, withQr }) {
  const q = {
    park: db.prepare('SELECT * FROM parks WHERE id = ?'),
    car: db.prepare('SELECT * FROM cars WHERE id = ? AND park_id = ?'),
    recent: db.prepare('SELECT * FROM sheets WHERE driver_id = ? AND shift_date >= ? ORDER BY shift_date, id'),
    history: db.prepare('SELECT * FROM sheets WHERE driver_id = ? AND shift_date <= ? ORDER BY shift_date DESC, id DESC LIMIT 40'),
    own: db.prepare('SELECT * FROM sheets WHERE id = ? AND driver_id = ?')
  };

  /** Loads the driver's park; a blocked driver only ever sees the lock screen. */
  function needDriver(req, res, next) {
    if (!req.driver) return res.redirect('/login');
    billing.renew(req.driver.park_id);
    const park = q.park.get(req.driver.park_id);
    req.park = park;
    req.tz = park.tz;
    req.pset = parkSettings(park);
    if (req.driver.blocked) {
      return res.status(403).type('html').send(C.driverPage({ title: 'Доступ закрыт', park, rev: rev(park.id),
        body: D.blockedBody({ driver: req.driver, reason: req.driver.block_reason ? 'причина: ' + req.driver.block_reason + '.' : '', phone: req.pset.dispPhone }) }));
    }
    next();
  }
  const page = (req, res, opts, code = 200) =>
    res.status(code).type('html').send(C.driverPage({ park: req.park, rev: rev(req.park.id), flash: req.flash, ...opts }));

  app.get('/d', needDriver, (req, res) => {
    const d = req.driver, tz = req.tz;
    const { today } = svc.ctx(req.park.id);
    const car = d.car_id ? q.car.get(d.car_id, d.park_id) : null;
    const recent = q.recent.all(d.id, addDays(today, -3));
    const active = recent.find((s) => IS_ACTIVE(sheetStatus(s, tz)));
    const todaySheets = recent.filter((s) => s.shift_date === today);
    const todaySheet = todaySheets[todaySheets.length - 1] || null;
    const week = recent.filter((s) => s.shift_date >= today && s.shift_date <= addDays(today, DAYS_AHEAD - 1) && !['cancelled', 'refused'].includes(sheetStatus(s, tz)));
    const docs = docProblems({ driver: d, car, day: today, warnDays: svc.toWarn(req.pset) });
    const suspended = billing.access(req.park).state === 'suspended';
    const canIssue = req.park.status === 'active' && !suspended;
    const alerts = canIssue ? docs : { ...docs, errors: [suspended ? 'Подписка таксопарка не продлена' : 'Работа таксопарка приостановлена', ...docs.errors] };
    page(req, res, { title: 'Мой путевой лист', body: D.driverHome({
      driver: d, car, park: { ...req.park, settings: req.pset }, tz, today, active, todaySheet, week,
      history: q.history.all(d.id, today).filter((s) => { const st = sheetStatus(s, tz); return !IS_ACTIVE(st) && st !== 'planned'; }).slice(0, 12),
      docs: alerts, canIssue
    }) });
  });

  app.post('/d/issue', needDriver, (req, res) => {
    const d = req.driver;
    const { today } = svc.ctx(d.park_id);
    const days = list(req.body.days).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
    if (!days.length) { auth.flash(res, 'Отметьте хотя бы один день.', 'bad'); return res.redirect('/d'); }
    try {
      const msgs = [];
      let okCount = 0;
      if (days.includes(today)) {
        svc.issue(d.park_id, d.id, today, { odo: toInt(req.body.odo), by: d.name });
        okCount++;
      }
      const rest = days.filter((x) => x !== today);
      if (rest.length) {
        const r = svc.issueDays(d.park_id, d.id, rest, d.name);
        okCount += r.ok.length;
        for (const f of r.failed) msgs.push(`${ruDay(f.day)}: ${f.msg}`);
      }
      if (msgs.length) auth.flash(res, `${okCount ? `Выписано ${okCount} ${plural(okCount, 'лист', 'листа', 'листов')}. ` : ''}Не выписано: ${msgs.join(' ')}`, okCount ? 'warn' : 'bad');
      else auth.flash(res, days.includes(today) && okCount === 1 ? 'Путевой лист выписан. Пройдите медосмотр.' : `Выписано ${okCount} ${plural(okCount, 'лист', 'листа', 'листов')}.`);
      res.redirect('/d');
    } catch (e) { fail(req, res, e, '/d'); }
  });

  app.post('/d/odo', needDriver, (req, res) => {
    try { svc.setOdoOut(req.driver.park_id, toInt(req.body.id), toInt(req.body.odo), { driverId: req.driver.id, by: req.driver.name }); auth.flash(res, 'Одометр сохранён.'); res.redirect('/d'); }
    catch (e) { fail(req, res, e, '/d'); }
  });
  app.post('/d/finish', needDriver, (req, res) => {
    try { svc.finish(req.driver.park_id, toInt(req.body.id), req.driver.id, toInt(req.body.odo)); auth.flash(res, 'Смена сдана. Диспетчер примет машину.'); res.redirect('/d'); }
    catch (e) { fail(req, res, e, '/d'); }
  });
  app.post('/d/cancel', needDriver, (req, res) => {
    try { svc.cancel(req.driver.park_id, toInt(req.body.id), { by: req.driver.name, reason: 'Отменён водителем', driverId: req.driver.id }); auth.flash(res, 'Лист отменён.'); res.redirect('/d'); }
    catch (e) { fail(req, res, e, '/d'); }
  });

  app.get('/d/notify', needDriver, (req, res) => page(req, res, { title: 'Уведомления', body: notifyPage({
    events: EVENTS.driver, off: push.offList(req.driver), devices: push.devices('driver', req.driver.id), enabled: push.enabled, action: '/d/notify' })
    + '<p class="center"><a class="linkbtn" href="/d">← К моему листу</a></p>' }));
  app.post('/d/notify', needDriver, (req, res) => {
    const on = list(req.body.on);
    db.prepare('UPDATE drivers SET push_off = ? WHERE id = ?').run(Object.keys(EVENTS.driver).filter((k) => !on.includes(k)).join(','), req.driver.id);
    auth.flash(res, 'Сохранено.');
    res.redirect('/d/notify');
  });

  app.get('/d/sheet/:id', needDriver, wrap(async (req, res) => {
    const s = q.own.get(toInt(req.params.id), req.driver.id);
    if (!s) return page(req, res, { title: 'Не найдено', body: C.errorBody(404, 'Такого листа нет.', '/d') }, 404);
    res.type('html').send(D.sheetDoc({ sheets: await withQr(req, [s]), back: '/d', title: `Путевой лист № ${s.no}` }));
  }));

  app.get('/d/print-week', needDriver, wrap(async (req, res) => {
    const { today } = svc.ctx(req.driver.park_id);
    const rows = q.recent.all(req.driver.id, today).filter((s) => s.shift_date <= addDays(today, DAYS_AHEAD - 1) && !['cancelled', 'refused'].includes(sheetStatus(s, req.tz)));
    res.type('html').send(D.sheetDoc({ sheets: await withQr(req, rows), back: '/d', title: 'Листы на неделю' }));
  }));
}
