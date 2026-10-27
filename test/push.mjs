// Web Push: subscriptions, encryption and VAPID as a browser sees them, events, schedule, preferences, park isolation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

process.env.SUPER_PASSWORD = 'root-test-pass';
const { createApp } = await import('../src/server.js');
const { generateVapidKeys, allowedEndpoint } = await import('../src/push.js');
const { dayKey, addDays } = await import('../src/time.js');

const vapid = generateVapidKeys();
const env = { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:help@example.ru' };

/* ---------- fake push service: records what the server sent ---------- */
const inbox = [];
const gone = new Set();
const fakeFetch = async (url, opts) => {
  inbox.push({ url, headers: opts.headers, body: Buffer.from(opts.body) });
  return new Response(null, { status: gone.has(url) ? 410 : 201 });
};

/** A browser on a phone: its own keys, decrypts what arrives at its endpoint (RFC 8291). */
function phone(name) {
  const ecdh = crypto.createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const endpoint = `https://fcm.googleapis.com/fcm/send/${name}-${crypto.randomBytes(4).toString('hex')}`;
  const decrypt = (buf) => {
    const salt = buf.subarray(0, 16), idlen = buf[20], asPub = buf.subarray(21, 21 + idlen), data = buf.subarray(21 + idlen);
    const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
    const shared = ecdh.computeSecret(asPub);
    const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), pub, asPub, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const d = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
    d.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
    assert.equal(plain[plain.length - 1], 2, 'последняя запись помечена разделителем 0x02');
    return JSON.parse(plain.subarray(0, plain.length - 1).toString());
  };
  return {
    endpoint,
    sub: { endpoint, keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } },
    got: () => inbox.filter((m) => m.url === endpoint).map((m) => decrypt(m.body))
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'putevka-push-'));
const { app, db, push } = createApp({ dbFile: path.join(dir, 't.db'), log: () => {}, push: { env, fetchImpl: fakeFetch } });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const today = dayKey('Europe/Moscow');

function client() {
  const jar = {};
  const call = async (method, url, form, { json, origin = base } = {}) => {
    const headers = {};
    const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck) headers.cookie = ck;
    let body;
    if (json) { headers['content-type'] = 'application/json'; headers.origin = origin; body = JSON.stringify(json); }
    else if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded'; headers.origin = origin;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) for (const x of [].concat(v)) p.append(k, x);
      body = p.toString();
    }
    const r = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); if (/Max-Age=0/.test(c)) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: r.status, loc: r.headers.get('location'), text: await r.text() };
  };
  return { get: (u) => call('GET', u), post: (u, f) => call('POST', u, f), json: (u, j, o) => call('POST', u, null, { json: j, ...o }) };
}
const one = (sql, ...a) => db.prepare(sql).get(...a);
const settle = async () => { await new Promise((r) => setImmediate(r)); await push.flush(); };
const at = (day, hm) => new Date(`${day}T${hm}:00+03:00`);
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

const owner = client(), disp = client(), medic = client(), drv = client(), drv2 = client(), ownerB = client(), dispB = client();
const pDrv = phone('drv'), pDrv2 = phone('drv2'), pDisp = phone('disp'), pOwner = phone('owner'), pDispB = phone('dispB');
let s1;
try {
  await step('без ключей VAPID уведомления честно выключены', async () => {
    const plain = createApp({ dbFile: path.join(dir, 'plain.db'), log: () => {}, push: { env: {} } });
    assert.equal(plain.push.enabled, false);
    const srv = plain.app.listen(0);
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/push/key`);
    assert.equal(r.status, 404);
    srv.close(); plain.db.close();
  });

  await step('подготовка: парк, сотрудники, два водителя', async () => {
    await owner.post('/signup', { park: 'Такси Пуш', city: 'Москва', tz: 'Europe/Moscow', name: 'Петров Пётр Петрович', phone: '89000000000', email: 'p@example.ru', login: 'powner', password: 'owner-pass-1', agree: '1' });
    await owner.post('/p/staff', { name: 'Смирнова Ольга Николаевна', role: 'dispatcher', login: 'pdisp', password: 'disp-pass-1' });
    await owner.post('/p/staff', { name: 'Орлова Наталья Ивановна', role: 'medic', login: 'pmedic', password: 'medic-pass-1' });
    await disp.post('/login/staff', { login: 'pdisp', password: 'disp-pass-1' });
    await medic.post('/login/staff', { login: 'pmedic', password: 'medic-pass-1' });
    db.prepare("INSERT INTO cars (park_id, model, num, reg, odo) VALUES (1, 'Kia K5', 'А702ОР', '750', 1000), (1, 'Kia Rio', 'В101ВВ', '750', 2000)").run();
    await disp.post('/p/drivers', { name: 'Ершов Денис Андреевич', phone: '89000000002', lic: '1', carrier_id: '1', car_id: '1', pin: '2222' });
    await disp.post('/p/drivers', { name: 'Гусев Артём Олегович', phone: '89000000005', lic: '2', carrier_id: '1', car_id: '2', pin: '5555' });
    await drv.post('/login/driver', { phone: '89000000002', pin: '2222' });
    await drv2.post('/login/driver', { phone: '89000000005', pin: '5555' });
  });

  await step('включить уведомления может только вошедший, только из своего сайта и только у push-сервиса', async () => {
    assert.equal(JSON.parse((await drv.get('/api/push/key')).text).key, vapid.publicKey);
    assert.equal((await client().json('/api/push/subscribe', pDrv.sub)).status, 401);
    assert.equal((await drv.json('/api/push/subscribe', pDrv.sub, { origin: 'https://evil.example' })).status, 403);
    const bad = await drv.json('/api/push/subscribe', { ...pDrv.sub, endpoint: 'https://127.0.0.1/steal' });
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.text).error, /не поддерживается/);
    assert.equal(allowedEndpoint('http://fcm.googleapis.com/x'), false);
    assert.equal(allowedEndpoint('https://fcm.googleapis.com.evil.ru/x'), false);
    assert.equal(allowedEndpoint('https://web.push.apple.com/abc'), true);
    assert.equal((await drv.json('/api/push/subscribe', pDrv.sub)).status, 200);
    assert.equal((await drv2.json('/api/push/subscribe', pDrv2.sub)).status, 200);
    assert.equal((await disp.json('/api/push/subscribe', pDisp.sub)).status, 200);
    assert.equal((await owner.json('/api/push/subscribe', pOwner.sub)).status, 200);
    assert.match((await drv.get('/d/notify')).text, /Включены на 1 устройстве/);
    assert.match((await drv.get('/d')).text, /href="\/d\/notify"/);
  });

  await step('водителю: «медосмотр пройден» и «выпущен на линию» — зашифровано и подписано VAPID', async () => {
    await drv.post('/d/issue', { days: today, odo: '1000' });
    s1 = one('SELECT id FROM sheets WHERE driver_id = 1').id;
    await medic.post(`/p/sheet/${s1}/med`, { ok: '1' });
    await settle();
    const [m] = pDrv.got();
    assert.equal(m.title, 'Медосмотр пройден');
    assert.match(m.body, /Лист № \d{6}_\d{3}/);
    assert.equal(m.url, '/d');
    const raw = inbox.find((x) => x.url === pDrv.endpoint);
    assert.equal(raw.headers['Content-Encoding'], 'aes128gcm');
    assert.doesNotMatch(raw.body.toString('latin1'), /Медосмотр|\d{6}_\d{3}/, 'текст не идёт открытым');
    const [, t, k] = raw.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.equal(k, vapid.publicKey);
    const [h, p, sig] = t.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.equal(claims.sub, 'mailto:help@example.ru');
    const pub = Buffer.from(vapid.publicKey, 'base64url');
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'подпись VAPID проверяется открытым ключом');
    await disp.post(`/p/sheet/${s1}/tech`, { ok: '1', odo: '1000' });
    await settle();
    assert.equal(pDrv.got()[1].title, 'Вы выпущены на линию');
    assert.equal(pDrv2.got().length, 0, 'другому водителю ничего');
  });

  await step('отметка не прошла — уведомления нет', async () => {
    await drv2.post('/d/issue', { days: today });
    const s2 = one('SELECT id FROM sheets WHERE driver_id = 2').id;
    await medic.post(`/p/sheet/${s2}/med`, { ok: '1' });
    await settle();
    assert.equal(pDrv2.got().length, 1);
    const r = await disp.post(`/p/sheet/${s2}/tech`, { ok: '1' }); // no odometer: the release fails and rolls back
    assert.equal(r.status, 302);
    await settle();
    assert.equal(one('SELECT tech_status FROM sheets WHERE id = ?', s2).tech_status, null);
    assert.equal(pDrv2.got().length, 1, 'откатилась отметка — откатилось и уведомление');
    assert.equal(one("SELECT COUNT(*) AS n FROM push_outbox WHERE event = 'line' AND subject_id = 2").n, 0);
  });

  await step('водитель сам выключает ненужное', async () => {
    const s2 = one('SELECT id FROM sheets WHERE driver_id = 2').id;
    const f = await drv2.post('/d/notify', { on: ['med', 'tomorrow'] });
    assert.equal(f.loc, '/d/notify');
    assert.equal(one('SELECT push_off FROM drivers WHERE id = 2').push_off, 'line');
    assert.doesNotMatch((await drv2.get('/d/notify')).text, /name="on" value="line" checked/);
    await disp.post(`/p/sheet/${s2}/tech`, { ok: '1', odo: '2000' });
    await settle();
    assert.equal(pDrv2.got().length, 1, '«выпуск» выключен — не пришло');
  });

  await step('«лист на завтра готов» — вечером в 18:00 по времени парка, один раз', async () => {
    const tomorrow = addDays(today, 1);
    await disp.post('/p/issue', { driver: '1', days: tomorrow });
    await push.tick(at(today, '17:30'));
    assert.equal(pDrv.got().length, 2, 'до 18:00 рано');
    await push.tick(at(today, '18:05'));
    const m = pDrv.got()[2];
    assert.equal(m.title, 'Лист на завтра готов');
    assert.match(m.body, new RegExp(tomorrow.split('-').reverse().join('\\.')));
    await push.tick(at(today, '19:05'));
    assert.equal(pDrv.got().length, 3, 'повторно не приходит');
  });

  await step('диспетчеру: «N листов ждут подписи», без повторов каждую минуту', async () => {
    db.prepare("UPDATE parks SET settings = json_set(settings, '$.eplMode', 'sandbox') WHERE id = 1").run();
    await disp.post('/p/me', { sig_type: 'goskey', sig_cert: 'GK-1' });
    await disp.post('/p/issue', { driver: '2', days: [addDays(today, 2), addDays(today, 3)] });
    const t0 = new Date();
    await push.tick(t0);
    const [m] = pDisp.got();
    assert.equal(m.title, '2 листа ждут подписи');
    assert.equal(m.url, '/p/sign');
    await push.tick(new Date(t0.getTime() + 60e3));
    assert.equal(pDisp.got().length, 1, 'через минуту не повторяет');
    await disp.post('/p/issue', { driver: '2', days: addDays(today, 4) });
    await push.tick(new Date(t0.getTime() + 31 * 60e3));
    assert.equal(pDisp.got()[1].title, '3 листа ждут подписи', 'очередь выросла — напоминает');
    assert.equal(pOwner.got().filter((x) => /подписи/.test(x.title)).length, 0, 'у владельца нет подписи — ему не о чем напоминать');
  });

  await step('владельцу: «до конца подписки 3 дня, не хватает X ₽» — один раз за период', async () => {
    const t = one("SELECT id FROM tariffs WHERE name = 'Парк'").id;
    db.prepare("UPDATE parks SET tariff_id = ?, trial_until = '', paid_until = ?, balance = 30000 WHERE id = 1").run(t, addDays(today, 3));
    await push.tick(at(today, '10:00'));
    const m = pOwner.got().find((x) => /подписки/.test(x.title));
    assert.equal(m.title, 'До конца подписки 3 дня');
    assert.match(m.body, /не хватает 690 ₽/);
    assert.equal(m.url, '/p/billing');
    await push.tick(at(today, '11:00'));
    assert.equal(pOwner.got().filter((x) => /подписки/.test(x.title)).length, 1);
    assert.equal(pDisp.got().filter((x) => /подписки/.test(x.title)).length, 0, 'диспетчеру про деньги не пишем');
    await owner.post('/p/notify', { on: [] });
    assert.equal(one("SELECT push_off FROM users WHERE login = 'powner'").push_off, 'sign,sub');
    assert.match((await disp.get('/p/notify')).text, /Листы ждут моей подписи/);
    assert.doesNotMatch((await disp.get('/p/notify')).text, /Подписка и баланс/, 'диспетчеру этот пункт не показываем');
  });

  await step('второй парк не получает уведомлений первого и не может отписать чужой телефон', async () => {
    await ownerB.post('/signup', { park: 'Другой парк', city: 'Москва', tz: 'Europe/Moscow', name: 'Другой Владелец', phone: '89000000099', email: 'b@example.ru', login: 'bowner', password: 'owner-pass-1', agree: '1' });
    await ownerB.post('/p/staff', { name: 'Диспетчер Другой', role: 'dispatcher', login: 'bdisp', password: 'disp-pass-1' });
    await dispB.post('/login/staff', { login: 'bdisp', password: 'disp-pass-1' });
    db.prepare("UPDATE parks SET settings = json_set(settings, '$.eplMode', 'sandbox') WHERE id = 2").run();
    await dispB.post('/p/me', { sig_type: 'goskey', sig_cert: 'GK-B' });
    assert.equal((await dispB.json('/api/push/subscribe', pDispB.sub)).status, 200);
    assert.equal(JSON.parse((await dispB.json('/api/push/unsubscribe', { endpoint: pDisp.endpoint })).text).ok, false);
    assert.equal(one('SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = ?', pDisp.endpoint).n, 1, 'чужая подписка на месте');
    await disp.post('/p/issue', { driver: '2', days: addDays(today, 5) });
    await push.tick(new Date(Date.now() + 4 * 3600e3));
    assert.equal(pDispB.got().length, 0, 'диспетчер второго парка ничего не получил');
    assert.ok(pDisp.got().length >= 3);
  });

  await step('push-сервис сказал «подписки нет» — она удаляется; новый пароль водителя отключает его телефоны', async () => {
    gone.add(pDrv.endpoint);
    db.prepare("UPDATE parks SET settings = json_set(settings, '$.eplMode', 'off') WHERE id = 1").run();
    await disp.post('/p/issue', { driver: '1', days: addDays(today, 2) });
    await push.tick(at(addDays(today, 1), '18:10'));
    assert.equal(one('SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = ?', pDrv.endpoint).n, 0);
    assert.equal(one("SELECT COUNT(*) AS n FROM push_subs WHERE kind = 'driver' AND subject_id = 2").n, 1);
    await disp.post('/p/drivers/2/pin', { pin: '7777' });
    assert.equal(one("SELECT COUNT(*) AS n FROM push_subs WHERE kind = 'driver' AND subject_id = 2").n, 0);
    assert.equal((await drv2.json('/api/push/unsubscribe', { endpoint: pDrv2.endpoint })).status, 401, 'старая сессия водителя закрыта');
  });

  console.log(`\nУведомления: проверок пройдено ${passed}.`);
} catch (e) {
  console.error('\n✗ Провал после', passed, 'проверок:\n', e);
  process.exitCode = 1;
} finally {
  server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
}
