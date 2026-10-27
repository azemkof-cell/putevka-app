import { esc, fRub, fNum, shortName } from '../util.js';
import { ruDay, weekday } from '../time.js';

const BY = { day: 'По дням', driver: 'По водителям' };

/** Owner's reports: totals for the period, then a table by day or by driver, downloadable for Excel. */
export function reportsPage({ r, by }) {
  const t = r.total;
  const qs = (b) => `from=${esc(r.from)}&amp;to=${esc(r.to)}&amp;by=${b}`;
  const kpi = (label, value, cls = '') => `<div class="kpi${cls}"><b>${value}</b>${label}</div>`;
  const money = (v) => `<td class="num mono">${v ? fRub(v) : '—'}</td>`;
  const n = (v) => `<td class="num mono">${v ? fNum(v) : '—'}</td>`;
  const common = (x) => `${n(x.sheets)}${n(x.km)}${n(x.medRefused)}${n(x.techRefused)}`;
  const rows = by === 'driver'
    ? r.drivers.map((d) => `<tr><td class="nm">${esc(shortName(d.name))}</td>${common(d)}${n(d.closed)}${money(d.sheetsCost)}${money(d.services)}${money(d.spent)}</tr>`)
    : r.days.filter((d) => d.sheets || d.spent || d.cancelled).map((d) => `<tr><td class="nm">${ruDay(d.day)} <small>${weekday(d.day)}</small></td>${common(d)}${money(d.sheetsCost)}${money(d.services)}${money(d.subscription)}${money(d.spent)}</tr>`);
  const head = by === 'driver'
    ? '<th>Водитель</th><th class="num">Листов</th><th class="num">Пробег, км</th><th class="num">Отказы: медосмотр</th><th class="num">Отказы: выпуск</th><th class="num">Смен закрыто</th><th class="num">Листы</th><th class="num">Услуги</th><th class="num">Всего</th>'
    : '<th>Дата</th><th class="num">Листов</th><th class="num">Пробег, км</th><th class="num">Отказы: медосмотр</th><th class="num">Отказы: выпуск</th><th class="num">Листы</th><th class="num">Услуги</th><th class="num">Подписка</th><th class="num">Всего</th>';
  return `<div class="head-row"><div><h1>Отчёты</h1><p class="muted">${ruDay(r.from)} — ${ruDay(r.to)}. Листы считаются по дате смены, деньги — по дню списания.</p></div></div>
    <form method="get" class="toolbar filters-form">
      <label class="fld">С<input type="date" name="from" id="r-from" value="${esc(r.from)}"></label>
      <label class="fld">По<input type="date" name="to" id="r-to" value="${esc(r.to)}"></label>
      <input type="hidden" name="by" value="${esc(by)}">
      <button class="btn">Показать</button>
      <a class="btn" href="/p/reports.csv?${qs(by)}">Скачать для Excel</a>
    </form>
    <div class="kpis report-kpis">
      ${kpi('листов', fNum(t.sheets))}${kpi('км пробега', fNum(t.km))}
      ${kpi('отказов на медосмотре', fNum(t.medRefused), t.medRefused ? ' k-wait' : '')}${kpi('отказов на выпуске', fNum(t.techRefused), t.techRefused ? ' k-wait' : '')}
      ${kpi('расходы на сервис', fRub(t.spent))}
    </div>
    <p class="hint">Расходы: листы ${fRub(t.sheetsCost)} (с учётом возвратов), услуги исполнителей ${fRub(t.services)}, подписка ${fRub(t.subscription)}. Аннулировано листов: ${fNum(t.cancelled) || 0}.</p>
    <nav class="filters report-tabs">${Object.entries(BY).map(([k, l]) => `<a href="/p/reports?${qs(k)}"${k === by ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    ${rows.length ? `<div class="scroll"><table class="t t-narrow"><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="empty">За выбранный период нет ни листов, ни списаний.</p>'}`;
}

/** The same table as CSV for Excel: UTF-8 with BOM, «;» between cells, rubles with a comma. */
export function reportsCsv({ r, by }) {
  const cell = (v) => { const s = String(v ?? ''); return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rub = (k) => (k / 100).toFixed(2).replace('.', ',');
  const head = by === 'driver'
    ? ['Водитель', 'Листов', 'Пробег, км', 'Отказы: медосмотр', 'Отказы: выпуск', 'Смен закрыто', 'Аннулировано', 'Листы, ₽', 'Услуги, ₽', 'Всего, ₽']
    : ['Дата', 'Листов', 'Пробег, км', 'Отказы: медосмотр', 'Отказы: выпуск', 'Аннулировано', 'Листы, ₽', 'Услуги, ₽', 'Подписка, ₽', 'Всего, ₽'];
  const line = (x, first) => by === 'driver'
    ? [first, x.sheets, x.km, x.medRefused, x.techRefused, x.closed, x.cancelled, rub(x.sheetsCost), rub(x.services), rub(x.spent)]
    : [first, x.sheets, x.km, x.medRefused, x.techRefused, x.cancelled, rub(x.sheetsCost), rub(x.services), rub(x.subscription), rub(x.spent)];
  const body = by === 'driver' ? r.drivers.map((d) => line(d, d.name)) : r.days.map((d) => line(d, ruDay(d.day)));
  return '﻿' + [head, ...body, line(r.total, 'Итого')].map((row) => row.map(cell).join(';')).join('\r\n');
}
