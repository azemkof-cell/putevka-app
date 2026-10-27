import { esc, plural } from '../util.js';

/** Push settings: switch this device on or off (needs JS) and choose what to be told about (plain form). */
export function notifyPage({ events, off, devices, enabled, action, wrapCls = '' }) {
  if (!enabled) return `<section class="${wrapCls} stack"><h1>Уведомления</h1><p class="empty">Уведомления пока не настроены на сервере. Администратор включает их ключами VAPID.</p></section>`;
  return `<section class="${wrapCls} stack notify">
    <div><h1>Уведомления</h1><p class="muted">Сообщения приходят на телефон, даже когда приложение закрыто.</p></div>
    <div class="panel stack">
      <div class="row-between push-row"><div><b>Этот телефон</b><p class="hint" id="push-state">${devices ? `Включены на ${devices} ${plural(devices, 'устройстве', 'устройствах', 'устройствах')}.` : 'Выключены.'}</p></div>
      <button class="btn btn-main push-btn" type="button" id="push-toggle" data-push-key="/api/push/key" hidden>Включить</button></div>
      <p class="hint" id="push-hint">На iPhone уведомления работают, только если приложение установлено на экран «Домой» (iOS 16.4 и новее).</p>
      <noscript><p class="hint">Чтобы включить уведомления, разрешите JavaScript в браузере.</p></noscript>
    </div>
    <form method="post" action="${action}" class="panel stack">
      <h2>О чём сообщать</h2>
      ${Object.entries(events).map(([k, label]) => `<label class="fld check"><input type="checkbox" name="on" value="${k}"${off.includes(k) ? '' : ' checked'}> ${esc(label)}</label>`).join('')}
      <button class="btn btn-dark">Сохранить</button>
    </form>
  </section>`;
}
