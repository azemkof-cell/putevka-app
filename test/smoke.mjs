// End-to-end check of the whole platform against a fresh temporary database.
// Run: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.SUPER_PASSWORD = 'root-test-pass';
const { createApp } = await import('../src/server.js');
const { dayKey, addDays } = await import('../src/time.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'putevka-test-'));
const { app, db } = createApp({ dbFile: path.join(dir, 'test.db'), log: () => {} });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const today = dayKey('Europe/Moscow');

function client() {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const call = async (method, url, form, extra = {}) => {
    const headers = { ...extra };
    if (cookie()) headers.cookie = cookie();
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers.origin ??= base;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) for (const x of [].concat(v)) p.append(k, x);
      body = p.toString();
    }
    const r = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) {
      const kv = c.split(';')[0]; const i = kv.indexOf('=');
      if (/Max-Age=0/.test(c)) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return { status: r.status, loc: r.headers.get('location'), text: await r.text(), type: r.headers.get('content-type') };
  };
  return {
    cookie, get: (u) => call('GET', u), post: (u, f, h) => call('POST', u, f, h),
    async go(u, f) { const r = await call('POST', u, f); return r.loc ? { ...(await call('GET', r.loc)), from: r } : r; }
  };
}

let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };
const one = (sql, ...a) => db.prepare(sql).get(...a);
const balance = (id) => one('SELECT balance FROM parks WHERE id = ?', id).balance;
const pinOf = (html) => html.match(/class="mono sel pin">([^<]+)</)[1];

const root = client(), ownerA = client(), disp = client(), medic = client(), drv = client(), drv2 = client(), ownerB = client();
const signup = (c, o) => c.post('/signup', { park: 'Такси Восток', city: 'Москва', tz: 'Europe/Moscow', inn: '7700000000', name: 'Соколов Андрей Викторович', phone: '+7 900 000-00-00', email: 'a@example.ru', login: 'vostok', password: 'owner-pass-1', agree: '1', ...o });
let A, B, carA, carB2, dA, dA2;

try {
  await step('главная страница с тарифом и подключением', async () => {
    const r = await client().get('/');
    assert.equal(r.status, 200);
    assert.match(r.text, /Путевой лист приходит водителю в телефон/);
    assert.match(r.text, /19 ₽/);
    assert.match(r.text, /Без своего медика и механика/);
    assert.match(r.text, /Большой парк/);
    assert.match(r.text, /href="\/signup"/);
    assert.equal((await client().get('/manifest.webmanifest')).status, 200);
    assert.match((await client().get('/sw.js')).text, /keepOffline/);
    assert.match((await client().get('/offline')).text, /Нет интернета/);
  });

  await step('регистрация парка: проверки и создание кабинета', async () => {
    assert.match((await signup(client(), { agree: '' })).text, /согласие/);
    assert.match((await signup(client(), { login: 'я' })).text, /Логин/);
    assert.match((await signup(client(), { inn: '123' })).text, /ИНН/);
    const r = await signup(ownerA, {});
    assert.equal(r.loc, '/p');
    A = one("SELECT * FROM parks WHERE name = 'Такси Восток'");
    assert.equal(A.trial_until, addDays(today, 13));
    assert.equal(one('SELECT COUNT(*) AS n FROM carriers WHERE park_id = ?', A.id).n, 1);
    const p = await ownerA.get('/p');
    assert.match(p.text, /Подготовка парка/);
    assert.match(p.text, /Пробный период до/);
    assert.match((await signup(client(), {})).text, /логин уже занят/);
  });

  await step('администратор платформы: тарифы и свой тариф парку', async () => {
    assert.equal((await root.post('/login/staff', { login: 'root', password: 'root-test-pass' })).loc, '/s');
    assert.match((await root.get('/s')).text, /Такси Восток/);
    assert.match((await root.go('/s/tariffs', { name: 'Эконом', per_sheet: '15', monthly: '0', trial_days: '7' })).text, /Тариф создан/);
    const ek = one("SELECT * FROM tariffs WHERE name = 'Эконом'");
    assert.equal(ek.per_sheet, 1500);
    await root.post(`/s/tariffs/${ek.id}/default`, {});
    assert.equal(one('SELECT is_default FROM tariffs WHERE id = ?', ek.id).is_default, 1);
    assert.match((await root.go(`/s/parks/${A.id}/personal`, { per_sheet: '10,50', monthly: '0', note: 'скидка' })).text, /Свой тариф сохранён/);
    const t = one('SELECT t.* FROM parks p JOIN tariffs t ON t.id = p.tariff_id WHERE p.id = ?', A.id);
    assert.equal(t.personal, 1); assert.equal(t.per_sheet, 1050); assert.equal(t.monthly, 0);
    assert.equal((await ownerA.get('/s')).loc, '/p');
    assert.equal((await root.get('/p')).loc, '/s');
  });

  await step('владелец: сотрудники, медорганизация, машины', async () => {
    assert.match((await ownerA.go('/p/staff', { name: 'Смирнова Ольга Николаевна', role: 'dispatcher', login: 'disp', password: 'disp-pass-1' })).text, /Сотрудник добавлен/);
    assert.match((await ownerA.go('/p/staff', { name: 'Орлова Наталья Ивановна', role: 'medic', login: 'medic', password: 'medic-pass-1' })).text, /Сотрудник добавлен/);
    assert.equal((await disp.post('/login/staff', { login: 'disp', password: 'disp-pass-1' })).loc, '/p');
    assert.equal((await medic.post('/login/staff', { login: 'medic', password: 'medic-pass-1' })).loc, '/p');
    assert.equal((await disp.get('/p/staff')).status, 403);
    assert.equal((await medic.get('/p/drivers')).status, 403);
    assert.match((await ownerA.go('/p/settings', { name: 'Такси Восток', city: 'Москва', inn: '7700000000', tz: 'Europe/Moscow', medOrg: 'ООО «Медосмотр Тест»', medLic: 'Л041-1', medAddr: 'Москва', route: 'Городские', okud: '0345001', licCard: 'стандартная', dispPhone: '+7 900 111-11-11', warnDays: '14', techStamp: 'Фонарь установлен.' })).text, /Настройки сохранены/);
    assert.match((await disp.go('/p/cars', { model: 'Kia', num: 'Q123QQ', reg: '750', odo: '1' })).text, /Госномер в формате/);
    assert.match((await disp.go('/p/cars', { model: 'Belgee X50', num: 'x415km', reg: '797', odo: '128440', garage: '14008', permit: '021303-2', osago_to: addDays(today, 200), diag_to: addDays(today, 200), fuel: 'АИ-95' })).text, /Машина добавлена/);
    carA = one("SELECT * FROM cars WHERE num = 'Х415КМ'");
    assert.ok(carA);
    assert.match((await disp.go('/p/cars', { model: 'Kia K5', num: 'А702ОР', reg: '750', odo: '64912', diag_to: addDays(today, 2) })).text, /Машина добавлена/);
    carB2 = one("SELECT * FROM cars WHERE num = 'А702ОР'");
  });

  await step('водители: пароль, перевозчик, закрепление машины', async () => {
    const carrier = one('SELECT id FROM carriers WHERE park_id = ?', A.id).id;
    assert.match((await disp.go('/p/drivers', { name: 'Каримов Руслан', phone: '89000000001', lic: '1', carrier_id: '' })).text, /Выберите перевозчика/);
    const r = await disp.post('/p/drivers', { name: 'Каримов Руслан Ильдарович', phone: '8 (900) 000-00-01', lic: '99 31 482915', lic_from: '2024-02-13', lic_to: '2034-02-13', snils: '000-000-001 01', carrier_id: String(carrier), car_id: String(carA.id), pin: '' });
    const pin = pinOf(r.text);
    assert.match(pin, /^\d{6}$/);
    dA = one("SELECT * FROM drivers WHERE phone = '79000000001'");
    dA.pin = pin;
    await disp.post('/p/drivers', { name: 'Ершов Денис Андреевич', phone: '+79000000002', lic: '99 22 118340', carrier_id: String(carrier), car_id: String(carB2.id), pin: '2222' });
    dA2 = one("SELECT * FROM drivers WHERE phone = '79000000002'");
    assert.match((await disp.go('/p/drivers', { name: 'Ершов Денис', phone: '89000000002', lic: '1', carrier_id: String(carrier) })).text, /уже есть/);
  });

  await step('водитель входит и видит предупреждение о документах', async () => {
    assert.equal((await drv.post('/login/driver', { phone: '+7 900 000-00-01', pin: 'wrong' })).status, 401);
    assert.equal((await drv.post('/login/driver', { phone: '89000000001', pin: dA.pin })).loc, '/d');
    const h = await drv.get('/d');
    assert.match(h.text, /Получить путевой лист/);
    assert.match(h.text, /Неделя/);
    assert.equal((await drv2.post('/login/driver', { phone: '9000000002', pin: '2222' })).loc, '/d');
    assert.match((await drv2.get('/d')).text, /Диагностическая карта: осталось 2 дня/);
  });

  await step('лист на сегодня: одометр, номер, бесплатно в пробный период', async () => {
    assert.match((await drv.go('/d/issue', { days: today, odo: '128000' })).text, /не может быть меньше 128/);
    const r = await drv.go('/d/issue', { days: today, odo: '128 450' });
    assert.match(r.text, /Путевой лист выписан/);
    const s = one('SELECT * FROM sheets WHERE driver_id = ? AND shift_date = ?', dA.id, today);
    assert.match(s.no, /^\d{6}_001$/);
    assert.equal(s.price, 0);
    assert.equal(s.odo_out, 128450);
    assert.match((await drv.go('/d/issue', { days: today, odo: '128450' })).text, /уже есть лист/);
  });

  await step('неделя вперёд: несколько дней сразу, лимит 7 дней', async () => {
    const days = [1, 2, 3].map((n) => addDays(today, n));
    const r = await drv.go('/d/issue', { days });
    assert.match(r.text, /Выписано 3 листа/);
    assert.equal(one('SELECT COUNT(*) AS n FROM sheets WHERE driver_id = ? AND shift_date > ?', dA.id, today).n, 3);
    assert.match((await drv.go('/d/issue', { days: addDays(today, 7) })).text, /до 6 дней вперёд/);
    const tomorrow = one('SELECT * FROM sheets WHERE driver_id = ? AND shift_date = ?', dA.id, days[0]);
    assert.equal(tomorrow.odo_out, null);
    assert.match(tomorrow.no, /_001$/);
  });

  await step('штампы только в день смены; медработник не выпускает', async () => {
    const tomorrow = one('SELECT * FROM sheets WHERE driver_id = ? AND shift_date = ?', dA.id, addDays(today, 1));
    assert.match((await medic.go(`/p/sheet/${tomorrow.id}/med`, { ok: '1' })).text, /в день смены/);
    const s = one('SELECT * FROM sheets WHERE driver_id = ? AND shift_date = ?', dA.id, today);
    assert.match((await disp.go(`/p/sheet/${s.id}/tech`, { ok: '1', odo: '128450' })).text, /Сначала нужен медосмотр/);
    assert.equal((await medic.post(`/p/sheet/${s.id}/tech`, { ok: '1' })).status, 403);
  });

  await step('диспетчер ставит медосмотр за медработника и выпускает', async () => {
    const s = one('SELECT * FROM sheets WHERE driver_id = ? AND shift_date = ?', dA.id, today);
    const medicU = one("SELECT id FROM users WHERE login = 'medic'");
    assert.match((await disp.go(`/p/sheet/${s.id}/med`, { ok: '1' })).text, /Выберите медработника/);
    assert.match((await disp.go(`/p/sheet/${s.id}/med`, { ok: '1', medic: String(medicU.id) })).text, /Медосмотр отмечен/);
    const after = one('SELECT * FROM sheets WHERE id = ?', s.id);
    assert.equal(after.med_by, 'Орлова Наталья Ивановна');
    assert.equal(after.med_entered_by, 'Смирнова Ольга Николаевна');
    assert.match((await disp.go(`/p/sheet/${s.id}/tech`, { ok: '1', odo: '128455' })).text, /выпущен на линию/);
    assert.equal(one('SELECT odo_out FROM sheets WHERE id = ?', s.id).odo_out, 128455);
    const sheet = (await drv.get(`/d/sheet/${s.id}`)).text;
    assert.match(sheet, /Прошёл предрейсовый медицинский осмотр/);
    assert.match(sheet, /Орлова Наталья Ивановна/);
    assert.match(sheet, /штамп медорганизации, подпись медработника/, 'на бумаге — место под настоящий штамп');
    assert.match(sheet, /Отмечено в «Путёвке»: медосмотр/);
    assert.doesNotMatch(sheet, /ink-stamp/, 'никаких нарисованных штампов');
    assert.match(sheet, /<svg[^>]+viewBox/);
    assert.match(sheet, /СНИЛС 000-000-001 01/);
    assert.match((await drv.get('/d')).text, /Сдать смену/);
  });

  await step('QR-проверка: лист действителен, подделка не найдена', async () => {
    const s = one('SELECT * FROM sheets WHERE driver_id = ? AND shift_date = ?', dA.id, today);
    const c = await client().get(`/c/${s.token}`);
    assert.match(c.text, /Лист действителен/);
    assert.match(c.text, /Каримов Р\. И\./);
    assert.doesNotMatch(c.text, /000-000-001/);
    assert.equal((await client().get('/c/forged-token')).status, 404);
  });

  await step('сдача смены и приёмка машины', async () => {
    const s = one('SELECT * FROM sheets WHERE driver_id = ? AND shift_date = ?', dA.id, today);
    assert.match((await drv.go('/d/finish', { id: s.id, odo: '128400' })).text, /не может быть меньше/);
    assert.match((await drv.go('/d/finish', { id: s.id, odo: '128 700' })).text, /Смена сдана/);
    assert.match((await disp.go(`/p/sheet/${s.id}/accept`, { odo: '128690' })).text, /смена закрыта/);
    assert.equal(one('SELECT odo FROM cars WHERE id = ?', carA.id).odo, 128690);
    assert.match((await client().get(`/c/${s.token}`)).text, /Смена закрыта/);
  });

  await step('после пробного периода списывается цена своего тарифа', async () => {
    await root.post(`/s/parks/${A.id}/trial`, { trial_until: '' });
    assert.match((await drv2.go('/d/issue', { days: today, odo: '64912' })).text, /недостаточно средств/);
    assert.match((await root.go(`/s/parks/${A.id}/money`, { amount: '100', comment: 'Счёт № 1' })).text, /Зачислено 100 ₽/);
    assert.equal(one("SELECT COUNT(*) AS n FROM payments WHERE park_id = ? AND method = 'manual' AND status = 'succeeded'", A.id).n, 1);
    assert.match((await drv2.go('/d/issue', { days: today, odo: '64912' })).text, /Путевой лист выписан/);
    assert.equal(balance(A.id), 10000 - 1050);
  });

  await step('отмена листа до медосмотра возвращает деньги', async () => {
    const r = await drv2.go('/d/issue', { days: addDays(today, 1) });
    assert.match(r.text, /Выписано 1 лист/);
    const s = one('SELECT * FROM sheets WHERE driver_id = ? AND shift_date = ?', dA2.id, addDays(today, 1));
    const before = balance(A.id);
    assert.match((await drv2.go('/d/cancel', { id: s.id })).text, /Лист отменён/);
    assert.equal(balance(A.id), before + 1050);
    const own = one('SELECT * FROM sheets WHERE driver_id = ? AND shift_date = ?', dA.id, addDays(today, 2));
    assert.match((await drv2.go('/d/cancel', { id: own.id })).text, /не ваш/);
  });

  await step('истёкший документ блокирует лист на дату после срока', async () => {
    // diag card of car 2 ends in 2 days → issuing on day+3 fails, on day+2 works
    const r = await disp.go('/p/issue', { driver: String(dA2.id), days: [addDays(today, 2), addDays(today, 3)] });
    assert.match(r.text, /Выписано 1/);
    assert.match(r.text, /Диагностическая карта: срок истёк/);
  });

  await step('кнопка «всем на неделю» и неделя в кабинете', async () => {
    await root.post(`/s/parks/${A.id}/money`, { amount: '1000' });
    const r = await disp.go('/p/issue-week', {});
    assert.match(r.text, /Выписано \d+/);
    const w = await disp.get('/p/week');
    assert.match(w.text, /Неделя/);
    assert.match(w.text, /class="cell c-plan"/);
  });

  await step('печать пачкой: все листы на неделю с QR', async () => {
    const r = await disp.get(`/p/print?from=${today}&to=${addDays(today, 6)}`);
    const n = (r.text.match(/<article class="paper/g) || []).length;
    assert.ok(n >= 5, `листов в печати: ${n}`);
    assert.equal((r.text.match(/class="qr"/g) || []).length, n);
    assert.match((await drv.get('/d/print-week')).text, /<article class="paper/);
  });

  await step('блокировка водителя закрывает кабинет и листы', async () => {
    const s = one('SELECT * FROM sheets WHERE driver_id = ? ORDER BY id LIMIT 1', dA.id);
    assert.match((await disp.go(`/p/drivers/${dA.id}/block`, { reason: 'долг по аренде' })).text, /заблокирован/);
    const h = await drv.get('/d');
    assert.equal(h.status, 403);
    assert.match(h.text, /долг по аренде/);
    assert.equal((await drv.get(`/d/sheet/${s.id}`)).status, 403);
    assert.equal((await drv.post('/d/issue', { days: addDays(today, 4) })).status, 403);
    assert.match((await disp.go(`/p/drivers/${dA.id}/unblock`, {})).text, /снова может/);
    assert.equal((await drv.get('/d')).status, 200);
  });

  await step('второй парк не видит чужих данных', async () => {
    assert.equal((await signup(ownerB, { park: 'Такси Запад', login: 'zapad', inn: '' })).loc, '/p');
    B = one("SELECT * FROM parks WHERE name = 'Такси Запад'");
    const sA = one('SELECT * FROM sheets WHERE park_id = ? LIMIT 1', A.id);
    assert.equal((await ownerB.get(`/p/sheet/${sA.id}`)).status, 404);
    assert.equal((await ownerB.get(`/p/drivers/${dA.id}`)).status, 404);
    assert.equal((await ownerB.get(`/p/cars/${carA.id}`)).status, 404);
    assert.match((await ownerB.go(`/p/sheet/${sA.id}/cancel`, { reason: 'x' })).text, /не найден/);
    assert.doesNotMatch((await ownerB.get('/p/drivers')).text, /Каримов/);
    assert.doesNotMatch((await ownerB.get('/p/journal')).text, new RegExp(sA.no));
    assert.equal(one('SELECT cancelled_at FROM sheets WHERE id = ?', sA.id).cancelled_at, null);
    // the same car number can exist in another park
    assert.match((await ownerB.go('/p/cars', { model: 'Belgee X50', num: 'Х415КМ', reg: '797', odo: '1' })).text, /Машина добавлена/);
  });

  await step('один телефон в двух парках: водитель выбирает парк', async () => {
    const carrierB = one('SELECT id FROM carriers WHERE park_id = ?', B.id).id;
    await ownerB.post('/p/drivers', { name: 'Каримов Руслан Ильдарович', phone: '+79000000001', lic: '99 31 482915', carrier_id: String(carrierB), pin: dA.pin });
    const c = client();
    const r = await c.post('/login/driver', { phone: '79000000001', pin: dA.pin });
    assert.match(r.text, /Выберите таксопарк/);
    const ticket = r.text.match(/name="ticket" value="([^"]+)"/)[1];
    const dB = one('SELECT id FROM drivers WHERE park_id = ? AND phone = ?', B.id, '79000000001').id;
    assert.equal((await c.post('/login/driver/pick', { ticket, driver: String(dB) })).loc, '/d');
    assert.match((await c.get('/d')).text, /Такси Запад/);
  });

  await step('блокировка парка платформой', async () => {
    assert.match((await root.go(`/s/parks/${A.id}/block`, { reason: 'не оплачен счёт' })).text, /заблокирован/);
    assert.match((await drv.go('/d/issue', { days: addDays(today, 5) })).text, /приостановлена/);
    assert.match((await disp.get('/p')).text, /Работа парка приостановлена/);
    await root.post(`/s/parks/${A.id}/unblock`, {});
  });

  let cardPay;
  await step('нет денег на месяц: подписка не продлевается, функции закрыты', async () => {
    db.prepare('UPDATE parks SET balance = 50000 WHERE id = ?').run(A.id);
    assert.match((await root.go(`/s/parks/${A.id}/personal`, { per_sheet: '10,50', monthly: '1000', note: 'скидка' })).text, /Свой тариф сохранён/);
    assert.equal(balance(A.id), 50000, 'ничего не списано');
    assert.match((await disp.get('/p')).text, /Подписка не продлена/);
    assert.match((await disp.go('/p/issue', { driver: String(dA.id), days: addDays(today, 6) })).text, /Подписка не продлена/);
    assert.match((await disp.go('/p/drivers', { name: 'Новый Водитель', phone: '79000000077', lic: '1', carrier_id: '1' })).text, /Подписка не продлена/);
    assert.equal(one("SELECT COUNT(*) AS n FROM drivers WHERE phone = '79000000077'").n, 0);
    assert.match((await drv.go('/d/issue', { days: addDays(today, 6) })).text, /Подписка таксопарка не продлена/);
    // already issued sheets keep working so nobody is stuck on the road
    const s = one('SELECT * FROM sheets WHERE driver_id = ? AND shift_date = ?', dA2.id, today);
    assert.match((await medic.go(`/p/sheet/${s.id}/med`, { ok: '1' })).text, /Медосмотр отмечен/);
  });

  await step('оплата картой (тестовый режим) продлевает подписку сразу', async () => {
    assert.match((await ownerA.go('/p/billing/pay', { amount: 'other', amount_other: '50', method: 'card' })).text, /Минимальная сумма/);
    const r = await ownerA.post('/p/billing/pay', { amount: 'other', amount_other: '1 500', method: 'card' });
    assert.match(r.loc, /^\/pay\/demo\/\d+$/);
    cardPay = Number(r.loc.split('/').pop());
    assert.equal((await disp.get(r.loc)).loc, '/p/billing', 'чужая роль не видит оплату');
    assert.match((await ownerA.get(r.loc)).text, /Тестовая оплата/);
    const done = await ownerA.post(r.loc, { result: 'ok' });
    assert.equal(done.loc, `/p/billing/return/${cardPay}`);
    const ret = await ownerA.get(done.loc);
    assert.equal(ret.loc, '/p/billing');
    assert.match((await ownerA.get('/p/billing')).text, /Оплата прошла: 1\s500 ₽/);
    assert.equal(balance(A.id), 50000 + 150000 - 100000, 'оплата минус месяц подписки');
    const park = one('SELECT * FROM parks WHERE id = ?', A.id);
    assert.ok(park.paid_until > today, 'оплачено вперёд');
    const busy = one('SELECT id FROM sheets WHERE driver_id = ? AND shift_date = ? AND cancelled_at IS NULL', dA.id, addDays(today, 6));
    assert.match((await disp.go(`/p/sheet/${busy.id}/cancel`, { reason: 'перепланировали' })).text, /аннулирован/);
    const iss = await disp.go('/p/issue', { driver: String(dA.id), days: addDays(today, 6) });
    assert.match(iss.text, /Выписано 1/, (iss.text.match(/class="flash[^>]*>([^<]*)/) || [])[1]);
  });

  await step('повторное подтверждение не зачисляет деньги второй раз', async () => {
    const before = balance(A.id);
    await ownerA.post(`/pay/demo/${cardPay}`, { result: 'ok' });
    assert.equal(balance(A.id), before);
    assert.equal(one("SELECT COUNT(*) AS n FROM ledger WHERE park_id = ? AND kind = 'topup' AND comment LIKE 'Банковская карта%'", A.id).n, 1);
  });

  await step('СБП с QR-кодом и отказ от оплаты', async () => {
    const before = balance(A.id);
    const r = await ownerA.post('/p/billing/pay', { amount: '3000', method: 'sbp' });
    const page = await ownerA.get(r.loc);
    assert.match(page.text, /<svg[^>]+viewBox/);
    const back = await ownerA.post(r.loc, { result: 'fail' });
    await ownerA.get(back.loc);
    assert.match((await ownerA.get('/p/billing')).text, /Оплата не прошла/);
    assert.equal(balance(A.id), before);
  });

  await step('подписка продлевается сама, пока хватает денег', async () => {
    db.prepare('UPDATE parks SET paid_until = ? WHERE id = ?').run(addDays(today, -1), A.id);
    const before = balance(A.id);
    await disp.get('/p');
    await disp.get('/p');
    assert.equal(balance(A.id), before - 100000);
    assert.ok(one('SELECT paid_until FROM parks WHERE id = ?', A.id).paid_until > today);
    db.prepare('UPDATE parks SET paid_until = ? WHERE id = ?').run(addDays(today, -1), A.id);
    assert.match((await disp.get('/p')).text, /Подписка не продлена/);
  });

  let invId;
  await step('счёт для юрлица: номер, сумма прописью, QR для банка', async () => {
    const r = await ownerA.post('/p/billing/invoice', { amount: 'other', amount_other: '3000', p_name: 'ООО «Такси Восток»', p_inn: '7700000000', p_kpp: '770001001', p_addr: 'Москва' });
    assert.match(r.loc, /^\/p\/billing\/invoice\/\d+$/);
    invId = Number(r.loc.split('/').pop());
    let inv = await ownerA.get(r.loc);
    assert.match(inv.text, /Счёт на оплату № \d{2}-0001/);
    assert.match(inv.text, /Три тысячи рублей 00 копеек/);
    assert.match(inv.text, /Реквизиты получателя не заполнены/);
    await root.post('/s/platform', { signupOpen: '1', reqName: 'ООО «Путёвка»', reqInn: '7700000001', reqKpp: '770001001', reqAccount: '40702810900000000001', reqBank: 'АО «Банк»', reqBic: '044525000', reqCorr: '30101810400000000225', reqVat: 'none' });
    inv = await ownerA.get(r.loc);
    assert.match(inv.text, /class="qr big"><svg/);
    assert.match(inv.text, /Без НДС/);
    assert.equal((await ownerB.get(r.loc)).loc, '/p/billing', 'чужой парк не видит счёт');
    assert.match((await root.get(`/s/invoice/${invId}`)).text, /Счёт на оплату/);
  });

  await step('выписка из банка: платёж по счёту зачисляется сам и не задваивается', async () => {
    const no = one('SELECT invoice_no FROM payments WHERE id = ?', invId).invoice_no;
    const stmt = ['1CClientBankExchange', 'ВерсияФормата=1.03', 'Кодировка=Windows',
      'СекцияДокумент=Платежное поручение', 'Номер=512', 'Дата=27.10.2026', 'Сумма=3000.00', 'ПлательщикИНН=7700000000', 'Плательщик=ООО «Такси Восток»',
      'ПолучательСчет=40702810900000000001', `НазначениеПлатежа=Оплата по счету №${no} от 26.10.2026 за сервис Путёвка. Без НДС`, 'КонецДокумента',
      'СекцияДокумент=Платежное поручение', 'Номер=77', 'Дата=27.10.2026', 'Сумма=2000.00', 'ПлательщикИНН=500000000099', 'Плательщик=ИП Неизвестный',
      'ПолучательСчет=40702810900000000001', 'НазначениеПлатежа=Пополнение баланса', 'КонецДокумента',
      'СекцияДокумент=Платежное поручение', 'Номер=78', 'Дата=27.10.2026', 'Сумма=900.00', 'ПлательщикИНН=1', 'Плательщик=Кто-то',
      'ПолучательСчет=40702810000000000999', 'НазначениеПлатежа=не нам', 'КонецДокумента', 'КонецФайла'].join('\r\n');
    const before = balance(A.id);
    const r = await root.post('/s/statement', { text: stmt });
    assert.match(r.text, /Зачислено по счетам: 1/);
    assert.match(r.text, /Без счёта: 1/);
    assert.match(r.text, /На другой счёт: 1/);
    assert.equal(one('SELECT status FROM payments WHERE id = ?', invId).status, 'succeeded');
    assert.equal(balance(A.id), before + 300000 - 100000, 'зачислено и сразу продлена подписка');
    assert.doesNotMatch((await disp.get('/p')).text, /Подписка не продлена/);
    const again = await root.post('/s/statement', { text: stmt });
    assert.match(again.text, /Уже были загружены: 2/);
    assert.equal(balance(A.id), before + 200000);
    const doc = one("SELECT * FROM bank_docs WHERE status = 'unmatched'");
    const bBefore = balance(B.id);
    assert.match((await root.go(`/s/statement/${doc.id}/assign`, { park_id: String(B.id) })).text, /Платёж зачислен/);
    assert.equal(balance(B.id), bBefore + 200000);
  });

  await step('администратор отмечает счёт оплаченным вручную', async () => {
    const r = await ownerA.post('/p/billing/invoice', { amount: '5000', p_name: 'ООО «Такси Восток»' });
    const id = Number(r.loc.split('/').pop());
    const before = balance(A.id);
    assert.match((await root.get('/s/payments')).text, /Ожидает/);
    const paid = await root.go(`/s/payments/${id}/paid`, { amount: '4 999,50' });
    assert.match(paid.text, /Зачислено 4\s999,50 ₽/, `status ${paid.status} loc ${paid.from?.loc} id ${id} ${r.loc}`);
    assert.equal(balance(A.id), before + 499950);
    assert.equal(one('SELECT paid_amount FROM payments WHERE id = ?', id).paid_amount, 499950);
  });

  await step('неиспользованный вчерашний лист становится «Не использован»', async () => {
    const s = one('SELECT * FROM sheets WHERE driver_id = ? AND shift_date = ?', dA.id, addDays(today, 1));
    db.prepare('UPDATE sheets SET shift_date = ? WHERE id = ?').run(addDays(today, -1), s.id);
    const j = await disp.get(`/p/journal?from=${addDays(today, -1)}&to=${addDays(today, -1)}`);
    assert.match(j.text, /Не использован/);
    assert.match((await medic.go(`/p/sheet/${s.id}/med`, { ok: '1' })).text, /уже отмечен или лист закрыт/);
  });

  await step('журнал и выгрузка в Excel', async () => {
    const csv = await ownerA.get(`/p/journal.csv?from=${addDays(today, -7)}&to=${addDays(today, 7)}`);
    assert.match(csv.type, /text\/csv/);
    assert.match(csv.text, /№;Дата смены;Перевозчик;Водитель/);
    assert.match(csv.text, /Каримов Руслан Ильдарович/);
  });

  await step('баланс у владельца и платежи у платформы', async () => {
    const b = await ownerA.get('/p/billing');
    assert.match(b.text, /Подписка с/);
    assert.match(b.text, /Счёт № \d{2}-0001/);
    assert.match(b.text, /Возврат за лист/);
    assert.equal((await disp.get('/p/billing')).status, 403);
    assert.match((await root.get('/s/payments?f=all')).text, /Счёт № 1/);
  });

  await step('защита: чужой сайт, перебор пароля, гости', async () => {
    assert.equal((await disp.post(`/p/drivers/${dA2.id}/block`, {}, { origin: 'https://evil.example' })).status, 403);
    assert.equal(one('SELECT blocked FROM drivers WHERE id = ?', dA2.id).blocked, 0);
    const bad = client();
    for (let i = 0; i < 8; i++) await bad.post('/login/driver', { phone: '79000000555', pin: 'zz' });
    assert.equal((await bad.post('/login/driver', { phone: '79000000555', pin: 'zz' })).status, 429);
    assert.equal((await client().get('/p')).loc, '/login?staff=1');
    assert.equal((await client().get('/s')).loc, '/login?staff=1');
    assert.equal((await client().get('/d')).loc, '/login');
    assert.equal((await ownerA.get('/nope')).status, 404);
  });

  await step('смена пароля водителя выкидывает его из приложения', async () => {
    const r = await disp.post(`/p/drivers/${dA2.id}/pin`, { pin: '' });
    const pin = pinOf(r.text);
    assert.equal((await drv2.get('/d')).loc, '/login');
    assert.equal((await client().post('/login/driver', { phone: '79000000002', pin })).loc, '/d');
  });

  console.log(`\nВсё в порядке. Проверок пройдено: ${passed}.`);
} catch (e) {
  console.error('\n✗ Провал после', passed, 'проверок:\n', e);
  process.exitCode = 1;
} finally {
  server.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
