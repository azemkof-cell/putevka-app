import { esc, fRub, plural } from '../util.js';
import { ruDay, fDateTime } from '../time.js';
import { rubWords } from '../money.js';
import { icon } from './common.js';

const STATUS = { pending: ['Ожидает оплаты', 'p-wait'], succeeded: ['Оплачен', 'p-line'], canceled: ['Отменён', 'p-closed'] };
const payPill = (p) => `<span class="pill ${STATUS[p.status][1]}">${STATUS[p.status][0]}</span>`;
const KIND = { topup: 'Пополнение', sheet: 'Путевой лист', refund: 'Возврат', monthly: 'Подписка', adjust: 'Корректировка', service: 'Услуга сервиса' };

export function accessCard({ park, access, tariff }) {
  const s = access.state;
  const head = {
    trial: ['b-info', 'Пробный период', `до ${ruDay(access.until)} включительно. Листы бесплатно.`],
    payg: ['b-ok', 'Оплата за листы', `${fRub(tariff.per_sheet)} списывается за каждый выписанный лист.`],
    active: ['b-ok', 'Подписка активна', `оплачена по ${ruDay(access.until)}. Следующее продление — ${fRub(access.monthly)} с баланса.`],
    suspended: ['b-bad', 'Подписка не продлена', `Не хватает ${fRub(access.need)}. Новые листы, водители и машины недоступны. После пополнения доступ откроется сразу.`]
  }[s];
  return `<div class="state-card ${head[0]}"><b>${head[1]}</b><span>${head[2]}</span></div>`;
}

export function forecast({ park, access, tariff, estimate }) {
  if (access.state === 'trial') return access.monthly ? `После пробного периода — ${fRub(access.monthly)} в месяц${tariff.per_sheet ? ` и ${fRub(tariff.per_sheet)} за лист` : ''}.` : '';
  if (access.monthly && park.balance >= 0) {
    const months = Math.floor(park.balance / access.monthly);
    return months ? `Баланса хватит ещё на ${months} ${plural(months, 'месяц', 'месяца', 'месяцев')} подписки.` : 'Баланса не хватит на следующий месяц.';
  }
  if (estimate > 0 && park.balance > 0) {
    const days = Math.floor(park.balance / (estimate / 30));
    return `При нынешнем числе листов хватит примерно на ${days} ${plural(days, 'день', 'дня', 'дней')}.`;
  }
  return '';
}

export function billingPage({ park, tariff, access, estimate, ledger, payments, tz, mode, payer, monthSheets }) {
  const unit = estimate > 0 ? estimate : 100000;
  const presets = [1, 3, 6].map((m) => Math.max(10000, Math.ceil((unit * m) / 10000) * 10000));
  const labels = estimate > 0 ? ['на месяц', 'на 3 месяца', 'на полгода'] : ['', '', ''];
  const amountField = (idp) => `<div class="amounts">
      ${presets.map((a, i) => `<label class="amt"><input type="radio" name="amount" value="${a / 100}"${i === 0 ? ' checked' : ''}><b>${fRub(a)}</b><small>${labels[i]}</small></label>`).join('')}
      <label class="amt amt-other"><input type="radio" name="amount" value="other"><span>Другая сумма</span><input name="amount_other" id="${idp}-other" inputmode="decimal" placeholder="₽" aria-label="Другая сумма, ₽"></label>
    </div>`;
  const pv = (k) => esc(payer[k] || '');
  return `<div class="head-row"><div><h1>Баланс и оплата</h1><p class="muted">Пополняйте заранее: подписка и листы оплачиваются с баланса автоматически.</p></div></div>
    <div class="bill-top">
      ${accessCard({ park, access, tariff })}
      <div class="panel big-num"><span>Баланс</span><b class="${park.balance < 0 ? 'bad' : ''}">${fRub(park.balance)}</b><small>${esc(forecast({ park, access, tariff, estimate }))}</small></div>
      <div class="panel"><span class="muted">Тариф «${esc(tariff.name)}»</span><h2>${tariff.monthly ? `${fRub(tariff.monthly)} в месяц` : 'Без абонентской платы'}</h2><p>${tariff.per_sheet ? `${fRub(tariff.per_sheet)} за лист` : 'Листы без доплаты'}</p><p class="hint">В этом месяце выписано ${monthSheets} ${plural(monthSheets, 'лист', 'листа', 'листов')}.${estimate ? ` В среднем ${fRub(estimate)} в месяц.` : ''}</p></div>
    </div>

    <div class="pay-grid">
      <form method="post" action="/p/billing/pay" class="panel pay-box">
        <h2>Оплатить онлайн</h2>
        <p class="hint">Деньги поступят на баланс сразу после оплаты.${mode === 'demo' ? ' <b class="warnmark">Тестовый режим: деньги не списываются.</b>' : ''}</p>
        ${amountField('on')}
        <div class="pay-methods">
          <button class="pm" name="method" value="card"${mode === 'off' ? ' disabled' : ''}><span class="pm-ic">${cardIcon}</span><b>Картой</b><small>Мир, Visa, Mastercard</small></button>
          <button class="pm" name="method" value="sbp"${mode === 'off' ? ' disabled' : ''}><span class="pm-ic">${qrIcon}</span><b>По СБП</b><small>QR-код или приложение банка</small></button>
        </div>
        ${mode === 'off' ? '<p class="hint">Онлайн-оплата не подключена. Выставьте счёт.</p>' : ''}
      </form>
      <form method="post" action="/p/billing/invoice" class="panel pay-box">
        <h2>Счёт для юрлица или ИП</h2>
        <p class="hint">Оплата с расчётного счёта. Деньги зачисляются, когда платёж придёт в банк, обычно за 1 рабочий день.</p>
        ${amountField('inv')}
        <div class="form-grid tight">
          <label class="fld full">Плательщик<input name="p_name" id="py-name" required value="${pv('name') || esc(park.name)}"></label>
          <label class="fld">ИНН<input name="p_inn" id="py-inn" inputmode="numeric" maxlength="12" value="${pv('inn') || esc(park.inn)}"></label>
          <label class="fld">КПП<input name="p_kpp" id="py-kpp" inputmode="numeric" maxlength="9" value="${pv('kpp')}"></label>
          <label class="fld full">Адрес<input name="p_addr" id="py-addr" value="${pv('addr')}"></label>
        </div>
        <button class="btn btn-dark">Выставить счёт</button>
      </form>
    </div>

    ${payments.length ? `<h2 class="h-sec">Платежи и счета</h2><div class="scroll"><table class="t t-narrow"><thead><tr><th>Дата</th><th>Способ</th><th>Документ</th><th class="num">Сумма</th><th>Статус</th><th></th></tr></thead><tbody>
    ${payments.map((p) => `<tr><td class="mono">${fDateTime(tz, p.created_at)}</td><td>${{ card: 'Карта', sbp: 'СБП', invoice: 'Счёт', manual: 'Зачисление' }[p.method]}</td>
      <td>${p.invoice_no ? `Счёт № ${esc(p.invoice_no)}` : esc(p.comment)}</td><td class="num mono">${fRub(p.paid_amount ?? p.amount)}</td><td>${payPill(p)}</td>
      <td class="acts">${p.invoice_no ? `<a class="btn btn-sm" href="/p/billing/invoice/${p.id}" target="_blank">${icon.print} Счёт</a>` : ''}${p.status === 'pending' && p.method !== 'invoice' && p.confirmation_url ? `<a class="btn btn-sm" href="${esc(p.confirmation_url)}">Оплатить</a>` : ''}
        ${p.status === 'pending' ? `<form method="post" action="/p/billing/${p.id}/cancel"><button class="btn btn-sm">Отменить</button></form>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : ''}

    <h2 class="h-sec">Движение по балансу</h2>
    ${ledger.length ? `<div class="scroll"><table class="t t-narrow"><thead><tr><th>Дата</th><th>Операция</th><th>Описание</th><th class="num">Сумма</th></tr></thead><tbody>
    ${ledger.map((l) => `<tr><td class="mono">${fDateTime(tz, l.at)}</td><td>${KIND[l.kind]}</td><td>${esc(l.comment)}</td><td class="num mono ${l.amount > 0 ? 'okmark' : ''}">${l.amount > 0 ? '+' : ''}${fRub(l.amount)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="empty">Операций пока нет.</p>'}`;
}

const cardIcon = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/></svg>';
const qrIcon = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>';

/* ---------- printable invoice ---------- */
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export function longDate(iso, tz) {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const [y, m, dd] = d.split('-');
  return `${Number(dd)} ${MONTHS[Number(m) - 1]} ${y} г.`;
}

export function vatLine(amount, rate) {
  if (!rate || rate === 'none') return ['Без налога (НДС)', '—'];
  const r = Number(rate);
  return [`В том числе НДС ${r}%`, fRub(Math.round((amount * r) / (100 + r)))];
}

export function invoiceDoc({ p, park, req, qr, purpose, tz, back }) {
  const payer = JSON.parse(p.payer || '{}');
  const [vatLabel, vatSum] = vatLine(p.amount, req.reqVat);
  const ready = req.reqName && req.reqAccount && req.reqBic;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Счёт № ${esc(p.invoice_no)}</title><link rel="stylesheet" href="/app.css?v=4"></head>
<body class="print-body">
<div class="print-bar no-print"><a class="btn" href="${esc(back)}">← Назад</a><button class="btn btn-main" type="button" data-print>${icon.print} Скачать PDF / печать</button></div>
${ready ? '' : '<p class="flash flash-bad no-print paper-w">Реквизиты получателя не заполнены. Администратор платформы указывает их в разделе «Настройки».</p>'}
<article class="paper invoice">
  <table class="bank"><tbody>
    <tr><td colspan="2" rowspan="2" class="b-name">${esc(req.reqBank)}<small>Банк получателя</small></td><td>БИК</td><td class="mono">${esc(req.reqBic)}</td></tr>
    <tr><td>Сч. №</td><td class="mono">${esc(req.reqCorr)}</td></tr>
    <tr><td>ИНН ${esc(req.reqInn)}</td><td>КПП ${esc(req.reqKpp)}</td><td rowspan="2">Сч. №</td><td rowspan="2" class="mono">${esc(req.reqAccount)}</td></tr>
    <tr><td colspan="2" class="b-name">${esc(req.reqName)}<small>Получатель</small></td></tr>
  </tbody></table>
  <h1 class="inv-title">Счёт на оплату № ${esc(p.invoice_no)} от ${longDate(p.created_at, tz)}</h1>
  <div class="inv-parties">
    <div><span>Поставщик</span><b>${esc([req.reqName, req.reqInn && 'ИНН ' + req.reqInn, req.reqKpp && 'КПП ' + req.reqKpp, req.reqAddr].filter(Boolean).join(', '))}</b></div>
    <div><span>Покупатель</span><b>${esc([payer.name, payer.inn && 'ИНН ' + payer.inn, payer.kpp && 'КПП ' + payer.kpp, payer.addr].filter(Boolean).join(', '))}</b></div>
    <div><span>Основание</span><b>Договор-оферта сервиса «Путёвка», таксопарк № ${park.id}</b></div>
  </div>
  <table class="inv-t"><thead><tr><th>№</th><th>Товары (работы, услуги)</th><th>Кол-во</th><th>Ед.</th><th>Цена</th><th>Сумма</th></tr></thead>
    <tbody><tr><td>1</td><td>Пополнение лицевого счёта (аванс) за услуги сервиса «Путёвка», таксопарк № ${park.id}</td><td>1</td><td>усл.</td><td class="mono">${fRub(p.amount)}</td><td class="mono">${fRub(p.amount)}</td></tr></tbody></table>
  <div class="inv-sum">
    <div><span>Итого:</span><b class="mono">${fRub(p.amount)}</b></div>
    <div><span>${vatLabel}:</span><b class="mono">${vatSum}</b></div>
    <div><span>Всего к оплате:</span><b class="mono">${fRub(p.amount)}</b></div>
  </div>
  <p>Всего наименований 1, на сумму ${fRub(p.amount)}<br><b>${rubWords(p.amount)}</b></p>
  <div class="inv-pay">
    ${ready && qr ? `<div class="qr big">${qr}</div>` : ''}
    <div><b>Назначение платежа</b><p class="mono-ish">${esc(purpose)}</p>
      <p class="hint">Укажите номер счёта в назначении — тогда платёж зачислится автоматически. ${ready ? 'QR-код можно отсканировать в приложении банка: реквизиты и сумма подставятся сами.' : ''}</p></div>
  </div>
  <div class="inv-sign"><div><span>Руководитель</span><i></i></div><div><span>Бухгалтер</span><i></i></div></div>
  <p class="hint">Оплата этого счёта означает согласие с условиями договора-оферты. Счёт действителен 10 банковских дней.</p>
</article>
<script src="/app.js?v=4" defer></script></body></html>`;
}

/* ---------- built-in test payment page (no YooKassa keys yet) ---------- */
export function demoPayBody({ p, park, qr }) {
  return `<section class="demo-pay">
    <div class="demo-badge">Тестовая оплата · деньги не списываются</div>
    <h1>${fRub(p.amount)}</h1>
    <p class="muted">Пополнение баланса «${esc(park.name)}»</p>
    ${p.method === 'sbp' ? `<div class="qr big center-qr">${qr}</div><p class="hint center">Так будет выглядеть QR-код СБП. В рабочем режиме его показывает ЮKassa, и он открывает приложение банка.</p>`
      : `<div class="fake-card"><span>Номер карты</span><b class="mono">2202 2000 0000 0000</b><div><span>ММ/ГГ <b class="mono">12/30</b></span><span>CVC <b class="mono">•••</b></span></div></div>`}
    <form method="post" action="/pay/demo/${p.id}" class="stack">
      <button class="btn btn-main" name="result" value="ok">Оплатить ${fRub(p.amount)}</button>
      <button class="btn" name="result" value="fail">Отказаться от оплаты</button>
    </form>
    <p class="hint">Чтобы принимать настоящие платежи, укажите ключи ЮKassa (YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY). Эта страница исчезнет.</p>
  </section>`;
}
