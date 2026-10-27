import crypto from 'node:crypto';
import { nowIso, fRub, plural } from './util.js';
import { dayKey, addDays, daysBetween, ruDay } from './time.js';

/**
 * Web Push without extra dependencies: VAPID (RFC 8292, ES256) and payload encryption (RFC 8291, aes128gcm).
 * Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url, `node scripts/vapid-keys.mjs` makes a pair)
 * and VAPID_SUBJECT (mailto: or https: contact for push services).
 *
 * Events are written to push_outbox inside the same transaction as the change they report,
 * so a rolled-back mark never sends a notification; flush() delivers them afterwards.
 */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');

/** What each person can switch on or off. */
export const EVENTS = {
  driver: { med: 'Медосмотр', line: 'Выпуск на линию', tomorrow: 'Лист на завтра готов' },
  staff: { sign: 'Листы ждут моей подписи', sub: 'Подписка и баланс' }
};
export const staffEvents = (user) => Object.fromEntries(Object.entries(EVENTS.staff).filter(([k]) => k !== 'sub' || user.role === 'owner'));

// Push services of the browsers our users have. The server POSTs only there, never to an arbitrary address.
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'];
export function allowedEndpoint(url, extra = process.env.PUSH_HOSTS) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.port) return false;
  const hosts = PUSH_HOSTS.concat(String(extra || '').split(',').map((h) => h.trim()).filter(Boolean));
  return hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function vapidKey(publicKey, privateKey) {
  const pub = unb64u(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY: нужен несжатый ключ P-256 (65 байт, base64url)');
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: privateKey }, format: 'jwk' });
}

/** Authorization header for one push service origin. */
export function vapidAuth({ endpoint, publicKey, key, subject, now = Date.now() }) {
  const enc = (o) => b64u(JSON.stringify(o));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${publicKey}`;
}

/** Encrypts the payload for one subscription (RFC 8291). */
export function encrypt(payload, { p256dh, auth }) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('неверные ключи подписки');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}

export function makePush(db, { env = process.env, fetchImpl = (...a) => fetch(...a), log = console.error, billing = null } = {}) {
  const publicKey = env.VAPID_PUBLIC_KEY || '';
  const enabled = !!(publicKey && env.VAPID_PRIVATE_KEY);
  const key = enabled ? vapidKey(publicKey, env.VAPID_PRIVATE_KEY) : null;
  const subject = env.VAPID_SUBJECT || 'mailto:support@example.ru';

  const q = {
    subsOf: db.prepare('SELECT * FROM push_subs WHERE kind = ? AND subject_id = ?'),
    add: db.prepare(`INSERT INTO push_subs (kind, subject_id, park_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET kind = excluded.kind, subject_id = excluded.subject_id, park_id = excluded.park_id, p256dh = excluded.p256dh, auth = excluded.auth`),
    del: db.prepare('DELETE FROM push_subs WHERE endpoint = ?'),
    delMine: db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND kind = ? AND subject_id = ?'),
    enqueue: db.prepare(`INSERT OR IGNORE INTO push_outbox (kind, subject_id, park_id, event, dedup, title, body, url, created_at)
      VALUES (@kind, @subject_id, @park_id, @event, @dedup, @title, @body, @url, @created_at)`),
    pending: db.prepare('SELECT * FROM push_outbox WHERE sent_at IS NULL ORDER BY id LIMIT 200'),
    sent: db.prepare('UPDATE push_outbox SET sent_at = ?, delivered = ? WHERE id = ?'),
    driver: db.prepare('SELECT * FROM drivers WHERE id = ?'),
    user: db.prepare('SELECT * FROM users WHERE id = ? AND active = 1')
  };

  const offList = (row) => String(row?.push_off || '').split(',').filter(Boolean);
  const wants = (kind, subjectId, event) => {
    const row = kind === 'driver' ? q.driver.get(subjectId) : q.user.get(subjectId);
    return !!row && !offList(row).includes(event);
  };

  /** Queues a notification; call inside the transaction of the change. `dedup` makes it one-time. */
  function notify({ kind, subjectId, parkId, event, title, body, url = '/', dedup = null }) {
    if (!enabled) return;
    if (!q.subsOf.all(kind, subjectId).length) return; // nobody to tell: do not pile up rows
    q.enqueue.run({ kind, subject_id: subjectId, park_id: parkId, event, dedup, title, body, url, created_at: nowIso() });
    setImmediate(() => flush().catch((e) => log('push flush:', e.message)));
  }

  async function send(sub, payload) {
    const r = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high',
        Authorization: vapidAuth({ endpoint: sub.endpoint, publicKey, key, subject }) },
      body: encrypt(JSON.stringify(payload), sub)
    });
    if (r.status === 404 || r.status === 410) { q.del.run(sub.endpoint); return false; } // the browser dropped this subscription
    if (!r.ok) throw new Error(`push ${r.status}`);
    return true;
  }

  let flushing = null;
  /** Delivers queued notifications to every device of the person who did not switch that kind off. */
  function flush() {
    if (!enabled || !db.open) return Promise.resolve(0);
    flushing ||= (async () => {
      let n = 0;
      for (const m of q.pending.all()) {
        let delivered = 0;
        if (wants(m.kind, m.subject_id, m.event)) {
          for (const sub of q.subsOf.all(m.kind, m.subject_id)) {
            if (sub.park_id !== m.park_id) continue; // a device signed in to another park never gets this park's news
            try { if (await send(sub, { title: m.title, body: m.body, url: m.url, tag: m.event })) delivered++; }
            catch (e) { log('push send:', e.message); }
          }
        }
        q.sent.run(nowIso(), delivered, m.id);
        n += delivered;
      }
      return n;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  function subscribe({ kind, subjectId, parkId, sub }) {
    if (!enabled) throw new Error('Уведомления не настроены на сервере.');
    const endpoint = String(sub?.endpoint || '');
    if (!allowedEndpoint(endpoint)) throw new Error('Этот браузер не поддерживается для уведомлений.');
    const p256dh = String(sub?.keys?.p256dh || ''), auth = String(sub?.keys?.auth || '');
    if (unb64u(p256dh).length !== 65 || unb64u(auth).length !== 16) throw new Error('Неверная подписка.');
    q.add.run(kind, subjectId, parkId, endpoint, p256dh, auth, nowIso());
  }
  const unsubscribe = ({ kind, subjectId, endpoint }) => q.delMine.run(String(endpoint || ''), kind, subjectId).changes > 0;
  const devices = (kind, subjectId) => q.subsOf.all(kind, subjectId).length;

  /**
   * Scheduled notices, run every minute:
   * - drivers at 18:00 park time: tomorrow's waybill is ready (once per sheet);
   * - signers: N sheets wait for their signature (when the number grows, at most every 30 minutes);
   * - owners: the subscription ends in 3 days or less and the balance does not cover it (once per period).
   */
  function scheduled(now = new Date()) {
    if (!enabled) return;
    const parks = db.prepare("SELECT * FROM parks WHERE status = 'active' AND id IN (SELECT park_id FROM push_subs)").all();
    for (const park of parks) {
      const today = dayKey(park.tz, now);
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: park.tz, hour: '2-digit', hourCycle: 'h23' }).format(now));
      const epl = (() => { try { return JSON.parse(park.settings || '{}').eplMode; } catch { return 'off'; } })();
      const tx = db.transaction(() => {
        if (hour >= 18) {
          const tomorrow = addDays(today, 1);
          for (const s of db.prepare(`SELECT s.*, (SELECT 1 FROM epl_titles t WHERE t.sheet_id = s.id AND t.code = 'T1') AS t1 FROM sheets s
            WHERE s.park_id = ? AND s.shift_date = ? AND s.cancelled_at IS NULL AND s.driver_id IN (SELECT subject_id FROM push_subs WHERE kind = 'driver' AND park_id = ?)`).all(park.id, tomorrow, park.id)) {
            if (s.epl && !s.t1) continue; // an electronic sheet is ready only when the task (T1) is signed
            notify({ kind: 'driver', subjectId: s.driver_id, parkId: park.id, event: 'tomorrow', dedup: `tomorrow:${s.id}`,
              title: 'Лист на завтра готов', body: `№ ${s.no} на ${ruDay(s.shift_date)}. Утром пройдите медосмотр.`, url: '/d' });
          }
        }
        const staff = db.prepare("SELECT * FROM users WHERE park_id = ? AND active = 1 AND id IN (SELECT subject_id FROM push_subs WHERE kind = 'user' AND park_id = ?)").all(park.id, park.id);
        if (epl && epl !== 'off' && api.epd) {
          for (const u of staff) {
            const n = api.epd.count(u, park);
            const last = db.prepare("SELECT * FROM push_outbox WHERE kind = 'user' AND subject_id = ? AND event = 'sign' ORDER BY id DESC LIMIT 1").get(u.id);
            const lastN = last ? Number(last.dedup.split(':')[2]) : 0;
            const age = last ? now - new Date(last.created_at) : Infinity;
            // remind when more sheets are waiting than last time, or the same queue is still there 3 hours later
            if (n > 0 && age > 30 * 60e3 && (n > lastN || age > 3 * 3600e3)) {
              notify({ kind: 'user', subjectId: u.id, parkId: park.id, event: 'sign', dedup: `sign:${u.id}:${n}:${now.toISOString().slice(0, 13)}`,
                title: `${n} ${plural(n, 'лист ждёт', 'листа ждут', 'листов ждут')} подписи`, body: 'Откройте «На подпись» и подпишите пачкой.', url: '/p/sign' });
            }
          }
        }
        const a = billing?.access(park);
        if (a?.state === 'active' && park.balance < a.monthly) {
          const left = daysBetween(today, a.until);
          if (left >= 0 && left <= 3) {
            for (const u of staff.filter((x) => x.role === 'owner')) {
              notify({ kind: 'user', subjectId: u.id, parkId: park.id, event: 'sub', dedup: `sub:${park.id}:${a.until}:${u.id}`,
                title: `До конца подписки ${left === 0 ? 'последний день' : `${left} ${plural(left, 'день', 'дня', 'дней')}`}`,
                body: `На балансе не хватает ${fRub(a.monthly - park.balance)}. Пополните, чтобы листы выписывались без перерыва.`, url: '/p/billing' });
            }
          }
        }
      });
      tx();
    }
  }

  async function tick(now = new Date()) {
    scheduled(now);
    return flush();
  }

  // epd is attached after it is built: it needs the service, which needs notify()
  const api = { enabled, publicKey, epd: null, notify, flush, subscribe, unsubscribe, devices, scheduled, tick, wants, offList };
  return api;
}
