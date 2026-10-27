import { esc, fNum, fPhone, fRub, shortName, plural, ROLE_LABEL } from '../util.js';
import { fTime, fDateTime, ruDay, shortRuDay, weekday, addDays, TZ_LIST } from '../time.js';
import { sheetStatus, STATUS, docProblems, DAYS_AHEAD } from '../service.js';
import { pill, plate, icon } from './common.js';

const can = (user, ...roles) => roles.includes(user.role);
const snap = (s) => JSON.parse(s.snapshot);

export function parkNav(user, counts = {}) {
  const all = ['owner', 'dispatcher', 'medic'], ops = ['owner', 'dispatcher'], own = ['owner'];
  const epl = counts.epl ? [['sign', '/p/sign', 'На подпись', counts.sign || '', all]] : [];
  return [
    ['today', '/p', 'Смены', counts.waiting || '', all],
    ...epl,
    ['week', '/p/week', 'Неделя', '', ops],
    ['drivers', '/p/drivers', 'Водители', counts.driverIssues || '', ops],
    ['cars', '/p/cars', 'Машины', counts.carIssues || '', ops],
    ['carriers', '/p/carriers', 'Перевозчики', '', ops],
    ['journal', '/p/journal', 'Журнал', '', all],
    ['staff', '/p/staff', 'Сотрудники', '', own],
    ['billing', '/p/billing', 'Баланс', '', own],
    ['settings', '/p/settings', 'Настройки', '', own],
    ...(counts.epl ? [['me', '/p/me', 'Моя подпись', '', all]] : [])
  ].filter((i) => i[4].includes(user.role)).map(([k, h, l, b]) => [k, h, l, b]);
}

export function parkBanner({ park, tariff, access, user }) {
  if (park.status !== 'active') return `<div class="banner b-bad">${icon.lock}<span><b>Работа парка приостановлена.</b> ${esc(park.block_reason || 'Обратитесь к администратору сервиса.')} Новые листы не выписываются.</span></div>`;
  const owner = user.role === 'owner';
  if (access.state === 'suspended') return `<div class="banner b-bad">${icon.lock}<span><b>Подписка не продлена.</b> На балансе не хватает ${fRub(access.need)}. Новые листы, водители и машины недоступны, уже выписанные листы работают. ${owner ? '<a href="/p/billing">Пополнить баланс</a>' : 'Попросите владельца парка пополнить баланс.'}</span></div>`;
  if (user.role === 'medic') return '';
  if (access.state === 'trial') return `<div class="banner b-info"><span>Пробный период до <b>${ruDay(access.until)}</b>. ${access.monthly ? `Дальше ${fRub(access.monthly)} в месяц с баланса — ` : ''}${owner ? '<a href="/p/billing">пополнить заранее</a>' : ''}</span></div>`;
  if (access.state === 'active') {
    const left = Math.round((Date.parse(access.until) - Date.parse(new Date().toISOString().slice(0, 10))) / 864e5);
    if (left <= 5 && park.balance < access.monthly) return `<div class="banner b-warn">${icon.warn}<span>${ruDay(access.until)} подписка закончится, а на балансе ${fRub(park.balance)} из ${fRub(access.monthly)}.${owner ? ' <a href="/p/billing">Пополнить</a>' : ''}</span></div>`;
  }
  const per = tariff?.per_sheet || 0;
  if (per && park.balance < per) return `<div class="banner b-bad">${icon.warn}<span><b>Баланс ${fRub(park.balance)}.</b> Новые листы не выписываются, пока баланс не пополнен.${owner ? ' <a href="/p/billing">Пополнить</a>' : ''}</span></div>`;
  if (per && park.balance < per * 30) return `<div class="banner b-warn">${icon.warn}<span>На балансе ${fRub(park.balance)}, это примерно ${Math.floor(park.balance / per)} ${plural(Math.floor(park.balance / per), 'лист', 'листа', 'листов')}.${owner ? ' <a href="/p/billing">Пополнить</a>' : ''}</span></div>`;
  return '';
}

const docChips = (p) => [...p.errors.map((t) => `<span class="chip c-bad">${esc(t)}</span>`), ...p.warnings.map((t) => `<span class="chip c-warn">${esc(t)}</span>`)].join('');
const docState = (p) => (p.errors.length ? 'bad' : p.warnings.length ? 'warn' : 'ok');

/* ---------------- Смены ---------------- */
export function todayPage({ user, park, tz, today, day, rows, idle, medics, counts, setup }) {
  const isOps = can(user, 'owner', 'dispatcher');
  const medicSelect = (s) => medics.length > 1
    ? `<select name="medic" aria-label="Медработник">${medics.map((m) => `<option value="${m.id}">${esc(shortName(m.name))}</option>`).join('')}</select>`
    : medics.length === 1 ? `<input type="hidden" name="medic" value="${medics[0].id}">` : '';
  const act = (s) => {
    const st = sheetStatus(s, tz);
    if (s.epl) return ['planned', 'wait_med', 'wait_tech', 'line', 'returning'].includes(st) ? '<a class="btn btn-sm" href="/p/sign">На подпись</a>' : '';
    if (st === 'wait_med') {
      if (user.role === 'medic') return medForms(s, '');
      if (!isOps) return '';
      if (!medics.length) return '<a class="linkbtn" href="/p/staff">Добавьте медработника</a>';
      return medForms(s, medicSelect(s));
    }
    if (st === 'wait_tech' && isOps) return `<form method="post" action="/p/sheet/${s.id}/tech" class="inline"><input type="hidden" name="ok" value="1"><input name="odo" class="mono odo-in" inputmode="numeric" value="${s.odo_out ?? ''}" placeholder="одометр" aria-label="Одометр при выезде" required><button class="btn btn-sm btn-ok">Выпустить</button></form>
      ${refuse(`/p/sheet/${s.id}/tech`, 'Не выпускать', 'Неисправность')}`;
    if ((st === 'line' || st === 'returning') && isOps) return `<form method="post" action="/p/sheet/${s.id}/accept" class="inline"><input name="odo" class="mono odo-in" inputmode="numeric" value="${s.odo_back ?? ''}" placeholder="одометр" aria-label="Одометр при возвращении" required><button class="btn btn-sm ${st === 'returning' ? 'btn-ok' : ''}">Принять машину</button></form>`;
    if (st === 'planned' && isOps) return cancelForm(s, 'Отменить');
    return '';
  };
  const dayTabs = Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => addDays(today, i - 1));
  return `${setup ? onboarding(setup) : ''}<div class="head-row">
      <div><h1>Смены</h1><p class="muted">${day === today ? 'Сегодня, ' : ''}${weekday(day)} ${ruDay(day)}</p></div>
      <div class="kpis"><span class="kpi"><b>${counts.line}</b>на линии</span><span class="kpi k-wait"><b>${counts.wait}</b>ждут отметок</span><span class="kpi"><b>${counts.returning}</b>сдают смену</span></div>
    </div>
    <div class="toolbar">
      <nav class="day-tabs">${dayTabs.map((d) => `<a href="/p?day=${d}"${d === day ? ' aria-current="page"' : ''}><small>${d === today ? 'сегодня' : weekday(d)}</small>${shortRuDay(d)}</a>`).join('')}</nav>
      ${rows.length ? `<a class="btn btn-sm" href="/p/print?day=${day}" target="_blank">${icon.print} Печать всех на ${shortRuDay(day)}</a>` : ''}
    </div>
    ${rows.length ? `<div class="scroll cards-wrap"><table class="t cards"><thead><tr><th>Лист</th><th>Водитель</th><th>Машина</th><th>Одометр</th><th>Медосмотр</th><th>Выпуск</th><th>Статус</th><th>Действие</th><th></th></tr></thead><tbody>
      ${rows.map((s) => { const sn = snap(s); const st = sheetStatus(s, tz); return `<tr class="st-${st}">
        <td class="mono" data-l="Лист">${esc(s.no)}${s.epl ? ` <span class="chip ${s.gis_id ? 'c-ok' : 'c-plan'}">ЭПЛ</span>` : ''}${s.shift_date !== day ? `<small>от ${shortRuDay(s.shift_date)}</small>` : ''}</td>
        <td class="nm" data-l="Водитель">${esc(shortName(sn.driver.name))}</td>
        <td data-l="Машина">${plate(sn.car)}</td>
        <td class="mono" data-l="Одометр">${s.odo_out != null ? fNum(s.odo_out) : '—'}${s.odo_back != null ? `<small>→ ${fNum(s.odo_back)}</small>` : ''}</td>
        <td data-l="Медосмотр">${s.med_status === 'ok' ? `<span class="okmark">✓ ${fTime(tz, s.med_at)}</span><small>${esc(shortName(s.med_by))}</small>` : s.med_status === 'refused' ? '<span class="badmark">✕ не допущен</span>' : '—'}</td>
        <td data-l="Выпуск">${s.tech_status === 'ok' ? `<span class="okmark">✓ ${fTime(tz, s.tech_at)}</span>` : s.tech_status === 'refused' ? '<span class="badmark">✕ запрещён</span>' : '—'}</td>
        <td data-l="Статус">${pill(st)}</td>
        <td class="acts">${act(s)}</td>
        <td><a class="btn btn-sm" href="/p/sheet/${s.id}">Лист</a></td></tr>`; }).join('')}
    </tbody></table></div>` : `<p class="empty">На ${ruDay(day)} листов нет.${isOps ? ' Водители выписывают их сами, или выпишите ниже.' : ''}</p>`}
    ${isOps && idle.length && day >= today ? `<section class="idle"><h2>Без листа на ${shortRuDay(day)}</h2><div class="idle-list">
      ${idle.map(({ d, car, problems }) => `<div class="idle-item"><span><b>${esc(shortName(d.name))}</b><small>${car ? esc(car.model) + ' · ' + esc(car.num) : 'нет машины'}</small></span>
        ${problems ? `<span class="chip c-bad" title="${esc(problems)}">${esc(problems)}</span>` : `<form method="post" action="/p/issue"><input type="hidden" name="driver" value="${d.id}"><input type="hidden" name="days" value="${day}"><input type="hidden" name="back" value="/p?day=${day}"><button class="btn btn-sm">${icon.plus} Выписать</button></form>`}</div>`).join('')}
    </div></section>` : ''}`;
}
function onboarding(s) {
  const steps = [
    [s.carriers > 0, 'Перевозчик', 'ИП или ООО, чьи реквизиты будут в листе', '/p/carriers'],
    [s.cars > 0, 'Машины', 'госномер, ОСАГО, диагностическая карта', '/p/cars'],
    [s.drivers > 0, 'Водители', 'ВУ, телефон для входа, закреплённая машина', '/p/drivers'],
    [s.medics > 0, 'Медработник', 'его ФИО будет в штампе медосмотра', '/p/staff'],
    [s.settings, 'Медорганизация', 'название и лицензия для штампа', '/p/settings']
  ];
  const done = steps.filter((x) => x[0]).length;
  if (done === steps.length) return '';
  return `<section class="panel onboard"><div class="row-between"><h2>Подготовка парка</h2><span class="muted">${done} из ${steps.length}</span></div>
    <ol class="ob-steps">${steps.map(([ok, t, d, href]) => `<li class="${ok ? 'done' : ''}"><a href="${href}"><b>${t}</b><span>${d}</span></a></li>`).join('')}</ol></section>`;
}
const medForms = (s, medicField) => `<form method="post" action="/p/sheet/${s.id}/med" class="inline"><input type="hidden" name="ok" value="1">${medicField}<button class="btn btn-sm btn-ok">Допустить</button></form>
  <details class="pop"><summary class="btn btn-sm">Не допускать</summary><form method="post" action="/p/sheet/${s.id}/med"><input type="hidden" name="ok" value="0">${medicField}<input name="note" placeholder="Причина" required aria-label="Причина недопуска"><button class="btn btn-sm btn-bad">Подтвердить</button></form></details>`;
const refuse = (action, label, ph) => `<details class="pop"><summary class="btn btn-sm">${label}</summary><form method="post" action="${action}"><input type="hidden" name="ok" value="0"><input name="note" placeholder="${ph}" required aria-label="Причина"><button class="btn btn-sm btn-bad">Подтвердить</button></form></details>`;
const cancelForm = (s, label = 'Аннулировать') => `<details class="pop"><summary class="btn btn-sm">${label}</summary><form method="post" action="/p/sheet/${s.id}/cancel"><input name="reason" required placeholder="Причина" aria-label="Причина"><button class="btn btn-sm btn-bad">Подтвердить</button></form></details>`;

/* ---------------- Неделя ---------------- */
export function weekPage({ tz, today, drivers, sheets, cars, price, inTrial, warnDays }) {
  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(today, i));
  const map = new Map();
  for (const s of sheets) {
    const st = sheetStatus(s, tz);
    if (st === 'cancelled' || st === 'refused') continue;
    map.set(s.driver_id + '|' + s.shift_date, { s, st });
  }
  let free = 0;
  const rows = drivers.filter((d) => !d.blocked).map((d) => {
    const car = cars.get(d.car_id);
    const cells = days.map((day) => {
      const hit = map.get(d.id + '|' + day);
      if (hit) return `<td><a class="cell c-${STATUS[hit.st].tone}" href="/p/sheet/${hit.s.id}" title="${STATUS[hit.st].label}">${esc(hit.s.no.slice(-3))}<small>${STATUS[hit.st].label}</small></a></td>`;
      const p = docProblems({ driver: d, car, day, warnDays });
      if (!car || !d.carrier_id || p.errors.length) return `<td><span class="cell c-none" title="${esc(!car ? 'Нет машины' : !d.carrier_id ? 'Нет перевозчика' : p.errors.join('; '))}">—</span></td>`;
      free++;
      return `<td><form method="post" action="/p/issue"><input type="hidden" name="driver" value="${d.id}"><input type="hidden" name="days" value="${day}"><input type="hidden" name="back" value="/p/week"><button class="cell c-add" aria-label="Выписать ${esc(shortName(d.name))} на ${ruDay(day)}">${icon.plus}</button></form></td>`;
    });
    return `<tr><th scope="row"><b>${esc(shortName(d.name))}</b><small>${car ? esc(car.num) : 'нет машины'}</small></th>${cells.join('')}</tr>`;
  });
  return `<div class="head-row"><div><h1>Неделя</h1><p class="muted">Листы на ${DAYS_AHEAD} дней. Штампы ставятся только в день смены.</p></div>
    <div class="head-actions">
      <form method="post" action="/p/issue-week" data-confirm="Выписать листы всем водителям на все свободные дни (${free})?${price && !inTrial ? ` Спишется до ${fRub(price * free)}.` : ''}"><button class="btn btn-main"${free ? '' : ' disabled'}>Выписать всем на неделю${free ? ` · ${free}` : ''}</button></form>
      <a class="btn" href="/p/print?from=${today}&amp;to=${addDays(today, DAYS_AHEAD - 1)}" target="_blank">${icon.print} Печать недели</a>
    </div></div>
    ${drivers.length ? `<div class="scroll"><table class="t week-t"><thead><tr><th>Водитель</th>${days.map((d) => `<th class="${d === today ? 'is-today' : ''}">${weekday(d)}<small>${shortRuDay(d)}</small></th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
      : '<p class="empty">Сначала добавьте водителей.</p>'}
    <p class="hint">«—» значит, лист выписать нельзя: нет машины, перевозчика или истёк документ. Подробности в разделе «Водители».</p>`;
}

/* ---------------- Водители ---------------- */
const DRV_FILTERS = [['all', 'Все'], ['bad', 'Ограничения'], ['warn', 'Предупреждения'], ['line', 'На линии'], ['free', 'Без листа сегодня'], ['blocked', 'Заблокированы']];
export function driversPage({ list, filter, q, cars, carriers, counts }) {
  const carOpts = (sel) => `<option value="">— нет —</option>` + cars.filter((c) => c.active || c.id === sel).map((c) => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.model)} · ${esc(c.num)}</option>`).join('');
  return `<div class="head-row"><div><h1>Водители</h1><p class="muted">Логин водителя — номер телефона. Заблокированный водитель не видит ни новых, ни старых листов.</p></div>
    <a class="btn btn-main" href="#add">${icon.plus} Добавить водителя</a></div>
    <form class="toolbar" method="get">
      <nav class="filters">${DRV_FILTERS.map(([k, l]) => `<a href="?f=${k}${q ? '&amp;q=' + encodeURIComponent(q) : ''}"${k === filter ? ' aria-current="page"' : ''}>${l}${counts[k] ? `<span class="nb">${counts[k]}</span>` : ''}</a>`).join('')}</nav>
      <input type="hidden" name="f" value="${esc(filter)}"><input type="search" name="q" id="drv-q" value="${esc(q)}" placeholder="Поиск: ФИО, телефон, номер машины" aria-label="Поиск" class="search">
    </form>
    ${list.length ? `<div class="scroll"><table class="t"><thead><tr><th>Водитель</th><th>Телефон</th><th>Перевозчик</th><th>Машина</th><th>Документы</th><th>Сегодня</th><th>Доступ</th><th></th></tr></thead><tbody>
    ${list.map(({ d, carrier, problems, todaySt }) => `<tr class="${d.blocked ? 'is-off' : ''}">
      <td><b>${esc(d.name)}</b><small>ВУ ${esc(d.lic)}${d.lic_to ? ' до ' + ruDay(d.lic_to) : ''}</small></td>
      <td class="mono">${esc(fPhone(d.phone))}</td>
      <td>${carrier ? esc(carrier.name) : '<span class="badmark">не указан</span>'}</td>
      <td><form method="post" action="/p/drivers/${d.id}/car" class="autosubmit"><select name="car_id" aria-label="Машина">${carOpts(d.car_id)}</select><noscript><button class="btn btn-sm">OK</button></noscript></form></td>
      <td class="chips">${docState(problems) === 'ok' ? '<span class="chip c-ok">в порядке</span>' : docChips(problems)}</td>
      <td>${todaySt ? pill(todaySt) : '<span class="muted">—</span>'}</td>
      <td>${d.blocked
        ? `<form method="post" action="/p/drivers/${d.id}/unblock"><span class="badmark">Заблокирован</span>${d.block_reason ? `<small>${esc(d.block_reason)}</small>` : ''}<button class="btn btn-sm btn-ok">Разблокировать</button></form>`
        : `<details class="pop"><summary class="btn btn-sm">Заблокировать</summary><form method="post" action="/p/drivers/${d.id}/block"><input name="reason" placeholder="Причина (увидит водитель)" aria-label="Причина блокировки"><button class="btn btn-sm btn-bad">Заблокировать</button></form></details>`}</td>
      <td><a class="btn btn-sm" href="/p/drivers/${d.id}">Карточка</a></td></tr>`).join('')}
    </tbody></table></div>` : `<p class="empty">${filter === 'all' && !q ? 'Водителей пока нет. Добавьте первого ниже.' : 'Никого не нашлось.'}</p>`}
    <form method="post" action="/p/drivers" class="panel form-grid" id="add"><h2 class="full">Новый водитель</h2>
      ${driverFields({}, cars, carriers)}
      <label class="fld">Пароль<input name="pin" id="d-pin" autocomplete="off" placeholder="пусто — придумаем сами"></label>
      <button class="btn btn-dark">Добавить</button></form>`;
}

function driverFields(d, cars, carriers) {
  const v = (k) => esc(d[k] ?? '');
  const carrierSel = d.carrier_id ?? (carriers.length === 1 ? carriers[0].id : null);
  return `<label class="fld">ФИО полностью<input name="name" id="d-name" required value="${v('name')}" placeholder="Фамилия Имя Отчество"></label>
    <label class="fld">Телефон (логин)<input name="phone" id="d-phone" type="tel" required value="${d.phone ? esc(fPhone(d.phone)) : ''}" placeholder="+7 900 000-00-00"></label>
    <label class="fld">Перевозчик<select name="carrier_id" id="d-carrier" required><option value="">— выберите —</option>${carriers.filter((c) => c.active || c.id === carrierSel).map((c) => `<option value="${c.id}"${c.id === carrierSel ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <label class="fld">Машина<select name="car_id" id="d-car"><option value="">— позже —</option>${cars.filter((c) => c.active).map((c) => `<option value="${c.id}"${c.id === d.car_id ? ' selected' : ''}>${esc(c.model)} · ${esc(c.num)}</option>`).join('')}</select></label>
    <label class="fld">Удостоверение (серия, номер)<input name="lic" id="d-lic" required value="${v('lic')}" placeholder="99 00 000000"></label>
    <label class="fld">ВУ выдано<input name="lic_from" id="d-licfrom" type="date" value="${v('lic_from')}"></label>
    <label class="fld">ВУ действует до<input name="lic_to" id="d-licto" type="date" value="${v('lic_to')}"></label>
    <label class="fld">Категория<input name="cls" id="d-cls" value="${v('cls') || 'B'}"></label>
    <label class="fld">СНИЛС<input name="snils" id="d-snils" value="${v('snils')}" placeholder="000-000-000 00"></label>`;
}

export function driverCard({ d, cars, carriers, sheets, tz }) {
  return `<p><a href="/p/drivers" class="linkbtn">← Все водители</a></p>
    <div class="two-col">
    <form method="post" action="/p/drivers/${d.id}" class="panel form-grid"><h1 class="full">${esc(d.name)}</h1>
      ${driverFields(d, cars, carriers)}
      <button class="btn btn-dark">Сохранить</button></form>
    <div class="stack">
      <form method="post" action="/p/drivers/${d.id}/pin" class="panel stack" data-confirm="Сменить пароль? Водителя выкинет из приложения на всех телефонах.">
        <h2>Пароль для входа</h2>
        <p class="hint">Логин — телефон <span class="mono">${esc(fPhone(d.phone))}</span>.</p>
        <label class="fld">Новый пароль<input name="pin" id="d-newpin" autocomplete="off" placeholder="пусто — придумаем сами"></label>
        <button class="btn">Сменить пароль</button></form>
      <div class="panel"><h2>Последние листы</h2>
        ${sheets.length ? `<div class="mini-list">${sheets.map((s) => `<a href="/p/sheet/${s.id}"><span class="mono">${esc(s.no)}</span>${pill(sheetStatus(s, tz))}<small>${ruDay(s.shift_date)}</small></a>`).join('')}</div>` : '<p class="hint">Листов ещё не было.</p>'}</div>
    </div></div>`;
}

export function pinShown({ d, pin, isNew }) {
  return `<section class="card narrow center pin-card"><h1>${isNew ? 'Водитель добавлен' : 'Пароль изменён'}</h1>
    <p>${esc(d.name)}</p>
    <div class="cred"><span>Логин</span><b class="mono sel">${esc(fPhone(d.phone))}</b><span>Пароль</span><b class="mono sel pin">${esc(pin)}</b></div>
    <p class="hint">Передайте водителю лично. Пароль больше нигде не показывается. Приложение: откройте этот сайт на телефоне и нажмите «Установить».</p>
    <a class="btn btn-dark" href="/p/drivers">Готово</a></section>`;
}

/* ---------------- Машины ---------------- */
const CAR_FILTERS = [['all', 'Все'], ['bad', 'Ограничения'], ['warn', 'Предупреждения'], ['off', 'Выведены']];
export function carsPage({ list, filter, q, counts }) {
  const dt = (v, state) => (v ? `<span class="${state}">${ruDay(v)}</span>` : '<span class="muted">—</span>');
  return `<div class="head-row"><div><h1>Машины</h1><p class="muted">С истёкшим ОСАГО, диагностической картой или разрешением лист не выпишется.</p></div><a class="btn btn-main" href="#add">${icon.plus} Добавить машину</a></div>
    <form class="toolbar" method="get">
      <nav class="filters">${CAR_FILTERS.map(([k, l]) => `<a href="?f=${k}${q ? '&amp;q=' + encodeURIComponent(q) : ''}"${k === filter ? ' aria-current="page"' : ''}>${l}${counts[k] ? `<span class="nb">${counts[k]}</span>` : ''}</a>`).join('')}</nav>
      <input type="hidden" name="f" value="${esc(filter)}"><input type="search" name="q" id="car-q" value="${esc(q)}" placeholder="Поиск: номер, марка" aria-label="Поиск" class="search">
    </form>
    ${list.length ? `<div class="scroll"><table class="t"><thead><tr><th>Госномер</th><th>Марка</th><th>Гараж. №</th><th>ОСАГО до</th><th>ДК до</th><th>Разрешение до</th><th>Пробег</th><th>Водитель</th><th></th></tr></thead><tbody>
    ${list.map(({ c, driver, problems }) => {
      const cls = (k, label) => problems.errors.some((t) => t.startsWith(label)) ? 'badmark' : problems.warnings.some((t) => t.startsWith(label)) ? 'warnmark' : '';
      return `<tr class="${c.active ? '' : 'is-off'}"><td>${plate(c)}</td><td>${esc(c.model)}<small>${esc(c.fuel)}</small></td><td class="mono">${esc(c.garage)}</td>
      <td>${dt(c.osago_to, cls('osago_to', 'ОСАГО'))}</td><td>${dt(c.diag_to, cls('diag_to', 'Диагностическая карта'))}</td><td>${dt(c.permit_to, cls('permit_to', 'Разрешение такси'))}</td>
      <td class="mono">${fNum(c.odo)} км</td><td>${driver ? esc(shortName(driver.name)) : '<span class="muted">свободна</span>'}</td>
      <td><a class="btn btn-sm" href="/p/cars/${c.id}">Карточка</a></td></tr>`; }).join('')}
    </tbody></table></div>` : `<p class="empty">${filter === 'all' && !q ? 'Машин пока нет.' : 'Ничего не нашлось.'}</p>`}
    <form method="post" action="/p/cars" class="panel form-grid" id="add"><h2 class="full">Новая машина</h2>${carFields({})}<button class="btn btn-dark">Добавить</button></form>`;
}

function carFields(c) {
  const v = (k) => esc(c[k] ?? '');
  const fuels = ['АИ-92', 'АИ-95', 'АИ-98', 'ДТ', 'Газ (метан)', 'Газ (пропан)', 'Электро'];
  const cur = c.fuel || 'АИ-95';
  return `<label class="fld">Марка, модель<input name="model" id="c-model" required value="${v('model')}" placeholder="Kia Rio"></label>
    <label class="fld">Госномер<input name="num" id="c-num" required value="${v('num')}" placeholder="А123ВС" maxlength="6" class="upper"></label>
    <label class="fld">Регион<input name="reg" id="c-reg" required value="${v('reg')}" placeholder="750" maxlength="3" inputmode="numeric"></label>
    <label class="fld">Пробег, км<input name="odo" id="c-odo" required value="${c.odo ?? ''}" inputmode="numeric" placeholder="0"></label>
    <label class="fld">Гаражный №<input name="garage" id="c-garage" value="${v('garage')}"></label>
    <label class="fld">Горючее<select name="fuel" id="c-fuel">${[...new Set([...fuels, cur])].map((f) => `<option${f === cur ? ' selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
    <label class="fld">СТС<input name="sts" id="c-sts" value="${v('sts')}"></label>
    <label class="fld">Рег. № в реестре такси<input name="permit" id="c-permit" value="${v('permit')}"></label>
    <label class="fld">Разрешение действует до<input name="permit_to" id="c-permitto" type="date" value="${v('permit_to')}"></label>
    <label class="fld">Полис ОСАГО<input name="osago" id="c-osago" value="${v('osago')}" placeholder="ХХХ 0000000000"></label>
    <label class="fld">ОСАГО до<input name="osago_to" id="c-osagoto" type="date" value="${v('osago_to')}"></label>
    <label class="fld">Диагностическая карта до<input name="diag_to" id="c-diagto" type="date" value="${v('diag_to')}"></label>`;
}

export function carCard({ c }) {
  return `<p><a href="/p/cars" class="linkbtn">← Все машины</a></p>
    <form method="post" action="/p/cars/${c.id}" class="panel form-grid"><h1 class="full">${esc(c.model)} ${esc(c.num)}</h1>${carFields(c)}
      <label class="fld check"><input type="checkbox" name="active" id="c-active" value="1"${c.active ? ' checked' : ''}> В работе</label>
      <button class="btn btn-dark">Сохранить</button></form>`;
}

/* ---------------- Перевозчики ---------------- */
function carrierFields(c) {
  const v = (k) => esc(c[k] ?? '');
  return `<label class="fld full">Наименование<input name="name" id="cr-name" required value="${v('name')}" placeholder="ИП Иванов Иван Иванович или ООО «Такси»"></label>
    <label class="fld">ИНН<input name="inn" id="cr-inn" value="${v('inn')}" inputmode="numeric" maxlength="12"></label>
    <label class="fld">ОГРН / ОГРНИП<input name="ogrn" id="cr-ogrn" value="${v('ogrn')}" inputmode="numeric" maxlength="15"></label>
    <label class="fld">Телефон<input name="phone" id="cr-phone" value="${v('phone')}"></label>
    <label class="fld">№ в реестре перевозчиков<input name="reestr" id="cr-reestr" value="${v('reestr')}"></label>
    <label class="fld full">Адрес<input name="addr" id="cr-addr" value="${v('addr')}"></label>`;
}
export function carriersPage({ list }) {
  return `<div class="head-row"><div><h1>Перевозчики</h1><p class="muted">ИП или ООО, от имени которых выписываются листы. Реквизиты попадают в штамп и шапку листа.</p></div></div>
    ${list.length ? `<div class="scroll"><table class="t"><thead><tr><th>Наименование</th><th>ИНН</th><th>ОГРН</th><th>Реестр</th><th>Водителей</th><th></th></tr></thead><tbody>
    ${list.map(({ c, n }) => `<tr class="${c.active ? '' : 'is-off'}"><td><b>${esc(c.name)}</b><small>${esc(c.addr)}</small></td><td class="mono">${esc(c.inn)}</td><td class="mono">${esc(c.ogrn)}</td><td class="mono">${esc(c.reestr)}</td><td>${n}</td><td><a class="btn btn-sm" href="/p/carriers/${c.id}">Изменить</a></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="empty">Добавьте хотя бы одного перевозчика — без него лист не выписать.</p>'}
    <form method="post" action="/p/carriers" class="panel form-grid" id="add"><h2 class="full">Новый перевозчик</h2>${carrierFields({})}<button class="btn btn-dark">Добавить</button></form>`;
}
export function carrierCard({ c }) {
  return `<p><a href="/p/carriers" class="linkbtn">← Все перевозчики</a></p>
    <form method="post" action="/p/carriers/${c.id}" class="panel form-grid"><h1 class="full">${esc(c.name)}</h1>${carrierFields(c)}
    <label class="fld check"><input type="checkbox" name="active" id="cr-active" value="1"${c.active ? ' checked' : ''}> Работает</label>
    <button class="btn btn-dark">Сохранить</button></form>`;
}

/* ---------------- Журнал ---------------- */
export function journalPage({ rows, from, to, drivers, driverId, user, tz, totalKm }) {
  const isOps = can(user, 'owner', 'dispatcher');
  return `<div class="head-row"><div><h1>Журнал путевых листов</h1><p class="muted">${rows.length} ${plural(rows.length, 'лист', 'листа', 'листов')} · пробег ${fNum(totalKm)} км</p></div></div>
    <form method="get" class="toolbar filters-form">
      <label class="fld">С<input type="date" name="from" id="j-from" value="${esc(from)}"></label>
      <label class="fld">По<input type="date" name="to" id="j-to" value="${esc(to)}"></label>
      <label class="fld">Водитель<select name="driver" id="j-driver"><option value="">Все</option>${drivers.map((d) => `<option value="${d.id}"${String(d.id) === String(driverId) ? ' selected' : ''}>${esc(shortName(d.name))}</option>`).join('')}</select></label>
      <button class="btn">Показать</button>
      <a class="btn" href="/p/journal.csv?from=${esc(from)}&amp;to=${esc(to)}&amp;driver=${esc(driverId || '')}">Скачать для Excel</a>
      ${isOps ? `<a class="btn" href="/p/print?from=${esc(from)}&amp;to=${esc(to)}${driverId ? '&amp;driver=' + esc(driverId) : ''}" target="_blank">${icon.print} Печать</a>` : ''}
    </form>
    ${rows.length ? `<div class="scroll"><table class="t"><thead><tr><th>№</th><th>Дата</th><th>Водитель</th><th>Машина</th><th>Выезд</th><th>Возврат</th><th>Пробег</th><th>Статус</th><th></th></tr></thead><tbody>
    ${rows.map((s) => { const sn = snap(s); const st = sheetStatus(s, tz); return `<tr>
      <td class="mono">${esc(s.no)}</td><td>${ruDay(s.shift_date)}</td><td>${esc(shortName(sn.driver.name))}</td><td>${plate(sn.car)}</td>
      <td class="mono">${s.tech_status === 'ok' ? fTime(tz, s.tech_at) : ''}<small>${fNum(s.odo_out)}</small></td>
      <td class="mono">${fTime(tz, s.back_at)}<small>${fNum(s.odo_back)}</small></td>
      <td class="mono">${s.odo_back != null && s.odo_out != null ? fNum(s.odo_back - s.odo_out) + ' км' : ''}</td>
      <td>${pill(st)}</td>
      <td class="acts"><a class="btn btn-sm" href="/p/sheet/${s.id}">Лист</a>${isOps && ['planned', 'wait_med', 'wait_tech', 'line', 'returning'].includes(st) ? cancelForm(s) : ''}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<p class="empty">За выбранный период листов нет.</p>'}`;
}

/* ---------------- Сотрудники ---------------- */
export function staffPage({ users, me }) {
  return `<div class="head-row"><div><h1>Сотрудники</h1><p class="muted">Диспетчер выписывает листы и ставит все отметки, в том числе медосмотр за медработника. Медработник отмечает только медосмотр. ФИО медработника попадает в штамп.</p></div></div>
    <div class="scroll"><table class="t t-narrow"><thead><tr><th>ФИО</th><th>Логин</th><th>Роль</th><th>Подпись и аттестация</th><th>Статус</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr class="${u.active ? '' : 'is-off'}"><td><b>${esc(u.name)}</b></td><td class="mono">${esc(u.login)}</td><td>${ROLE_LABEL[u.role]}</td>
      <td>${u.sig_ready ? `<span class="chip c-ok">${u.sig_type === 'ukep' ? 'УКЭП' : 'Госключ'}</span>` : '<span class="chip c-plan">подпись не подключена</span>'}
        ${u.role !== 'medic' ? (u.tech_cert ? `<span class="chip c-ok">контролёр № ${esc(u.tech_cert)}</span>` : '') : ''}
        ${u.role !== 'medic' ? `<details class="pop"><summary class="linkbtn">${u.tech_cert ? 'Изменить аттестацию' : 'Аттестация контролёра'}</summary><form method="post" action="/p/staff/${u.id}/tech"><input name="tech_cert" value="${esc(u.tech_cert)}" placeholder="№ удостоверения" aria-label="Номер удостоверения"><input type="date" name="tech_cert_date" value="${esc(u.tech_cert_date)}" aria-label="Дата"><button class="btn btn-sm btn-dark">Сохранить</button></form></details>` : ''}</td>
      <td>${u.active ? 'Активен' : 'Отключён'}</td>
      <td class="acts">${u.id === me.id ? '<span class="muted">это вы</span>' : `<form method="post" action="/p/staff/${u.id}/toggle"><button class="btn btn-sm">${u.active ? 'Отключить' : 'Включить'}</button></form>`}
        <details class="pop"><summary class="btn btn-sm">Новый пароль</summary><form method="post" action="/p/staff/${u.id}/password"><input name="password" type="password" minlength="8" required placeholder="Не короче 8 знаков" aria-label="Новый пароль" autocomplete="new-password"><button class="btn btn-sm btn-dark">Сохранить</button></form></details></td></tr>`).join('')}
    </tbody></table></div>
    <form method="post" action="/p/staff" class="panel form-grid"><h2 class="full">Новый сотрудник</h2>
      <label class="fld">ФИО (как в штампе)<input name="name" id="u-name" required placeholder="Иванова Наталья Сергеевна"></label>
      <label class="fld">Роль<select name="role" id="u-role"><option value="dispatcher">Диспетчер</option><option value="medic">Медработник</option><option value="owner">Владелец (все права)</option></select></label>
      <label class="fld">Логин<input name="login" id="u-login" required autocomplete="off"></label>
      <label class="fld">Пароль<input name="password" id="u-pass" type="password" minlength="8" required autocomplete="new-password"></label>
      <button class="btn btn-dark">Добавить</button></form>`;
}

/* ---------------- Настройки ---------------- */
export function settingsPage({ park, s }) {
  const f = (k, l, extra = '') => `<label class="fld">${l}<input name="${k}" id="s-${k}" value="${esc(s[k])}"${extra}></label>`;
  const p = (k, l, extra = '') => `<label class="fld">${l}<input name="${k}" id="p-${k}" value="${esc(park[k])}"${extra}></label>`;
  return `<div class="head-row"><div><h1>Настройки</h1><p class="muted">Применяются к новым листам. Уже выписанные листы не меняются.</p></div></div>
    <form method="post" action="/p/settings" class="settings">
      <fieldset><legend>Таксопарк</legend>
        ${p('name', 'Название', ' required')}${p('city', 'Город')}${p('inn', 'ИНН')}
        <label class="fld">Часовой пояс<select name="tz" id="p-tz">${TZ_LIST.map(([z, l]) => `<option value="${z}"${z === park.tz ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        ${f('dispPhone', 'Телефон диспетчера (видят водители)')}
        ${f('warnDays', 'Предупреждать о документах за, дней', ' inputmode="numeric"')}</fieldset>
      <fieldset><legend>Путевые листы</legend>
        <label class="fld full">Форма листа<select name="eplMode" id="s-eplMode">
          <option value="off"${s.eplMode === 'off' ? ' selected' : ''}>Бумажный: печать, штампы и подписи ставятся вручную</option>
          <option value="sandbox"${s.eplMode === 'sandbox' ? ' selected' : ''}>Электронный (ЭПЛ) через тестового оператора ЭПД</option></select></label>
        <p class="hint full">В электронном режиме каждый подписывает свою часть листа своей подписью: задание — диспетчер, медосмотр — медработник (УКЭП), выпуск и приём — аттестованный контролёр. Новый режим действует для новых листов.</p></fieldset>
      <fieldset><legend>Медосмотр</legend>
        ${f('medOrg', 'Медорганизация')}${f('medLic', 'Лицензия')}<div class="full">${f('medAddr', 'Адрес медорганизации')}</div>
        <p class="hint full">ФИО в штампе берётся из учётной записи медработника (раздел «Сотрудники»).</p></fieldset>
      <fieldset><legend>Бланк</legend>
        ${f('route', 'Вид сообщения')}${f('licCard', 'Лицензионная карточка')}${f('okud', 'Форма по ОКУД')}
        <label class="fld full">Текст штампа при выпуске на линию<textarea name="techStamp" id="s-techStamp" rows="3">${esc(s.techStamp)}</textarea></label></fieldset>
      <button class="btn btn-dark">Сохранить</button>
    </form>`;
}
