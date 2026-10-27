import crypto from 'node:crypto';
import { nowIso, shortName, plural, fNum } from './util.js';
import { dayKey, addDays, ruDay, daysBetween } from './time.js';
import { parkSettings } from './db.js';

export class UserError extends Error {}

export const MAX_DAY_RUN = 3000;      // km per shift accepted without a typo check
export const MED_VALID_HOURS = 12;    // a medical check is valid for release this long
export const DAYS_AHEAD = 7;          // today + 6 days

export const STATUS = {
  planned: { label: 'Запланирован', tone: 'plan' },
  wait_med: { label: 'Ждёт медосмотра', tone: 'wait' },
  wait_tech: { label: 'Ждёт выпуска', tone: 'wait' },
  line: { label: 'На линии', tone: 'line' },
  returning: { label: 'Сдаёт смену', tone: 'wait' },
  closed: { label: 'Смена закрыта', tone: 'closed' },
  refused: { label: 'Не допущен', tone: 'bad' },
  expired: { label: 'Не использован', tone: 'closed' },
  cancelled: { label: 'Аннулирован', tone: 'closed' }
};

export function sheetStatus(s, tz, now = new Date()) {
  if (s.cancelled_at) return 'cancelled';
  if (s.med_status === 'refused' || s.tech_status === 'refused') return 'refused';
  if (s.closed_at) return 'closed';
  if (s.back_at) return 'returning';
  if (s.tech_status === 'ok') return 'line';
  if (s.med_status === 'ok') return now - new Date(s.med_at) > MED_VALID_HOURS * 3600e3 ? 'expired' : 'wait_tech';
  const today = dayKey(tz, now);
  if (s.shift_date > today) return 'planned';
  if (s.shift_date < today) return 'expired';
  return 'wait_med';
}
/** Statuses that still occupy the driver's and car's day. */
export const TAKES_DAY = (st) => !['cancelled', 'refused'].includes(st);
export const IS_ACTIVE = (st) => ['wait_med', 'wait_tech', 'line', 'returning'].includes(st);

const CAR_DOCS = [['osago_to', 'ОСАГО'], ['diag_to', 'Диагностическая карта'], ['permit_to', 'Разрешение такси']];

/** Expired documents block a waybill; documents ending soon only warn. */
export function docProblems({ driver, car, day, warnDays = 14 }) {
  const errors = [], warnings = [];
  const check = (to, label) => {
    if (!to) return;
    if (to < day) { errors.push(`${label}: срок истёк ${ruDay(to)}`); return; }
    const left = daysBetween(day, to);
    if (left < warnDays) warnings.push(`${label}: ${left === 0 ? 'последний день' : `осталось ${left} ${plural(left, 'день', 'дня', 'дней')}`} (до ${ruDay(to)})`);
  };
  if (driver) check(driver.lic_to, 'Водительское удостоверение');
  if (car) for (const [k, l] of CAR_DOCS) check(car[k], l);
  return { errors, warnings };
}

export function makeService(db, billing) {
  const q = {
    park: db.prepare('SELECT * FROM parks WHERE id = ?'),
    driver: db.prepare('SELECT * FROM drivers WHERE id = ? AND park_id = ?'),
    car: db.prepare('SELECT * FROM cars WHERE id = ? AND park_id = ?'),
    carrier: db.prepare('SELECT * FROM carriers WHERE id = ? AND park_id = ?'),
    sheet: db.prepare('SELECT * FROM sheets WHERE id = ? AND park_id = ?'),
    driverDay: db.prepare('SELECT * FROM sheets WHERE driver_id = ? AND shift_date = ?'),
    carDay: db.prepare('SELECT * FROM sheets WHERE car_id = ? AND shift_date = ? AND driver_id <> ?'),
    driverRecent: db.prepare('SELECT * FROM sheets WHERE driver_id = ? AND shift_date >= ? AND cancelled_at IS NULL AND closed_at IS NULL'),
    carRecent: db.prepare('SELECT * FROM sheets WHERE car_id = ? AND driver_id <> ? AND shift_date >= ? AND cancelled_at IS NULL AND closed_at IS NULL'),
    counter: db.prepare(`INSERT INTO day_counters (park_id, day, n) VALUES (?, ?, 1)
      ON CONFLICT(park_id, day) DO UPDATE SET n = n + 1 RETURNING n`),
    ins: db.prepare(`INSERT INTO sheets (park_id, no, token, shift_date, valid_to, driver_id, car_id, carrier_id, issued_at, issued_by, price, odo_out, snapshot, epl)
      VALUES (@park_id, @no, @token, @shift_date, @valid_to, @driver_id, @car_id, @carrier_id, @issued_at, @issued_by, @price, @odo_out, @snapshot, @epl)`),
    medic: db.prepare("SELECT * FROM users WHERE id = ? AND park_id = ? AND role = 'medic' AND active = 1"),
    audit: db.prepare('INSERT INTO audit (park_id, at, who, action, details) VALUES (?, ?, ?, ?, ?)'),
    carOdoUp: db.prepare('UPDATE cars SET odo = ? WHERE id = ? AND odo < ?')
  };

  const log = (parkId, who, action, details = '') => q.audit.run(parkId, nowIso(), who, action, details);
  const ctx = (parkId) => {
    const park = q.park.get(parkId);
    if (!park) throw new UserError('Таксопарк не найден.');
    return { park, tz: park.tz, today: dayKey(park.tz), set: parkSettings(park) };
  };
  function getSheet(parkId, id) {
    const s = q.sheet.get(id, parkId);
    if (!s) throw new UserError('Путевой лист не найден.');
    return s;
  }

  /** Everything that would stop a waybill for this driver on this day, without issuing it. */
  function precheck(parkId, driverId, day) {
    const { park, tz, today, set } = ctx(parkId);
    const d = q.driver.get(driverId, parkId);
    if (!d) throw new UserError('Водитель не найден.');
    if (park.status !== 'active') throw new UserError('Работа таксопарка приостановлена. Обратитесь к администратору сервиса.');
    if (billing.access(park).state === 'suspended') throw new UserError('Подписка таксопарка не продлена: на балансе не хватает денег. Новые листы выписываются после пополнения.');
    if (d.blocked) throw new UserError('Доступ к путевым листам закрыт диспетчером.');
    if (!day || day < today || day > addDays(today, DAYS_AHEAD - 1)) throw new UserError(`Лист можно выписать на сегодня и до ${DAYS_AHEAD - 1} дней вперёд.`);
    const carrier = d.carrier_id ? q.carrier.get(d.carrier_id, parkId) : null;
    if (!carrier || !carrier.active) throw new UserError('У водителя не указан перевозчик. Обратитесь к диспетчеру.');
    const car = d.car_id ? q.car.get(d.car_id, parkId) : null;
    if (!car) throw new UserError('За водителем не закреплена машина. Обратитесь к диспетчеру.');
    if (!car.active) throw new UserError('Закреплённая машина выведена из работы. Обратитесь к диспетчеру.');
    for (const s of q.driverDay.all(d.id, day)) {
      if (TAKES_DAY(sheetStatus(s, tz))) throw new UserError(`На ${ruDay(day)} уже есть лист № ${s.no}.`);
    }
    for (const s of q.carDay.all(car.id, day, d.id)) {
      if (TAKES_DAY(sheetStatus(s, tz))) throw new UserError(`Машина ${car.num} на ${ruDay(day)} уже по листу № ${s.no} у другого водителя.`);
    }
    if (day === today) {
      const prev = q.driverRecent.all(d.id, addDays(today, -3)).find((s) => s.shift_date < today && ['line', 'returning'].includes(sheetStatus(s, tz)));
      if (prev) throw new UserError(`Сначала сдайте смену по листу № ${prev.no}.`);
      const carPrev = q.carRecent.all(car.id, d.id, addDays(today, -3)).find((s) => ['line', 'returning'].includes(sheetStatus(s, tz)));
      if (carPrev) throw new UserError(`Машина ${car.num} ещё на линии по листу № ${carPrev.no}.`);
    }
    const docs = docProblems({ driver: d, car, day, warnDays: toWarn(set) });
    if (docs.errors.length) throw new UserError('Лист не выписан. ' + docs.errors.join('; ') + '.');
    return { park, tz, today, set, d, car, carrier };
  }
  const toWarn = (set) => Math.max(0, parseInt(set.warnDays, 10) || 14);

  const issue = db.transaction((parkId, driverId, day, { odo = null, by }) => {
    billing.renew(parkId);
    const { tz, today, set, d, car, carrier } = precheck(parkId, driverId, day);
    const park = q.park.get(parkId);
    if (odo !== null && odo !== undefined) {
      if (day !== today) odo = null;
      else checkOdoOut(odo, car);
    }
    const price = billing.sheetPrice(park);
    if (price > 0 && park.balance < price) throw new UserError('На балансе таксопарка недостаточно средств. Обратитесь к диспетчеру.');
    const n = q.counter.get(parkId, day).n;
    const no = `${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(2, 4)}_${String(n).padStart(3, '0')}`;
    const snapshot = {
      tz,
      blank: { route: set.route, okud: set.okud, licCard: set.licCard, techStamp: set.techStamp },
      carrier: { name: carrier.name, inn: carrier.inn, ogrn: carrier.ogrn, addr: carrier.addr, phone: carrier.phone, reestr: carrier.reestr },
      driver: { name: d.name, lic: d.lic, licFrom: d.lic_from, licTo: d.lic_to, cls: d.cls, snils: d.snils },
      car: { model: car.model, num: car.num, reg: car.reg, garage: car.garage, permit: car.permit, fuel: car.fuel, osago: car.osago }
    };
    const id = q.ins.run({
      park_id: parkId, no, token: crypto.randomBytes(12).toString('base64url'), shift_date: day, valid_to: addDays(day, 1),
      driver_id: d.id, car_id: car.id, carrier_id: carrier.id, issued_at: nowIso(), issued_by: by, price,
      odo_out: odo ?? null, snapshot: JSON.stringify(snapshot), epl: set.eplMode && set.eplMode !== 'off' ? 1 : 0
    }).lastInsertRowid;
    if (price > 0) billing.post(parkId, -price, 'sheet', `Путевой лист № ${no}, ${shortName(d.name)}`, by, id);
    log(parkId, by, 'Выписан лист', `№ ${no} на ${ruDay(day)}, ${shortName(d.name)}, ${car.num}`);
    return id;
  });

  /** Issues several days for one driver; each day succeeds or fails on its own. */
  function issueDays(parkId, driverId, days, by) {
    const ok = [], failed = [];
    for (const day of [...new Set(days)].sort()) {
      try { ok.push({ day, id: issue(parkId, driverId, day, { by }) }); }
      catch (e) { if (!(e instanceof UserError)) throw e; failed.push({ day, msg: e.message }); }
    }
    return { ok, failed };
  }

  function checkOdoOut(odo, car) {
    if (!Number.isInteger(odo) || odo < 0) throw new UserError('Введите показания одометра числом.');
    if (odo < car.odo) throw new UserError(`Одометр не может быть меньше ${fNum(car.odo)} км (последнее значение машины).`);
    if (odo - car.odo > MAX_DAY_RUN * 10) throw new UserError('Показания одометра сильно больше прошлых. Проверьте цифры.');
  }

  const setOdoOut = db.transaction((parkId, sheetId, odo, { driverId = null, by }) => {
    const { tz } = ctx(parkId);
    const s = getSheet(parkId, sheetId);
    if (driverId && s.driver_id !== driverId) throw new UserError('Это не ваш путевой лист.');
    const st = sheetStatus(s, tz);
    if (!['wait_med', 'wait_tech'].includes(st)) throw new UserError('Одометр при выезде вносится в день смены, до выпуска на линию.');
    checkOdoOut(odo, q.car.get(s.car_id, parkId));
    db.prepare('UPDATE sheets SET odo_out = ? WHERE id = ?').run(odo, s.id);
    log(parkId, by, 'Одометр при выезде', `№ ${s.no}: ${odo}`);
  });

  const markMed = db.transaction((parkId, sheetId, actor, { ok, note = '', medicId = null }) => {
    // the park's own staff, or a partner medic of the service working for this park
    if (!(actor.park_id === parkId || (actor.service && actor.role === 'medic')) || !['medic', 'owner', 'dispatcher'].includes(actor.role)) throw new UserError('Нет прав.');
    const { tz, set } = ctx(parkId);
    const s = getSheet(parkId, sheetId);
    const st = sheetStatus(s, tz);
    if (st === 'planned') throw new UserError(`Медосмотр отмечается в день смены (${ruDay(s.shift_date)}).`);
    if (st !== 'wait_med') throw new UserError('Медосмотр по этому листу уже отмечен или лист закрыт.');
    const medic = actor.role === 'medic' ? actor : q.medic.get(medicId, parkId);
    if (!medic) throw new UserError('Выберите медработника, который провёл осмотр.');
    if (!ok && !String(note).trim()) throw new UserError('Укажите причину недопуска.');
    db.prepare('UPDATE sheets SET med_status = ?, med_at = ?, med_by = ?, med_entered_by = ?, med_info = ?, med_note = ? WHERE id = ?')
      .run(ok ? 'ok' : 'refused', nowIso(), medic.name, actor.id === medic.id ? null : actor.name,
        JSON.stringify(actor.service ? { org: actor.svc_org, addr: '', lic: actor.svc_lic } : { org: set.medOrg, addr: set.medAddr, lic: set.medLic }), String(note).trim(), s.id);
    log(parkId, actor.name, ok ? 'Медосмотр: допущен' : 'Медосмотр: не допущен', `№ ${s.no}${actor.id !== medic.id ? `, медработник ${medic.name}` : ''}${note ? ', ' + note : ''}`);
  });

  const markTech = db.transaction((parkId, sheetId, actor, { ok, note = '', odo = null }) => {
    if (!(actor.park_id === parkId || (actor.service && actor.role === 'dispatcher')) || !['owner', 'dispatcher'].includes(actor.role)) throw new UserError('Нет прав.');
    const { tz } = ctx(parkId);
    const s = getSheet(parkId, sheetId);
    const st = sheetStatus(s, tz);
    if (st === 'wait_med' || st === 'planned') throw new UserError('Сначала нужен медосмотр.');
    if (st !== 'wait_tech') throw new UserError('Выпуск по этому листу уже отмечен или лист закрыт.');
    if (!ok && !String(note).trim()) throw new UserError('Укажите причину, по которой выпуск запрещён.');
    let odoOut = s.odo_out;
    if (ok) {
      if (odo !== null && odo !== undefined && odo !== odoOut) { checkOdoOut(odo, q.car.get(s.car_id, parkId)); odoOut = odo; }
      if (odoOut === null) throw new UserError('Укажите одометр при выезде.');
    }
    db.prepare('UPDATE sheets SET odo_out = ?, tech_status = ?, tech_at = ?, tech_by = ?, tech_note = ? WHERE id = ?')
      .run(odoOut, ok ? 'ok' : 'refused', nowIso(), shortName(actor.name), String(note).trim(), s.id);
    log(parkId, actor.name, ok ? 'Выпуск на линию' : 'Выпуск запрещён', `№ ${s.no}${note ? ', ' + note : ''}`);
  });

  const finish = db.transaction((parkId, sheetId, driverId, odo) => {
    const { tz } = ctx(parkId);
    const s = getSheet(parkId, sheetId);
    if (s.driver_id !== driverId) throw new UserError('Это не ваш путевой лист.');
    if (sheetStatus(s, tz) !== 'line') throw new UserError('Сдать можно только смену, которая на линии.');
    checkOdoBack(odo, s);
    db.prepare('UPDATE sheets SET back_at = ?, odo_back = ? WHERE id = ?').run(nowIso(), odo, s.id);
    q.carOdoUp.run(odo, s.car_id, odo);
    log(parkId, shortName(q.driver.get(driverId, parkId).name), 'Сдал смену', `№ ${s.no}, одометр ${odo}`);
  });

  function checkOdoBack(odo, s) {
    if (!Number.isInteger(odo)) throw new UserError('Введите показания одометра числом.');
    if (odo < s.odo_out) throw new UserError(`Одометр при возвращении не может быть меньше, чем при выезде (${fNum(s.odo_out)} км).`);
    if (odo - s.odo_out > MAX_DAY_RUN) throw new UserError(`Пробег за смену больше ${fNum(MAX_DAY_RUN)} км. Проверьте цифры.`);
  }

  /** Dispatcher takes the car back; works both after the driver handed in the shift and straight from the line. */
  const accept = db.transaction((parkId, sheetId, actor, odo) => {
    if (!(actor.park_id === parkId || (actor.service && actor.role === 'dispatcher')) || !['owner', 'dispatcher'].includes(actor.role)) throw new UserError('Нет прав.');
    const { tz } = ctx(parkId);
    const s = getSheet(parkId, sheetId);
    const st = sheetStatus(s, tz);
    if (!['line', 'returning'].includes(st)) throw new UserError('Принять можно только машину, которая на линии или сдаётся.');
    const value = odo ?? s.odo_back;
    checkOdoBack(value, s);
    db.prepare('UPDATE sheets SET back_at = COALESCE(back_at, ?), odo_back = ?, closed_at = ?, closed_by = ? WHERE id = ?')
      .run(nowIso(), value, nowIso(), shortName(actor.name), s.id);
    // If the car's mileage came from the driver's figure on this sheet, the dispatcher's correction replaces it.
    const car = q.car.get(s.car_id, parkId);
    const newOdo = s.odo_back !== null && car.odo === s.odo_back ? value : Math.max(car.odo, value);
    db.prepare('UPDATE cars SET odo = ? WHERE id = ? AND park_id = ?').run(newOdo, s.car_id, parkId);
    log(parkId, actor.name, 'Принял машину', `№ ${s.no}, одометр ${value}`);
  });

  /** Unused sheets (no medical check yet) are refunded. */
  const cancel = db.transaction((parkId, sheetId, { by, reason, driverId = null }) => {
    const { tz } = ctx(parkId);
    const s = getSheet(parkId, sheetId);
    const st = sheetStatus(s, tz);
    if (driverId) {
      if (s.driver_id !== driverId) throw new UserError('Это не ваш путевой лист.');
      if (!['planned', 'wait_med'].includes(st)) throw new UserError('Отменить можно только лист, по которому ещё не было медосмотра.');
    } else if (!['planned', 'wait_med', 'wait_tech', 'line', 'returning'].includes(st)) {
      throw new UserError('Аннулировать можно только действующий лист.');
    }
    reason = String(reason || '').trim();
    if (!reason) throw new UserError('Укажите причину.');
    db.prepare('UPDATE sheets SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?').run(nowIso(), by, reason, s.id);
    let refunded = 0;
    if (['planned', 'wait_med'].includes(st) && s.price > 0) {
      billing.post(parkId, s.price, 'refund', `Возврат за лист № ${s.no}`, by, s.id);
      refunded = s.price;
    }
    log(parkId, by, 'Аннулирован лист', `№ ${s.no}: ${reason}`);
    return refunded;
  });

  return { log, ctx, getSheet, precheck, issue, issueDays, setOdoOut, markMed, markTech, finish, accept, cancel, toWarn };
}
