// Electronic waybill on the test ЭПД operator: who may sign what, batch signing, order of parts, registration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.SUPER_PASSWORD = 'root-test-pass';
const { createApp } = await import('../src/server.js');
const { dayKey, addDays } = await import('../src/time.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'putevka-epl-'));
const { app, db } = createApp({ dbFile: path.join(dir, 't.db'), log: () => {} });
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
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded'; headers.origin = base;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) for (const x of [].concat(v)) p.append(k, x);
      body = p.toString();
    }
    const r = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); if (/Max-Age=0/.test(c)) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: r.status, loc: r.headers.get('location'), text: await r.text() };
  };
  return { get: (u) => call('GET', u), post: (u, f) => call('POST', u, f), async go(u, f) { const r = await call('POST', u, f); return r.loc ? { ...(await call('GET', r.loc)), from: r } : r; } };
}
const one = (sql, ...a) => db.prepare(sql).get(...a);
const flash = (t) => (t.match(/class="flash[^>]*>([^<]*)/) || [])[1] || '';
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

const owner = client(), disp = client(), medic = client(), disp2 = client(), drv = client();
let sheetId, sheet2;
try {
  await step('парк включает электронные листы, сотрудники подключают свои подписи', async () => {
    await owner.post('/signup', { park: 'Такси ЭПЛ', city: 'Москва', tz: 'Europe/Moscow', name: 'Петров Пётр Петрович', phone: '89000000000', email: 'e@example.ru', login: 'eplowner', password: 'owner-pass-1', agree: '1' });
    const s = await owner.go('/p/settings', { name: 'Такси ЭПЛ', city: 'Москва', tz: 'Europe/Moscow', eplMode: 'sandbox', warnDays: '14', route: 'Городские', okud: '0345001', licCard: 'стандартная', techStamp: 'x', medOrg: 'ООО «Мед»' });
    assert.match(s.text, /Настройки сохранены/);
    assert.match(s.text, /href="\/p\/sign"/, 'в меню появился раздел «На подпись»');
    await owner.post('/p/staff', { name: 'Смирнова Ольга Николаевна', role: 'dispatcher', login: 'edisp', password: 'disp-pass-1' });
    await owner.post('/p/staff', { name: 'Кузнецов Игорь Игоревич', role: 'dispatcher', login: 'edisp2', password: 'disp-pass-1' });
    await owner.post('/p/staff', { name: 'Орлова Наталья Ивановна', role: 'medic', login: 'emedic', password: 'medic-pass-1' });
    await disp.post('/login/staff', { login: 'edisp', password: 'disp-pass-1' });
    await disp2.post('/login/staff', { login: 'edisp2', password: 'disp-pass-1' });
    await medic.post('/login/staff', { login: 'emedic', password: 'medic-pass-1' });
    assert.match((await disp.go('/p/me', { sig_type: 'goskey', sig_cert: 'GK-001' })).text, /Подпись подключена/);
    assert.match((await disp2.go('/p/me', { sig_type: 'goskey', sig_cert: 'GK-002' })).text, /Подпись подключена/);
    await medic.post('/p/me', { sig_type: 'goskey', sig_cert: 'MED-777' });
    assert.equal(one("SELECT sig_type FROM users WHERE login = 'emedic'").sig_type, 'ukep', 'медработнику — только УКЭП');
    const d = one("SELECT id FROM users WHERE login = 'edisp'").id;
    assert.match((await owner.go(`/p/staff/${d}/tech`, { tech_cert: 'АТ-12345', tech_cert_date: '2026-03-01' })).text, /может подписывать выпуск/);
  });

  await step('водитель выписывает лист — он сразу электронный', async () => {
    db.prepare("INSERT INTO cars (park_id, model, num, reg, odo) VALUES (1, 'Kia K5', 'А702ОР', '750', 64912)").run();
    db.prepare("INSERT INTO cars (park_id, model, num, reg, odo) VALUES (1, 'Kia Rio', 'В101ВВ', '750', 1000)").run();
    const r = await disp.post('/p/drivers', { name: 'Ершов Денис Андреевич', phone: '89000000002', lic: '99 22 118340', carrier_id: '1', car_id: '1', pin: '2222' });
    assert.match(r.text, /Водитель добавлен/);
    await disp.post('/p/drivers', { name: 'Гусев Артём Олегович', phone: '89000000005', lic: '99 22 000005', carrier_id: '1', car_id: '2', pin: '5555' });
    await drv.post('/login/driver', { phone: '89000000002', pin: '2222' });
    assert.match((await drv.go('/d/issue', { days: today, odo: '64912' })).text, /Путевой лист выписан/);
    const s = one('SELECT * FROM sheets WHERE driver_id = 1');
    assert.equal(s.epl, 1);
    sheetId = s.id;
    assert.match((await drv.get('/d')).text, /ждёт подписей/);
    await disp.post('/p/issue', { driver: '2', days: today });
    sheet2 = one('SELECT id FROM sheets WHERE driver_id = 2').id;
  });

  await step('обычные кнопки отметок для электронного листа не работают', async () => {
    assert.match((await disp.go(`/p/sheet/${sheetId}/tech`, { ok: '1', odo: '64912' })).text, /отметки ставятся подписанием/);
    assert.match((await medic.go(`/p/sheet/${sheetId}/med`, { ok: '1' })).text, /отметки ставятся подписанием/);
    assert.equal(one('SELECT med_status FROM sheets WHERE id = ?', sheetId).med_status, null);
  });

  await step('медосмотр нельзя подписать раньше задания и чужой ролью', async () => {
    const q = await medic.get('/p/sign');
    assert.doesNotMatch(q.text, new RegExp(`value="T2:${sheetId}"`), 'без Т1 медику нечего подписывать');
    const r = await disp.go('/p/sign', { pick: `T2:${sheetId}`, [`ok_${sheetId}`]: '1' });
    assert.match(flash(r.text), /не можете подписать «Предрейсовый медосмотр»/);
  });

  await step('диспетчер подписывает задания пачкой и подтверждает сам', async () => {
    const q = await disp.get('/p/sign');
    assert.match(q.text, new RegExp(`value="T1:${sheetId}"`));
    const r = await disp.post('/p/sign', { pick: [`T1:${sheetId}`, `T1:${sheet2}`] });
    assert.match(r.loc, /^\/p\/sign\/s\/\d+$/);
    const page = await disp.get(r.loc);
    assert.match(page.text, /Подтвердите в «Госключ»/);
    assert.match(page.text, /2 документа/);
    // nobody else can confirm someone's signing
    assert.match((await disp2.go(`${r.loc}/confirm`, {})).text, /Подписание не найдено/);
    assert.match((await medic.go(`${r.loc}/confirm`, {})).text, /Подписание не найдено/);
    assert.equal(one('SELECT COUNT(*) AS n FROM epl_titles').n, 0);
    const done = await disp.go(`${r.loc}/confirm`, {});
    assert.match(flash(done.text), /Подписано: 2/);
    const t1 = one("SELECT * FROM epl_titles WHERE sheet_id = ? AND code = 'T1'", sheetId);
    assert.equal(t1.signer_name, 'Смирнова Ольга Николаевна');
    assert.equal(t1.cert, 'GK-001');
    assert.match((await disp.go(`${r.loc}/confirm`, {})).text, /уже завершено|Подписание/);
  });

  await step('медработник подписывает медосмотр, недопуск — с причиной', async () => {
    const bad = await medic.go('/p/sign', { pick: [`T2:${sheet2}`], [`ok_${sheet2}`]: '0', [`note_${sheet2}`]: '' });
    assert.match(flash(bad.text), /причину/);
    const r = await medic.post('/p/sign', { pick: [`T2:${sheetId}`, `T2:${sheet2}`], [`ok_${sheetId}`]: '1', [`ok_${sheet2}`]: '0', [`note_${sheet2}`]: 'давление' });
    assert.match((await medic.get(r.loc)).text, /КриптоПро myDSS/);
    assert.match(flash((await medic.go(`${r.loc}/confirm`, {})).text), /Подписано: 2/);
    const s = one('SELECT * FROM sheets WHERE id = ?', sheetId);
    assert.equal(s.med_status, 'ok');
    assert.equal(s.med_by, 'Орлова Наталья Ивановна');
    assert.equal(s.med_entered_by, null, 'подписал сам медработник');
    assert.equal(one('SELECT med_status FROM sheets WHERE id = ?', sheet2).med_status, 'refused');
  });

  await step('выпуск подписывает только аттестованный контролёр', async () => {
    const r = await disp2.go('/p/sign', { pick: `T34:${sheetId}`, [`odo_${sheetId}`]: '64912', [`ok_${sheetId}`]: '1' });
    assert.match(flash(r.text), /нет аттестации контролёра/);
    const go = await disp.post('/p/sign', { pick: `T34:${sheetId}`, [`odo_${sheetId}`]: '64920', [`ok_${sheetId}`]: '1' });
    assert.match(flash((await disp.go(`${go.loc}/confirm`, {})).text), /Подписано: 1/);
    const s = one('SELECT * FROM sheets WHERE id = ?', sheetId);
    assert.equal(s.tech_status, 'ok');
    assert.equal(s.odo_out, 64920);
    assert.match(s.gis_id, /^ЭПЛ-ТЕСТ-/, 'после Т1–Т4 лист зарегистрирован');
  });

  await step('лист и QR-проверка показывают подписи и регистрацию', async () => {
    const sheet = (await drv.get(`/d/sheet/${sheetId}`)).text;
    assert.match(sheet, /Электронный путевой лист/);
    assert.match(sheet, /Зарегистрирован в ГИС ЭПД/);
    assert.match(sheet, /Подписано электронной подписью · УКЭП/);
    assert.doesNotMatch(sheet, /место для штампа/, 'в электронном листе нет мест под бумажные штампы');
    const token = one('SELECT token FROM sheets WHERE id = ?', sheetId).token;
    const c = await client().get(`/c/${token}`);
    assert.match(c.text, /Лист действителен/);
    assert.match(c.text, /ЭПЛ-ТЕСТ-/);
    assert.match(c.text, /Предрейсовый медосмотр/);
    assert.match((await drv.get('/d')).text, /зарегистрирован в ГИС ЭПД/);
  });

  await step('приём машины (Т5) после смены', async () => {
    assert.match((await drv.go('/d/finish', { id: String(sheetId), odo: '65100' })).text, /Смена сдана/);
    const r = await disp.post('/p/sign', { pick: `T5:${sheetId}`, [`odo_${sheetId}`]: '65100' });
    assert.match(flash((await disp.go(`${r.loc}/confirm`, {})).text), /Подписано: 1/);
    assert.ok(one('SELECT closed_at FROM sheets WHERE id = ?', sheetId).closed_at);
    assert.equal(one("SELECT COUNT(*) AS n FROM epl_titles WHERE sheet_id = ?", sheetId).n, 5);
  });

  await step('если лист изменился, не подписывается только он, остальные проходят', async () => {
    await disp.post('/p/issue', { driver: '1', days: [addDays(today, 1), addDays(today, 2)] });
    const [a, b] = db.prepare('SELECT id FROM sheets WHERE driver_id = 1 AND shift_date > ? ORDER BY shift_date').all(today).map((x) => x.id);
    const r = await disp.post('/p/sign', { pick: [`T1:${a}`, `T1:${b}`] });
    await disp.post(`/p/sheet/${b}/cancel`, { reason: 'выходной' });
    const done = await disp.go(`${r.loc}/confirm`, {});
    assert.match(flash(done.text), /Подписано: 1\. Не подписано: № \d{6}_\d{3}: лист аннулирован/);
  });

  await step('отмена подписания ничего не подписывает', async () => {
    await disp.post('/p/issue', { driver: '1', days: addDays(today, 3) });
    const c = one('SELECT id FROM sheets WHERE driver_id = 1 AND shift_date = ?', addDays(today, 3)).id;
    const r = await disp.post('/p/sign', { pick: `T1:${c}` });
    assert.match((await disp.go(`${r.loc}/cancel`, {})).text, /Подписание отменено/);
    assert.equal(one('SELECT COUNT(*) AS n FROM epl_titles WHERE sheet_id = ?', c).n, 0);
  });

  const root = client(), smed = client(), smech = client();
  let s3;
  await step('платформа заводит своих исполнителей: медработника партнёра и механика', async () => {
    await root.post('/login/staff', { login: 'root', password: 'root-test-pass' });
    assert.match((await root.get('/s/services')).text, /Услуги подписантов/);
    assert.match((await root.go('/s/services/staff', { name: 'Медведева Анна Сергеевна', kind: 'medic', svc_org: 'ООО «Медпартнёр»', svc_lic: 'Л041-01-77/123', login: 'smed', password: 'smed-pass-1' })).text, /Исполнитель добавлен/);
    assert.match((await root.go('/s/services/staff', { name: 'Механиков Олег Петрович', kind: 'mech', svc_org: 'Путёвка', svc_city: 'Москва', tech_cert: 'АТ-99-001', login: 'smech', password: 'smech-pass-1' })).text, /Исполнитель добавлен/);
    assert.match((await root.go('/s/services/staff', { name: 'Без Лицензии', kind: 'medic', svc_org: 'X', login: 'nolic', password: 'nolic-pass-1' })).text, /лицензию медорганизации/);
    assert.equal((await smed.post('/login/staff', { login: 'smed', password: 'smed-pass-1' })).loc, '/x');
    assert.equal((await smech.post('/login/staff', { login: 'smech', password: 'smech-pass-1' })).loc, '/x');
    assert.equal((await smed.get('/p')).loc, '/x', 'исполнитель не попадает в кабинеты парков');
    await smed.post('/x/me', { sig_cert: 'MP-555' });
    await smech.post('/x/me', { sig_type: 'goskey', sig_cert: 'GK-MECH-1' });
    assert.match((await smed.get('/x')).text, /ни один таксопарк не подключил/);
  });

  await step('парк подключает услуги, исполнитель видит только его', async () => {
    const st = await owner.get('/p/settings');
    assert.match(st.text, /Нет своего медика или механика/);
    assert.match(st.text, /49 ₽/);
    assert.match((await owner.go('/p/services', { svcMed: '1', svcMech: '1' })).text, /Услуги подключены/);
    await client().post('/signup', { park: 'Чужой парк', city: 'Москва', tz: 'Europe/Moscow', name: 'Чужой Владелец', phone: '89000000099', email: 'x@example.ru', login: 'otherpark', password: 'other-pass-1', agree: '1' });
    const x = await smed.get('/x');
    assert.match(x.text, /Такси ЭПЛ/);
    assert.doesNotMatch(x.text, /Чужой парк/);
    await disp.post('/p/issue', { driver: '2', days: today });
    s3 = one("SELECT id FROM sheets WHERE driver_id = 2 AND shift_date = ? AND med_status IS NULL", today).id;
    const r = await disp.post('/p/sign', { pick: `T1:${s3}` });
    await disp.post(`${r.loc}/confirm`, {});
  });

  await step('у парка нет денег — исполнитель не может подписать', async () => {
    db.prepare('UPDATE parks SET balance = 0 WHERE id = 1').run();
    const r = await smed.go('/x/sign', { park: '1', pick: `T2:${s3}`, [`ok_${s3}`]: '1' });
    assert.match(flash(r.text), /не хватает денег/);
  });

  await step('медработник партнёра подписывает медосмотр, парк платит за подпись', async () => {
    db.prepare('UPDATE parks SET balance = 100000 WHERE id = 1').run();
    assert.match((await smed.go('/x/sign?park=2', { pick: `T2:${s3}`, [`ok_${s3}`]: '1' })).text, /не подключил/);
    const r = await smed.post('/x/sign', { park: '1', pick: `T2:${s3}`, [`ok_${s3}`]: '1' });
    assert.match(r.loc, /^\/x\/sign\/s\/\d+$/);
    assert.match(flash((await smed.go(`${r.loc}/confirm`, {})).text), /Подписано: 1/);
    assert.equal(one('SELECT balance FROM parks WHERE id = 1').balance, 100000 - 4900);
    assert.match(one("SELECT comment FROM ledger WHERE kind = 'service' ORDER BY id DESC").comment, /Медосмотр сервиса/);
    const sheet = (await disp.get(`/p/sheet/${s3}`)).text;
    assert.match(sheet, /Медведева Анна Сергеевна/);
    assert.match(sheet, /ООО «Медпартнёр», лицензия Л041-01-77\/123/);
  });

  await step('механик сервиса подписывает выпуск, но не задание', async () => {
    await disp.post('/p/issue', { driver: '2', days: addDays(today, 4) });
    const future = one('SELECT id FROM sheets WHERE driver_id = 2 AND shift_date = ?', addDays(today, 4)).id;
    assert.match(flash((await smech.go('/x/sign', { park: '1', pick: `T1:${future}` })).text), /не можете подписать «Задание водителю»/);
    const r = await smech.post('/x/sign', { park: '1', pick: `T34:${s3}`, [`odo_${s3}`]: '1000', [`ok_${s3}`]: '1' });
    assert.match(flash((await smech.go(`${r.loc}/confirm`, {})).text), /Подписано: 1/);
    assert.equal(one('SELECT balance FROM parks WHERE id = 1').balance, 100000 - 4900 - 5900);
    assert.match(one('SELECT gis_id FROM sheets WHERE id = ?', s3).gis_id, /^ЭПЛ-ТЕСТ-/);
  });

  await step('парк отключил услугу — исполнитель его больше не видит', async () => {
    await owner.post('/p/services', {});
    assert.doesNotMatch((await smed.get('/x')).text, /Такси ЭПЛ/);
    assert.equal(one("SELECT value FROM platform WHERE key = 'svcMedOn'").value, '1');
  });

  console.log(`\nЭПЛ: проверок пройдено ${passed}.`);
} catch (e) {
  console.error('\n✗ Провал после', passed, 'проверок:\n', e);
  process.exitCode = 1;
} finally {
  server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
}
