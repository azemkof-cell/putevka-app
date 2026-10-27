import crypto from 'node:crypto';
import { nowIso, shortName } from './util.js';
import { sheetStatus, UserError } from './service.js';
import { astralOperator } from './epd/astral.js';

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

/**
 * The ЭПД operator interface. Every operator (the sandbox below, src/epd/astral.js) implements:
 *   verifySigner({ cert, type })               → { found, cert, owner, type }   whose certificate it is
 *   startSigning(session, user, docs)          → { operatorId, app, code }      the batch goes to the signer's own app
 *   pollSigning(operatorId)                    → { status: waiting|signed|rejected|expired, signatures: [{ ref, id, cert, signedAt }] }
 *   register(sheet, titles)                    → { docId, status: pending|registered|rejected, gisId, error }
 *   status(docId)                              → { status, gisId, error }
 * Methods may be sync or async. Only the operator says that a batch is signed: the app never marks it signed by itself.
 */
export const OPERATOR_METHODS = ['verifySigner', 'startSigning', 'pollSigning', 'register', 'status'];

/** Test operator: same interface as a real one, but talks to nobody. The signer confirms with a button on our page. */
export function sandboxOperator() {
  return {
    name: 'Тестовый оператор ЭПД',
    sandbox: true,
    verifySigner: ({ cert, type }) => ({ found: true, cert, owner: null, type }),
    startSigning: (session, user) => ({ operatorId: `sbx-sign-${session.id}`, app: user.sig_type === 'ukep' ? 'КриптоПро myDSS' : 'Госключ', code: String(crypto.randomInt(1000, 10000)) }),
    pollSigning: () => ({ status: 'waiting', signatures: [] }),
    register: (sheet) => ({ docId: `sbx-${sheet.id}`, status: 'registered', gisId: `ЭПЛ-ТЕСТ-${crypto.randomBytes(5).toString('hex').toUpperCase()}` }),
    status: () => ({ status: 'registered' })
  };
}

/** Picks the operator from EPD_OPERATOR (sandbox by default) and checks it implements the whole interface. */
export function makeOperator({ env = process.env, fetchImpl, callbackUrl } = {}) {
  const kind = env.EPD_OPERATOR || 'sandbox';
  let op;
  if (kind === 'sandbox') op = sandboxOperator();
  else if (kind === 'astral') op = astralOperator({ env, fetchImpl, callbackUrl });
  else throw new Error(`Неизвестный оператор ЭПД: EPD_OPERATOR=${kind}. Доступны: sandbox, astral.`);
  return checkOperator(op);
}
export function checkOperator(op) {
  const missing = OPERATOR_METHODS.filter((m) => typeof op[m] !== 'function');
  if (missing.length) throw new Error(`Оператор ЭПД «${op.name}» не умеет: ${missing.join(', ')}`);
  return op;
}

/** A batch not confirmed within this time is dropped: marks must carry the current time, not the time of a forgotten request. */
export const SIGN_TTL_MIN = 15;
const normName = (n) => String(n || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const normCert = (c) => String(c || '').replace(/[\s:]/g, '').toUpperCase();

/**
 * What exactly the signer signs: one document per title, built from the sheet frozen at issue (snapshot)
 * plus this signer's decision. The hash ties the signature returned by the operator to this content.
 */
export function titleDocument(sheet, code, it, user, at) {
  const sn = JSON.parse(sheet.snapshot);
  const data = code === 'T1' ? { route: sn.blank.route, valid: [sheet.shift_date, sheet.valid_to] }
    : code === 'T2' ? { admitted: it.ok !== false, note: it.note || '', org: user.service ? user.svc_org : undefined }
      : code === 'T3' ? { fit: it.ok !== false, note: it.note || '' }
        : code === 'T4' ? { departed_at: at, odometer: it.odo ?? sheet.odo_out }
          : { returned_at: at, odometer: it.odo ?? sheet.odo_back };
  const body = {
    schema: 'putevka.epl.title/1', title: code, waybill: { no: sheet.no, shift_date: sheet.shift_date, valid_to: sheet.valid_to },
    carrier: { name: sn.carrier.name, inn: sn.carrier.inn, ogrn: sn.carrier.ogrn },
    driver: { name: sn.driver.name, licence: sn.driver.lic }, car: { model: sn.car.model, plate: `${sn.car.num} ${sn.car.reg}` },
    data, signer: { name: user.name, certificate: user.sig_cert }, at
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { ref: `${sheet.id}-${code}`, sheetId: sheet.id, code, name: `${TITLES[code].label}, лист № ${sheet.no}`, body, hash };
}
/** Titles each signing item produces: a refused release is only T3, there is no departure (T4). */
const codesOf = (it) => (it.code === 'T34' ? (it.ok === false ? ['T3'] : ['T3', 'T4']) : [it.code]);

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

export function makeEpd(db, svc, { operator = sandboxOperator(), billing = null, platform = null, log = console.error } = {}) {
  checkOperator(operator);
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
    addTitle: db.prepare(`INSERT INTO epl_titles (park_id, sheet_id, code, signer_id, signer_name, sig_type, cert, signed_at, session_id, operator_id)
      VALUES (@park_id, @sheet_id, @code, @signer_id, @signer_name, @sig_type, @cert, @signed_at, @session_id, @operator_id)`),
    session: db.prepare('SELECT * FROM sign_sessions WHERE id = ?'),
    sessionByOp: db.prepare('SELECT * FROM sign_sessions WHERE operator_id = ?'),
    sheet: db.prepare('SELECT * FROM sheets WHERE id = ? AND park_id = ?'),
    park: db.prepare('SELECT * FROM parks WHERE id = ?'),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    finish: db.prepare("UPDATE sign_sessions SET status = ?, confirmed_at = ?, result = ? WHERE id = ? AND status = 'waiting'"),
    audit: db.prepare('INSERT INTO audit (park_id, at, who, action, details) VALUES (?, ?, ?, ?, ?)')
  };
  const meta = (s) => JSON.parse(s.result || '{}');

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

  /**
   * Connects the user's own signature. With a real operator the certificate must exist there and be issued
   * to this very person; a medic's certificate must be a qualified one (УКЭП).
   */
  async function connectSignature(user, { type, cert }) {
    cert = String(cert || '').trim().slice(0, 64);
    if (!cert) throw new UserError('Укажите серийный номер сертификата из приложения подписи.');
    let r;
    try { r = await operator.verifySigner({ cert, type, user }); }
    catch (e) { log('epd verifySigner:', e.message); throw new UserError('Оператор ЭПД сейчас не отвечает. Попробуйте через несколько минут.'); }
    if (!r?.found) throw new UserError('Оператор ЭПД не нашёл такой сертификат. Проверьте серийный номер в приложении подписи.');
    if (r.owner !== null && normName(r.owner) !== normName(user.name)) throw new UserError(`Сертификат выписан на другого человека (${shortName(r.owner)}). Подключите свою подпись: подписывать чужой нельзя.`);
    const sigType = r.type || type;
    if (user.role === 'medic' && sigType !== 'ukep') throw new UserError('Медработник подписывает медосмотр только квалифицированной подписью (УКЭП).');
    db.prepare('UPDATE users SET sig_type = ?, sig_cert = ?, sig_ready = 1 WHERE id = ?').run(sigType, r.cert || cert, user.id);
    return { type: sigType, cert: r.cert || cert };
  }

  /** A batch to sign. Items: { sheetId, code: 'T1'|'T2'|'T34'|'T5', ok, note, odo }. The batch goes to the signer's own app. */
  async function startSession(user, park, items) {
    const rights = signRights(user);
    if (!items.length) throw new UserError('Отметьте хотя бы один лист.');
    let cost = 0;
    const docs = [];
    const at = nowIso();
    for (const it of items) {
      if (!rights[it.code]) throw new UserError(`Вы не можете подписать «${it.code === 'T34' ? TITLES.T3.label : TITLES[it.code].label}»: ${rights.why.join(', ') || 'другая роль'}.`);
      if (!serviceAllowed(user, park, it.code)) throw new UserError('Этот таксопарк не подключил услугу сервиса.');
      const sheet = q.sheet.get(it.sheetId, park.id);
      if (!sheet || !sheet.epl) throw new UserError('Путевой лист не найден.');
      if (it.ok !== false) cost += servicePrice(user, it.code);
      for (const code of codesOf(it)) docs.push(titleDocument(sheet, code, it, user, at));
    }
    if (cost > 0 && park.balance < cost) throw new UserError('На балансе таксопарка не хватает денег на услугу. Парку нужно пополнить баланс.');
    const id = db.prepare("INSERT INTO sign_sessions (park_id, user_id, items, status, created_at) VALUES (?, ?, ?, 'waiting', ?)")
      .run(park.id, user.id, JSON.stringify(items), at).lastInsertRowid;
    let op;
    try { op = await operator.startSigning(q.session.get(id), user, docs); }
    catch (e) {
      q.finish.run('canceled', nowIso(), JSON.stringify({ reason: 'оператор не принял документы' }), id);
      if (e instanceof UserError) throw e;
      log('epd startSigning:', e.message);
      throw new UserError('Оператор ЭПД сейчас не отвечает. Ничего не подписано, попробуйте через несколько минут.');
    }
    db.prepare('UPDATE sign_sessions SET operator_id = ?, result = ? WHERE id = ?')
      .run(op.operatorId, JSON.stringify({ app: op.app, code: op.code, docs: docs.map((d) => ({ ref: d.ref, code: d.code, sheetId: d.sheetId, hash: d.hash })) }), id);
    return id;
  }

  function getSession(id, user) {
    const s = q.session.get(id);
    if (!s || s.user_id !== user.id) throw new UserError('Подписание не найдено.');
    return s;
  }

  const stop = (s, status, extra) => q.finish.run(status, nowIso(), JSON.stringify({ ...meta(s), ...extra }), s.id);

  /**
   * Signatures returned by the operator must cover every document of the batch, carry the signer's own
   * certificate and the content we sent. Otherwise nothing of the batch is applied.
   */
  function checkSignatures(s, user, sigs) {
    const byRef = new Map(sigs.map((g) => [g.ref, g]));
    for (const d of meta(s).docs || []) {
      const g = byRef.get(d.ref);
      if (!g) return 'оператор вернул не все подписи';
      if (normCert(g.cert) !== normCert(user.sig_cert)) return 'документ подписан не вашим сертификатом';
      if (g.hash && g.hash !== d.hash) return 'подписанный документ не совпадает с отправленным';
    }
    return null;
  }

  /**
   * Applies a batch the signer confirmed in their own app. Each item is applied on its own:
   * if a sheet changed meanwhile (cancelled, already signed), only that item fails.
   * `sigs` are the operator's signatures; the sandbox has none and is confirmed by the signer's button.
   */
  function confirm(id, user, sigs = null) {
    const s = getSession(id, user);
    if (s.status !== 'waiting') throw new UserError('Это подписание уже завершено.');
    if (!operator.sandbox && !sigs) throw new UserError('Подтверждение приходит от оператора, страница обновится сама.');
    if (Date.now() - Date.parse(s.created_at) > SIGN_TTL_MIN * 60e3) {
      stop(s, 'canceled', { reason: `не подтверждено за ${SIGN_TTL_MIN} минут` });
      throw new UserError(`Подписание не подтверждено за ${SIGN_TTL_MIN} минут и отменено. Начните заново.`);
    }
    const fresh = q.user.get(user.id);
    if (!fresh?.active) { stop(s, 'canceled', { reason: 'учётная запись отключена' }); throw new UserError('Учётная запись отключена.'); }
    const rights = signRights(fresh);
    const items = JSON.parse(s.items);
    const sigByRef = new Map((sigs || []).map((g) => [g.ref, g]));
    const done = [], failed = [];
    const now = nowIso();
    const signedAt = (g) => {
      const t = Date.parse(g?.signedAt || '');
      return Number.isFinite(t) && t >= Date.parse(s.created_at) && t <= Date.now() + 60e3 ? new Date(Math.min(t, Date.now())).toISOString() : now;
    };
    const put = (sheet, code) => {
      const g = sigByRef.get(`${sheet.id}-${code}`);
      q.addTitle.run({ park_id: s.park_id, sheet_id: sheet.id, code, signer_id: user.id, signer_name: fresh.name, sig_type: fresh.sig_type, cert: g?.cert || fresh.sig_cert, signed_at: signedAt(g), session_id: s.id, operator_id: g?.id || null });
    };
    for (const it of items) {
      try {
        db.transaction(() => {
          if (!rights[it.code]) throw new UserError(`больше нет права подписи: ${rights.why.join(', ') || 'роль изменилась'}`);
          const sheet = q.sheet.get(it.sheetId, s.park_id);
          if (!sheet || !sheet.epl) throw new UserError('лист не найден');
          const park = q.park.get(s.park_id);
          if (!serviceAllowed(fresh, park, it.code)) throw new UserError('парк отключил услугу');
          const price = it.ok === false ? 0 : servicePrice(fresh, it.code);
          if (price > 0) {
            if (park.balance < price) throw new UserError('у парка закончились деньги на балансе');
            billing.post(s.park_id, -price, 'service', `${it.code === 'T2' ? 'Медосмотр' : 'Выпуск механиком'} сервиса, лист № ${sheet.no}`, fresh.name, sheet.id);
          }
          const have = Object.fromEntries(q.titles.all(sheet.id).map((t) => [t.code, t]));
          if (it.code === 'T1') {
            if (have.T1) throw new UserError('задание уже подписано');
            if (sheet.cancelled_at) throw new UserError('лист аннулирован');
            put(sheet, 'T1');
          } else if (it.code === 'T2') {
            if (!have.T1) throw new UserError('сначала диспетчер подписывает задание');
            svc.markMed(s.park_id, sheet.id, fresh, { ok: it.ok !== false, note: it.note || '' });
            put(sheet, 'T2');
          } else if (it.code === 'T34') {
            if (!have.T2) throw new UserError('нет подписанного медосмотра');
            svc.markTech(s.park_id, sheet.id, fresh, { ok: it.ok !== false, note: it.note || '', odo: it.odo ?? null });
            put(sheet, 'T3');
            if (it.ok !== false) put(sheet, 'T4');
          } else if (it.code === 'T5') {
            if (!have.T4) throw new UserError('нет подписанного выезда');
            svc.accept(s.park_id, sheet.id, fresh, it.odo ?? null);
            put(sheet, 'T5');
          }
        })();
        done.push(it);
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        const sheet = q.sheet.get(it.sheetId, s.park_id);
        failed.push({ ...it, no: sheet?.no, msg: e.message });
      }
    }
    stop(s, 'confirmed', { done: done.length, failed });
    q.audit.run(s.park_id, now, fresh.name, 'Подписал пакет ЭПЛ', `${done.length} из ${items.length}${failed.length ? `, ошибки: ${failed.map((f) => `№ ${f.no}: ${f.msg}`).join('; ')}` : ''}`);
    return { done, failed };
  }

  /**
   * Asks the operator whether the signer confirmed the batch in their app, and applies it when they did.
   * Safe to call any number of times: the page polls it, notifications and the background sync call it too.
   * Returns the session as it is now.
   */
  async function poll(id, user) {
    let s = getSession(id, user);
    if (s.status !== 'waiting') return s;
    const old = Date.now() - Date.parse(s.created_at) > SIGN_TTL_MIN * 60e3;
    if (operator.sandbox) {
      if (old) stop(s, 'canceled', { reason: `не подтверждено за ${SIGN_TTL_MIN} минут` });
      return q.session.get(s.id);
    }
    let r;
    try { r = await operator.pollSigning(s.operator_id); }
    catch (e) { log('epd pollSigning:', e.message); return s; }
    s = q.session.get(s.id);
    if (s.status !== 'waiting') return s; // someone else applied it while we waited for the operator
    if (old && r.status !== 'rejected') {
      // confirmed too late: the marks would carry an old time, so nothing is applied
      stop(s, 'canceled', { reason: `не подтверждено за ${SIGN_TTL_MIN} минут` });
    } else if (r.status === 'signed') {
      const bad = checkSignatures(s, user, r.signatures || []);
      if (bad) {
        stop(s, 'canceled', { reason: bad });
        q.audit.run(s.park_id, nowIso(), user.name, 'Подпись не принята', bad);
      } else {
        confirm(s.id, user, r.signatures);
        await settle(s.park_id);
      }
    } else if (r.status === 'rejected') stop(s, 'canceled', { reason: r.reason || 'вы отклонили подписание в приложении' });
    else if (r.status === 'expired') stop(s, 'canceled', { reason: r.reason || 'время на подтверждение истекло' });
    return q.session.get(s.id);
  }

  /** One line for the signer about how the batch ended. */
  function summary(s) {
    const m = meta(s);
    if (s.status === 'canceled') return { text: `Не подписано: ${m.reason || 'подписание отменено'}.`, tone: 'bad' };
    if (s.status === 'waiting') return { text: 'Ждём подтверждения в приложении подписи.', tone: 'warn' };
    const failed = (m.failed || []).map((f) => `№ ${f.no}: ${f.msg}`).join('; ');
    return { text: `Подписано: ${m.done}.${failed ? ` Не подписано: ${failed}.` : ''}`, tone: m.failed?.length ? (m.done ? 'warn' : 'bad') : 'ok' };
  }

  function cancel(id, user) {
    const s = getSession(id, user);
    if (s.status === 'waiting') stop(s, 'canceled', { reason: 'вы отменили подписание' });
  }

  /**
   * Registration in ГИС ЭПД: once T1–T4 are signed the operator registers the waybill; the answer may come later,
   * so pending registrations are re-checked by status. Operator failures are logged and retried on the next call.
   */
  async function settle(parkId) {
    const rows = db.prepare(`SELECT * FROM sheets WHERE park_id = ? AND epl = 1 AND gis_id IS NULL AND COALESCE(gis_status, '') IN ('', 'pending')
      AND EXISTS (SELECT 1 FROM epl_titles t WHERE t.sheet_id = sheets.id AND t.code = 'T4')`).all(parkId);
    for (const sheet of rows) {
      const have = q.titles.all(sheet.id).filter((t) => ['T1', 'T2', 'T3', 'T4'].includes(t.code));
      if (have.length < 4) continue;
      try {
        const r = sheet.gis_doc ? await operator.status(sheet.gis_doc) : await operator.register(sheet, have);
        const docId = sheet.gis_doc || r.docId;
        if (r.status === 'registered' && r.gisId) {
          db.prepare("UPDATE sheets SET gis_doc = ?, gis_status = 'registered', gis_id = ?, gis_at = ?, gis_error = NULL WHERE id = ?").run(docId, r.gisId, nowIso(), sheet.id);
          q.audit.run(parkId, nowIso(), operator.name, 'ЭПЛ зарегистрирован в ГИС ЭПД', `№ ${sheet.no}: ${r.gisId}`);
        } else if (r.status === 'rejected') {
          db.prepare("UPDATE sheets SET gis_doc = ?, gis_status = 'rejected', gis_error = ? WHERE id = ?").run(docId, String(r.error || 'без причины').slice(0, 300), sheet.id);
          q.audit.run(parkId, nowIso(), operator.name, 'ЭПЛ не зарегистрирован', `№ ${sheet.no}: ${r.error || 'без причины'}`);
        } else {
          db.prepare("UPDATE sheets SET gis_doc = ?, gis_status = 'pending' WHERE id = ?").run(docId, sheet.id);
        }
      } catch (e) {
        log('epd register:', e.message);
      }
    }
  }

  /** Background pass for a real operator: abandoned pages, missed notifications, slow registrations. */
  async function syncAll() {
    for (const s of db.prepare("SELECT * FROM sign_sessions WHERE status = 'waiting'").all()) {
      const u = q.user.get(s.user_id);
      if (u) await poll(s.id, u);
    }
    for (const { park_id } of db.prepare("SELECT DISTINCT park_id FROM sheets WHERE epl = 1 AND gis_id IS NULL AND COALESCE(gis_status, '') IN ('', 'pending') AND shift_date >= date('now', '-7 days')").all()) {
      await settle(park_id);
    }
  }

  /** Operator notification: only says what changed; the state is always re-read from the operator. */
  async function notify({ signingId, docId }) {
    if (signingId) {
      const s = q.sessionByOp.get(signingId);
      const u = s && q.user.get(s.user_id);
      if (u) await poll(s.id, u);
    }
    if (docId) {
      const sheet = db.prepare('SELECT park_id FROM sheets WHERE gis_doc = ?').get(docId);
      if (sheet) await settle(sheet.park_id);
    }
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

  return { operator, servicePrice, serviceAllowed, serviceParks, queue, count, connectSignature, startSession, getSession, confirm, poll, summary, cancel, settle, syncAll, notify, titlesOf, titleMap, signerLine };
}
