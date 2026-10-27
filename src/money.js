// Russian money helpers for invoices: amount in words and the bank-app payment QR (ГОСТ Р 56042-2014).

const ONES_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const form = (n, f) => { const a = n % 100, b = n % 10; return a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b > 1 && b < 5 ? f[1] : f[2]; };

function triad(n, feminine) {
  const out = [];
  out.push(HUNDREDS[Math.floor(n / 100)]);
  const t = n % 100;
  if (t >= 10 && t < 20) out.push(TEENS[t - 10]);
  else { out.push(TENS[Math.floor(t / 10)]); out.push((feminine ? ONES_F : ONES_M)[t % 10]); }
  return out.filter(Boolean).join(' ');
}

/** 123450 kopecks → "Одна тысяча двести тридцать четыре рубля 50 копеек" */
export function rubWords(kop) {
  const rub = Math.floor(Math.abs(kop) / 100), k = Math.abs(kop) % 100;
  const groups = [
    [1e9, false, ['миллиард', 'миллиарда', 'миллиардов']],
    [1e6, false, ['миллион', 'миллиона', 'миллионов']],
    [1e3, true, ['тысяча', 'тысячи', 'тысяч']]
  ];
  let rest = rub; const words = [];
  for (const [size, fem, f] of groups) {
    const n = Math.floor(rest / size);
    if (n) words.push(triad(n, fem), form(n, f));
    rest %= size;
  }
  if (rest) words.push(triad(rest, false));
  if (!rub) words.push('ноль');
  words.push(form(rub, ['рубль', 'рубля', 'рублей']));
  const s = words.filter(Boolean).join(' ');
  return s[0].toUpperCase() + s.slice(1) + ` ${String(k).padStart(2, '0')} ${form(k, ['копейка', 'копейки', 'копеек'])}`;
}

/** Payment QR understood by Russian bank apps. "|" is the separator, so it is removed from values. */
export function gostPayload(f) {
  const clean = (v) => String(v ?? '').replace(/[|\r\n]/g, ' ').trim();
  const pairs = [
    ['Name', f.name], ['PersonalAcc', f.account], ['BankName', f.bank], ['BIC', f.bic], ['CorrespAcc', f.corr || '0'],
    ['PayeeINN', f.inn], ['KPP', f.kpp], ['Sum', f.sum], ['Purpose', f.purpose]
  ].filter(([, v]) => v !== undefined && v !== '');
  return 'ST00012|' + pairs.map(([k, v]) => `${k}=${clean(v)}`).join('|');
}

/** Parses a 1C bank statement (1CClientBankExchange) into payment documents. */
export function parse1C(text) {
  const docs = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('СекцияДокумент')) { cur = { kind: line.split('=')[1] || '' }; continue; }
    if (line === 'КонецДокумента') { if (cur) docs.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf('=');
    if (i > 0) cur[line.slice(0, i)] = line.slice(i + 1);
  }
  return docs.map((d) => ({
    no: d['Номер'] || '', date: d['Дата'] || '',
    amount: Math.round(parseFloat(String(d['Сумма'] || '0').replace(',', '.')) * 100) || 0,
    payer: d['Плательщик1'] || d['Плательщик'] || '', payerInn: d['ПлательщикИНН'] || '',
    payeeAccount: d['ПолучательСчет'] || d['ПолучательРасчСчет'] || '', purpose: d['НазначениеПлатежа'] || ''
  })).filter((d) => d.amount > 0);
}

/** Finds our invoice number ("Счёт № 26-0007") in a payment purpose. */
export function invoiceRef(purpose) {
  const m = String(purpose || '').match(/(\d{2}-\d{4,})/);
  return m ? m[1] : null;
}
