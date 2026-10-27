// Production readiness: legal pages with the platform's requisites, health check, database backups.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.SUPER_PASSWORD = 'root-test-pass';
const { createApp } = await import('../src/server.js');
const { backupDb } = await import('../scripts/backup.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'putevka-launch-'));
const dbFile = path.join(dir, 't.db');
const { app, db } = createApp({ dbFile, log: () => {} });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

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
    return { status: r.status, loc: r.headers.get('location'), text: await r.text(), type: r.headers.get('content-type'), headers: r.headers };
  };
  return { get: (u) => call('GET', u), post: (u, f) => call('POST', u, f) };
}

let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };
const root = client(), owner = client();

try {
  await step('без реквизитов документы открываются и честно говорят, что реквизитов нет', async () => {
    const r = await client().get('/offer');
    assert.equal(r.status, 200);
    assert.match(r.text, /Реквизиты ещё не заполнены/);
  });

  await step('администратор заполняет реквизиты — они появляются в оферте и политике', async () => {
    await root.post('/login/staff', { login: 'root', password: 'root-test-pass' });
    const r = await root.post('/s/platform', { reqName: 'ООО «Путёвка»', reqInn: '7700000001', reqKpp: '770001001', reqOgrn: '1207700000001', reqAddr: '127000, г. Москва, ул. Примерная, д. 10',
      reqAccount: '40702810900000000001', reqBank: 'АО «Банк»', reqBic: '044525000', reqCorr: '30101810400000000225', reqVat: 'none', supportEmail: 'help@example.ru', supportPhone: '+7 900 000-00-00', signupOpen: '1', legalDate: '2026-10-27' });
    assert.equal(r.loc, '/s/platform');
    assert.match((await root.get('/s/platform')).text, /name="reqOgrn"[^>]*value="1207700000001"/);
    for (const url of ['/offer', '/privacy']) {
      const p = await client().get(url);
      assert.equal(p.status, 200);
      assert.match(p.text, /ООО «Путёвка»/);
      assert.match(p.text, /ОГРН 1207700000001/);
      assert.match(p.text, /Редакция от 27\.10\.2026/);
      assert.match(p.text, /help@example\.ru/);
      assert.doesNotMatch(p.text, /Реквизиты ещё не заполнены/);
      assert.doesNotMatch(p.text, /style=|<script(?! src)/, 'CSP: без inline-стилей и скриптов');
    }
  });

  await step('оферта показывает текущие цены тарифов и услуг, политика — 152-ФЗ и хранение в РФ', async () => {
    const offer = (await client().get('/offer')).text;
    assert.match(offer, /Старт/);
    assert.match(offer, /19 ₽/);
    assert.match(offer, /990 ₽/);
    assert.match(offer, /49 ₽ за осмотр/);
    assert.match(offer, /не подписывает документы за пользователей/);
    db.prepare("UPDATE tariffs SET per_sheet = 2100 WHERE name = 'Старт'").run();
    assert.match((await client().get('/offer')).text, /21 ₽/, 'цены берутся из базы, а не из текста');
    const privacy = (await client().get('/privacy')).text;
    assert.match(privacy, /152-ФЗ/);
    assert.match(privacy, /СНИЛС/);
    assert.match(privacy, /в Российской Федерации/);
    assert.match(privacy, /только фамилию и инициалы/);
  });

  await step('ссылки на документы: подвал, форма регистрации, счёт', async () => {
    const home = (await client().get('/')).text;
    assert.match(home, /class="pub-foot"[\s\S]*href="\/offer"[\s\S]*href="\/privacy"/);
    const su = (await client().get('/signup')).text;
    assert.match(su, /name="agree"[\s\S]{0,200}href="\/offer"[\s\S]{0,200}href="\/privacy"/);
    await owner.post('/signup', { park: 'Такси Тест', city: 'Москва', tz: 'Europe/Moscow', name: 'Иванов Иван Иванович', phone: '89000000000', email: 'p@example.ru', login: 'lowner', password: 'owner-pass-1', agree: '1' });
    const inv = await owner.post('/p/billing/invoice', { amount: '5000', p_name: 'ООО «Такси Тест»', p_inn: '7700000002' });
    const page = await owner.get(inv.loc);
    assert.match(page.text, new RegExp(`href="${base.replace(/[.:/]/g, '\\$&')}/offer"`));
    assert.match(page.text, /Основание[\s\S]{0,120}Договор-оферта/);
    const adm = await root.get(`/s/invoice/${inv.loc.split('/').pop()}`);
    assert.match(adm.text, /\/offer"/);
  });

  await step('/health: без входа, без кеша, с проверкой базы', async () => {
    const r = await client().get('/health');
    assert.equal(r.status, 200);
    assert.match(r.type, /json/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const j = JSON.parse(r.text);
    assert.equal(j.ok, true);
    assert.equal(j.db, 'ok');
    assert.match(j.version, /^\d+\.\d+\.\d+$/);
  });

  await step('резервная копия: целая база, хранится 14 последних', async () => {
    const out = path.join(dir, 'backups');
    let last;
    for (let i = 0; i < 16; i++) last = await backupDb({ dbFile, dir: out, now: new Date(Date.UTC(2026, 9, 1 + i, 3, 0, 0)) });
    const files = fs.readdirSync(out).sort();
    assert.equal(files.length, 14);
    assert.equal(files[0], 'putevka-2026-10-03_030000.db', 'две самые старые копии удалены');
    assert.equal(path.basename(last.file), 'putevka-2026-10-16_030000.db');
    assert.equal(last.removed.length, 1);
    const copy = new Database(last.file, { readonly: true });
    assert.equal(copy.prepare("SELECT name FROM parks WHERE name = 'Такси Тест'").get().name, 'Такси Тест');
    copy.close();
    fs.writeFileSync(path.join(out, 'чужой-файл.txt'), 'x');
    await backupDb({ dbFile, dir: out, now: new Date(Date.UTC(2026, 9, 20)) });
    assert.ok(fs.existsSync(path.join(out, 'чужой-файл.txt')), 'посторонние файлы не трогаются');
    await assert.rejects(backupDb({ dbFile: path.join(dir, 'нет.db'), dir: out }), /База не найдена/);
  });

  await step('/health отвечает 503, если база недоступна', async () => {
    db.close();
    const r = await client().get('/health');
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.text).ok, false);
  });

  console.log(`\nЗапуск: проверок пройдено ${passed}.`);
} catch (e) {
  console.error('\n✗ Провал после', passed, 'проверок:\n', e);
  process.exitCode = 1;
} finally {
  server.close(); if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true });
}
