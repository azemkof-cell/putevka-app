import { esc, fRub, fNum, fPhone } from '../util.js';
import { ruDay, fDateTime } from '../time.js';

export const superNav = (n = {}) => [['parks', '/s', 'Таксопарки'], ['tariffs', '/s/tariffs', 'Тарифы'], ['payments', '/s/payments', 'Платежи', n.pending || ''], ['services', '/s/services', 'Услуги'], ['platform', '/s/platform', 'Настройки']];

const accessLabel = (a) => ({ trial: `<span class="pill p-plan">пробный до ${ruDay(a.until)}</span>`, active: `<span class="pill p-line">оплачен до ${ruDay(a.until)}</span>`, payg: '<span class="pill p-closed">оплата за листы</span>', suspended: '<span class="pill p-bad">не продлён</span>' })[a.state];
const rub = (kop) => (kop / 100).toString().replace('.', ',');

export function parksPage({ rows, q, totals }) {
  return `<div class="head-row"><div><h1>Таксопарки</h1><p class="muted">${rows.length} подключено</p></div>
    <div class="kpis"><span class="kpi"><b>${fNum(totals.sheetsMonth)}</b>листов в этом месяце</span><span class="kpi"><b>${fNum(totals.drivers)}</b>водителей</span><span class="kpi"><b>${fRub(totals.revenueMonth)}</b>выручка за месяц</span></div></div>
    <form class="toolbar" method="get"><input type="search" name="q" id="pk-q" value="${esc(q)}" placeholder="Поиск: название, город, ИНН, телефон" class="search" aria-label="Поиск"></form>
    ${rows.length ? `<div class="scroll"><table class="t"><thead><tr><th>Парк</th><th>Контакт</th><th>Тариф</th><th class="num">Баланс</th><th>Доступ</th><th class="num">Водители</th><th class="num">Листов за месяц</th><th>Статус</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.p.status === 'active' ? '' : 'is-off'}">
      <td><b>${esc(r.p.name)}</b><small>${esc(r.p.city)} · № ${r.p.id}</small></td>
      <td>${esc(r.p.contact)}<small class="mono">${esc(fPhone(r.p.phone))}</small></td>
      <td>${esc(r.tariff?.name || '—')}${r.tariff?.personal ? ' <span class="chip c-plan">свой</span>' : ''}<small>${r.tariff ? fRub(r.tariff.per_sheet) + ' / лист' : ''}</small></td>
      <td class="num mono ${r.p.balance < 0 ? 'bad' : ''}">${fRub(r.p.balance)}</td>
      <td>${accessLabel(r.access)}</td>
      <td class="num">${r.drivers}</td><td class="num">${r.sheetsMonth}</td>
      <td>${r.p.status === 'active' ? '<span class="pill p-line">работает</span>' : '<span class="pill p-bad">заблокирован</span>'}</td>
      <td><a class="btn btn-sm" href="/s/parks/${r.p.id}">Открыть</a></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="empty">Таксопарков пока нет. Они подключаются сами на главной странице.</p>'}`;
}

export function parkDetail({ p, tariffs, tariff, owners, ledger, stats, access }) {
  const KIND = { topup: 'Пополнение', sheet: 'Лист', refund: 'Возврат', monthly: 'Абонентская', adjust: 'Корректировка', service: 'Услуга' };
  const tz = p.tz;
  return `<p><a href="/s" class="linkbtn">← Все таксопарки</a></p>
    <div class="head-row"><div><h1>${esc(p.name)}</h1><p class="muted">№ ${p.id} · ${esc(p.city)} · ИНН ${esc(p.inn || '—')} · подключён ${esc(p.created_at.slice(0, 10).split('-').reverse().join('.'))}</p></div>
      ${p.status === 'active'
        ? `<details class="pop right"><summary class="btn btn-bad">Заблокировать парк</summary><form method="post" action="/s/parks/${p.id}/block"><input name="reason" required placeholder="Причина (увидит парк)" aria-label="Причина"><button class="btn btn-sm btn-bad">Заблокировать</button></form></details>`
        : `<form method="post" action="/s/parks/${p.id}/unblock"><span class="badmark">Заблокирован: ${esc(p.block_reason)}</span><button class="btn btn-ok">Разблокировать</button></form>`}</div>
    <div class="bill-grid">
      <div class="panel big-num"><span>Баланс</span><b class="${p.balance < 0 ? 'bad' : ''}">${fRub(p.balance)}</b><small>${stats.sheetsMonth} листов в этом месяце, ${stats.drivers} водителей</small><div>${accessLabel(access)}</div></div>
      <form method="post" action="/s/parks/${p.id}/money" class="panel stack"><h2>Пополнить или списать</h2>
        <label class="fld">Сумма, ₽ (минус — списание)<input name="amount" id="m-amount" required inputmode="decimal" placeholder="5000"></label>
        <label class="fld">Комментарий<input name="comment" id="m-comment" placeholder="Оплата по счёту № …"></label>
        <button class="btn btn-dark">Провести</button></form>
      <div class="panel stack"><h2>Контакты</h2><p>${esc(p.contact)}<br><span class="mono">${esc(fPhone(p.phone))}</span><br>${esc(p.email)}</p>
        ${owners.map((u) => `<p class="hint">Вход владельца: <span class="mono">${esc(u.login)}</span></p>`).join('')}
        ${owners[0] ? `<details class="pop"><summary class="btn btn-sm">Сбросить пароль владельца</summary><form method="post" action="/s/parks/${p.id}/owner-password"><input name="password" type="password" minlength="8" required placeholder="Новый пароль" aria-label="Новый пароль" autocomplete="new-password"><button class="btn btn-sm btn-dark">Сохранить</button></form></details>` : ''}</div>
    </div>
    <div class="two-col">
      <form method="post" action="/s/parks/${p.id}/tariff" class="panel stack"><h2>Тариф парка</h2>
        <p class="hint">Сейчас: <b>${esc(tariff?.name || '—')}</b>${tariff ? `, ${fRub(tariff.per_sheet)} за лист${tariff.monthly ? `, ${fRub(tariff.monthly)} в месяц` : ''}` : ''}.</p>
        <label class="fld">Выбрать общий тариф<select name="tariff_id" id="pt-id">${tariffs.filter((t) => !t.personal || t.id === p.tariff_id).map((t) => `<option value="${t.id}"${t.id === p.tariff_id ? ' selected' : ''}>${esc(t.name)} — ${fRub(t.per_sheet)} / лист${t.monthly ? `, ${fRub(t.monthly)} / мес` : ''}${t.personal ? ' (свой)' : ''}</option>`).join('')}</select></label>
        <button class="btn">Назначить</button></form>
      <form method="post" action="/s/parks/${p.id}/personal" class="panel form-grid"><h2 class="full">Свой тариф для этого парка</h2>
        <label class="fld">За лист, ₽<input name="per_sheet" id="pp-sheet" required inputmode="decimal" value="${tariff?.personal ? rub(tariff.per_sheet) : ''}"></label>
        <label class="fld">В месяц, ₽<input name="monthly" id="pp-month" inputmode="decimal" value="${tariff?.personal ? rub(tariff.monthly) : '0'}"></label>
        <label class="fld full">Комментарий<input name="note" id="pp-note" value="${tariff?.personal ? esc(tariff.note) : ''}" placeholder="Скидка за объём"></label>
        <button class="btn btn-dark">${tariff?.personal ? 'Изменить свой тариф' : 'Назначить свой тариф'}</button></form>
    </div>
    <form method="post" action="/s/parks/${p.id}/trial" class="panel inline-form"><h2>Сроки доступа</h2>
      <label class="fld">Пробный период до<input type="date" name="trial_until" id="tr-until" value="${esc(p.trial_until)}"></label>
      <label class="fld">Подписка оплачена до<input type="date" name="paid_until" id="tr-paid" value="${esc(p.paid_until)}"></label>
      <button class="btn">Сохранить</button><span class="hint">Пустая дата пробного периода — он закончен. Дату оплаты меняйте только для подарка или исправления.</span></form>
    <h2 class="h-sec">Движение средств</h2>
    ${ledger.length ? `<div class="scroll"><table class="t t-narrow"><thead><tr><th>Дата</th><th>Операция</th><th>Описание</th><th>Кто</th><th class="num">Сумма</th></tr></thead><tbody>
    ${ledger.map((l) => `<tr><td class="mono">${fDateTime(tz, l.at)}</td><td>${KIND[l.kind]}</td><td>${esc(l.comment)}</td><td>${esc(l.by)}</td><td class="num mono">${l.amount > 0 ? '+' : ''}${fRub(l.amount)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="empty">Операций нет.</p>'}`;
}

export function tariffsPage({ tariffs, counts }) {
  const shared = tariffs.filter((t) => !t.personal), personal = tariffs.filter((t) => t.personal);
  const row = (t) => `<tr><td><b>${esc(t.name)}</b>${t.is_default ? ' <span class="chip c-ok">для новых парков</span>' : ''}<small>${esc(t.note)}</small></td>
    <td class="num mono">${fRub(t.per_sheet)}</td><td class="num mono">${fRub(t.monthly)}</td><td class="num">${t.trial_days}</td><td class="num">${counts.get(t.id) || 0}</td>
    <td class="acts">${t.personal ? '' : `<a class="btn btn-sm" href="/s/tariffs/${t.id}">Изменить</a>${t.is_default ? '' : `<form method="post" action="/s/tariffs/${t.id}/default"><button class="btn btn-sm">Сделать основным</button></form>`}
      <details class="pop right"><summary class="btn btn-sm">Всем паркам</summary><form method="post" action="/s/tariffs/${t.id}/apply-all"><label class="fld check"><input type="checkbox" name="personal_too" value="1"> и паркам со своим тарифом</label><button class="btn btn-sm btn-dark">Назначить всем</button></form></details>`}</td></tr>`;
  return `<div class="head-row"><div><h1>Тарифы</h1><p class="muted">Основной тариф получают новые парки. Любому парку можно назначить другой общий или свой тариф в карточке парка.</p></div></div>
    <div class="scroll"><table class="t t-narrow"><thead><tr><th>Тариф</th><th class="num">За лист</th><th class="num">В месяц</th><th class="num">Пробных дней</th><th class="num">Парков</th><th></th></tr></thead><tbody>${shared.map(row).join('')}</tbody></table></div>
    ${personal.length ? `<h2 class="h-sec">Свои тарифы парков</h2><div class="scroll"><table class="t t-narrow"><thead><tr><th>Тариф</th><th class="num">За лист</th><th class="num">В месяц</th><th class="num">Пробных дней</th><th class="num">Парков</th><th></th></tr></thead><tbody>${personal.map(row).join('')}</tbody></table></div>` : ''}
    <form method="post" action="/s/tariffs" class="panel form-grid"><h2 class="full">Новый тариф</h2>${tariffFields({ trial_days: 14 })}<button class="btn btn-dark">Создать</button></form>`;
}
function tariffFields(t) {
  return `<label class="fld">Название<input name="name" id="tf-name" required value="${esc(t.name || '')}"></label>
    <label class="fld">За лист, ₽<input name="per_sheet" id="tf-sheet" required inputmode="decimal" value="${t.per_sheet != null ? rub(t.per_sheet) : ''}"></label>
    <label class="fld">В месяц, ₽<input name="monthly" id="tf-month" inputmode="decimal" value="${t.monthly != null ? rub(t.monthly) : '0'}"></label>
    <label class="fld">Пробных дней для новых парков<input name="trial_days" id="tf-trial" inputmode="numeric" value="${t.trial_days ?? 0}"></label>
    <label class="fld full">Описание<input name="note" id="tf-note" value="${esc(t.note || '')}"></label>`;
}
export function tariffEdit({ t }) {
  return `<p><a href="/s/tariffs" class="linkbtn">← Все тарифы</a></p>
    <form method="post" action="/s/tariffs/${t.id}" class="panel form-grid"><h1 class="full">${esc(t.name)}</h1>${tariffFields(t)}<button class="btn btn-dark">Сохранить</button>
    <p class="hint full">Новая цена применяется к следующим листам. Уже выписанные не пересчитываются.</p></form>`;
}

export function paymentsPage({ rows, filter, counts, mode }) {
  const F = [['pending', 'Ждут оплаты'], ['succeeded', 'Оплачены'], ['all', 'Все']];
  const M = { card: 'Карта', sbp: 'СБП', invoice: 'Счёт', manual: 'Вручную' };
  const S = { pending: ['Ожидает', 'p-wait'], succeeded: ['Оплачен', 'p-line'], canceled: ['Отменён', 'p-closed'] };
  return `<div class="head-row"><div><h1>Платежи</h1><p class="muted">Онлайн-оплата: ${mode === 'yookassa' ? '<b class="okmark">ЮKassa подключена</b>' : mode === 'demo' ? '<b class="warnmark">тестовый режим</b> — укажите ключи ЮKassa' : 'выключена'}.</p></div>
    <a class="btn btn-main" href="/s/statement">Загрузить выписку из банка</a></div>
    <nav class="filters toolbar">${F.map(([k, l]) => `<a href="?f=${k}"${k === filter ? ' aria-current="page"' : ''}>${l}${counts[k] ? `<span class="nb">${counts[k]}</span>` : ''}</a>`).join('')}</nav>
    ${rows.length ? `<div class="scroll"><table class="t"><thead><tr><th>Дата</th><th>Парк</th><th>Способ</th><th>Документ</th><th class="num">Сумма</th><th>Статус</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="mono">${fDateTime('Europe/Moscow', r.created_at)}</td><td><a href="/s/parks/${r.park_id}">${esc(r.park)}</a><small>№ ${r.park_id}</small></td>
      <td>${M[r.method]}</td><td>${r.invoice_no ? `Счёт № ${esc(r.invoice_no)}` : esc(r.comment || r.provider_id || '')}<small>${esc(r.created_by)}</small></td>
      <td class="num mono">${fRub(r.paid_amount ?? r.amount)}${r.paid_amount != null && r.paid_amount !== r.amount ? `<small>счёт ${fRub(r.amount)}</small>` : ''}</td>
      <td><span class="pill ${S[r.status][1]}">${S[r.status][0]}</span>${r.paid_at ? `<small>${fDateTime('Europe/Moscow', r.paid_at)}</small>` : ''}</td>
      <td class="acts">${r.invoice_no ? `<a class="btn btn-sm" href="/s/invoice/${r.id}" target="_blank">Счёт</a>` : ''}
        ${r.status === 'pending' && r.method === 'invoice' ? `<details class="pop right"><summary class="btn btn-sm btn-ok">Оплачен</summary><form method="post" action="/s/payments/${r.id}/paid"><input name="amount" inputmode="decimal" value="${(r.amount / 100).toString().replace('.', ',')}" aria-label="Поступило, ₽"><button class="btn btn-sm btn-dark">Зачислить</button></form></details>` : ''}
        ${r.status === 'pending' ? `<form method="post" action="/s/payments/${r.id}/cancel"><button class="btn btn-sm">Отменить</button></form>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="empty">Платежей нет.</p>'}`;
}

export function statementPage({ result, unmatched, parks }) {
  return `<p><a href="/s/payments" class="linkbtn">← Платежи</a></p>
    <div class="head-row"><div><h1>Выписка из банка</h1><p class="muted">Выгрузите выписку в формате 1С (файл kl_to_1c.txt) из интернет-банка. Платежи со ссылкой на счёт («Счёт № 26-0001») зачислятся сами. Повторная загрузка той же выписки ничего не задвоит.</p></div></div>
    ${result ? `<div class="panel stat-res"><b>Загружено.</b> Зачислено по счетам: ${result.matched.length}. Без счёта: ${result.unmatched.length}. Уже были загружены: ${result.skipped}.${result.foreign ? ` На другой счёт: ${result.foreign}.` : ''}
      ${result.matched.length ? `<ul>${result.matched.map((m) => `<li>${fRub(m.amount)} — счёт № ${esc(m.invoice)}, парк № ${m.parkId}</li>`).join('')}</ul>` : ''}</div>` : ''}
    <form method="post" action="/s/statement" class="panel stack">
      <label class="fld">Файл выписки<input type="file" id="st-file" accept=".txt" data-load-into="st-text"></label>
      <label class="fld">или вставьте текст выписки<textarea name="text" id="st-text" rows="8" class="mono" placeholder="1CClientBankExchange …"></textarea></label>
      <button class="btn btn-dark">Разнести платежи</button>
    </form>
    <h2 class="h-sec">Платежи без счёта</h2>
    ${unmatched.length ? `<div class="scroll"><table class="t"><thead><tr><th>Дата</th><th>Плательщик</th><th>Назначение</th><th class="num">Сумма</th><th>Зачислить парку</th></tr></thead><tbody>
    ${unmatched.map((d) => `<tr><td class="mono">${esc(d.doc_date)}<small>п/п № ${esc(d.doc_no)}</small></td><td>${esc(d.payer)}<small>ИНН ${esc(d.payer_inn)}</small></td><td>${esc(d.purpose)}</td><td class="num mono">${fRub(d.amount)}</td>
      <td class="acts"><form method="post" action="/s/statement/${d.id}/assign" class="inline"><select name="park_id" aria-label="Таксопарк">${parks.map((p) => `<option value="${p.id}"${p.inn && p.inn === d.payer_inn ? ' selected' : ''}>${esc(p.name)} (№ ${p.id})</option>`).join('')}</select><button class="btn btn-sm btn-ok">Зачислить</button></form>
        <form method="post" action="/s/statement/${d.id}/ignore"><button class="btn btn-sm">Не наш</button></form></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="empty">Неразнесённых платежей нет.</p>'}`;
}

export function platformPage({ s }) {
  return `<div class="head-row"><div><h1>Настройки платформы</h1></div></div>
    <form method="post" action="/s/platform" class="settings"><fieldset><legend>Для таксопарков</legend>
      <label class="fld full">Как пополнить баланс (видят владельцы парков)<textarea name="payInfo" id="pl-pay" rows="3">${esc(s.payInfo || '')}</textarea></label>
      <label class="fld">Телефон поддержки<input name="supportPhone" id="pl-phone" value="${esc(s.supportPhone || '')}"></label>
      <label class="fld">Почта поддержки<input name="supportEmail" id="pl-email" value="${esc(s.supportEmail || '')}"></label>
      <label class="fld check full"><input type="checkbox" name="signupOpen" id="pl-signup" value="1"${s.signupOpen !== '0' ? ' checked' : ''}> Парки могут подключаться сами</label>
    </fieldset>
    <fieldset><legend>Реквизиты для счетов</legend>
      <label class="fld full">Получатель<input name="reqName" id="pl-rname" value="${esc(s.reqName || '')}" placeholder="ООО «Путёвка»"></label>
      <label class="fld">ИНН<input name="reqInn" id="pl-rinn" value="${esc(s.reqInn || '')}" inputmode="numeric"></label>
      <label class="fld">КПП<input name="reqKpp" id="pl-rkpp" value="${esc(s.reqKpp || '')}" inputmode="numeric"></label>
      <label class="fld">Расчётный счёт<input name="reqAccount" id="pl-racc" value="${esc(s.reqAccount || '')}" inputmode="numeric" maxlength="20"></label>
      <label class="fld">Банк<input name="reqBank" id="pl-rbank" value="${esc(s.reqBank || '')}"></label>
      <label class="fld">БИК<input name="reqBic" id="pl-rbic" value="${esc(s.reqBic || '')}" inputmode="numeric" maxlength="9"></label>
      <label class="fld">Корр. счёт<input name="reqCorr" id="pl-rcorr" value="${esc(s.reqCorr || '')}" inputmode="numeric" maxlength="20"></label>
      <label class="fld full">Адрес<input name="reqAddr" id="pl-raddr" value="${esc(s.reqAddr || '')}"></label>
      <label class="fld">НДС<select name="reqVat" id="pl-rvat">${[['none', 'Без НДС'], ['5', 'НДС 5%'], ['7', 'НДС 7%'], ['10', 'НДС 10%'], ['22', 'НДС 22%']].map(([v, l]) => `<option value="${v}"${(s.reqVat || 'none') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    </fieldset><button class="btn btn-dark">Сохранить</button></form>`;
}
