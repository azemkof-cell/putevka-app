import QRCode from 'qrcode';
import { esc, fNum, shortName } from './util.js';
import { fDate, fTime, ruDay } from './time.js';
import { sheetStatus, STATUS } from './service.js';
import { eplBlock } from './views/epl.js';

export function plate(c) {
  if (!c || !c.num) return '—';
  const n = c.num;
  return `<span class="plate"><span>${esc(n[0])} ${esc(n.slice(1, 4))} ${esc(n.slice(4))}</span><span class="reg">${esc(c.reg)}<small>RUS</small></span></span>`;
}

export const qrSvg = (url) => QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff00' } });

/**
 * Renders a waybill from the data frozen at the moment of issue,
 * so later edits of the carrier, driver or car never rewrite history.
 */
export function waybill(s, { qr = '', checkUrl = '', titles = null } = {}) {
  const snap = JSON.parse(s.snapshot);
  const tz = snap.tz;
  const o = snap.carrier, b = snap.blank, d = snap.driver, c = snap.car;
  const med = s.med_info ? JSON.parse(s.med_info) : null;
  const st = sheetStatus(s, tz);
  const epl = !!s.epl;
  const T = titles || {};
  const L = (lbl, val, cls = '') => `<div class="pf ${cls}"><span>${lbl}</span><b>${val || '&nbsp;'}</b></div>`;
  // Paper: an empty line for a handwritten signature under the printed name. ЭПЛ: a mark that the part is e-signed.
  const sig = (role, name, signed) => `<div class="sg"><span>${role}</span><i>${epl && signed ? '<em class="es">ЭП</em>' : ''}</i><b>${esc(name || '')}</b></div>`;
  const techOk = s.tech_status === 'ok';
  const sysNote = (text) => `<small class="sys">Отмечено в «Путёвке»: ${text}</small>`;

  // Carrier requisites are printed as text; the paper form keeps a free place for the carrier's real stamp.
  const orgStamp = `<div class="org-req"><b>${esc(o.name)}</b>${o.inn ? 'ИНН ' + esc(o.inn) : ''} ${o.ogrn ? 'ОГРН ' + esc(o.ogrn) : ''}${o.addr ? '<br>' + esc(o.addr) : ''}${o.phone ? '<br>Тел.: ' + esc(o.phone) : ''}${epl ? '' : '<span class="stamp-slot small">место для штампа</span>'}</div>`;

  const techStamp = epl
    ? `${eplBlock('T3', T.T3, tz)}${eplBlock('T4', T.T4, tz)}${s.tech_status === 'refused' ? `<div class="refused-mark">Выпуск на линию не разрешён${s.tech_note ? ': ' + esc(s.tech_note) : ''}</div>` : ''}`
    : `<div class="stamp-slot">${esc(b.techStamp)} Прошёл предрейсовый контроль технического состояния. Исправен.<span>штамп и подпись контролёра</span></div>
       ${techOk ? sysNote(`выпуск разрешён ${fDate(tz, s.tech_at)} в ${fTime(tz, s.tech_at)}, ${esc(s.tech_by)}`) : ''}
       ${s.tech_status === 'refused' ? `<div class="refused-mark">Выпуск на линию не разрешён${s.tech_note ? ': ' + esc(s.tech_note) : ''}</div>` : ''}`;

  const medStamp = epl
    ? `<div class="esig-wrap">${eplBlock('T2', T.T2, tz)}${med?.org ? `<small class="sys">${esc(med.org)}${med.lic ? ', лицензия ' + esc(med.lic) : ''}</small>` : ''}${s.med_status === 'refused' ? `<div class="refused-mark">Не допущен${s.med_note ? ': ' + esc(s.med_note) : ''}</div>` : ''}</div>`
    : `<div class="stamp-slot wide-ph">Прошёл предрейсовый медицинский осмотр, к исполнению трудовых обязанностей допущен<span>штамп медорганизации, подпись медработника, дата и время</span></div>
       ${s.med_status === 'ok' ? sysNote(`медосмотр ${fDate(tz, s.med_at)} в ${fTime(tz, s.med_at)}, ${esc(s.med_by)}`) : ''}
       ${s.med_status === 'refused' ? `<div class="refused-mark">К исполнению трудовых обязанностей не допущен${s.med_note ? ': ' + esc(s.med_note) : ''}. ${esc(s.med_by)}, ${fDate(tz, s.med_at)} ${fTime(tz, s.med_at)}</div>` : ''}`;

  const licDates = [ruDay(d.licFrom), ruDay(d.licTo)].filter(Boolean).join(' – ');
  const footer = st === 'closed' ? `Пробег за смену: ${fNum(s.odo_back - s.odo_out)} км`
    : st === 'cancelled' ? `Аннулирован: ${esc(s.cancel_reason || '')}` : STATUS[st].label;

  return `<article class="paper${st === 'cancelled' ? ' is-void' : ''}">
    ${st === 'cancelled' ? '<div class="void">АННУЛИРОВАН</div>' : ''}
    ${epl ? `<div class="epl-head"><b>Электронный путевой лист</b><span>${s.gis_id ? `Зарегистрирован в ГИС ЭПД · ${esc(s.gis_id)} · ${fDate(tz, s.gis_at)} ${fTime(tz, s.gis_at)}` : 'Ещё не зарегистрирован в ГИС ЭПД: ждёт подписей'}</span></div>` : ''}
    <div class="p-top">${orgStamp}
      <div class="p-qr">${qr ? `<div class="qr" aria-label="QR-код для проверки листа">${qr}</div>` : ''}<div class="p-legal">Реквизиты по приказу Минтранса России № 390 от 28.09.2022${checkUrl ? `<br>Проверка: <span class="mono">${esc(checkUrl.replace(/^https?:\/\//, ''))}</span>` : ''}</div></div></div>
    <div class="p-title"><div><div class="p-kind">Путевой лист</div><div class="p-dates">с <b>${ruDay(s.shift_date)}</b> по <b>${ruDay(s.valid_to)}</b></div></div>
      <div class="p-codes"><div><span>№ (серия)</span><b class="mono">${esc(s.no)}</b></div><div><span>Форма по ОКУД</span><b class="mono">${esc(b.okud)}</b></div><div><span>Гаражный №</span><b class="mono">${esc(c.garage)}</b></div></div></div>
    <div class="p-grid">
      ${L('Организация (наименование, адрес, телефон)', [o.name, o.addr, o.phone].filter(Boolean).map(esc).join(', '), 'wide')}
      ${L('Марка автомобиля', esc(c.model))}
      ${L('Государственный номерной знак', plate(c))}
      ${L('Водитель (фамилия, имя, отчество) / СНИЛС', `${esc(d.name)}${d.snils ? ' / СНИЛС ' + esc(d.snils) : ''}`, 'wide')}
      ${L('Удостоверение №, срок действия', `<span class="mono">${esc(d.lic)}</span>${licDates ? ' · ' + licDates : ''}`)}
      ${L('Класс', esc(d.cls))}
      ${L('Лицензионная карточка', esc(b.licCard))}
      ${L('Регистрационный № (реестр такси)', `<span class="mono">${esc(c.permit)}</span>`)}
      ${L('Вид сообщения', esc(b.route))}
      ${L('Вид перевозок', 'Перевозки легковым такси')}
    </div>
    <div class="p-cols">
      <div class="p-col">
        <h4>Задание водителю</h4>
        ${epl ? eplBlock('T1', T.T1, tz) : ''}
        ${L('В распоряжение', esc(o.name))}${L('Дата', ruDay(s.shift_date))}
        ${techStamp}
        <div class="p-box"><span>Время выезда с парковки, ч:мин</span><b class="mono">${techOk ? fTime(tz, s.tech_at) : ''}</b></div>
        ${sig('Контроль технического состояния ТС', techOk ? s.tech_by : '', T.T3)}
        <div class="p-box"><span>Время возвращения на парковку, ч:мин</span><b class="mono">${fTime(tz, s.back_at)}</b></div>
        ${sig('Контроль технического состояния ТС', s.closed_at ? s.closed_by : '', T.T5)}
        ${L('Опоздания, ожидания, простои, прочие отметки', '')}
        ${sig('Автомобиль сдал водитель', s.back_at ? shortName(d.name) : '', false)}
      </div>
      <div class="p-col">
        <h4>Автомобиль технически исправен</h4>
        <div class="p-box"><span>Показания спидометра при выезде, км</span><b class="mono">${fNum(s.odo_out)}</b></div>
        ${sig('Выезд разрешён · контролёр', techOk ? s.tech_by : '', T.T4)}
        ${sig('Автомобиль в исправном состоянии принял водитель', techOk ? shortName(d.name) : '', false)}
        <table class="p-t"><thead><tr><th>Горючее, марка</th><th>Код</th></tr></thead><tbody><tr><td>${esc(c.fuel)}</td><td></td></tr></tbody></table>
        <table class="p-t"><thead><tr><th>Движение горючего</th><th>л</th></tr></thead><tbody>
          <tr><th>Выдано по заправочному листу №</th><td></td></tr><tr><th>Остаток при выезде</th><td></td></tr><tr><th>Остаток при возвращении</th><td></td></tr><tr><th>Расход по норме / фактический</th><td></td></tr></tbody></table>
        <div class="p-box"><span>Автомобиль принял. Спидометр при возвращении, км</span><b class="mono">${s.closed_at ? fNum(s.odo_back) : ''}</b></div>
        ${sig('Контролёр', s.closed_at ? s.closed_by : '', T.T5)}
        ${epl ? eplBlock('T5', T.T5, tz) : ''}
      </div>
    </div>
    <div class="p-bottom">${medStamp}<div class="mp">М.П.</div></div>
    <div class="p-mark"><span>Сформирован ${fDate(tz, s.issued_at)} в ${fTime(tz, s.issued_at)}</span><span>${footer}</span></div>
  </article>`;
}
