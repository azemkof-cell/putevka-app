// Checks the YooKassa integration against a fake YooKassa API: request shape, webhook, idempotency, tampering.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.SUPER_PASSWORD = 'root-test-pass';
const { createApp } = await import('../src/server.js');

const api = { created: [], status: new Map(), failCreate: false, headers: null };
const fakeFetch = async (url, opts = {}) => {
  const u = new URL(url);
  const json = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
  if (opts.method === 'POST' && u.pathname === '/v3/payments') {
    if (api.failCreate) return json(401, { type: 'error', description: 'Authentication error' });
    const body = JSON.parse(opts.body);
    api.headers = opts.headers;
    const id = `yk-${api.created.length + 1}`;
    api.created.push({ id, body });
    api.status.set(id, { id, status: 'pending', paid: false, amount: body.amount, metadata: body.metadata });
    return json(200, { id, status: 'pending', confirmation: { type: 'redirect', confirmation_url: `https://yoomoney.ru/checkout/payments/v2/contract?orderId=${id}` } });
  }
  const m = u.pathname.match(/^\/v3\/payments\/(.+)$/);
  if (opts.method === 'GET' && m) return json(200, api.status.get(decodeURIComponent(m[1])) || {});
  return json(404, {});
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'putevka-yk-'));
const { app, db } = createApp({ dbFile: path.join(dir, 't.db'), log: () => {}, payments: { yookassa: { shopId: '123456', secret: 'test_secret', receipts: '1' }, fetchImpl: fakeFetch } });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const jar = {};
const call = async (method, url, form) => {
  const headers = {};
  const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  if (ck) headers.cookie = ck;
  let body;
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers.origin = base; body = new URLSearchParams(form).toString(); }
  const r = await fetch(base + url, { method, headers, body, redirect: 'manual' });
  for (const c of r.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); if (/Max-Age=0/.test(c)) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = kv.slice(i + 1); }
  return { status: r.status, loc: r.headers.get('location'), text: await r.text() };
};
const hook = (obj) => fetch(base + '/pay/yookassa', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'notification', event: 'payment.succeeded', object: obj }) });
const balance = () => db.prepare('SELECT balance FROM parks WHERE id = 1').get().balance;

let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };
try {
  await call('POST', '/signup', { park: 'Такси Тест', city: 'Казань', tz: 'Europe/Moscow', name: 'Иванов Иван', phone: '89000000000', email: 'park@example.ru', login: 'ykowner', password: 'owner-pass-1', agree: '1' });

  await step('запрос в ЮKassa: сумма, способ, возврат, чек, ключ идемпотентности', async () => {
    const r = await call('POST', '/p/billing/pay', { amount: 'other', amount_other: '1500', method: 'card' });
    assert.equal(r.loc, 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=yk-1');
    const b = api.created[0].body;
    assert.deepEqual(b.amount, { value: '1500.00', currency: 'RUB' });
    assert.equal(b.payment_method_data.type, 'bank_card');
    assert.equal(b.capture, true);
    assert.equal(b.confirmation.type, 'redirect');
    assert.match(b.confirmation.return_url, /\/p\/billing\/return\/1$/);
    assert.equal(b.metadata.payment_id, '1');
    assert.equal(b.receipt.customer.email, 'park@example.ru');
    assert.equal(b.receipt.items[0].payment_mode, 'advance');
    assert.equal(api.headers.Authorization, 'Basic ' + Buffer.from('123456:test_secret').toString('base64'));
    assert.ok(api.headers['Idempotence-Key']);
  });

  await step('поддельное уведомление «оплачено» не зачисляет деньги', async () => {
    const r = await hook({ id: 'yk-1', status: 'succeeded', paid: true, amount: { value: '1500.00' } });
    assert.equal(r.status, 200);
    assert.equal(balance(), 0, 'API говорит pending — денег нет');
  });

  await step('настоящее уведомление зачисляет ровно один раз', async () => {
    api.status.set('yk-1', { ...api.status.get('yk-1'), status: 'succeeded', paid: true });
    await hook({ id: 'yk-1' });
    await hook({ id: 'yk-1' });
    assert.equal(balance(), 150000);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'topup'").get().n, 1);
    const back = await call('GET', '/p/billing/return/1');
    assert.equal(back.loc, '/p/billing');
    assert.match((await call('GET', '/p/billing')).text, /Оплата прошла/);
  });

  await step('СБП: если сумма в ЮKassa не совпала, деньги не зачисляются', async () => {
    const r = await call('POST', '/p/billing/pay', { amount: '2000', method: 'sbp' });
    assert.match(r.loc, /orderId=yk-2/);
    assert.equal(api.created[1].body.payment_method_data.type, 'sbp');
    api.status.set('yk-2', { ...api.status.get('yk-2'), status: 'succeeded', paid: true, amount: { value: '1.00', currency: 'RUB' } });
    assert.equal((await hook({ id: 'yk-2' })).status, 200);
    assert.equal(balance(), 150000);
  });

  await step('неизвестный платёж и ошибка ЮKassa обрабатываются спокойно', async () => {
    assert.equal((await hook({ id: 'nope' })).status, 200);
    api.failCreate = true;
    const r = await call('POST', '/p/billing/pay', { amount: '1000', method: 'card' });
    assert.equal(r.loc, '/p/billing');
    assert.match((await call('GET', '/p/billing')).text, /Платёжный сервис ответил ошибкой/);
    assert.equal(db.prepare("SELECT status FROM payments ORDER BY id DESC").get().status, 'canceled');
  });

  console.log(`\nЮKassa: проверок пройдено ${passed}.`);
} catch (e) {
  console.error('\n✗ Провал после', passed, 'проверок:\n', e);
  process.exitCode = 1;
} finally {
  server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
}
