export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const nowIso = () => new Date().toISOString();

/** "дд.мм.гггг" or "гггг-мм-дд" → "гггг-мм-дд", otherwise ''. */
export function parseDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

/** Digits only, leading 8 → 7, 10 digits → prefixed with 7. */
export function normPhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d;
}
export function fPhone(d) {
  d = String(d || '');
  if (d.length !== 11) return d;
  return `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
}

export const toInt = (s) => {
  const v = parseInt(String(s ?? '').replace(/[\s ]/g, ''), 10);
  return Number.isFinite(v) ? v : null;
};
/** "1 234,50" → 123450 kopecks */
export function toKop(s) {
  const t = String(s ?? '').replace(/[\s ₽]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(parseFloat(t) * 100);
}
export function fRub(kop) {
  const v = (kop || 0) / 100;
  return v.toLocaleString('ru-RU', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }) + ' ₽';
}
export const fNum = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('ru-RU'));

export const shortName = (n) => {
  const p = String(n || '').trim().split(/\s+/);
  return p[0] + (p[1] ? ' ' + p[1][0] + '.' : '') + (p[2] ? ' ' + p[2][0] + '.' : '');
};
export const firstName = (n) => String(n || '').trim().split(/\s+/)[1] || n;

/** Russian plates use only letters that look the same in Latin. */
const LAT2CYR = { A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', Y: 'У', X: 'Х' };
export const normPlate = (s) => String(s || '').toUpperCase().replace(/\s/g, '').replace(/[ABEKMHOPCTYX]/g, (c) => LAT2CYR[c]);
export const PLATE_RE = /^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}$/;

export const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

export const ROLE_LABEL = { super: 'Администратор платформы', owner: 'Владелец парка', dispatcher: 'Диспетчер', medic: 'Медработник' };
