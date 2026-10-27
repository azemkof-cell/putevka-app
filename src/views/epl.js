import { esc, fNum, shortName, plural } from '../util.js';
import { ruDay, fDateTime } from '../time.js';
import { TITLES, SIG_LABEL } from '../epd.js';
import { plate } from './common.js';

const snap = (s) => JSON.parse(s.snapshot);

/** The batch-signing queue: everything this person has to sign, with one button per section. */
export function queuePage({ q, user, sandbox, operatorName, action = '/p/sign', meHref = '/p/me', title = 'На подпись', note = '' }) {
  const r = q.rights;
  const head = (s) => { const sn = snap(s); return `<td class="mono">${esc(s.no)}<small>${ruDay(s.shift_date)}</small></td><td class="nm">${esc(shortName(sn.driver.name))}</td><td>${plate(sn.car)}</td>`; };
  const check = (code, s) => `<td class="ck"><input type="checkbox" name="pick" value="${code}:${s.id}" checked aria-label="Подписать лист ${esc(s.no)}"></td>`;
  const section = (code, title, hint, rows, cols, rowFn, btn) => {
    if (!r[code]) return '';
    return `<form method="post" action="${action}" class="panel sign-sec">
      <div class="row-between"><div><h2>${title} <span class="cnt">${rows.length}</span></h2><p class="hint">${hint}</p></div>
      ${rows.length ? `<button class="btn btn-main">${btn} · ${rows.length}</button>` : ''}</div>
      ${rows.length ? `<div class="scroll flat"><table class="t t-narrow"><thead><tr><th class="ck"><input type="checkbox" data-check-all checked aria-label="Отметить все"></th><th>Лист</th><th>Водитель</th><th>Машина</th>${cols}</tr></thead><tbody>
        ${rows.map((s) => `<tr>${check(code, s)}${head(s)}${rowFn(s)}</tr>`).join('')}</tbody></table></div>` : '<p class="empty slim">Подписывать нечего.</p>'}
    </form>`;
  };
  const sel = (name, opts) => `<select name="${name}" aria-label="Результат">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`;
  return `<div class="head-row"><div><h1>${esc(title)}</h1><p class="muted">Вы подписываете своей подписью: ${esc(SIG_LABEL[user.sig_type] || 'не подключена')}. Отметьте листы и подтвердите пачку один раз в приложении подписи.</p></div>
    ${sandbox ? `<span class="chip c-warn">${esc(operatorName)}</span>` : ''}</div>
    ${!r.T1 && !r.T2 && !r.T34 && !r.T5 ? `<div class="banner b-warn"><span>Сейчас вы не можете подписывать: ${esc(r.why.join(', ') || 'ваша роль не подписывает листы')}. <a href="${meHref}">Моя подпись</a></span></div>` : ''}
    ${note}
    ${section('T2', 'Медосмотр (Т2)', 'Подписывайте только водителей, которых вы осмотрели. Недопуск тоже подписывается — с причиной.', q.T2,
      '<th>Результат</th><th>Причина недопуска</th>',
      (s) => `<td>${sel(`ok_${s.id}`, [['1', 'Допущен'], ['0', 'Не допущен']])}</td><td><input name="note_${s.id}" class="note-in" placeholder="если не допущен" aria-label="Причина"></td>`, 'Подписать медосмотр')}
    ${section('T1', 'Задания водителям (Т1)', 'Листы, выписанные водителями и диспетчерами. Можно подписать сразу на неделю вперёд.', q.T1,
      '<th>Перевозчик</th>', (s) => `<td>${esc(snap(s).carrier.name)}</td>`, 'Подписать задания')}
    ${section('T34', 'Выпуск на линию (Т3 + Т4)', 'Техконтроль и выезд одной подписью. Проверьте одометр.', q.T34,
      '<th>Одометр при выезде</th><th>Результат</th>',
      (s) => `<td><input name="odo_${s.id}" class="mono odo-in" inputmode="numeric" value="${s.odo_out ?? ''}" required aria-label="Одометр"></td><td>${sel(`ok_${s.id}`, [['1', 'Исправен, выпустить'], ['0', 'Не выпускать']])}<input name="note_${s.id}" class="note-in" placeholder="неисправность" aria-label="Неисправность"></td>`, 'Подписать выпуск')}
    ${section('T5', 'Приём машины (Т5)', 'Машины, вернувшиеся с линии.', q.T5,
      '<th>Одометр при возвращении</th>', (s) => `<td><input name="odo_${s.id}" class="mono odo-in" inputmode="numeric" value="${s.odo_back ?? ''}" placeholder="больше ${fNum(s.odo_out)}" required aria-label="Одометр"></td>`, 'Подписать приём')}`;
}

/** Waiting for the signer to confirm the batch in their own app. */
export function sessionPage({ s, items, sheets, sandbox, user, base = '/p/sign' }) {
  const meta = JSON.parse(s.result || '{}');
  const byCode = {};
  for (const it of items) (byCode[it.code] ||= []).push(it);
  const names = { T1: 'задание', T2: 'медосмотр', T34: 'выпуск', T5: 'приём машины' };
  return `<section class="card narrow sign-confirm">
    <span class="sig-ic" aria-hidden="true">✍</span>
    <h1>Подтвердите в «${esc(meta.app || 'приложении подписи')}»</h1>
    <p class="muted">${items.length} ${plural(items.length, 'документ', 'документа', 'документов')}: ${Object.entries(byCode).map(([c, a]) => `${names[c]} — ${a.length}`).join(', ')}. Подписывает ${esc(user.name)}.</p>
    <div class="code-box"><span>Код в приложении</span><b class="mono">${esc(meta.code || '—')}</b></div>
    <ul class="sign-list">${items.slice(0, 12).map((it) => { const sh = sheets.get(it.sheetId); return `<li><span class="mono">${esc(sh?.no || '')}</span> ${esc(sh ? shortName(snap(sh).driver.name) : '')} · ${names[it.code]}${it.ok === false ? ' · <b class="badmark">отказ</b>' : ''}</li>`; }).join('')}${items.length > 12 ? `<li class="muted">и ещё ${items.length - 12}</li>` : ''}</ul>
    ${sandbox ? `<form method="post" action="${base}/s/${s.id}/confirm"><button class="btn btn-main btn-wide">Подтвердить в тестовом приложении</button></form>
      <p class="hint">Тестовый оператор. В рабочем режиме на телефон подписанта придёт запрос, он подтвердит его сам, и страница обновится автоматически.</p>`
      : '<p class="hint">Ждём подтверждения… Страница обновится сама.</p>'}
    <form method="post" action="${base}/s/${s.id}/cancel"><button class="linkbtn">Отменить подписание</button></form>
  </section>`;
}

export function mySignaturePage({ user, sandbox, action = '/p/me' }) {
  const ready = !!user.sig_ready;
  const roleHint = user.service ? (user.role === 'medic' ? `Вы подписываете медосмотры как медработник ${user.svc_org || 'медорганизации-партнёра'}. Только УКЭП.` : 'Вы подписываете выпуск и приём машин как механик сервиса.')
    : user.role === 'medic' ? 'Медработник подписывает медосмотр только квалифицированной подписью (УКЭП).'
    : 'Диспетчер подписывает задание. Если у вас есть аттестация контролёра техсостояния, вы подписываете и выпуск, и приём машины.';
  return `<div class="head-row"><div><h1>Моя подпись</h1><p class="muted">Каждый подписывает только своей подписью. Передавать подпись другому человеку закон запрещает (63-ФЗ, ст. 10).</p></div></div>
    <div class="two-col">
      <form method="post" action="${action}" class="panel form-grid"><h2 class="full">${ready ? 'Подпись подключена' : 'Подключить подпись'}</h2>
        <p class="hint full">${roleHint}</p>
        <label class="fld">Вид подписи<select name="sig_type" id="me-sig">${user.role === 'medic' ? '' : `<option value="goskey"${user.sig_type === 'goskey' ? ' selected' : ''}>Госключ + машиночитаемая доверенность</option>`}<option value="ukep"${user.sig_type === 'ukep' || user.role === 'medic' ? ' selected' : ''}>УКЭП (облачная, КриптоПро myDSS)</option></select></label>
        <label class="fld">Сертификат: серийный номер<input name="sig_cert" id="me-cert" value="${esc(user.sig_cert)}" placeholder="из приложения подписи" required></label>
        <p class="hint full">Владелец сертификата: <b>${esc(user.name)}</b>. ФИО в сертификате должно совпадать.</p>
        <button class="btn btn-dark">${sandbox ? (ready ? 'Сохранить' : 'Подключить тестовую подпись') : 'Сохранить'}</button>
      </form>
      <div class="panel stack"><h2>Что вы подписываете</h2>
        <ul class="rights">
          <li class="${['owner', 'dispatcher'].includes(user.role) && !user.service ? 'yes' : 'no'}">${TITLES.T1.label} (Т1)</li>
          <li class="${user.role === 'medic' ? 'yes' : 'no'}">${TITLES.T2.label} (Т2)</li>
          <li class="${['owner', 'dispatcher'].includes(user.role) && user.tech_cert ? 'yes' : 'no'}">${TITLES.T3.label} и ${TITLES.T4.label.toLowerCase()} (Т3, Т4)</li>
          <li class="${['owner', 'dispatcher'].includes(user.role) && user.tech_cert ? 'yes' : 'no'}">${TITLES.T5.label} (Т5)</li>
        </ul>
        ${['owner', 'dispatcher'].includes(user.role) ? `<p class="hint">${user.tech_cert ? `Аттестация контролёра: № ${esc(user.tech_cert)}${user.tech_cert_date ? ' от ' + ruDay(user.tech_cert_date) : ''}.` : `Аттестации контролёра техсостояния нет. ${user.service ? 'Её вносит администратор платформы.' : 'Владелец парка вносит её в разделе «Сотрудники».'}`}</p>` : ''}
      </div>
    </div>`;
}

/** Signature blocks printed on an electronic waybill instead of ink stamps. */
export function eplBlock(code, t, tz) {
  if (!t) return `<div class="esig esig-wait"><b>${TITLES[code].label}</b><span>ожидает электронной подписи (${TITLES[code].who})</span></div>`;
  return `<div class="esig"><b>${TITLES[code].label}</b><span>Подписано электронной подписью · ${esc(SIG_LABEL[t.sig_type] || t.sig_type)}</span><span>${esc(t.signer_name)} · ${fDateTime(tz, t.signed_at)}${t.cert ? ` · серт. ${esc(t.cert)}` : ''}</span></div>`;
}
