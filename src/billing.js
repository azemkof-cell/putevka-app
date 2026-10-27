import { nowIso, fRub } from './util.js';
import { dayKey, addDays, ruDay } from './time.js';

/** Same day next month; the 31st becomes the last day of a shorter month. */
export function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/**
 * Subscription rules
 * - trial:     everything is free until trial_until;
 * - payg:      tariff without a monthly fee, only the per-sheet price is charged;
 * - active:    the month is paid (paid_until >= today);
 * - suspended: the month ran out and the balance could not cover the next one.
 *              New sheets, drivers and cars are blocked; sheets already issued keep working,
 *              so no driver is left on the road without a valid waybill.
 * Renewal happens automatically on the first request after paid_until and right after any top-up.
 */
export function makeBilling(db) {
  const q = {
    park: db.prepare('SELECT * FROM parks WHERE id = ?'),
    tariff: db.prepare('SELECT * FROM tariffs WHERE id = ?'),
    defaultTariff: db.prepare('SELECT * FROM tariffs WHERE is_default = 1 ORDER BY id LIMIT 1'),
    add: db.prepare('INSERT INTO ledger (park_id, at, amount, kind, comment, by, sheet_id) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    bal: db.prepare('UPDATE parks SET balance = balance + ? WHERE id = ?'),
    paidUntil: db.prepare('UPDATE parks SET paid_until = ? WHERE id = ?'),
    audit: db.prepare('INSERT INTO audit (park_id, at, who, action, details) VALUES (?, ?, ?, ?, ?)')
  };

  const inTrial = (park, today = dayKey(park.tz)) => !!park.trial_until && today <= park.trial_until;
  const tariff = (id) => q.tariff.get(id);

  function post(parkId, amount, kind, comment, by = '', sheetId = null) {
    q.add.run(parkId, nowIso(), amount, kind, comment, by, sheetId);
    q.bal.run(amount, parkId);
  }

  function access(park) {
    const today = dayKey(park.tz);
    const t = tariff(park.tariff_id);
    if (inTrial(park, today)) return { state: 'trial', until: park.trial_until, monthly: t?.monthly || 0 };
    if (!t?.monthly) return { state: 'payg', monthly: 0 };
    if (park.paid_until && park.paid_until >= today) return { state: 'active', until: park.paid_until, monthly: t.monthly };
    return { state: 'suspended', monthly: t.monthly, need: Math.max(0, t.monthly - park.balance) };
  }

  /** Pays the next month from the balance if the current one is over and there is enough money. */
  const renew = db.transaction((parkId) => {
    const park = q.park.get(parkId);
    if (!park) return null;
    const a = access(park);
    if (a.state !== 'suspended' || park.balance < a.monthly) return a;
    const today = dayKey(park.tz);
    const until = addDays(addMonths(today, 1), -1);
    post(parkId, -a.monthly, 'monthly', `Подписка с ${ruDay(today)} по ${ruDay(until)}`, 'система');
    q.paidUntil.run(until, parkId);
    q.audit.run(parkId, nowIso(), 'система', 'Подписка продлена', `до ${ruDay(until)}, ${fRub(a.monthly)}`);
    return access(q.park.get(parkId));
  });

  /** Price of one waybill for the park right now (0 during trial). */
  function sheetPrice(park) {
    if (inTrial(park)) return 0;
    return tariff(park.tariff_id)?.per_sheet || 0;
  }

  function newParkTerms() {
    const t = q.defaultTariff.get();
    return { tariffId: t.id, trialDays: t.trial_days };
  }
  const trialUntil = (tz, days) => (days > 0 ? addDays(dayKey(tz), days - 1) : '');

  /** Rough monthly cost: the fee plus the per-sheet price times sheets issued in the last 30 days. */
  function monthlyEstimate(park) {
    const t = tariff(park.tariff_id);
    if (!t) return 0;
    const n = db.prepare("SELECT COUNT(*) AS n FROM sheets WHERE park_id = ? AND cancelled_at IS NULL AND issued_at >= datetime('now', '-30 days')").get(park.id).n;
    return t.monthly + t.per_sheet * n;
  }

  return { inTrial, access, renew, post, sheetPrice, newParkTerms, trialUntil, tariff, monthlyEstimate };
}
