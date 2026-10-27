// Owner's reports: sheets, mileage, refusals and spending by day and by driver; Excel export; who may see them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.SUPER_PASSWORD = 'root-test-pass';
const { createApp } = await import('../src/server.js');
const { dayKey, addDays } = await import('../src/time.js');
const { parkReport, reportPeriod } = await import('../src/reports.js');
const { parseDate } = await import('../src/util.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'putevka-rep-'));
const { app, db, svc, billing } = createApp({ dbFile: path.join(dir, 't.db'), log: () => {} });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const today = dayKey('Europe/Moscow');

function client() {
  const jar = {};
  const call = async (method, url, form) => {
    const headers = {};
    const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck) headers.cookie = ck;
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers.origin = base; body = new URLSearchParams(form).toString(); }
    const r = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); if (/Max-Age=0/.test(c)) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: r.status, loc: r.headers.get('location'), text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer()), type: r.headers.get('content-type'), disp: r.headers.get('content-disposition') };
  };
  return { get: (u) => call('GET', u), post: (u, f) => call('POST', u, f) };
}
const one = (sql, ...a) => db.prepare(sql).get(...a);
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

const owner = client(), disp = client(), ownerB = client();
let A, medic, d1, d2;
try {
  await step('подготовка: парк без пробного периода, 19 ₽ за лист, смены с отказами и возвратом', async () => {
    await owner.post('/signup', { park: 'Такси Отчёт', city: 'Москва', tz: 'Europe/Moscow', name: 'Петров Пётр Петрович', phone: '89000000000', email: 'r@example.ru', login: 'rowner', password: 'owner-pass-1', agree: '1' });
    await owner.post('/p/staff', { name: 'Смирнова Ольга Николаевна', role: 'dispatcher', login: 'rdisp', password: 'disp-pass-1' });
    await owner.post('/p/staff', { name: 'Орлова Наталья Ивановна', role: 'medic', login: 'rmedic', password: 'medic-pass-1' });
    await disp.post('/login/staff', { login: 'rdisp', password: 'disp-pass-1' });
    db.prepare("UPDATE parks SET trial_until = '', balance = 1000000 WHERE id = 1").run();
    A = one('SELECT * FROM parks WHERE id = 1');
    medic = one("SELECT * FROM users WHERE login = 'rmedic'");
    const dispU = one("SELECT * FROM users WHERE login = 'rdisp'");
    db.prepare("INSERT INTO cars (park_id, model, num, reg, odo) VALUES (1, 'Kia K5', 'А702ОР', '750', 1000), (1, 'Kia Rio', 'В101ВВ', '750', 5000)").run();
    const ins = db.prepare("INSERT INTO drivers (park_id, carrier_id, car_id, name, phone, pin_hash, lic) VALUES (1, 1, ?, ?, ?, 'x', '1')");
    d1 = ins.run(1, 'Ершов Денис Андреевич', '79000000002').lastInsertRowid;
    d2 = ins.run(2, 'Гусев Артём Олегович', '79000000005').lastInsertRowid;
    // Ершов: closed shift today, 250 km; a sheet for tomorrow
    const a = svc.issue(1, d1, today, { odo: 1000, by: 'Ершов' });
    svc.markMed(1, a, medic, { ok: true });
    svc.markTech(1, a, dispU, { ok: true });
    svc.finish(1, a, d1, 1250);
    svc.accept(1, a, dispU, null);
    svc.issue(1, d1, addDays(today, 1), { by: 'Ершов' });
    // Гусев: refused at the medical check today; a sheet for tomorrow cancelled with refund
    const b = svc.issue(1, d2, today, { odo: 5000, by: 'Гусев' });
    svc.markMed(1, b, medic, { ok: false, note: 'давление' });
    const c = svc.issue(1, d2, addDays(today, 1), { by: 'Гусев' });
    svc.cancel(1, c, { by: 'Смирнова', reason: 'выходной' });
    // a service medic signature charged for Ершов's sheet
    billing.post(1, -4900, 'service', 'Медосмотр сервиса', 'Медведева', a);
  });

  await step('итоги за период: листы, пробег, отказы, деньги в копейках', async () => {
    const r = parkReport(db, A, { from: today, to: addDays(today, 1) });
    assert.equal(r.total.sheets, 3, 'аннулированный лист не считается');
    assert.equal(r.total.cancelled, 1);
    assert.equal(r.total.km, 250);
    assert.equal(r.total.closed, 1);
    assert.equal(r.total.medRefused, 1);
    assert.equal(r.total.techRefused, 0);
    assert.equal(r.total.sheetsCost, 4 * 1900 - 1900, 'четыре листа минус возврат');
    assert.equal(r.total.services, 4900);
    assert.equal(r.total.spent, 3 * 1900 + 4900);
    assert.equal(r.days.length, 2);
    assert.equal(r.days[0].sheets, 2);
    assert.equal(r.days[1].sheets, 1);
  });

  await step('по водителям: деньги и смены у своего водителя', async () => {
    const r = parkReport(db, A, { from: today, to: addDays(today, 1) });
    const e = r.drivers.find((x) => x.name === 'Ершов Денис Андреевич');
    const g = r.drivers.find((x) => x.name === 'Гусев Артём Олегович');
    assert.deepEqual([e.sheets, e.km, e.closed, e.sheetsCost, e.services, e.spent], [2, 250, 1, 3800, 4900, 8700]);
    assert.deepEqual([g.sheets, g.medRefused, g.cancelled, g.sheetsCost, g.spent], [1, 1, 1, 1900, 1900]);
  });

  await step('подписка и границы дня по времени парка', async () => {
    // charged at 22:30 UTC yesterday = 01:30 today in Moscow: belongs to today, not to yesterday
    const at = new Date(`${today}T01:30:00+03:00`).toISOString();
    db.prepare("INSERT INTO ledger (park_id, at, amount, kind, comment) VALUES (1, ?, -99000, 'monthly', 'Подписка')").run(at);
    db.prepare("INSERT INTO ledger (park_id, at, amount, kind, comment) VALUES (1, ?, 500000, 'topup', 'Пополнение')").run(at);
    const r = parkReport(db, A, { from: today, to: today });
    assert.equal(r.total.subscription, 99000);
    assert.equal(r.days[0].subscription, 99000);
    assert.equal(r.total.spent, 4 * 1900 - 1900 + 4900 + 99000, 'все четыре листа списаны сегодня, возврат тоже; пополнение не расход');
    assert.equal(parkReport(db, A, { from: addDays(today, -1), to: addDays(today, -1) }).total.subscription, 0);
  });

  await step('период: по умолчанию с начала месяца, перевёрнутый исправляется, не больше года', async () => {
    assert.deepEqual(reportPeriod({}, 'Europe/Moscow', parseDate), { from: `${today.slice(0, 8)}01`, to: today });
    assert.deepEqual(reportPeriod({ from: '2026-05-10', to: '2026-05-01' }, 'Europe/Moscow', parseDate), { from: '2026-05-01', to: '2026-05-10' });
    assert.deepEqual(reportPeriod({ from: '2020-01-01', to: '2026-10-27' }, 'Europe/Moscow', parseDate), { from: '2025-10-27', to: '2026-10-27' });
  });

  await step('страница «Отчёты»: у владельца в меню, по дням и по водителям', async () => {
    assert.match((await owner.get('/p')).text, /href="\/p\/reports"/);
    const p = await owner.get(`/p/reports?from=${today}&to=${addDays(today, 1)}`);
    assert.equal(p.status, 200);
    assert.match(p.text, /<b>3<\/b>листов/);
    assert.match(p.text, /<b>250<\/b>км пробега/);
    assert.match(p.text, /отказов на медосмотре/);
    assert.match(p.text, /aria-current="page">По дням/);
    const byDriver = await owner.get(`/p/reports?from=${today}&to=${addDays(today, 1)}&by=driver`);
    assert.match(byDriver.text, /Ершов Д\. А\./);
    assert.match(byDriver.text, /aria-current="page">По водителям/);
    assert.doesNotMatch(p.text + byDriver.text, /style=/, 'CSP: без inline-стилей');
  });

  await step('выгрузка в Excel: CSV с BOM, «;», рубли с запятой, строка итогов', async () => {
    const r = await owner.get(`/p/reports.csv?from=${today}&to=${addDays(today, 1)}&by=driver`);
    assert.match(r.type, /text\/csv; charset=utf-8/);
    assert.match(r.disp, new RegExp(`otchet-voditeli_${today}_${addDays(today, 1)}\\.csv`));
    assert.equal(r.text.charCodeAt(0), 0xFEFF);
    const lines = r.text.slice(1).split('\r\n');
    assert.equal(lines[0], 'Водитель;Листов;Пробег, км;Отказы: медосмотр;Отказы: выпуск;Смен закрыто;Аннулировано;Листы, ₽;Услуги, ₽;Всего, ₽');
    assert.ok(lines.includes('Ершов Денис Андреевич;2;250;0;0;1;0;38,00;49,00;87,00'));
    assert.match(lines[lines.length - 1], /^Итого;3;250;1;0;1;1;/);
    const days = await owner.get(`/p/reports.csv?from=${today}&to=${today}`);
    assert.match(days.text.split('\r\n')[0], /Дата;Листов;.*Подписка, ₽;Всего, ₽$/);
    assert.match(days.text, /;990,00;/);
  });

  await step('диспетчеру отчёты не показываются, второй парк видит только своё', async () => {
    assert.equal((await disp.get('/p/reports')).status, 403);
    assert.equal((await disp.get('/p/reports.csv')).status, 403);
    assert.doesNotMatch((await disp.get('/p')).text, /href="\/p\/reports"/);
    await ownerB.post('/signup', { park: 'Другой парк', city: 'Москва', tz: 'Europe/Moscow', name: 'Другой Владелец', phone: '89000000099', email: 'b@example.ru', login: 'rbowner', password: 'owner-pass-1', agree: '1' });
    const p = await ownerB.get(`/p/reports?from=${today}&to=${addDays(today, 1)}&by=driver`);
    assert.equal(p.status, 200);
    assert.doesNotMatch(p.text, /Ершов|Гусев/);
    assert.match(p.text, /нет ни листов, ни списаний/);
    const csv = await ownerB.get(`/p/reports.csv?from=${today}&to=${addDays(today, 1)}&by=driver`);
    assert.doesNotMatch(csv.text, /Ершов|Гусев/);
    assert.match(csv.text, /Итого;0;0;0;0;0;0;0,00;0,00;0,00/);
  });

  console.log(`\nОтчёты: проверок пройдено ${passed}.`);
} catch (e) {
  console.error('\n✗ Провал после', passed, 'проверок:\n', e);
  process.exitCode = 1;
} finally {
  server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
}
