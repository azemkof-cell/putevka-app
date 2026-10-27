import { dayKey, addDays, daysBetween } from './time.js';

export const MAX_REPORT_DAYS = 366;

/** Spending kinds of the ledger, as the owner sees them. Refunds reduce the cost of sheets. */
const SPEND = { sheet: 'sheets', refund: 'sheets', service: 'services', monthly: 'subscription' };

/**
 * Owner's report for one park over [from, to] (park-local days):
 * sheets, mileage, refusals at the medical check and at release, and money spent on the service,
 * by day and by driver. Sheets count by shift date, money by the local day it was charged. Money in kopecks.
 */
export function parkReport(db, park, { from, to }) {
  const tz = park.tz;
  const blank = () => ({ sheets: 0, closed: 0, km: 0, medRefused: 0, techRefused: 0, cancelled: 0, sheetsCost: 0, services: 0, subscription: 0 });
  const days = new Map(), drivers = new Map(), total = blank();
  for (let d = from; d <= to; d = addDays(d, 1)) days.set(d, { day: d, ...blank() });

  const names = new Map(db.prepare('SELECT id, name FROM drivers WHERE park_id = ?').all(park.id).map((d) => [d.id, d.name]));
  const driverRow = (id, snapName) => {
    if (!drivers.has(id)) drivers.set(id, { driverId: id, name: names.get(id) || snapName || '—', ...blank() });
    return drivers.get(id);
  };

  const sheets = db.prepare('SELECT * FROM sheets WHERE park_id = ? AND shift_date BETWEEN ? AND ?').all(park.id, from, to);
  const sheetDriver = new Map();
  for (const s of sheets) {
    const dr = driverRow(s.driver_id, JSON.parse(s.snapshot).driver?.name);
    sheetDriver.set(s.id, s.driver_id);
    const rows = [days.get(s.shift_date), dr, total];
    if (s.cancelled_at) { for (const r of rows) r.cancelled++; continue; }
    const km = s.odo_back != null && s.odo_out != null ? s.odo_back - s.odo_out : 0;
    for (const r of rows) {
      r.sheets++;
      if (s.closed_at) r.closed++;
      r.km += km;
      if (s.med_status === 'refused') r.medRefused++;
      if (s.tech_status === 'refused') r.techRefused++;
    }
  }

  // Money: the ledger is in UTC; widen the window by a day on each side, then keep the park-local days asked for.
  const ledger = db.prepare(`SELECT * FROM ledger WHERE park_id = ? AND kind IN ('sheet', 'refund', 'service', 'monthly') AND at >= ? AND at < ?`)
    .all(park.id, addDays(from, -1), addDays(to, 2));
  const findSheet = db.prepare('SELECT driver_id, snapshot FROM sheets WHERE id = ? AND park_id = ?');
  for (const l of ledger) {
    const day = dayKey(tz, new Date(l.at));
    if (day < from || day > to) continue;
    const key = SPEND[l.kind] === 'sheets' ? 'sheetsCost' : SPEND[l.kind];
    const spent = -l.amount;
    const rows = [days.get(day), total];
    if (l.sheet_id) {
      // a sheet issued earlier but charged in this period still belongs to its driver
      let id = sheetDriver.get(l.sheet_id);
      if (id === undefined) { const s = findSheet.get(l.sheet_id, park.id); if (s) { id = s.driver_id; driverRow(id, JSON.parse(s.snapshot).driver?.name); } }
      if (id !== undefined) rows.push(drivers.get(id));
    }
    for (const r of rows) r[key] += spent;
  }

  const spend = (r) => ({ ...r, spent: r.sheetsCost + r.services + r.subscription });
  return {
    from, to, total: spend(total),
    days: [...days.values()].map(spend),
    drivers: [...drivers.values()].map(spend).sort((a, b) => b.sheets - a.sheets || a.name.localeCompare(b.name, 'ru'))
  };
}

/** Reads the period from the query: this month by default, never longer than a year, never reversed. */
export function reportPeriod(query, tz, parse) {
  const today = dayKey(tz);
  let from = parse(query.from) || `${today.slice(0, 8)}01`;
  let to = parse(query.to) || today;
  if (to < from) [from, to] = [to, from];
  if (daysBetween(from, to) >= MAX_REPORT_DAYS) from = addDays(to, -(MAX_REPORT_DAYS - 1));
  return { from, to };
}
