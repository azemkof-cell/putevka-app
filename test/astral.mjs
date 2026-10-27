// The «Калуга Астрал» ЭПД operator against a fake API: own signature only, confirmation only from the operator,
// order of titles, registration in ГИС ЭПД, signed notifications.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

process.env.SUPER_PASSWORD = 'root-test-pass';
const { createApp } = await import('../src/server.js');
const { makeOperator, checkOperator, SIGN_TTL_MIN } = await import('../src/epd.js');
const { dayKey } = await import('../src/time.js');

const API = 'https://astral.test/api/v1';
const env = { EPD_OPERATOR: 'astral', ASTRAL_API_URL: API, ASTRAL_CLIENT_ID: 'cid', ASTRAL_CLIENT_SECRET: 'csecret', ASTRAL_WEBHOOK_SECRET: 'whsec' };

/* ---------- fake Astral API ---------- */
const api = {
  tokens: 0, revoked: new Set(), down: false,
  certs: new Map([['GK-001', { serial: 'GK-001', owner: { name: 'Смирнова Ольга Николаевна' }, type: 'goskey' }],
    ['UK-777', { serial: 'UK-777', owner: { name: 'Орлова Наталья Ивановна' }, type: 'ukep' }],
    ['GK-MED', { serial: 'GK-MED', owner: { name: 'Орлова Наталья Ивановна' }, type: 'goskey' }],
    ['GK-999', { serial: 'GK-999', owner: { name: 'Кузнецов Игорь Игоревич' }, type: 'goskey' }]]),
  sessions: new Map(), waybills: new Map(), seq: 0
};
/** The signer pressed «Подписать» in their app: the operator signs every document with that signer's certificate. */
api.sign = (id, cert) => {
  const s = api.sessions.get(id);
  s.status = 'signed';
  s.signatures = s.body.documents.map((d) => ({ ref: d.ref, id: `sig-${d.ref}`, certificate: cert ?? s.body.signer.certificate, signed_at: new Date().toISOString(), hash: d.hash }));
};
const fakeFetch = async (url, opts = {}) => {
  const u = new URL(url);
  const json = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
  if (api.down) throw new Error('connect ECONNREFUSED');
  if (u.pathname === '/api/v1/oauth/token') {
    const p = new URLSearchParams(opts.body);
    if (p.get('grant_type') !== 'client_credentials' || p.get('client_id') !== 'cid' || p.get('client_secret') !== 'csecret') return json(401, { error: 'invalid_client' });
    api.tokens++;
    return json(200, { access_token: `tok-${api.tokens}`, expires_in: 3600 });
  }
  const tok = String(opts.headers?.Authorization || '').replace('Bearer ', '');
  if (!/^tok-\d+$/.test(tok) || api.revoked.has(tok)) return json(401, { error: 'invalid_token' });
  let m;
  if ((m = u.pathname.match(/^\/api\/v1\/signers\/certificates\/(.+)$/))) {
    const c = api.certs.get(decodeURIComponent(m[1]));
    return c ? json(200, c) : json(404, {});
  }
  if (u.pathname === '/api/v1/signing/sessions' && opts.method === 'POST') {
    const body = JSON.parse(opts.body);
    const id = `ss-${++api.seq}`;
    api.sessions.set(id, { id, status: 'pending', body, idem: opts.headers['Idempotency-Key'], signatures: [] });
    return json(201, { id, status: 'pending', app_name: body.signer.signature_type === 'ukep' ? 'КриптоПро myDSS' : 'Госключ', confirmation_code: '4821' });
  }
  if ((m = u.pathname.match(/^\/api\/v1\/signing\/sessions\/(.+)$/))) {
    const s = api.sessions.get(decodeURIComponent(m[1]));
    return s ? json(200, { id: s.id, status: s.status, reason: s.reason, signatures: s.signatures }) : json(404, {});
  }
  if (u.pathname === '/api/v1/waybills' && opts.method === 'POST') {
    const body = JSON.parse(opts.body);
    const id = `wb-${++api.seq}`;
    api.waybills.set(id, { id, status: 'processing', body });
    return json(201, { id, status: 'processing' });
  }
  if ((m = u.pathname.match(/^\/api\/v1\/waybills\/(.+)$/))) {
    const w = api.waybills.get(decodeURIComponent(m[1]));
    return w ? json(200, { id: w.id, status: w.status, gis_id: w.gis_id, error: w.error }) : json(404, {});
  }
  return json(404, {});
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'putevka-astral-'));
const operator = makeOperator({ env, fetchImpl: fakeFetch, callbackUrl: 'https://putevka.test/epd/notify' });
const { app, db, epd } = createApp({ dbFile: path.join(dir, 't.db'), log: () => {}, epd: { operator } });
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
const state = async (c, loc) => JSON.parse((await c.get(`${loc}/state`)).text).status;
const notify = (body, secret = 'whsec') => {
  const raw = JSON.stringify(body);
  return fetch(base + '/epd/notify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': crypto.createHmac('sha256', secret).update(raw).digest('hex') }, body: raw });
};
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

const owner = client(), disp = client(), disp2 = client(), medic = client(), drv = client(), other = client();
let sheetId, signLoc;
try {
  await step('оператор выбирается переменными окружения и проверяет настройки', async () => {
    assert.throws(() => makeOperator({ env: { EPD_OPERATOR: 'astral' } }), /ASTRAL_API_URL/);
    assert.throws(() => makeOperator({ env: { EPD_OPERATOR: 'astral', ASTRAL_API_URL: API } }), /ASTRAL_CLIENT_ID/);
    assert.throws(() => makeOperator({ env: { EPD_OPERATOR: 'kontur' } }), /Неизвестный оператор/);
    assert.equal(makeOperator({ env: {} }).sandbox, true, 'без переменных — тестовый оператор');
    assert.throws(() => checkOperator({ name: 'Неполный', startSigning() {} }), /не умеет: verifySigner, pollSigning, register, status/);
    assert.equal(operator.name, 'Калуга Астрал');
  });

  await step('парк включает ЭПЛ через Астрал', async () => {
    await owner.post('/signup', { park: 'Такси Астрал', city: 'Москва', tz: 'Europe/Moscow', name: 'Петров Пётр Петрович', phone: '89000000000', email: 'a@example.ru', login: 'aowner', password: 'owner-pass-1', agree: '1' });
    const st = await owner.get('/p/settings');
    assert.match(st.text, /value="on"[^>]*>Электронный \(ЭПЛ\) через оператора ЭПД «Калуга Астрал»/);
    await owner.post('/p/settings', { name: 'Такси Астрал', city: 'Москва', tz: 'Europe/Moscow', eplMode: 'on', warnDays: '14', route: 'Городские', okud: '0345001', licCard: 'стандартная', techStamp: 'x' });
    assert.equal(JSON.parse(one('SELECT settings FROM parks WHERE id = 1').settings).eplMode, 'on');
    await owner.post('/p/staff', { name: 'Смирнова Ольга Николаевна', role: 'dispatcher', login: 'adisp', password: 'disp-pass-1' });
    await owner.post('/p/staff', { name: 'Кузнецов Игорь Игоревич', role: 'dispatcher', login: 'adisp2', password: 'disp-pass-1' });
    await owner.post('/p/staff', { name: 'Орлова Наталья Ивановна', role: 'medic', login: 'amedic', password: 'medic-pass-1' });
    await disp.post('/login/staff', { login: 'adisp', password: 'disp-pass-1' });
    await disp2.post('/login/staff', { login: 'adisp2', password: 'disp-pass-1' });
    await medic.post('/login/staff', { login: 'amedic', password: 'medic-pass-1' });
  });

  await step('подпись подключается только своим сертификатом, который есть у оператора', async () => {
    assert.match(flash((await disp.go('/p/me', { sig_type: 'goskey', sig_cert: 'NOPE' })).text), /не нашёл такой сертификат/);
    assert.match(flash((await disp.go('/p/me', { sig_type: 'goskey', sig_cert: 'GK-999' })).text), /выписан на другого человека \(Кузнецов И\. И\.\)/);
    assert.equal(one("SELECT sig_ready FROM users WHERE login = 'adisp'").sig_ready, 0);
    assert.match(flash((await disp.go('/p/me', { sig_type: 'goskey', sig_cert: 'GK-001' })).text), /Подпись подключена/);
    assert.match(flash((await medic.go('/p/me', { sig_cert: 'GK-MED' })).text), /только квалифицированной подписью/, 'Госключ медработнику не подходит');
    assert.match(flash((await medic.go('/p/me', { sig_cert: 'UK-777' })).text), /Подпись подключена/);
    assert.equal(one("SELECT sig_type FROM users WHERE login = 'amedic'").sig_type, 'ukep');
    await disp2.post('/p/me', { sig_type: 'goskey', sig_cert: 'GK-999' });
    const d = one("SELECT id FROM users WHERE login = 'adisp'").id;
    await owner.post(`/p/staff/${d}/tech`, { tech_cert: 'АТ-1', tech_cert_date: '2026-03-01' });
    assert.equal(api.tokens, 1, 'токен получен один раз и переиспользуется');
  });

  await step('пачка уходит в приложение подписанта, а не подписывается кнопкой', async () => {
    db.prepare("INSERT INTO cars (park_id, model, num, reg, odo) VALUES (1, 'Kia K5', 'А702ОР', '750', 64912)").run();
    await disp.post('/p/drivers', { name: 'Ершов Денис Андреевич', phone: '89000000002', lic: '99 22 118340', carrier_id: '1', car_id: '1', pin: '2222' });
    await drv.post('/login/driver', { phone: '89000000002', pin: '2222' });
    await drv.post('/d/issue', { days: today, odo: '64912' });
    sheetId = one('SELECT id FROM sheets').id;
    assert.equal(one('SELECT epl FROM sheets WHERE id = ?', sheetId).epl, 1);
    const r = await disp.post('/p/sign', { pick: `T1:${sheetId}` });
    signLoc = r.loc;
    assert.match(signLoc, /^\/p\/sign\/s\/\d+$/);
    const sent = [...api.sessions.values()][0];
    assert.equal(sent.body.signer.certificate, 'GK-001');
    assert.equal(sent.body.callback_url, 'https://putevka.test/epd/notify');
    assert.equal(sent.body.documents.length, 1);
    assert.equal(sent.body.documents[0].title, 'T1');
    const doc = JSON.parse(Buffer.from(sent.body.documents[0].content, 'base64').toString());
    assert.equal(doc.driver.name, 'Ершов Денис Андреевич');
    assert.equal(sent.body.documents[0].hash, crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex'));
    assert.ok(sent.idem, 'повтор запроса не создаст второе подписание');
    const page = await disp.get(signLoc);
    assert.match(page.text, /Подтвердите в «Госключ»/);
    assert.match(page.text, /4821/);
    assert.match(page.text, /data-sign-poll="\/p\/sign\/s\/\d+\/state"/, 'страница сама спрашивает статус');
    assert.doesNotMatch(page.text, /Подтвердить в тестовом приложении/);
    assert.match(flash((await disp.go(`${signLoc}/confirm`, {})).text), /Подтверждение приходит от оператора/);
    assert.equal(await state(disp, signLoc), 'waiting');
    assert.equal(one('SELECT COUNT(*) AS n FROM epl_titles').n, 0);
  });

  await step('статус чужого подписания не виден ни коллеге, ни другому парку', async () => {
    assert.equal((await disp2.get(`${signLoc}/state`)).status, 404);
    await other.post('/signup', { park: 'Чужой парк', city: 'Москва', tz: 'Europe/Moscow', name: 'Чужой Владелец', phone: '89000000099', email: 'x@example.ru', login: 'aother', password: 'other-pass-1', agree: '1' });
    assert.equal((await other.get(`${signLoc}/state`)).status, 404);
    const o = await other.get(signLoc);
    assert.equal(o.loc, '/p/sign');
    assert.equal(one("SELECT status FROM sign_sessions WHERE id = ?", Number(signLoc.split('/').pop())).status, 'waiting', 'чужой запрос ничего не изменил');
  });

  await step('подписант подтвердил в приложении — лист подписан его сертификатом', async () => {
    api.sign('ss-1');
    assert.equal(await state(disp, signLoc), 'confirmed');
    const t1 = one("SELECT * FROM epl_titles WHERE sheet_id = ? AND code = 'T1'", sheetId);
    assert.equal(t1.signer_name, 'Смирнова Ольга Николаевна');
    assert.equal(t1.cert, 'GK-001');
    assert.equal(t1.operator_id, `sig-${sheetId}-T1`);
    assert.equal((await disp.get(signLoc)).loc, '/p/sign');
    assert.match(flash((await disp.get('/p/sign')).text), /Подписано: 1/);
  });

  await step('подпись чужим сертификатом не принимается: ничего не подписано', async () => {
    const r = await medic.post('/p/sign', { pick: `T2:${sheetId}`, [`ok_${sheetId}`]: '1' });
    const id = [...api.sessions.keys()].pop();
    assert.equal(api.sessions.get(id).body.signer.signature_type, 'ukep');
    api.sign(id, 'GK-999');
    const page = await medic.get(r.loc);
    assert.equal(page.loc, '/p/sign');
    assert.match(flash((await medic.get('/p/sign')).text), /Не подписано: документ подписан не вашим сертификатом/);
    assert.equal(one('SELECT status, result FROM sign_sessions ORDER BY id DESC').status, 'canceled');
    assert.match(one('SELECT result FROM sign_sessions ORDER BY id DESC').result, /не вашим сертификатом/);
    assert.equal(one('SELECT med_status FROM sheets WHERE id = ?', sheetId).med_status, null);
    assert.match(one("SELECT action FROM audit ORDER BY id DESC").action, /Подпись не принята/);
  });

  await step('отказ в приложении и молчание дольше срока — ничего не подписано', async () => {
    let r = await medic.post('/p/sign', { pick: `T2:${sheetId}`, [`ok_${sheetId}`]: '1' });
    let id = [...api.sessions.keys()].pop();
    Object.assign(api.sessions.get(id), { status: 'rejected' });
    assert.equal(await state(medic, r.loc), 'canceled');
    assert.match(one('SELECT result FROM sign_sessions ORDER BY id DESC').result, /отклонили/);
    r = await medic.post('/p/sign', { pick: `T2:${sheetId}`, [`ok_${sheetId}`]: '1' });
    db.prepare('UPDATE sign_sessions SET created_at = ? WHERE id = ?').run(new Date(Date.now() - (SIGN_TTL_MIN + 1) * 60e3).toISOString(), Number(r.loc.split('/').pop()));
    id = [...api.sessions.keys()].pop();
    api.sign(id);
    assert.equal(await state(medic, r.loc), 'canceled', 'подтверждение через 16 минут не ставит отметку задним числом');
    assert.equal(one('SELECT med_status FROM sheets WHERE id = ?', sheetId).med_status, null);
  });

  await step('медработник подписывает медосмотр, страница сама узнаёт об этом', async () => {
    const r = await medic.post('/p/sign', { pick: `T2:${sheetId}`, [`ok_${sheetId}`]: '1' });
    api.sign([...api.sessions.keys()].pop());
    const page = await medic.get(r.loc);
    assert.equal(page.loc, '/p/sign');
    assert.match(flash((await medic.get('/p/sign')).text), /Подписано: 1/);
    assert.equal(one('SELECT med_status FROM sheets WHERE id = ?', sheetId).med_status, 'ok');
    assert.equal(one("SELECT cert FROM epl_titles WHERE sheet_id = ? AND code = 'T2'", sheetId).cert, 'UK-777');
  });

  await step('если подписант закрыл страницу, фоновая проверка всё равно применяет подпись', async () => {
    await disp.post('/p/sign', { pick: `T34:${sheetId}`, [`odo_${sheetId}`]: '64920', [`ok_${sheetId}`]: '1' });
    const id = [...api.sessions.keys()].pop();
    assert.deepEqual(api.sessions.get(id).body.documents.map((d) => d.title), ['T3', 'T4']);
    api.sign(id);
    await epd.syncAll();
    const s = one('SELECT * FROM sheets WHERE id = ?', sheetId);
    assert.equal(s.tech_status, 'ok');
    assert.equal(s.odo_out, 64920);
    assert.equal(s.gis_status, 'pending', 'лист отправлен на регистрацию');
    assert.equal(s.gis_id, null);
    const wb = [...api.waybills.values()][0];
    assert.deepEqual(wb.body.titles.map((t) => t.title), ['T1', 'T2', 'T3', 'T4']);
    assert.ok(wb.body.titles.every((t) => t.signature_id.startsWith('sig-')));
    assert.match((await drv.get(`/d/sheet/${sheetId}`)).text, /ждём ответа оператора/);
  });

  await step('уведомление оператора: без подписи отклоняется, телу не верим', async () => {
    const wb = [...api.waybills.values()][0];
    assert.equal((await notify({ waybill_id: wb.id }, 'wrong')).status, 403);
    assert.equal((await fetch(base + '/epd/notify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await notify({ waybill_id: wb.id, status: 'registered', gis_id: 'FAKE' })).status, 200);
    assert.equal(one('SELECT gis_id FROM sheets WHERE id = ?', sheetId).gis_id, null, 'оператор ещё не зарегистрировал — тело уведомления не в счёт');
    Object.assign(wb, { status: 'registered', gis_id: 'ЭПЛ-77-000123' });
    assert.equal((await notify({ waybill_id: wb.id })).status, 200);
    const s = one('SELECT * FROM sheets WHERE id = ?', sheetId);
    assert.equal(s.gis_id, 'ЭПЛ-77-000123');
    assert.equal(s.gis_status, 'registered');
    const token = s.token;
    assert.match((await client().get(`/c/${token}`)).text, /ЭПЛ-77-000123/);
  });

  await step('приём машины (Т5) — тем же порядком; отказ в регистрации виден в листе', async () => {
    await drv.post('/d/finish', { id: String(sheetId), odo: '65100' });
    const r = await disp.post('/p/sign', { pick: `T5:${sheetId}`, [`odo_${sheetId}`]: '65100' });
    api.sign([...api.sessions.keys()].pop());
    assert.equal(await state(disp, r.loc), 'confirmed');
    assert.ok(one('SELECT closed_at FROM sheets WHERE id = ?', sheetId).closed_at);
    assert.equal(one('SELECT COUNT(*) AS n FROM epl_titles WHERE sheet_id = ?', sheetId).n, 5);
    db.prepare("UPDATE sheets SET gis_id = NULL, gis_status = 'pending' WHERE id = ?").run(sheetId);
    Object.assign([...api.waybills.values()][0], { status: 'rejected', gis_id: undefined, error: 'неверный ИНН перевозчика' });
    await epd.settle(1);
    assert.match((await disp.get(`/p/sheet/${sheetId}`)).text, /отказал в регистрации в ГИС ЭПД: неверный ИНН перевозчика/);
  });

  await step('оператор недоступен — ничего не подписано и не зависло', async () => {
    await drv.post('/d/issue', { days: [dayKey('Europe/Moscow', new Date(Date.now() + 86400e3))] });
    const next = one('SELECT id FROM sheets WHERE id <> ? ORDER BY id DESC', sheetId).id;
    api.down = true;
    const r = await disp.go('/p/sign', { pick: `T1:${next}` });
    assert.match(flash(r.text), /Оператор ЭПД сейчас не отвечает/);
    assert.equal(one("SELECT COUNT(*) AS n FROM sign_sessions WHERE status = 'waiting'").n, 0);
    api.down = false;
  });

  await step('просроченный токен получается заново', async () => {
    api.revoked.add(`tok-${api.tokens}`);
    const before = api.tokens;
    assert.equal((await operator.verifySigner({ cert: 'GK-001' })).owner, 'Смирнова Ольга Николаевна');
    assert.equal(api.tokens, before + 1);
  });

  console.log(`\nОператор ЭПД «Калуга Астрал»: проверок пройдено ${passed}.`);
} catch (e) {
  console.error('\n✗ Провал после', passed, 'проверок:\n', e);
  process.exitCode = 1;
} finally {
  server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
}
