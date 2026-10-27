import { toInt } from '../util.js';
import { parseSignItems } from '../epd.js';
import * as C from '../views/common.js';
import * as EV from '../views/epl.js';
import { serviceHome } from '../views/services.js';

/**
 * Cabinet of the service's own signers: partner medics (remote pre-trip checks) and the service's mechanics.
 * They see only parks that subscribed to their service, sign with their own signature,
 * and every signature is charged to the park at the service price.
 */
export default function serviceRoutes(app, { db, auth, epd, fail, UserError }) {
  const need = (req, res, next) => {
    if (!req.user) return res.redirect('/login?staff=1');
    if (!req.user.service) return res.redirect(req.user.role === 'super' ? '/s' : '/p');
    next();
  };
  const page = (req, res, { title, body, active }, code = 200) => {
    const total = epd.serviceParks(req.user).reduce((a, p) => a + p.waiting, 0);
    res.status(code).type('html').send(C.staffPage({
      title, body, active, user: req.user, park: null, flash: req.flash,
      side: [req.user.role === 'medic' ? 'Медосмотры' : 'Выпуск на линию', req.user.svc_org || 'исполнитель сервиса'],
      nav: [['queue', '/x', 'Очередь', total || ''], ['me', '/x/me', 'Моя подпись', '']]
    }));
  };
  const parkOf = (req) => {
    const id = toInt(req.query.park ?? req.body?.park);
    const hit = epd.serviceParks(req.user).find((p) => p.park.id === id);
    return hit ? hit.park : null;
  };

  app.get('/x', need, (req, res) => {
    const parks = epd.serviceParks(req.user);
    const park = parkOf(req) || (parks.find((p) => p.waiting) || parks[0])?.park || null;
    const queue = park ? EV.queuePage({
      q: epd.queue(req.user, park), user: req.user, sandbox: epd.operator.sandbox, operatorName: epd.operator.name,
      action: `/x/sign?park=${park.id}`, meHref: '/x/me', title: park.name,
      note: `<p class="hint">${req.user.role === 'medic' ? 'Подписывайте только тех, кого осмотрели через комплекс в парке.' : 'Подписывайте выпуск только после осмотра машины на стоянке.'} Каждая подпись оплачивается парком по тарифу услуги.</p>`
    }) : '';
    page(req, res, { title: 'Очередь', active: 'queue', body: serviceHome({ parks, current: park, queue, user: req.user }) });
  });

  app.post('/x/sign', need, (req, res) => {
    try {
      const park = parkOf(req);
      if (!park) throw new UserError('Таксопарк не подключил вашу услугу.');
      const id = epd.startSession(req.user, park, parseSignItems(req.body));
      res.redirect(`/x/sign/s/${id}`);
    } catch (e) { fail(req, res, e, '/x'); }
  });
  app.get('/x/sign/s/:id', need, (req, res) => {
    try {
      const s = epd.getSession(toInt(req.params.id), req.user);
      if (s.status !== 'waiting') return res.redirect('/x');
      const items = JSON.parse(s.items);
      const sheets = new Map(items.map((it) => [it.sheetId, db.prepare('SELECT * FROM sheets WHERE id = ? AND park_id = ?').get(it.sheetId, s.park_id)]));
      page(req, res, { title: 'Подтверждение', active: 'queue', body: EV.sessionPage({ s, items, sheets, sandbox: epd.operator.sandbox, user: req.user, base: '/x/sign' }) });
    } catch (e) { fail(req, res, e, '/x'); }
  });
  app.post('/x/sign/s/:id/confirm', need, (req, res) => {
    try {
      if (!epd.operator.sandbox) throw new UserError('Подтверждение приходит от оператора, страница обновится сама.');
      const s = epd.getSession(toInt(req.params.id), req.user);
      const r = epd.confirm(s.id, req.user);
      const failed = r.failed.map((f) => `№ ${f.no}: ${f.msg}`).join('; ');
      auth.flash(res, `Подписано: ${r.done.length}.${failed ? ` Не подписано: ${failed}.` : ''}`, r.failed.length ? (r.done.length ? 'warn' : 'bad') : 'ok');
      res.redirect(`/x?park=${s.park_id}`);
    } catch (e) { fail(req, res, e, '/x'); }
  });
  app.post('/x/sign/s/:id/cancel', need, (req, res) => {
    try { epd.cancel(toInt(req.params.id), req.user); auth.flash(res, 'Подписание отменено.'); res.redirect('/x'); }
    catch (e) { fail(req, res, e, '/x'); }
  });

  app.get('/x/me', need, (req, res) => page(req, res, { title: 'Моя подпись', active: 'me', body: EV.mySignaturePage({ user: req.user, sandbox: epd.operator.sandbox, action: '/x/me' }) }));
  app.post('/x/me', need, (req, res) => {
    const type = req.user.role === 'medic' ? 'ukep' : (['ukep', 'goskey'].includes(req.body.sig_type) ? req.body.sig_type : 'goskey');
    const cert = String(req.body.sig_cert || '').trim().slice(0, 64);
    if (!cert) { auth.flash(res, 'Укажите серийный номер сертификата.', 'bad'); return res.redirect('/x/me'); }
    db.prepare('UPDATE users SET sig_type = ?, sig_cert = ?, sig_ready = ? WHERE id = ?').run(type, cert, epd.operator.sandbox ? 1 : 0, req.user.id);
    auth.flash(res, 'Подпись подключена. Подписывать можете только вы.');
    res.redirect('/x/me');
  });
}
