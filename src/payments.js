import crypto from 'node:crypto';
import { nowIso, fRub } from './util.js';
import { invoiceRef } from './money.js';

export class PayError extends Error {}

export const MIN_TOPUP = 10000;        // 100 ₽
export const MAX_ONLINE = 60000000;    // 600 000 ₽, card limits are lower anyway

// IP ranges YooKassa sends notifications from (see yookassa.ru/developers/using-api/webhooks).
const YK_NETS = ['185.71.76.0/27', '185.71.77.0/27', '77.75.153.0/25', '77.75.156.11/32', '77.75.156.35/32', '77.75.154.128/25'];
function ipInNet(ip, net) {
  const [base, bits] = net.split('/');
  const toInt = (a) => a.split('.').reduce((x, o) => (x << 8) + Number(o), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}
export const isYooKassaIp = (ip) => {
  const v4 = String(ip || '').replace(/^::ffff:/, '');
  return YK_NETS.some((n) => ipInNet(v4, n)) || /^2a02:5180:/i.test(String(ip));
};

/**
 * Top-ups of a park balance.
 * - "yookassa": real card / SBP payments when YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY are set;
 * - "demo":     no keys yet — a built-in test page imitates the payment form, nothing is charged;
 * - invoices:   a bank transfer from a company, matched by number from a 1C statement or marked by hand.
 * Money reaches the balance only through credit(), which is idempotent.
 */
export function makePayments(db, billing, { yookassa = {}, demo = process.env.PAYMENTS_DEMO !== '0', fetchImpl = (...a) => fetch(...a) } = {}) {
  const shopId = yookassa.shopId ?? process.env.YOOKASSA_SHOP_ID;
  const secret = yookassa.secret ?? process.env.YOOKASSA_SECRET_KEY;
  const receipts = (yookassa.receipts ?? process.env.YOOKASSA_RECEIPTS) === '1';
  const mode = shopId && secret ? 'yookassa' : demo ? 'demo' : 'off';

  const q = {
    pay: db.prepare('SELECT * FROM payments WHERE id = ?'),
    byProvider: db.prepare('SELECT * FROM payments WHERE provider = ? AND provider_id = ?'),
    byInvoice: db.prepare('SELECT * FROM payments WHERE invoice_no = ?'),
    ins: db.prepare(`INSERT INTO payments (park_id, method, amount, status, provider, invoice_no, payer, created_at, created_by, comment)
      VALUES (@park_id, @method, @amount, @status, @provider, @invoice_no, @payer, @created_at, @created_by, @comment)`),
    setProvider: db.prepare('UPDATE payments SET provider_id = ?, confirmation_url = ? WHERE id = ?'),
    succeed: db.prepare("UPDATE payments SET status = 'succeeded', paid_amount = ?, paid_at = ? WHERE id = ? AND status <> 'succeeded'"),
    cancel: db.prepare("UPDATE payments SET status = 'canceled' WHERE id = ? AND status = 'pending'"),
    audit: db.prepare('INSERT INTO audit (park_id, at, who, action, details) VALUES (?, ?, ?, ?, ?)'),
    seq: db.prepare("INSERT INTO platform (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value")
  };

  const METHOD_LABEL = { card: 'Банковская карта', sbp: 'СБП', invoice: 'Счёт', manual: 'Вручную' };

  /** The only place money is added to a balance. Safe to call twice for one payment. */
  const credit = db.transaction((paymentId, paidAmount, by) => {
    const p = q.pay.get(paymentId);
    if (!p) throw new PayError('Платёж не найден.');
    const amount = paidAmount ?? p.amount;
    if (q.succeed.run(amount, nowIso(), p.id).changes !== 1) return false;
    billing.post(p.park_id, amount, 'topup', p.invoice_no ? `Оплата по счёту № ${p.invoice_no}` : `${METHOD_LABEL[p.method]}${p.comment ? `: ${p.comment}` : ''}`, by);
    q.audit.run(p.park_id, nowIso(), by, 'Пополнение баланса', `${fRub(amount)}, ${METHOD_LABEL[p.method]}`);
    billing.renew(p.park_id);
    return true;
  });

  function checkAmount(amount, max = MAX_ONLINE) {
    if (!Number.isInteger(amount) || amount < MIN_TOPUP) throw new PayError(`Минимальная сумма — ${fRub(MIN_TOPUP)}.`);
    if (amount > max) throw new PayError(`Максимальная сумма за раз — ${fRub(max)}.`);
  }

  async function yk(method, path, body, idem) {
    const r = await fetchImpl('https://api.yookassa.ru/v3' + path, {
      method,
      headers: { Authorization: 'Basic ' + Buffer.from(`${shopId}:${secret}`).toString('base64'), 'Content-Type': 'application/json', ...(idem ? { 'Idempotence-Key': idem } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new PayError(`Платёжный сервис ответил ошибкой: ${j.description || r.status}. Попробуйте позже или выберите оплату по счёту.`);
    return j;
  }

  /** Creates an online payment and returns the URL of the payment form. */
  async function startOnline({ park, amount, method, returnUrl, by }) {
    if (mode === 'off') throw new PayError('Онлайн-оплата пока не подключена. Выставьте счёт.');
    if (!['card', 'sbp'].includes(method)) throw new PayError('Выберите способ оплаты.');
    checkAmount(amount);
    const id = q.ins.run({ park_id: park.id, method, amount, status: 'pending', provider: mode, invoice_no: null, payer: '{}', created_at: nowIso(), created_by: by, comment: '' }).lastInsertRowid;
    const back = returnUrl.replace(':id', id);
    if (mode === 'demo') {
      const url = `/pay/demo/${id}`;
      q.setProvider.run(`demo-${id}`, url, id);
      return url;
    }
    const body = {
      amount: { value: (amount / 100).toFixed(2), currency: 'RUB' },
      capture: true,
      payment_method_data: { type: method === 'sbp' ? 'sbp' : 'bank_card' },
      confirmation: { type: 'redirect', return_url: back },
      description: `Пополнение баланса «Путёвка», парк № ${park.id}`.slice(0, 128),
      metadata: { payment_id: String(id), park_id: String(park.id) }
    };
    if (receipts) {
      body.receipt = {
        customer: park.email ? { email: park.email } : { phone: park.phone },
        items: [{
          description: `Пополнение лицевого счёта сервиса «Путёвка», парк № ${park.id}`.slice(0, 128), quantity: '1.00',
          amount: body.amount, vat_code: Number(process.env.YOOKASSA_VAT_CODE || 1),
          payment_mode: process.env.YOOKASSA_PAYMENT_MODE || 'advance', payment_subject: process.env.YOOKASSA_PAYMENT_SUBJECT || 'payment'
        }]
      };
    }
    try {
      const r = await yk('POST', '/payments', body, `pv-${id}-${crypto.randomBytes(6).toString('hex')}`);
      q.setProvider.run(r.id, r.confirmation?.confirmation_url || '', id);
      return r.confirmation?.confirmation_url;
    } catch (e) {
      q.cancel.run(id);
      throw e;
    }
  }

  /** Asks the provider for the real state of a payment and credits it once it succeeded. */
  async function sync(paymentId) {
    const p = q.pay.get(paymentId);
    if (!p || p.status !== 'pending' || p.provider !== 'yookassa' || !p.provider_id) return p;
    const r = await yk('GET', `/payments/${encodeURIComponent(p.provider_id)}`);
    if (r.status === 'succeeded' && r.paid) {
      const got = Math.round(parseFloat(r.amount?.value || '0') * 100);
      if (got !== p.amount || r.metadata?.payment_id !== String(p.id)) throw new PayError('Сумма или номер платежа не совпали. Платёж передан на проверку.');
      credit(p.id, got, 'ЮKassa');
    } else if (r.status === 'canceled') q.cancel.run(p.id);
    return q.pay.get(p.id);
  }

  /** Webhook: never trusts the body, only uses it to know which payment to re-check. */
  async function webhook(body) {
    const id = body?.object?.id;
    if (body?.type !== 'notification' || !id) return false;
    const p = q.byProvider.get('yookassa', String(id));
    if (!p) return false;
    await sync(p.id);
    return true;
  }

  function demoFinish(paymentId, ok) {
    const p = q.pay.get(paymentId);
    if (!p || p.provider !== 'demo') throw new PayError('Платёж не найден.');
    if (ok) credit(p.id, p.amount, 'тестовая оплата');
    else q.cancel.run(p.id);
    return q.pay.get(p.id);
  }

  /** Invoice for a company: numbered "ГГ-NNNN" through the year. */
  function createInvoice({ park, amount, payer, by }) {
    checkAmount(amount, 10000000000);
    if (!payer.name?.trim()) throw new PayError('Укажите наименование плательщика.');
    if (payer.inn && !/^\d{10}(\d{2})?$/.test(payer.inn)) throw new PayError('ИНН плательщика — 10 или 12 цифр.');
    const yy = new Date().getFullYear() % 100;
    const n = q.seq.get(`invoice_seq_${yy}`).value;
    const no = `${String(yy).padStart(2, '0')}-${String(n).padStart(4, '0')}`;
    const id = q.ins.run({ park_id: park.id, method: 'invoice', amount, status: 'pending', provider: 'bank', invoice_no: no, payer: JSON.stringify(payer), created_at: nowIso(), created_by: by, comment: '' }).lastInsertRowid;
    db.prepare('UPDATE parks SET payer = ? WHERE id = ?').run(JSON.stringify(payer), park.id);
    q.audit.run(park.id, nowIso(), by, 'Выставлен счёт', `№ ${no} на ${fRub(amount)}`);
    return id;
  }

  /** Manual credit by the platform administrator (cash, transfer without an invoice, bonus). */
  function manual({ parkId, amount, comment, by }) {
    if (!Number.isInteger(amount) || amount <= 0) throw new PayError('Сумма должна быть больше нуля.');
    const id = q.ins.run({ park_id: parkId, method: 'manual', amount, status: 'pending', provider: 'bank', invoice_no: null, payer: '{}', created_at: nowIso(), created_by: by, comment }).lastInsertRowid;
    credit(id, amount, by);
    return id;
  }

  /**
   * Loads incoming transfers from a 1C statement. A transfer is matched to an invoice by its number
   * in the payment purpose; otherwise it waits in the list for the administrator.
   */
  function importStatement(docs, { by, account = '' }) {
    const res = { matched: [], unmatched: [], skipped: 0, foreign: 0 };
    const insDoc = db.prepare(`INSERT INTO bank_docs (doc_key, doc_date, doc_no, amount, payer, payer_inn, purpose, status, park_id, payment_id, imported_at)
      VALUES (@doc_key, @doc_date, @doc_no, @amount, @payer, @payer_inn, @purpose, @status, @park_id, @payment_id, @imported_at)`);
    for (const d of docs) {
      if (account && d.payeeAccount && d.payeeAccount !== account) { res.foreign++; continue; }
      const key = crypto.createHash('sha1').update([d.date, d.no, d.payerInn, d.amount, d.purpose].join('|')).digest('hex');
      if (db.prepare('SELECT 1 FROM bank_docs WHERE doc_key = ?').get(key)) { res.skipped++; continue; }
      const ref = invoiceRef(d.purpose);
      const inv = ref && q.byInvoice.get(ref);
      const row = { doc_key: key, doc_date: d.date, doc_no: d.no, amount: d.amount, payer: d.payer, payer_inn: d.payerInn, purpose: d.purpose, imported_at: nowIso(), park_id: null, payment_id: null, status: 'unmatched' };
      if (inv && inv.status !== 'canceled') {
        db.transaction(() => {
          if (inv.status === 'succeeded') {
            // the invoice was already paid: count the transfer as a separate top-up of the same park
            const extra = q.ins.run({ park_id: inv.park_id, method: 'invoice', amount: d.amount, status: 'pending', provider: 'bank', invoice_no: null, payer: inv.payer, created_at: nowIso(), created_by: by, comment: `Повторная оплата по счёту № ${inv.invoice_no}` }).lastInsertRowid;
            credit(extra, d.amount, by);
            row.payment_id = extra;
          } else {
            credit(inv.id, d.amount, by);
            row.payment_id = inv.id;
          }
          row.status = 'matched'; row.park_id = inv.park_id;
          insDoc.run(row);
        })();
        res.matched.push({ ...d, invoice: inv.invoice_no, parkId: inv.park_id });
      } else {
        insDoc.run(row);
        res.unmatched.push(d);
      }
    }
    return res;
  }

  /** Credits a transfer that could not be matched automatically to the park the administrator chose. */
  function assignDoc(docId, parkId, by) {
    const d = db.prepare("SELECT * FROM bank_docs WHERE id = ? AND status = 'unmatched'").get(docId);
    if (!d) throw new PayError('Платёж уже разнесён.');
    if (!db.prepare('SELECT 1 FROM parks WHERE id = ?').get(parkId)) throw new PayError('Выберите таксопарк.');
    db.transaction(() => {
      const id = q.ins.run({ park_id: parkId, method: 'invoice', amount: d.amount, status: 'pending', provider: 'bank', invoice_no: null, payer: JSON.stringify({ name: d.payer, inn: d.payer_inn }), created_at: nowIso(), created_by: by, comment: `Платёжное поручение № ${d.doc_no} от ${d.doc_date}` }).lastInsertRowid;
      credit(id, d.amount, by);
      db.prepare("UPDATE bank_docs SET status = 'matched', park_id = ?, payment_id = ? WHERE id = ?").run(parkId, id, d.id);
    })();
  }

  return { mode, credit, startOnline, sync, webhook, demoFinish, createInvoice, manual, importStatement, assignDoc, cancel: (id) => q.cancel.run(id).changes === 1, get: (id) => q.pay.get(id), METHOD_LABEL };
}
