import crypto from 'node:crypto';

/**
 * ЭПД operator «Калуга Астрал» (Астрал.Платформа).
 *
 * Implements the operator interface from src/epd.js: verifySigner, startSigning, pollSigning, register, status.
 *
 * IMPORTANT: platform.astral.ru/documentation was not reachable while this adapter was written, so the paths
 * and field names below are OUR contract, gathered in one place (ROUTES and the small mappers under it).
 * When the API access arrives: check each route against the documentation, fix ROUTES and the mappers,
 * and rerun test/astral.mjs with its fake API updated the same way. Nothing else in the app needs to change.
 * The title documents are sent as JSON (titleDocument in src/epd.js); if the operator needs the official XML
 * format of the electronic waybill, build it there.
 *
 * Environment:
 *   EPD_OPERATOR=astral
 *   ASTRAL_API_URL         base URL of the API, e.g. https://…/api/v1
 *   ASTRAL_CLIENT_ID, ASTRAL_CLIENT_SECRET   OAuth 2.0 client credentials (or ASTRAL_API_KEY for a static token)
 *   ASTRAL_TOKEN_URL       token endpoint, default ASTRAL_API_URL + /oauth/token
 *   ASTRAL_WEBHOOK_SECRET  shared secret for the HMAC signature of notifications
 *   ASTRAL_SENDER_ID       our account (abonent) at the operator, if the API asks for it
 */
export const ROUTES = {
  token: '/oauth/token',
  signer: (cert) => `/signers/certificates/${encodeURIComponent(cert)}`,
  startSigning: '/signing/sessions',
  signing: (id) => `/signing/sessions/${encodeURIComponent(id)}`,
  register: '/waybills',
  waybill: (id) => `/waybills/${encodeURIComponent(id)}`
};

export class OperatorError extends Error {}

const SIGNING = { pending: 'waiting', waiting: 'waiting', signed: 'signed', completed: 'signed', rejected: 'rejected', declined: 'rejected', expired: 'expired', canceled: 'expired' };
const WAYBILL = { registered: 'registered', accepted: 'registered', processing: 'pending', pending: 'pending', sent: 'pending', rejected: 'rejected', error: 'rejected' };

export function astralOperator({ env = process.env, fetchImpl = (...a) => fetch(...a), callbackUrl = '' } = {}) {
  const base = String(env.ASTRAL_API_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('EPD_OPERATOR=astral: укажите ASTRAL_API_URL');
  if (!env.ASTRAL_API_KEY && !(env.ASTRAL_CLIENT_ID && env.ASTRAL_CLIENT_SECRET)) throw new Error('EPD_OPERATOR=astral: укажите ASTRAL_CLIENT_ID и ASTRAL_CLIENT_SECRET (или ASTRAL_API_KEY)');
  const tokenUrl = env.ASTRAL_TOKEN_URL || base + ROUTES.token;
  let token = env.ASTRAL_API_KEY ? { value: env.ASTRAL_API_KEY, until: Infinity } : null;

  async function auth() {
    if (token && token.until > Date.now() + 30e3) return token.value;
    const r = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.ASTRAL_CLIENT_ID, client_secret: env.ASTRAL_CLIENT_SECRET }).toString()
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new OperatorError(`Оператор ЭПД не выдал доступ: ${j.error_description || j.error || r.status}`);
    token = { value: j.access_token, until: Date.now() + (Number(j.expires_in) || 300) * 1000 };
    return token.value;
  }

  async function call(method, path, body, { idem, retry = true } = {}) {
    const r = await fetchImpl(base + path, {
      method,
      headers: { Authorization: `Bearer ${await auth()}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idem ? { 'Idempotency-Key': idem } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.status === 401 && retry && !env.ASTRAL_API_KEY) { token = null; return call(method, path, body, { idem, retry: false }); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 404) return null;
    if (!r.ok) throw new OperatorError(`Оператор ЭПД ответил ошибкой: ${j.message || j.error || r.status}`);
    return j;
  }

  return {
    name: 'Калуга Астрал',
    sandbox: false,

    /** Does this certificate exist, and whose is it? The app compares the owner with the user's own name. */
    async verifySigner({ cert }) {
      const j = await call('GET', ROUTES.signer(cert));
      if (!j) return { found: false };
      return { found: true, cert: String(j.serial || cert), owner: String(j.owner?.name || j.subject || ''), type: j.type === 'goskey' ? 'goskey' : 'ukep', validTo: j.valid_to || '' };
    },

    /** Sends the batch to the signer's app. Only the certificate owner can confirm it there. */
    async startSigning(session, user, docs) {
      const j = await call('POST', ROUTES.startSigning, {
        external_id: `putevka-${session.id}`,
        sender_id: env.ASTRAL_SENDER_ID || undefined,
        signer: { certificate: user.sig_cert, name: user.name, signature_type: user.sig_type },
        documents: docs.map((d) => ({ ref: d.ref, type: 'waybill_title', title: d.code, name: d.name, content: Buffer.from(JSON.stringify(d.body)).toString('base64'), hash: d.hash })),
        callback_url: callbackUrl || undefined
      }, { idem: `putevka-sign-${session.id}` });
      if (!j?.id) throw new OperatorError('Оператор ЭПД не принял документы на подпись.');
      return { operatorId: String(j.id), app: j.app_name || (user.sig_type === 'ukep' ? 'КриптоПро myDSS' : 'Госключ'), code: j.confirmation_code ? String(j.confirmation_code) : '' };
    },

    /** State of a signing session; signatures are listed per document ref when signed. */
    async pollSigning(operatorId) {
      const j = await call('GET', ROUTES.signing(operatorId));
      if (!j) return { status: 'expired', reason: 'оператор не нашёл подписание' };
      return {
        status: SIGNING[j.status] || 'waiting',
        reason: j.reason || '',
        signatures: (j.signatures || []).map((s) => ({ ref: String(s.ref), id: String(s.id || s.signature_id || ''), cert: String(s.certificate || ''), signedAt: s.signed_at || '', hash: s.hash || '' }))
      };
    },

    /** Sends the signed pre-trip titles T1–T4 for registration in ГИС ЭПД. */
    async register(sheet, titles) {
      const j = await call('POST', ROUTES.register, {
        external_id: `putevka-sheet-${sheet.id}`,
        sender_id: env.ASTRAL_SENDER_ID || undefined,
        number: sheet.no,
        titles: titles.map((t) => ({ title: t.code, signature_id: t.operator_id }))
      }, { idem: `putevka-reg-${sheet.id}` });
      if (!j?.id) throw new OperatorError('Оператор ЭПД не принял лист на регистрацию.');
      return { docId: String(j.id), status: WAYBILL[j.status] || 'pending', gisId: j.gis_id || null, error: j.error || '' };
    },

    async status(docId) {
      const j = await call('GET', ROUTES.waybill(docId));
      if (!j) return { status: 'rejected', error: 'оператор не нашёл лист' };
      return { status: WAYBILL[j.status] || 'pending', gisId: j.gis_id || null, error: j.error || j.reason || '' };
    },

    /** Notifications are signed with HMAC-SHA256 of the raw body. The body is only a hint what to re-check. */
    checkNotification(raw, signature) {
      const secret = env.ASTRAL_WEBHOOK_SECRET;
      if (!secret || !signature) return false;
      const want = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      const got = String(signature).replace(/^sha256=/, '');
      return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
    },
    parseNotification(body) {
      return { signingId: body?.signing_session_id ? String(body.signing_session_id) : null, docId: body?.waybill_id ? String(body.waybill_id) : null };
    }
  };
}
