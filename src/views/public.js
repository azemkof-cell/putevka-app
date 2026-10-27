import { esc, fRub, shortName, plural } from '../util.js';
import { fTime, fDate, ruDay, TZ_LIST } from '../time.js';
import { STATUS } from '../service.js';
import { TITLES, SIG_LABEL } from '../epd.js';
import { checker, plate, icon } from './common.js';
import { priceBlock } from './services.js';

export function landing({ tariff, tariffs = [], services = {} }) {
  const per = tariff ? fRub(tariff.per_sheet) : '';
  const trial = tariff?.trial_days || 0;
  return `
<section class="hero">
  <div class="hero-text">
    <p class="eyebrow">Для таксопарков и перевозчиков</p>
    <h1>Путевой лист приходит водителю в телефон</h1>
    <p class="lead">Водитель выписывает лист сам, медработник и диспетчер ставят отметки в один тап, а лист с QR-кодом открывается даже без интернета. Никаких бланков, ручек и пачек со штампами.</p>
    <div class="hero-cta"><a class="btn btn-main" href="/signup">Подключить таксопарк</a><span class="muted">${trial ? `${trial} ${plural(trial, 'день', 'дня', 'дней')} бесплатно, без карты` : 'Подключение за 5 минут'}</span></div>
  </div>
  <div class="hero-phone" aria-hidden="true">
    <div class="phone-mock">
      <div class="pm-top"><small>Добрый день,</small><b>Руслан</b></div>
      <div class="pm-car">${plate({ num: 'Х415КМ', reg: '797' })}<span>Belgee X50</span></div>
      <div class="ticket pm-ticket">
        <small>Путевой лист · 27.10–28.10</small>
        <div class="no">№ 271026_014</div>
        <ol class="steps"><li class="done">Выписан</li><li class="done">Медосмотр</li><li class="done">Выпуск</li><li class="now">На линии</li></ol>
        <span class="btn btn-main">Открыть лист</span>
      </div>
      <div class="pm-week"><span class="on">пн</span><span class="on">вт</span><span class="on">ср</span><span>чт</span><span class="on">пт</span><span class="on">сб</span><span>вс</span></div>
    </div>
  </div>
</section>

<section class="flow">
  <h2>Как проходит смена</h2>
  <ol class="flow-steps">
    <li><b>Водитель</b><span>Открывает приложение, вводит одометр и получает лист. Можно сразу на неделю вперёд.</span></li>
    <li><b>Медработник</b><span>Отмечает предрейсовый осмотр. В лист встаёт штамп с ФИО, датой и временем.</span></li>
    <li><b>Диспетчер</b><span>Выпускает машину на линию, а вечером принимает её с пробегом. При необходимости ставит любые отметки сам.</span></li>
    <li><b>Проверка на дороге</b><span>Инспектор сканирует QR-код и видит, что лист настоящий и действует.</span></li>
  </ol>
</section>

<section class="feats">
  <h2>Что получает парк</h2>
  <div class="feat-grid">
    <div><b>Неделя вперёд</b><span>Листы на 7 дней для всех водителей одной кнопкой. Неиспользованные отменяются с возвратом денег.</span></div>
    <div><b>Сроки документов</b><span>ВУ, ОСАГО, диагностическая карта, разрешение. Заранее предупреждаем, а с истёкшим документом лист не выпишется.</span></div>
    <div><b>Блокировка водителя</b><span>Одно нажатие, и водитель не получит лист, пока вы не откроете доступ. Причину он увидит в приложении.</span></div>
    <div><b>Печать пачкой</b><span>Все листы на день или на неделю одним файлом на А4, если инспекция или медпункт работают с бумагой.</span></div>
    <div><b>Несколько перевозчиков</b><span>ИП и ООО в одном кабинете. В лист подставляются реквизиты того, кто возит.</span></div>
    <div><b>Журнал и выгрузка</b><span>Все листы, пробеги и отметки за любой период. Выгрузка в Excel.</span></div>
  </div>
</section>

${priceBlock({ tariffs, s: services })}`;
}

export function loginBody({ tab = 'driver', error = '', phone = '', login = '', choices = null, ticket = '' }) {
  const t = tab === 'staff' ? 'staff' : 'driver';
  if (choices) {
    return `<section class="auth"><h1>Выберите таксопарк</h1><p class="muted">Этот телефон есть в нескольких парках.</p>
      <div class="stack">${choices.map((c) => `<form method="post" action="/login/driver/pick"><input type="hidden" name="ticket" value="${esc(ticket)}"><input type="hidden" name="driver" value="${c.driverId}"><button class="btn btn-wide">${esc(c.name)}</button></form>`).join('')}</div></section>`;
  }
  return `<section class="auth">
    <h1>Вход</h1>
    <div class="seg" role="tablist">
      <a role="tab" href="/login" aria-selected="${t === 'driver'}">Водитель</a>
      <a role="tab" href="/login?staff=1" aria-selected="${t === 'staff'}">Таксопарк</a>
    </div>
    ${error ? `<div class="flash flash-bad">${esc(error)}</div>` : ''}
    ${t === 'driver' ? `
    <form method="post" action="/login/driver" class="stack">
      <label class="fld">Телефон<input name="phone" id="phone" type="tel" inputmode="tel" autocomplete="tel" required value="${esc(phone)}" placeholder="+7 900 000-00-00"></label>
      <label class="fld">Пароль<input name="pin" id="pin" type="password" autocomplete="current-password" required placeholder="Выдаёт диспетчер"></label>
      <button class="btn btn-main">Войти</button>
      <p class="hint">Забыли пароль? Диспетчер выдаст новый.</p>
    </form>` : `
    <form method="post" action="/login/staff" class="stack">
      <label class="fld">Логин<input name="login" id="login" autocomplete="username" required value="${esc(login)}"></label>
      <label class="fld">Пароль<input name="password" id="password" type="password" autocomplete="current-password" required></label>
      <button class="btn btn-main">Войти</button>
      <p class="hint">Ещё не подключены? <a href="/signup">Подключить таксопарк</a></p>
    </form>`}
  </section>`;
}

export function signupBody({ v = {}, error = '', trialDays = 0 }) {
  const f = (k, label, attrs = '') => `<label class="fld">${label}<input name="${k}" id="su-${k}" value="${esc(v[k] || '')}" ${attrs}></label>`;
  const tz = v.tz || 'Europe/Moscow';
  return `<section class="auth wide">
    <h1>Подключить таксопарк</h1>
    <p class="muted">${trialDays ? `Первые ${trialDays} ${plural(trialDays, 'день', 'дня', 'дней')} бесплатно. ` : ''}После регистрации добавьте перевозчика, машины и водителей, и можно выписывать листы.</p>
    ${error ? `<div class="flash flash-bad">${esc(error)}</div>` : ''}
    <form method="post" action="/signup" class="form-grid">
      ${f('park', 'Название таксопарка', 'required maxlength="120" placeholder="Такси Восток"')}
      ${f('city', 'Город', 'required maxlength="80"')}
      <label class="fld">Часовой пояс<select name="tz" id="su-tz">${TZ_LIST.map(([z, l]) => `<option value="${z}"${z === tz ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      ${f('inn', 'ИНН', 'inputmode="numeric" maxlength="12"')}
      ${f('name', 'Ваше ФИО', 'required maxlength="120"')}
      ${f('phone', 'Телефон', 'type="tel" required')}
      ${f('email', 'Эл. почта', 'type="email" required')}
      ${f('login', 'Логин для входа', 'required autocomplete="username" maxlength="60"')}
      <label class="fld">Пароль<input name="password" id="su-password" type="password" minlength="8" required autocomplete="new-password" placeholder="Не короче 8 знаков"></label>
      <label class="fld check full"><input type="checkbox" name="agree" id="su-agree" value="1" required><span>Принимаю условия <a href="/offer" target="_blank">договора-оферты</a> и даю согласие на обработку персональных данных по <a href="/privacy" target="_blank">политике</a></span></label>
      <button class="btn btn-main full">Создать кабинет</button>
    </form>
  </section>`;
}

/** Public verification page opened from the QR code. Shows only what an inspector needs. */
export function checkBody({ s, st, park, titles = null }) {
  const snap = JSON.parse(s.snapshot), tz = snap.tz;
  const valid = st === 'line';
  const verdict = valid ? ['ok', 'Лист действителен', 'Водитель допущен медработником и выпущен на линию.']
    : st === 'closed' ? ['closed', 'Смена закрыта', `Машина возвращена ${fDate(tz, s.back_at)} в ${fTime(tz, s.back_at)}.`]
      : st === 'cancelled' ? ['bad', 'Лист аннулирован', s.cancel_reason || '']
        : st === 'refused' ? ['bad', 'Водитель не допущен', '']
          : ['wait', STATUS[st].label, 'Лист выписан, но водитель ещё не выпущен на линию.'];
  const row = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  return `<section class="check">
    <div class="verdict v-${verdict[0]}">${verdict[0] === 'ok' ? icon.ok : icon.warn}<div><b>${verdict[1]}</b><span>${esc(verdict[2])}</span></div></div>
    <div class="check-rows">
      ${row('Путевой лист', `№ ${esc(s.no)}`)}
      ${row('Действует', `с ${ruDay(s.shift_date)} по ${ruDay(s.valid_to)}`)}
      ${row('Перевозчик', `${esc(snap.carrier.name)}${snap.carrier.inn ? ', ИНН ' + esc(snap.carrier.inn) : ''}`)}
      ${row('Водитель', esc(shortName(snap.driver.name)))}
      ${row('Автомобиль', `${plate(snap.car)} ${esc(snap.car.model)}`)}
      ${row('Медосмотр', s.med_status === 'ok' ? `${fDate(tz, s.med_at)} ${fTime(tz, s.med_at)}, ${esc(shortName(s.med_by))}` : s.med_status === 'refused' ? 'не допущен' : 'не пройден')}
      ${row('Выпуск на линию', s.tech_status === 'ok' ? `${fDate(tz, s.tech_at)} ${fTime(tz, s.tech_at)}, ${esc(s.tech_by)}` : s.tech_status === 'refused' ? 'запрещён' : 'не выпущен')}
      ${row('Таксопарк', esc(park.name))}
      ${s.epl ? row('ГИС ЭПД', s.gis_id ? `зарегистрирован · <span class="mono">${esc(s.gis_id)}</span>` : 'не зарегистрирован') : row('Форма', 'бумажный лист: проверьте штампы и подписи')}
      ${s.epl && titles ? ['T1', 'T2', 'T3', 'T4', 'T5'].filter((c) => titles[c]).map((c) => row(TITLES[c].label, `${esc(shortName(titles[c].signer_name))}, ${SIG_LABEL[titles[c].sig_type] || ''}, ${fDate(tz, titles[c].signed_at)} ${fTime(tz, titles[c].signed_at)}`)).join('') : ''}
    </div>
    <p class="hint">Данные получены из сервиса «Путёвка» ${fDate(tz, new Date().toISOString())} в ${fTime(tz, new Date().toISOString())}.</p>
  </section>`;
}

export const checkNotFound = () => `<section class="check"><div class="verdict v-bad">${icon.warn}<div><b>Лист не найден</b><span>Такого путевого листа в сервисе нет. Возможно, QR-код подделан или повреждён.</span></div></div></section>`;

export const offlineHtml = () => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Нет связи · Путёвка</title><link rel="stylesheet" href="/app.css?v=4"></head>
<body class="drv"><main class="wrap-phone"><section class="blocked">${checker('checker big')}<h1>Нет интернета</h1><p>Последний открытый путевой лист сохранён в телефоне и откроется без сети.</p><a class="btn btn-main" href="/d">Открыть мой лист</a></section></main></body></html>`;
