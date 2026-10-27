import express from 'express';
import { toInt } from '../util.js';
import { qrSvg } from '../waybill.js';
import { isYooKassaIp, PayError } from '../payments.js';
import * as C from '../views/common.js';
import * as BV from '../views/billing.js';

export default function payRoutes(app, { db, auth, payments, epd, wrap, baseUrl }) {
  // ЭПД operator notification. Must carry the operator's HMAC signature; even then the body only says
  // which signing or registration changed, and the state is re-read from the operator's API.
  app.post('/epd/notify', express.json({ limit: '64kb', verify: (req, res, buf) => { req.rawBody = buf; } }), wrap(async (req, res) => {
    const op = epd.operator;
    if (op.sandbox || !op.checkNotification?.(req.rawBody || Buffer.alloc(0), req.get('x-signature'))) return res.status(403).end();
    await epd.notify(op.parseNotification(req.body));
    res.status(200).end();
  }));

  // YooKassa notification. The body only says which payment changed; the real status is re-read from the API.
  app.post('/pay/yookassa', express.json({ limit: '64kb' }), wrap(async (req, res) => {
    if (process.env.YOOKASSA_CHECK_IP === '1' && !isYooKassaIp(req.ip)) return res.status(403).end();
    try { await payments.webhook(req.body); }
    catch (e) { if (!(e instanceof PayError)) throw e; console.error('yookassa webhook:', e.message); }
    res.status(200).end();
  }));

  // Built-in test payment form, only while no YooKassa keys are configured.
  const own = (req) => {
    const p = payments.get(toInt(req.params.id));
    if (!p || p.provider !== 'demo' || !req.user || req.user.park_id !== p.park_id || req.user.role !== 'owner') return null;
    return p;
  };
  app.get('/pay/demo/:id', wrap(async (req, res) => {
    const p = own(req);
    if (!p) return res.redirect('/p/billing');
    if (p.status !== 'pending') return res.redirect(`/p/billing/return/${p.id}`);
    const park = db.prepare('SELECT * FROM parks WHERE id = ?').get(p.park_id);
    const qr = p.method === 'sbp' ? await qrSvg(`${baseUrl(req)}/pay/demo/${p.id}`) : '';
    res.type('html').send(C.publicPage({ title: 'Тестовая оплата', bare: true, body: BV.demoPayBody({ p, park, qr }) }));
  }));
  app.post('/pay/demo/:id', (req, res) => {
    const p = own(req);
    if (!p) return res.redirect('/p/billing');
    payments.demoFinish(p.id, req.body.result === 'ok');
    res.redirect(`/p/billing/return/${p.id}`);
  });
  void auth;
}
