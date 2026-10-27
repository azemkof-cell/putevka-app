// Date helpers that respect each park's own time zone (parks can be anywhere in Russia).
export const DEFAULT_TZ = 'Europe/Moscow';

const fmts = new Map();
function fmt(tz) {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }));
  }
  return fmts.get(tz);
}

export function validTz(tz) {
  try { fmt(tz); return true; } catch { return false; }
}
export const safeTz = (tz) => (tz && validTz(tz) ? tz : DEFAULT_TZ);

function parts(tz, d) {
  const o = {};
  for (const p of fmt(safeTz(tz)).formatToParts(d)) o[p.type] = p.value;
  return o;
}

/** Calendar day in the park's zone, "YYYY-MM-DD". */
export function dayKey(tz, d = new Date()) {
  const p = parts(tz, d);
  return `${p.year}-${p.month}-${p.day}`;
}
export function fDate(tz, iso) {
  if (!iso) return '';
  const p = parts(tz, new Date(iso));
  return `${p.day}.${p.month}.${p.year}`;
}
export function fTime(tz, iso) {
  if (!iso) return '';
  const p = parts(tz, new Date(iso));
  return `${p.hour}:${p.minute}`;
}
export const fDateTime = (tz, iso) => (iso ? `${fDate(tz, iso)} ${fTime(tz, iso)}` : '');

/** Day arithmetic on "YYYY-MM-DD" strings (zone-independent). */
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
export const ruDay = (day) => (day ? day.split('-').reverse().join('.') : '');
export const shortRuDay = (day) => (day ? `${day.slice(8, 10)}.${day.slice(5, 7)}` : '');
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export const weekday = (day) => WD[new Date(day + 'T12:00:00Z').getUTCDay()];
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export const TZ_LIST = [
  ['Europe/Kaliningrad', 'Калининград (МСК−1)'],
  ['Europe/Moscow', 'Москва (МСК)'],
  ['Europe/Samara', 'Самара (МСК+1)'],
  ['Asia/Yekaterinburg', 'Екатеринбург (МСК+2)'],
  ['Asia/Omsk', 'Омск (МСК+3)'],
  ['Asia/Novosibirsk', 'Новосибирск (МСК+4)'],
  ['Asia/Krasnoyarsk', 'Красноярск (МСК+4)'],
  ['Asia/Irkutsk', 'Иркутск (МСК+5)'],
  ['Asia/Yakutsk', 'Якутск (МСК+6)'],
  ['Asia/Vladivostok', 'Владивосток (МСК+7)'],
  ['Asia/Magadan', 'Магадан (МСК+8)'],
  ['Asia/Kamchatka', 'Камчатка (МСК+9)']
];
