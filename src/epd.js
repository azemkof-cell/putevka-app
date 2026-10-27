import crypto from 'node:crypto';
import { nowIso, shortName } from './util.js';
import { sheetStatus, UserError } from './service.js';

/**
 * Electronic waybill (ЭПЛ) through an ЭПД operator.
 *
 * Every part of the waybill ("титул") is signed by the person responsible for it, with that person's
 * own signature, and only after that person confirms the batch in their signing app:
 *   T1 задание водителю          — диспетчер или владелец (УКЭП или Госключ + МЧД)
 *   T2 предрейсовый медосмотр    — медработник, только УКЭП
 *   T3 предрейсовый техконтроль  — аттестованный контролёр техсостояния
 *   T4 выезд: время и одометр    — тот же контролёр
 *   T5 возвращение               — тот же контролёр
 * Nobody can sign for someone else: a session belongs to one user and is confirmed by that user only.
 * When T1–T4 are signed, the operator registers the waybill in ГИС ЭПД.
 */
export const TITLES = {
  T1: { label: 'Задание водителю', who: 'диспетчер' },
  T2: { label: 'Предрейсовый медосмотр', who: 'медработник' },
  T3: { label: 'Предрейсовый техконтроль', who: 'контролёр техсостояния' },
  T4: { label: 'Выезд: время и одометр', who: 'контролёр техсостояния' },
  T5: { label: 'Возвращение: время и одометр', who: 'контролёр техсостояния' }
};
export const SIG_LABEL = { ukep: 'УКЭП (облачная)', goskey: 'Госключ + МЧД' };

/** What a user is allowed to sign, and why not when they cannot. */
export function signRights(u) {
  const r = { T1: false, T2: false, T34: false, T5: false, why: [] };
  if (!u.sig_ready) { r.why.push('подпись не подключена'); return r; }
  if (u.service) {
    // service staff sign only their part, never the park's own task (T1)
    if (u.role === 'medic') { if (u.sig_type === 'ukep') r.T2 = true; else r.why.push('медосмотр подписывается только УКЭП'); }
    if (u.role === 'dispatcher') { if (u.tech_cert) { r.T34 = true; r.T5 = true; } else r.why.push('нет аттестации контролёра техсостояния'); }
    return r;
  }
  if (['owner', 'dispatcher'].includes(u.role)) r.T1 = true;
  if (u.role === 'medic') {
    if (u.sig_type === 'ukep') r.T2 = true;
    else r.why.push('медосмотр подписывается только УКЭП');
  }
  if (['owner', 'dispatcher'].includes(u.role)) {
    if (u.tech_cert) { r.T34 = true; r.T5 = true; } else r.why.push('нет аттестации контролёра техсостояния');
  }
  return r;
}

/** Test operator: behaves like a real one (sessions, confirmation, registration) but talks to nobody. */
function sandboxOperator() {
  return {
    name: 'Тестовый оператор ЭПД',
    sandbox: true,
    startSigning: (session, user) => ({ operatorId: `sbx-sign-${session.id}`, app: user.sig_type === 'ukep' ? 'КриптоПро myDSS' : 'Госключ', code: String(crypto.randomInt(1000, 10000)) }),
    register: () => ({ gisId: `ЭПЛ-ТЕСТ-${crypto.randomBytes(5).toString('hex').toUpperCase()}` })
  };
}

/** Reads the signing form: checked rows "T2:15", plus ok_15 / note_15 / odo_15 for each row. */
export function parseSignItems(b) {
  const picks = Array.isArray(b.pick) ? b.pick : b.pick ? [b.pick] : [];
  const int = (v) => { const n = parseInt(String(v ?? '').replace(/\s/g, ''), 10); return Number.isFinite(n) ? n : null; };
  return picks.map((v) => {
    const [code, id] = String(v).split(':');
    const sheetId = int(id);
    const it = { code, sheetId };
    if (code === 'T2' || code === 'T34') {
      it.ok = b[`ok_${sheetId}`] !== '0';
      it.note = String(b[`note_${sheetId}`] || '').trim().slice(0, 200);
      if (!it.ok && !it.note) throw new UserError('Укажите причину отказа.');
    }
    if (code === 'T34' || code === 'T5') it.odo = int(b[`odo_${sheetId}`]);
    return it;
  }).filter((it) => ['T1', 'T2', 'T34', 'T5'].includes(it.code) && it.sheetId);
}

/** Which paid service covers a part of the waybill, if a service signer signs it. */
export const SERVICE_OF = { T2: 'Med', T34: 'Mech', T5: 'Mech' };

export function makeEpd(db, svc, { operator = sandboxOperator(), billing = null, platform = null } = {}) {
  const parkSet = (park) => { try { return JSON.parse(park.settings || '{}'); } catch { return {}; } };
  /** Price of one service signature for this park (0 when the park signs itself). */
  function servicePrice(user, code) {
    if (!user.service || !SERVICE_OF[code] || code === 'T5') return 0;
    return Number(platform?.get()[`svc${SERVICE_OF[code]}Price`] || 0);
  }
  /** Is the park subscribed to the service this signer provides, and is the service open? */
  function serviceAllowed(user, park, code) {
    if (!user.service) return true;
    const kind = SERVICE_OF[code];
    if (!kind) return false;
    const p = platform?.get() || {};
    return p[`svc${kind}On`] === '1' && parkSet(park)[`svc${kind}`] === '1' && park.status === 'active';
  }
  const q = {
    titles: db.prepare('SELECT * FROM epl_titles WHERE sheet_id = ? ORDER BY code'),
    titlesFor: (ids) => (ids.length ? db.prepare(`SELECT * FROM epl_titles WHERE sheet_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : []),
    addTitle: db.prepare(`INSERT INTO epl_titles (park_id, sheet_id, code, signer_id, signer_name, sig_type, cert, signed_at, session_id)
      VALUES (@park_id, @sheet_id, @code, @signer_id, @signer_name, @sig_type, @cert, @signed_at, @session_id)`),
    session: db.prepare('SELECT * FROM sign_sessions WHERE id = ?'),
    sheet: db.prepare('SELECT * FROM sheets WHERE id = ? AND park_id = ?'),
    audit: db.prepare('INSERT INTO audit (park_id, at, who, action, details) VALUES (?, ?, ?, ?, ?)')
  };

  const titleMap = (sheetIds) => {
    const m = new Map();
    for (const t of q.titlesFor(sheetIds)) {
      if (!m.has(t.sheet_id)) m.set(t.sheet_id, {});
      m.get(t.sheet_id)[t.code] = t;
    }
    return m;
  };

  /** Sheets waiting for this user's signature, grouped by what has to be signed. */
  function queue(user, park) {
    const rights = signRights(user);
    const rows = db.prepare(`SELECT * FROM sheets WHERE park_id = ? AND epl = 1 AND cancelled_at IS NULL AND closed_at IS NULL
      AND shift_date >= date('now', '-3 days') ORDER BY shift_date, no`).all(park.id);
    const tm = titleMap(rows.map((s) => s.id));
    const out = { T1: [], T2: [], T34: [], T5: [], rights };
    for (const s of rows) {
      const t = tm.get(s.id) || {};
      const st = sheetStatus(s, park.tz);
      if (!t.T1 && ['planned', 'wait_med'].includes(st)) out.T1.push(s);
      else if (t.T1 && !t.T2 && st === 'wait_med') out.T2.push(s);
      else if (t.T1 && t.T2 && !t.T3 && st === 'wait_tech') out.T34.push(s);
      else if (t.T4 && !t.T5 && ['line', 'returning'].includes(st)) out.T5.push(s);
    }
    return out;
  }

  function count(user, park) {
    const qq = queue(user, park), r = qq.rights;
    return (r.T1 ? qq.T1.length : 0) + (r.T2 ? qq.T2.length : 0) + (r.T34 ? qq.T34.length : 0) + (r.T5 ? qq.T5.length : 0);
  }

  /** A batch to sign. Items: { sheetId, code: 'T1'|'T2'|'T34'|'T5', ok, note, odo }. */
  function startSession(user, park, items) {
    const rights = signRights(user);
    if (!items.length) throw new UserError('Отметьте хотя бы один лист.');
    let cost = 0;
    for (const it of items) {
      if (!rights[it.code]) throw new UserError(`Вы не можете подписать «${it.code === 'T34' ? TITLES.T3.label : TITLES[it.code].label}»: ${rights.why.join(', ') || 'другая роль'}.`);
      if (!serviceAllowed(user, park, it.code)) throw new UserError('Этот таксопарк не подключил услугу сервиса.');
      if (!q.sheet.get(it.sheetId, park.id)) throw new UserError('Путевой лист не найден.');
      if (it.ok !== false) cost += servicePrice(user, it.code);
    }
    if (cost > 0 && park.balance < cost) throw new UserError('На балансе таксопарка не хватает денег на услугу. Парку нужно пополнить баланс.');
    const id = db.prepare("INSERT INTO sign_sessions (park_id, user_id, items, status, created_at) VALUES (?, ?, ?, 'waiting', ?)")
      .run(park.id, user.id, JSON.stringify(items), nowIso()).lastInsertRowid;
    const op = operator.startSigning(q.session.get(id), user);
    db.prepare('UPDATE sign_sessions SET operator_id = ?, result = ? WHERE id = ?').run(op.operatorId, JSON.stringify({ app: op.app, code: op.code }), id);
    return id;
  }

  function getSession(id, user) {
    const s = q.session.get(id);
    if (!s || s.user_id !== user.id) throw new UserError('Подписание не найдено.');
    return s;
  }

  /**
   * The signer confirmed the batch in their app. Each item is applied on its own:
   * if a sheet changed meanwhile (cancelled, already signed), only that item fails.
   */
  function confirm(id, user) {
    const s = getSession(id, user);
    if (s.status !== 'waiting') throw new UserError('Это подписание уже завершено.');
    const items = JSON.parse(s.items);
    const done = [], failed = [];
    const now = nowIso();
    const put = (sheet, code) => q.addTitle.run({ park_id: s.park_id, sheet_id: sheet.id, code, signer_id: user.id, signer_name: user.name, sig_type: user.sig_type, cert: user.sig_cert, signed_at: now, session_id: s.id });
    for (const it of items) {
      try {
        db.transaction(() => {
          const sheet = q.sheet.get(it.sheetId, s.park_id);
          if (!sheet || !sheet.epl) throw new UserError('лист не найден');
          const park = db.prepare('SELECT * FROM parks WHERE id = ?').get(s.park_id);
          if (!serviceAllowed(user, park, it.code)) throw new UserError('парк отключил услугу');
          const price = it.ok === false ? 0 : servicePrice(user, it.code);
          if (price > 0) {
            if (park.balance < price) throw new UserError('у парка закончились деньги на балансе');
            billing.post(s.park_id, -price, 'service', `${it.code === 'T2' ? 'Медосмотр' : 'Выпуск механиком'} сервиса, лист № ${sheet.no}`, user.name, sheet.id);
          }
          const have = Object.fromEntries(q.titles.all(sheet.id).map((t) => [t.code, t]));
          if (it.code === 'T1') {
            if (have.T1) throw new UserError('задание уже подписано');
            if (sheet.cancelled_at) throw new UserError('лист аннулирован');
            put(sheet, 'T1');
          } else if (it.code === 'T2') {
            if (!have.T1) throw new UserError('сначала диспетчер подписывает задание');
            svc.markMed(s.park_id, sheet.id, user, { ok: it.ok !== false, note: it.note || '' });
            put(sheet, 'T2');
          } else if (it.code === 'T34') {
            if (!have.T2) throw new UserError('нет подписанного медосмотра');
            svc.markTech(s.park_id, sheet.id, user, { ok: it.ok !== false, note: it.note || '', odo: it.odo ?? null });
            put(sheet, 'T3');
            if (it.ok !== false) put(sheet, 'T4');
          } else if (it.code === 'T5') {
            if (!have.T4) throw new UserError('нет подписанного выезда');
            svc.accept(s.park_id, sheet.id, user, it.odo ?? null);
            put(sheet, 'T5');
          }
          register(sheet.id, s.park_id);
        })();
        done.push(it);
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        const sheet = q.sheet.get(it.sheetId, s.park_id);
        failed.push({ ...it, no: sheet?.no, msg: e.message });
      }
    }
    db.prepare("UPDATE sign_sessions SET status = 'confirmed', confirmed_at = ?, result = ? WHERE id = ?")
      .run(now, JSON.stringify({ ...JSON.parse(s.result || '{}'), done: done.length, failed }), s.id);
    q.audit.run(s.park_id, now, user.name, 'Подписал пакет ЭПЛ', `${done.length} из ${items.length}${failed.length ? `, ошибки: ${failed.map((f) => `№ ${f.no}: ${f.msg}`).join('; ')}` : ''}`);
    return { done, failed };
  }

  function cancel(id, user) {
    const s = getSession(id, user);
    if (s.status === 'waiting') db.prepare("UPDATE sign_sessions SET status = 'canceled' WHERE id = ?").run(s.id);
  }

  /** Once the pre-trip parts T1–T4 are signed, the operator registers the waybill in ГИС ЭПД. */
  function register(sheetId, parkId) {
    const sheet = q.sheet.get(sheetId, parkId);
    if (!sheet || sheet.gis_id) return;
    const have = new Set(q.titles.all(sheetId).map((t) => t.code));
    if (!['T1', 'T2', 'T3', 'T4'].every((c) => have.has(c))) return;
    const r = operator.register(sheet);
    db.prepare('UPDATE sheets SET gis_id = ?, gis_at = ? WHERE id = ?').run(r.gisId, nowIso(), sheetId);
    q.audit.run(parkId, nowIso(), operator.name, 'ЭПЛ зарегистрирован в ГИС ЭПД', `№ ${sheet.no}: ${r.gisId}`);
  }

  const titlesOf = (sheetId) => Object.fromEntries(q.titles.all(sheetId).map((t) => [t.code, t]));
  const signerLine = (t) => `${shortName(t.signer_name)}, ${SIG_LABEL[t.sig_type] || t.sig_type}`;

  /** Parks a service signer works for, with how many sheets wait for them. */
  function serviceParks(user) {
    if (!user.service) return [];
    return db.prepare("SELECT * FROM parks WHERE status = 'active' ORDER BY name").all()
      .filter((p) => ['T2', 'T34'].some((c) => serviceAllowed(user, p, c)))
      .map((p) => ({ park: p, waiting: count(user, p) }));
  }

  return { operator, servicePrice, serviceAllowed, serviceParks, queue, count, startSession, getSession, confirm, cancel, register, titlesOf, titleMap, signerLine };
}
