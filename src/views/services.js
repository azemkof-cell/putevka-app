import { esc, fRub } from '../util.js';

const kop = (v) => Number(v || 0);
const rub = (k) => (kop(k) / 100).toString().replace('.', ',');

/* ---------- service signer's home ---------- */
export function serviceHome({ parks, current, queue, user }) {
  if (!parks.length) return `<div class="head-row"><div><h1>Очередь</h1></div></div><p class="empty">Пока ни один таксопарк не подключил вашу услугу.${user.sig_ready ? '' : ' Подключите свою подпись в разделе «Моя подпись».'}</p>`;
  return `<nav class="filters toolbar">${parks.map(({ park, waiting }) => `<a href="/x?park=${park.id}"${current && park.id === current.id ? ' aria-current="page"' : ''}>${esc(park.name)}<small class="muted">${esc(park.city)}</small>${waiting ? `<span class="nb">${waiting}</span>` : ''}</a>`).join('')}</nav>${queue}`;
}

/* ---------- platform: services and their staff ---------- */
export function servicesAdmin({ s, staff, cities }) {
  const row = (u) => `<tr class="${u.active ? '' : 'is-off'}"><td><b>${esc(u.name)}</b><small>${esc(u.login)}</small></td>
    <td>${u.role === 'medic' ? 'Медработник' : 'Механик'}<small>${esc(u.svc_org)}${u.svc_lic ? ', лиц. ' + esc(u.svc_lic) : ''}</small></td>
    <td>${esc(u.svc_city || '—')}</td>
    <td>${u.sig_ready ? `<span class="chip c-ok">${u.sig_type === 'ukep' ? 'УКЭП' : 'Госключ'}</span>` : '<span class="chip c-plan">подпись не подключена</span>'}${u.role === 'dispatcher' ? (u.tech_cert ? `<span class="chip c-ok">аттестат № ${esc(u.tech_cert)}</span>` : '<span class="chip c-bad">нет аттестата</span>') : ''}</td>
    <td class="acts"><form method="post" action="/s/services/staff/${u.id}/toggle"><button class="btn btn-sm">${u.active ? 'Отключить' : 'Включить'}</button></form></td></tr>`;
  return `<div class="head-row"><div><h1>Услуги подписантов</h1><p class="muted">Для парков без своего медработника или механика. Подписи ставят ваши исполнители своими подписями, парк платит за каждую подпись с баланса.</p></div></div>
    <form method="post" action="/s/services" class="settings">
      <fieldset><legend>Медосмотр (дистанционный)</legend>
        <label class="fld check full"><input type="checkbox" name="svcMedOn" id="sv-med-on" value="1"${s.svcMedOn === '1' ? ' checked' : ''}> Предлагать паркам</label>
        <label class="fld">Цена за осмотр, ₽<input name="svcMedPrice" id="sv-med-price" inputmode="decimal" value="${rub(s.svcMedPrice)}"></label>
        <label class="fld full">Описание для парков<textarea name="svcMedNote" id="sv-med-note" rows="2">${esc(s.svcMedNote)}</textarea></label>
        <p class="hint full">Медосмотр проводит только медорганизация с лицензией. Сервис выступает агентом: медработники — сотрудники партнёра, их организация и лицензия попадают в лист.</p></fieldset>
      <fieldset><legend>Выпуск на линию механиком</legend>
        <label class="fld check full"><input type="checkbox" name="svcMechOn" id="sv-mech-on" value="1"${s.svcMechOn === '1' ? ' checked' : ''}> Предлагать паркам</label>
        <label class="fld">Цена за смену (выпуск + приём), ₽<input name="svcMechPrice" id="sv-mech-price" inputmode="decimal" value="${rub(s.svcMechPrice)}"></label>
        <label class="fld full">Описание для парков<textarea name="svcMechNote" id="sv-mech-note" rows="2">${esc(s.svcMechNote)}</textarea></label>
        <p class="hint full">Механик осматривает машину вживую на стоянке парка. Сейчас механики есть в: ${cities.length ? esc(cities.join(', ')) : 'нигде'}.</p></fieldset>
      <button class="btn btn-dark">Сохранить</button>
    </form>
    <h2 class="h-sec">Исполнители</h2>
    ${staff.length ? `<div class="scroll"><table class="t"><thead><tr><th>ФИО</th><th>Роль и организация</th><th>Город</th><th>Подпись</th><th></th></tr></thead><tbody>${staff.map(row).join('')}</tbody></table></div>` : '<p class="empty">Исполнителей пока нет.</p>'}
    <form method="post" action="/s/services/staff" class="panel form-grid"><h2 class="full">Новый исполнитель</h2>
      <label class="fld">ФИО (как в сертификате)<input name="name" id="ss-name" required></label>
      <label class="fld">Кто<select name="kind" id="ss-kind"><option value="medic">Медработник партнёра</option><option value="mech">Механик сервиса</option></select></label>
      <label class="fld">Организация<input name="svc_org" id="ss-org" placeholder="ООО «Медпартнёр»" required></label>
      <label class="fld">Лицензия медорганизации<input name="svc_lic" id="ss-lic" placeholder="для медработника"></label>
      <label class="fld">Город<input name="svc_city" id="ss-city" placeholder="для механика"></label>
      <label class="fld">Аттестат контролёра №<input name="tech_cert" id="ss-cert" placeholder="для механика"></label>
      <label class="fld">Логин<input name="login" id="ss-login" required autocomplete="off"></label>
      <label class="fld">Пароль<input name="password" id="ss-pass" type="password" minlength="8" required autocomplete="new-password"></label>
      <button class="btn btn-dark">Добавить</button></form>`;
}

/* ---------- park: subscribe to services ---------- */
export function parkServices({ s, set, epl, cities, park }) {
  const card = (key, title, price, unit, note, on, extra = '') => `<label class="svc-card${on ? ' on' : ''}">
      <input type="checkbox" name="${key}" value="1"${on ? ' checked' : ''}${epl ? '' : ' disabled'}>
      <span class="svc-top"><b>${title}</b><span class="svc-price">${fRub(kop(price))}<small>${unit}</small></span></span>
      <span class="svc-note">${esc(note)}</span>${extra}</label>`;
  const noMech = !cities.some((c) => c.toLowerCase() === String(park.city || '').toLowerCase());
  return `<form method="post" action="/p/services" class="panel stack svc-form" id="services">
    <div><h2>Нет своего медика или механика?</h2><p class="hint">Подключите исполнителей сервиса. Они подписывают ваши листы своими подписями, оплата — за каждую подпись с баланса.${epl ? '' : ' <b>Доступно в режиме электронных листов</b> — включите его выше.'}</p></div>
    <div class="svc-grid">
      ${s.svcMedOn === '1' ? card('svcMed', 'Медосмотр', s.svcMedPrice, 'за осмотр', s.svcMedNote, set.svcMed === '1') : ''}
      ${s.svcMechOn === '1' ? card('svcMech', 'Выпуск механиком', s.svcMechPrice, 'за смену', s.svcMechNote, set.svcMech === '1', noMech ? `<span class="chip c-warn">В городе «${esc(park.city || '—')}» механиков сервиса пока нет${cities.length ? `. Есть: ${esc(cities.join(', '))}` : ''}</span>` : '') : ''}
    </div>
    <button class="btn btn-dark"${epl ? '' : ' disabled'}>Сохранить услуги</button>
  </form>`;
}

/* ---------- prices on the landing page ---------- */
export function priceBlock({ tariffs, s }) {
  const shared = tariffs.filter((t) => !t.personal).sort((a, b) => a.monthly - b.monthly);
  const def = shared.find((t) => t.is_default) || shared[0];
  const med = s.svcMedOn === '1' ? kop(s.svcMedPrice) : 0, mech = s.svcMechOn === '1' ? kop(s.svcMechPrice) : 0;
  const full = (def?.per_sheet || 0) + med + mech;
  return `<section class="price" id="price">
    <div class="price-head"><h2>Тарифы</h2><p class="muted">Платите за выписанные листы. Лист, отменённый до медосмотра, возвращается на баланс. Пополнение картой, по СБП или по счёту.</p></div>
    <div class="tariff-row">${shared.map((t) => `<div class="tcard${t === def ? ' main' : ''}">
      <span class="price-name">${esc(t.name)}</span>
      <div class="price-big">${fRub(t.per_sheet)}<small>за путевой лист</small></div>
      <p>${t.monthly ? `+ ${fRub(t.monthly)} в месяц` : 'Без абонентской платы'}</p>
      <p class="hint">${esc(t.note)}</p>
      ${t.trial_days ? `<p class="hint">${t.trial_days} дней бесплатно</p>` : ''}</div>`).join('')}</div>
    ${med || mech ? `<div class="svc-row">
      <div><h3>Без своего медика и механика</h3><p class="muted">Медосмотр проводит медработник партнёрской медорганизации дистанционно, выпуск — механик сервиса на вашей стоянке. Каждый подписывает своей подписью.</p></div>
      ${med ? `<div class="svc-pill"><b>${fRub(med)}</b><span>медосмотр</span></div>` : ''}
      ${mech ? `<div class="svc-pill"><b>${fRub(mech)}</b><span>выпуск и приём</span></div>` : ''}
      <div class="svc-pill total"><b>${fRub(full)}</b><span>смена под ключ на «${esc(def?.name || '')}»</span></div>
    </div>` : ''}
    <a class="btn btn-main" href="/signup">Подключить таксопарк</a>
  </section>`;
}

