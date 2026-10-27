import { esc, ROLE_LABEL } from '../util.js';
import { STATUS } from '../service.js';
export { plate } from '../waybill.js';

export const APP_NAME = 'Путёвка';

export const pill = (st, extra = '') => `<span class="pill p-${STATUS[st].tone}">${STATUS[st].label}${extra}</span>`;

export const checker = (cls = 'checker') => `<span class="${cls}" aria-hidden="true"></span>`;

export const icon = {
  lock: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  warn: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v5M12 18v.5"/></svg>',
  ok: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>',
  print: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7 9V3h10v6M7 17H4v-7h16v7h-3"/><rect x="7" y="14" width="10" height="7"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
};

function head(title) {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · ${APP_NAME}</title>
<meta name="theme-color" content="#181C24">
<meta name="description" content="Электронные путевые листы для таксопарков: водитель получает лист в телефоне, медработник и диспетчер ставят отметки, лист с QR-кодом печатается на А4.">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${APP_NAME}">
<link rel="stylesheet" href="/app.css?v=4">
</head>`;
}

const flashBox = (flash) => (flash ? `<div class="flash flash-${esc(flash.tone)}" role="status">${esc(flash.text)}</div>` : '');
const logoutForm = (cls = 'linkbtn') => `<form method="post" action="/logout" data-logout><button class="${cls}">Выйти</button></form>`;

/** Public pages: landing, login, signup, verification. */
export function publicPage({ title, body, flash, bare = false }) {
  return `${head(title)}
<body class="pub">
<header class="pub-top"><a class="brand" href="/">${checker()}<b>${APP_NAME}</b></a>
${bare ? '' : `<nav class="pub-nav"><a href="/#price">Тарифы</a><a href="/login">Войти</a><a class="btn btn-main btn-sm" href="/signup">Подключить парк</a></nav>`}</header>
<main class="pub-main">${flashBox(flash)}${body}</main>
<footer class="pub-foot"><span>${checker('checker sm')} ${APP_NAME} — путевые листы такси</span><a href="/login">Вход для водителей и парков</a></footer>
<script src="/app.js?v=4" defer></script>
</body></html>`;
}

/** Driver app: phone-first single column. */
export function driverPage({ title, body, flash, rev = '', park }) {
  return `${head(title)}
<body class="drv" data-rev="${esc(rev)}">
<header class="app-top"><a class="brand" href="/d">${checker()}<b>${APP_NAME}</b></a><span class="app-park">${esc(park?.name || '')}</span>${logoutForm()}</header>
<main class="wrap-phone">${flashBox(flash)}${body}</main>
<div class="install" id="install" hidden><div><b>Установите приложение</b><span id="install-text">Лист будет под рукой даже без интернета.</span></div><button class="btn btn-main btn-sm" type="button" id="install-btn">Установить</button><button class="linkbtn" type="button" id="install-close" aria-label="Скрыть">✕</button></div>
<script src="/app.js?v=4" defer></script>
</body></html>`;
}

/** Staff app (park and platform): sidebar on desktop, scrolling tabs on phones. */
export function staffPage({ title, body, flash, rev = '', user, park, nav, active, banner = '', side = null }) {
  return `${head(title)}
<body class="staff" data-rev="${esc(rev)}">
<div class="shell">
<aside class="side">
  <a class="brand" href="${user.role === 'super' ? '/s' : user.service ? '/x' : '/p'}">${checker()}<b>${APP_NAME}</b></a>
  ${park ? `<div class="side-park"><b>${esc(park.name)}</b><small>${esc(park.city || '')}</small></div>` : side ? `<div class="side-park"><b>${esc(side[0])}</b><small>${esc(side[1])}</small></div>` : '<div class="side-park"><b>Платформа</b><small>все таксопарки</small></div>'}
  <nav class="side-nav">${nav.map(([k, href, label, badge]) => `<a href="${href}"${k === active ? ' aria-current="page"' : ''}>${label}${badge ? `<span class="nb">${badge}</span>` : ''}</a>`).join('')}</nav>
  <div class="side-me"><span>${esc(user.name)}<small>${user.service ? (user.role === 'medic' ? 'Медработник сервиса' : 'Механик сервиса') : ROLE_LABEL[user.role]}</small></span>${logoutForm()}</div>
</aside>
<main class="content">${banner}${flashBox(flash)}${body}</main>
</div>
<script src="/app.js?v=4" defer></script>
</body></html>`;
}

export function errorBody(code, text, href = '/') {
  return `<section class="card narrow center"><h1>${code === 404 ? 'Страница не найдена' : code === 403 ? 'Нет доступа' : code === 429 ? 'Слишком много попыток' : 'Ошибка'}</h1><p class="muted">${esc(text)}</p><a class="btn" href="${href}">Назад</a></section>`;
}
