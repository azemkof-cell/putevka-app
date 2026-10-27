import { esc, fNum, firstName, plural } from '../util.js';
import { fTime, ruDay, shortRuDay, weekday, addDays } from '../time.js';
import { sheetStatus, STATUS, DAYS_AHEAD } from '../service.js';
import { pill, plate, icon } from './common.js';
import { waybill } from '../waybill.js';

const STEP = { wait_med: 1, wait_tech: 2, line: 3, returning: 4 };
const SHORT = { planned: 'план', wait_med: 'осм.', wait_tech: 'вып.', line: 'линия', returning: 'сдача', closed: 'закр.', refused: 'отказ', expired: 'проп.', cancelled: 'отм.' };

function ticket(s, tz) {
  const st = sheetStatus(s, tz);
  const cur = STEP[st] ?? 0;
  const steps = ['Выписан', 'Медосмотр', 'Выпуск', 'На линии'];
  const note = {
    wait_med: s.odo_out === null ? 'Внесите одометр и пройдите медосмотр. Штамп появится в листе сам.' : 'Пройдите медосмотр. Штамп появится в листе сам.',
    wait_tech: 'Медосмотр пройден. Покажите машину диспетчеру для выпуска.',
    line: 'Хорошей смены. Лист открывается и без интернета.',
    returning: 'Смена сдана. Диспетчер примет машину.'
  }[st];
  const needOdo = ['wait_med', 'wait_tech'].includes(st);
  return `<section class="card ticket">
    <div class="t-head"><small>Путевой лист · с ${ruDay(s.shift_date)} по ${ruDay(s.valid_to)}</small><div class="no">№ ${esc(s.no)}</div></div>
    <ol class="steps">${steps.map((l, i) => `<li class="${i < cur || (i === 3 && cur >= 3) ? 'done' : i === cur ? 'now' : ''}">${l}</li>`).join('')}</ol>
    <div class="waitnote">${note}</div>
    ${s.epl ? `<div class="epl-note">${s.gis_id ? `Электронный лист зарегистрирован в ГИС ЭПД · <span class="mono">${esc(s.gis_id)}</span>. Инспектору покажите QR-код в листе.` : 'Электронный лист: ждёт подписей диспетчера, медработника и контролёра.'}</div>` : ''}
    ${needOdo ? `<form method="post" action="/d/odo" class="odo-row">
      <input type="hidden" name="id" value="${s.id}">
      <label class="fld">Одометр при выезде, км<input name="odo" id="odo-out" class="mono" inputmode="numeric" required value="${s.odo_out ?? ''}" placeholder="как на приборке"></label>
      <button class="btn btn-ghost">${s.odo_out === null ? 'Сохранить' : 'Исправить'}</button></form>` : ''}
    <a class="btn btn-main" href="/d/sheet/${s.id}">Открыть лист</a>
  </section>
  ${st === 'line' ? `<section class="card"><h2>Сдать смену</h2>
    <form method="post" action="/d/finish" class="stack" data-confirm="Сдать смену? Диспетчер примет машину и закроет лист.">
      <input type="hidden" name="id" value="${s.id}">
      <label class="fld">Одометр при возвращении, км<input name="odo" id="odo-back" class="mono" inputmode="numeric" required placeholder="не меньше ${fNum(s.odo_out)}"></label>
      <button class="btn btn-dark">Сдать смену</button>
    </form></section>` : ''}`;
}

export function driverHome({ driver, car, park, tz, today, active, todaySheet, week, history, docs, canIssue }) {
  const greet = (() => { const h = Number(fTime(tz, new Date().toISOString()).slice(0, 2)); return h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер'; })();
  const alerts = [
    ...docs.errors.map((t) => `<div class="alert a-bad">${icon.warn}<span><b>Лист не выпишется.</b> ${esc(t)}. Обратитесь к диспетчеру.</span></div>`),
    ...docs.warnings.map((t) => `<div class="alert a-warn">${icon.warn}<span>${esc(t)}</span></div>`)
  ].join('');

  let main = '';
  if (active) main = ticket(active, tz);
  else {
    const refused = todaySheet && sheetStatus(todaySheet, tz) === 'refused' ? todaySheet : null;
    main = `${refused ? `<div class="alert a-bad">${icon.warn}<span><b>Сегодня вы не допущены</b> по листу № ${esc(refused.no)}${refused.med_note || refused.tech_note ? ': ' + esc(refused.med_note || refused.tech_note) : ''}.</span></div>` : ''}
    <section class="card start"><h2>Путевой лист на сегодня</h2>
      ${car && canIssue ? `<form method="post" action="/d/issue" class="stack">
        <input type="hidden" name="days" value="${today}">
        <label class="fld">Одометр сейчас, км<input name="odo" id="odo-now" class="mono" inputmode="numeric" required value="${car.odo}"></label>
        <button class="btn btn-main">Получить путевой лист</button>
      </form><p class="hint">Реквизиты, ваши документы и машина подставятся сами.</p>`
        : `<p class="hint">${!car ? 'За вами не закреплена машина. Обратитесь к диспетчеру.' : 'Сейчас лист не выписать. Обратитесь к диспетчеру.'}</p>`}
    </section>`;
  }

  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(today, i));
  const byDay = new Map(week.map((s) => [s.shift_date, s]));
  const freeDays = days.filter((d) => d !== today && !byDay.has(d));
  const weekBlock = `<section class="card">
    <div class="row-between"><h2>Неделя</h2><a class="linkbtn" href="/d/print-week">${icon.print} Печать недели</a></div>
    <form method="post" action="/d/issue" class="week-form">
      <div class="week">${days.map((d) => {
        const s = byDay.get(d);
        if (s) {
          const st = sheetStatus(s, tz);
          return `<a class="wd wd-${STATUS[st].tone}" href="/d/sheet/${s.id}" title="${STATUS[st].label}"><span>${weekday(d)}</span><b>${shortRuDay(d)}</b><small>${SHORT[st]}</small></a>`;
        }
        if (d === today) return `<span class="wd wd-empty"><span>${weekday(d)}</span><b>${shortRuDay(d)}</b><small>сегодня</small></span>`;
        return `<label class="wd wd-pick"><input type="checkbox" name="days" value="${d}"><span>${weekday(d)}</span><b>${shortRuDay(d)}</b><small>+</small></label>`;
      }).join('')}</div>
      ${freeDays.length && canIssue && car ? `<button class="btn btn-dark">Выписать отмеченные дни</button>` : ''}
    </form>
    ${week.filter((s) => s.shift_date > today && sheetStatus(s, tz) === 'planned').map((s) => `
      <div class="plan-row"><span><b>${weekday(s.shift_date)}, ${ruDay(s.shift_date)}</b> · № ${esc(s.no)}</span>
      <form method="post" action="/d/cancel" data-confirm="Отменить лист на ${ruDay(s.shift_date)}?"><input type="hidden" name="id" value="${s.id}"><button class="linkbtn">Отменить</button></form></div>`).join('')}
  </section>`;

  return `<div class="dv">
    <div class="d-top"><small>${greet},</small><b>${esc(firstName(driver.name))}</b></div>
    <div class="carline">${car ? plate(car) : ''}<div><b>${car ? esc(car.model) : 'Машина не закреплена'}</b><small>${car ? 'Пробег ' + fNum(car.odo) + ' км' : ''}</small></div></div>
    ${alerts}
    ${main}
    ${weekBlock}
    <section><h2 class="h-small">Прошлые листы</h2><div class="hist">
      ${history.length ? history.map((h) => { const st = sheetStatus(h, tz); return `<a href="/d/sheet/${h.id}"><span class="mono">№ ${esc(h.no)}</span>${pill(st)}<small>${ruDay(h.shift_date)}${h.back_at && h.tech_at ? ' · ' + fTime(tz, h.tech_at) + '–' + fTime(tz, h.back_at) : ''}</small><small>${h.odo_back != null && h.odo_out != null ? fNum(h.odo_back - h.odo_out) + ' км' : ''}</small></a>`; }).join('') : '<p class="hint">Пока пусто.</p>'}
    </div></section>
    ${park.settings?.dispPhone ? `<p class="hint center">Диспетчер: <span class="mono sel">${esc(park.settings.dispPhone)}</span></p>` : ''}
  </div>`;
}

export function blockedBody({ driver, reason, phone, title = 'Доступ к путевым листам закрыт' }) {
  return `<section class="blocked">
    <div class="lock">${icon.lock}</div>
    <h1>${esc(title)}</h1>
    <p>${esc(firstName(driver.name))}, ${reason ? esc(reason) : 'диспетчер приостановил выдачу листов.'} Выход на линию без путевого листа запрещён.</p>
    ${phone ? `<p>Телефон диспетчера:</p><p class="copy">${esc(phone)}</p>` : ''}
  </section>`;
}

/** Standalone waybill page (also cached by the app for offline use). */
export function sheetDoc({ sheets, back, title, autoPrint = false }) {
  const n = sheets.length;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#181C24"><title>${esc(title)}</title><link rel="stylesheet" href="/app.css?v=4"><link rel="manifest" href="/manifest.webmanifest"></head>
<body class="print-body"${autoPrint ? ' data-autoprint="1"' : ''}>
<div class="print-bar no-print"><a class="btn" href="${esc(back)}">← Назад</a>${n > 1 ? `<span class="muted">${n} ${plural(n, 'лист', 'листа', 'листов')}</span>` : ''}<button class="btn btn-main" type="button" data-print>${icon.print} Скачать PDF / печать</button></div>
${n ? sheets.map(({ s, qr, url, titles }) => waybill(s, { qr, checkUrl: url, titles })).join('<div class="page-break"></div>') : '<p class="empty">Нет листов для печати.</p>'}
<script src="/app.js?v=4" defer></script></body></html>`;
}
