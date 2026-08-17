/**
 * SVAROG Security v3.6.0
 * ═══════════════════════════════════════════════════════════════════
 *   • автовихід після бездіяльності
 *   • журнал входів (хто, коли, з якого пристрою)
 *   • індикатор офлайну
 *   • вибір ролі при додаванні адміна
 *   • двофакторка через Telegram-бот
 * ═══════════════════════════════════════════════════════════════════
 */

(function (global) {
  'use strict';

  const IDLE_MINUTES = 30;
  const WARN_SECONDS = 60;

  let idleTimer = null;
  let warnTimer = null;
  let lastActivity = Date.now();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function toast(m, t) {
    if (typeof global.showToast === 'function') global.showToast(m, t);
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. АВТОВИХІД
  // ═══════════════════════════════════════════════════════════════

  function resetIdle() {
    lastActivity = Date.now();
    hideWarning();
    clearTimeout(idleTimer);
    clearTimeout(warnTimer);

    idleTimer = setTimeout(showWarning, (IDLE_MINUTES * 60 - WARN_SECONDS) * 1000);
  }

  function showWarning() {
    let box = document.getElementById('sv-idle-warn');
    if (!box) {
      box = document.createElement('div');
      box.id = 'sv-idle-warn';
      box.className = 'sv-idle-warn';
      document.body.appendChild(box);
    }

    let left = WARN_SECONDS;
    const tick = function () {
      box.innerHTML =
        '<div class="sv-idle-title">🔒 Сеанс завершиться через ' + left + ' с</div>' +
        '<div class="sv-idle-sub">Адмінка була без дій ' + IDLE_MINUTES + ' хвилин</div>' +
        '<button class="btn-primary btn-sm" onclick="SvarogSecurity.stayLoggedIn()">Залишитись</button>';
      box.style.display = 'block';
      left--;
      if (left < 0) doLogout();
    };
    tick();
    warnTimer = setInterval(tick, 1000);
  }

  function hideWarning() {
    clearInterval(warnTimer);
    const box = document.getElementById('sv-idle-warn');
    if (box) box.style.display = 'none';
  }

  function stayLoggedIn() {
    resetIdle();
    toast('Сеанс продовжено', 'success');
  }

  function doLogout() {
    hideWarning();
    try {
      if (global.logAdminAction) global.logAdminAction('security', 'Автовихід через бездіяльність');
      if (global.firebase) firebase.auth().signOut();
    } catch (e) { /* нічого */ }
    location.reload();
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. ЖУРНАЛ ВХОДІВ
  // ═══════════════════════════════════════════════════════════════

  function deviceLabel() {
    const ua = navigator.userAgent;
    let os = 'невідомо';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac OS|Macintosh/i.test(ua)) os = 'macOS';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
    else if (/Linux/i.test(ua)) os = 'Linux';

    const app = /Electron/i.test(ua) ? 'Програма' : 'Браузер';
    return app + ' · ' + os;
  }

  async function recordLogin() {
    // Правило Firestore звіряє це поле з request.auth.token.email.lower(),
    // тому пишемо строго в нижньому регістрі — інакше запис відхилиться.
    const email = ((global.SvarogData && global.SvarogData.adminEmail()) || '').toLowerCase();
    if (!email || !global.db) return;
    try {
      await global.db.collection('login_history').add({
        email: email,
        device: deviceLabel(),
        userAgent: navigator.userAgent.slice(0, 200),
        at: Date.now()
      });
    } catch (e) {
      console.warn('[SVAROG] login_history:', e.code);
    }
  }

  async function renderLoginHistory() {
    const box = document.getElementById('sv-login-history');
    if (!box || !global.db) return;

    box.innerHTML = '<div style="color:#888;font-size:.85rem">Завантаження…</div>';
    try {
      const snap = await global.db.collection('login_history')
        .orderBy('at', 'desc').limit(50).get();

      const rows = [];
      snap.forEach(function (d) { rows.push(d.data()); });

      if (!rows.length) {
        box.innerHTML = '<div style="color:#888;font-size:.85rem">Записів ще немає</div>';
        return;
      }

      box.innerHTML = '<table class="an-table"><thead><tr><th>Коли</th><th>Хто</th>' +
        '<th>Пристрій</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td>' + new Date(r.at).toLocaleString('uk-UA') + '</td>' +
            '<td>' + esc(r.email) + '</td><td>' + esc(r.device) + '</td></tr>';
        }).join('') + '</tbody></table>';
    } catch (e) {
      box.innerHTML = '<div style="color:#ef4444;font-size:.85rem">Немає доступу (' + e.code + ')</div>';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. ІНДИКАТОР ОФЛАЙНУ
  //
  // Firestore при втраті мережі тихо віддає кеш, і адмін працює
  // зі старими даними, не підозрюючи про це.
  // ═══════════════════════════════════════════════════════════════

  function setOnline(online) {
    let bar = document.getElementById('sv-offline-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'sv-offline-bar';
      bar.className = 'sv-offline-bar';
      document.body.appendChild(bar);
    }
    if (online) {
      bar.style.display = 'none';
    } else {
      bar.innerHTML = '📡 Немає звʼязку — дані можуть бути застарілими, зміни не збережуться';
      bar.style.display = 'block';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. ВИБІР РОЛІ ПРИ ДОДАВАННІ АДМІНА
  //
  // Наявна кнопка створює role:"admin" — а це в правилах рівень
  // super_admin. Тобто будь-який доданий співробітник отримував
  // доступ до реквізитів картки й міг видаляти замовлення.
  // ═══════════════════════════════════════════════════════════════

  const ROLES = [
    ['operator',  'Оператор',   'Замовлення, клієнти, чати. Без налаштувань і ключів.'],
    ['moderator', 'Модератор',  'Плюс товари, контент, розсилки, промокоди.'],
    ['superadmin','Суперадмін', 'Повний доступ, включно з ключами оплат і керуванням адмінами.']
  ];

  function injectRolePicker() {
    const host = document.getElementById('sv-role-picker');
    if (!host || host.dataset.ready) return;
    host.dataset.ready = '1';
    host.innerHTML =
      '<label class="sv-label">Роль нового адміна</label>' +
      ROLES.map(function (r, i) {
        return '<label class="sv-role-opt">' +
          '<input type="radio" name="sv-new-role" value="' + r[0] + '"' + (i === 0 ? ' checked' : '') + '>' +
          '<span><b>' + r[1] + '</b><br><span style="color:#8a8f98;font-size:.8rem">' + r[2] + '</span></span>' +
          '</label>';
      }).join('');
  }

  function selectedRole() {
    const el = document.querySelector('input[name="sv-new-role"]:checked');
    return el ? el.value : 'operator';
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. ДВОФАКТОРКА ЧЕРЕЗ TELEGRAM
  //
  // Код надсилається у прив'язаний чат адміна. Без Cloud Functions:
  // повідомлення шле сама адмінка через токен бота.
  // ═══════════════════════════════════════════════════════════════

  function genCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  async function is2faEnabled(email) {
    if (!global.db) return null;
    try {
      const doc = await global.db.collection('admins').doc(String(email).toLowerCase()).get();
      if (!doc.exists) return null;
      const d = doc.data();
      return d.twoFactorChatId ? d.twoFactorChatId : null;
    } catch (e) { return null; }
  }

  /** Прив'язати Telegram для двофакторки: адмін надсилає боту /id */
  async function enable2fa() {
    const email = (global.SvarogData && global.SvarogData.adminEmail()) || '';
    const input = document.getElementById('sv-2fa-chat');
    const chatId = input ? input.value.trim() : '';
    const status = document.getElementById('sv-2fa-status');

    if (!/^-?\d{5,}$/.test(chatId)) {
      if (status) status.innerHTML = '<span style="color:#ffb020">Chat ID — це число. ' +
        'Напишіть боту /id, він його покаже.</span>';
      return;
    }

    const code = genCode();
    const ok = (typeof global.sendTelegramMessage === 'function')
      ? await global.sendTelegramMessage(chatId,
          '🔐 SVAROG: код підтвердження ' + code + '\nВведіть його в адмінці, щоб увімкнути двофакторку.', false)
      : false;

    if (!ok) {
      if (status) status.innerHTML = '<span style="color:#ef4444">Не вдалось надіслати. ' +
        'Перевірте Chat ID і що ви писали боту хоча б раз.</span>';
      return;
    }

    const entered = prompt('Введіть код, який надійшов у Telegram:');
    if (entered !== code) {
      if (status) status.innerHTML = '<span style="color:#ef4444">Код не збігається</span>';
      return;
    }

    try {
      await global.db.collection('admins').doc(String(email).toLowerCase())
        .set({ twoFactorChatId: chatId }, { merge: true });
      if (status) status.innerHTML = '<span style="color:#22c55e">✓ Двофакторку увімкнено</span>';
      toast('Двофакторку увімкнено', 'success');
      if (global.logAdminAction) global.logAdminAction('security', 'Увімкнув двофакторну автентифікацію');
    } catch (e) {
      if (status) status.innerHTML = '<span style="color:#ef4444">' + esc(e.message) + '</span>';
    }
  }

  async function disable2fa() {
    const email = (global.SvarogData && global.SvarogData.adminEmail()) || '';
    if (!confirm('Вимкнути двофакторку для ' + email + '?')) return;
    try {
      await global.db.collection('admins').doc(String(email).toLowerCase())
        .set({ twoFactorChatId: firebase.firestore.FieldValue.delete() }, { merge: true });
      const status = document.getElementById('sv-2fa-status');
      if (status) status.innerHTML = '<span style="color:#8a8f98">Двофакторку вимкнено</span>';
      if (global.logAdminAction) global.logAdminAction('security', 'Вимкнув двофакторну автентифікацію');
    } catch (e) {
      toast('Помилка: ' + e.message, 'error');
    }
  }

  /**
   * Перевірка при вході. Викликати після успішного signIn,
   * до показу адмінки.
   * @returns {Promise<boolean>} true — можна пускати
   */
  async function verifyLogin(email) {
    const chatId = await is2faEnabled(email);
    if (!chatId) return true;                     // двофакторка не увімкнена

    const code = genCode();
    const sent = (typeof global.sendTelegramMessage === 'function')
      ? await global.sendTelegramMessage(chatId, '🔐 SVAROG: код входу ' + code, false)
      : false;

    if (!sent) {
      // Не блокуємо доступ, якщо бот недоступний — інакше можна
      // назавжди замкнути себе поза адмінкою.
      toast('Не вдалось надіслати код у Telegram, вхід дозволено', 'warning');
      return true;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      const entered = prompt('Код підтвердження надіслано в Telegram (спроба ' + attempt + ' з 3):');
      if (entered === code) return true;
      if (entered === null) break;
    }

    toast('Невірний код', 'error');
    try { firebase.auth().signOut(); } catch (e) {}
    return false;
  }

  // ═══════════════════════════════════════════════════════════════

  function init() {
    ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(function (ev) {
      document.addEventListener(ev, function () {
        if (Date.now() - lastActivity > 5000) resetIdle();
      }, { passive: true });
    });
    resetIdle();

    global.addEventListener('online', function () { setOnline(true); });
    global.addEventListener('offline', function () { setOnline(false); });
    setOnline(navigator.onLine);

    recordLogin();
    injectRolePicker();
    setTimeout(renderLoginHistory, 1500);
  }

  global.SvarogSecurity = {
    init: init,
    stayLoggedIn: stayLoggedIn,
    logout: doLogout,
    renderLoginHistory: renderLoginHistory,
    selectedRole: selectedRole,
    injectRolePicker: injectRolePicker,
    enable2fa: enable2fa,
    disable2fa: disable2fa,
    verifyLogin: verifyLogin,
    ROLES: ROLES
  };

})(window);
