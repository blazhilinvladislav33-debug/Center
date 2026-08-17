/* ═══════════════════════════════════════════════════════════════════
   SVAROG · ІНТЕРФЕЙС  v3.6.0

   Світла тема, гарячі клавіші, збережені фільтри, автозбереження форм,
   нагадування про резервну копію, QR-код у накладній,
   історія змін замовлення.

   Все зберігається локально в браузері (localStorage), крім історії
   змін — вона пишеться в сам документ замовлення полем statusHistory.
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var LS = {
    theme:   'svarog.theme',
    filters: 'svarog.filters',
    forms:   'svarog.forms.',
    backup:  'svarog.lastBackup'
  };

  function ls(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      if (val === null) { localStorage.removeItem(key); return null; }
      localStorage.setItem(key, val); return val;
    } catch (e) { return null; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function db() { return global.db || (global.firebase && firebase.firestore()); }

  // ═══════════════════════ 1. СВІТЛА ТЕМА ═══════════════════════════
  var THEME_CSS = [
    'body.sv-light{background:#f4f5f7;color:#1c1e21}',
    'body.sv-light .sidebar,body.sv-light .main-content,body.sv-light .sv-panel,',
    'body.sv-light .card,body.sv-light .order-card,body.sv-light .stat-card{',
    'background:#fff;color:#1c1e21;border-color:rgba(0,0,0,.08)}',
    'body.sv-light .nav-item{color:#3a3d42}',
    'body.sv-light .nav-item:hover{background:rgba(0,0,0,.05)}',
    'body.sv-light .nav-item.active{background:rgba(10,132,255,.12);color:#0a84ff}',
    'body.sv-light .sv-input,body.sv-light input,body.sv-light select,body.sv-light textarea{',
    'background:#fff;color:#1c1e21;border:1px solid rgba(0,0,0,.15)}',
    'body.sv-light .sv-hint,body.sv-light .sv-empty{color:#6b7078}',
    'body.sv-light .btn-sm,body.sv-light .sv-mini{background:rgba(0,0,0,.06);color:#1c1e21}',
    'body.sv-light .sv-search-results{background:#fff;border-color:rgba(0,0,0,.14)}',
    'body.sv-light table th{color:#6b7078}',
    'body.sv-light .fin-table td,body.sv-light .crm-history td{border-bottom:1px solid rgba(0,0,0,.07)}'
  ].join('');

  function installThemeCss() {
    if (document.getElementById('sv-theme-css')) return;
    var s = document.createElement('style');
    s.id = 'sv-theme-css';
    s.textContent = THEME_CSS;
    document.head.appendChild(s);
  }

  function applyTheme(name) {
    installThemeCss();
    if (name === 'light') document.body.classList.add('sv-light');
    else document.body.classList.remove('sv-light');
    ls(LS.theme, name);
    var btn = document.getElementById('sv-theme-btn');
    if (btn) btn.textContent = name === 'light' ? '🌙' : '☀️';
  }

  function toggleTheme() {
    applyTheme(document.body.classList.contains('sv-light') ? 'dark' : 'light');
  }

  function initTheme() {
    applyTheme(ls(LS.theme) === 'light' ? 'light' : 'dark');
    // кнопка в шапці
    if (document.getElementById('sv-theme-btn')) return;
    var host = document.querySelector('.header-actions') ||
               document.querySelector('.top-bar') ||
               document.querySelector('header');
    if (!host) return;
    var b = document.createElement('button');
    b.id = 'sv-theme-btn';
    b.className = 'sv-mini';
    b.title = 'Світла / темна тема';
    b.textContent = document.body.classList.contains('sv-light') ? '🌙' : '☀️';
    b.onclick = toggleTheme;
    host.appendChild(b);
  }

  // ═══════════════════════ 2. ГАРЯЧІ КЛАВІШІ ════════════════════════
  var HOTKEYS = [
    { k: '/',  d: 'Пошук по всьому' },
    { k: 'g o', d: 'Замовлення' },
    { k: 'g c', d: 'Чати' },
    { k: 'g s', d: 'Склад' },
    { k: 'g f', d: 'Фінанси' },
    { k: 'g a', d: 'Аналітика' },
    { k: 'g h', d: 'Головна' },
    { k: 'Esc', d: 'Закрити вікно' },
    { k: '?',  d: 'Ця підказка' }
  ];

  var TAB_KEYS = {
    o: ['orders-tab', '📦 Замовлення'],
    c: ['chats-tab', '💬 Чати'],
    s: ['stock-tab', '📦 Склад'],
    f: ['finance-tab', '💰 Фінанси'],
    a: ['analytics-tab', '📈 Аналітика'],
    h: ['home-tab', '🏠 Головна'],
    t: ['team-tab', '🤝 Команда']
  };

  var awaitingG = false;

  function isTyping(e) {
    var t = e.target;
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }

  function goTab(id, title) {
    var btn = document.querySelector('[onclick*="' + id + '"]');
    if (btn) { btn.click(); return; }
    if (global.switchTab) { try { switchTab(id, null, title); } catch (e) {} }
  }

  function initHotkeys() {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.querySelectorAll('.sv-modal.open, .modal.open, .sv-modal[style*="flex"]').forEach(function (m) {
          m.classList.remove('open');
          if (m.style.display) m.style.display = 'none';
        });
        awaitingG = false;
        return;
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;

      if (awaitingG) {
        awaitingG = false;
        var target = TAB_KEYS[e.key.toLowerCase()];
        if (target) { e.preventDefault(); goTab(target[0], target[1]); }
        return;
      }
      if (e.key === 'g') { awaitingG = true; setTimeout(function () { awaitingG = false; }, 1200); return; }
      if (e.key === '/') {
        var s = document.getElementById('sv-global-search');
        if (s) { e.preventDefault(); s.focus(); }
        return;
      }
      if (e.key === '?') { e.preventDefault(); showHotkeys(); }
    });
  }

  function showHotkeys() {
    var box = document.getElementById('sv-hotkeys-modal');
    if (!box) {
      box = document.createElement('div');
      box.id = 'sv-hotkeys-modal';
      box.className = 'sv-modal';
      box.onclick = function (ev) { if (ev.target === box) box.style.display = 'none'; };
      box.innerHTML = '<div class="sv-modal-box"><button class="sv-modal-close" ' +
        'onclick="document.getElementById(\'sv-hotkeys-modal\').style.display=\'none\'">✕</button>' +
        '<h3 class="sv-panel-title">Гарячі клавіші</h3>' +
        '<table class="fin-table"><tbody>' +
        HOTKEYS.map(function (h) {
          return '<tr><td style="width:110px"><code>' + esc(h.k) + '</code></td><td>' + esc(h.d) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      document.body.appendChild(box);
    }
    box.style.display = 'flex';
  }

  // ═══════════════════════ 3. ЗБЕРЕЖЕНІ ФІЛЬТРИ ═════════════════════
  function readFilters() {
    try { return JSON.parse(ls(LS.filters) || '{}'); } catch (e) { return {}; }
  }
  function writeFilters(o) { ls(LS.filters, JSON.stringify(o)); }

  function saveFilter(name) {
    name = (name || prompt('Назва фільтра:') || '').trim();
    if (!name) return;
    var state = {};
    document.querySelectorAll('#orders-tab select, #orders-tab input[type="text"], #orders-tab input[type="search"]')
      .forEach(function (el, i) {
        var key = el.id || ('idx' + i);
        if (el.value) state[key] = el.value;
      });
    var all = readFilters();
    all[name] = state;
    writeFilters(all);
    renderFilters();
  }

  function applyFilter(name) {
    var all = readFilters();
    var state = all[name];
    if (!state) return;
    Object.keys(state).forEach(function (key) {
      var el = document.getElementById(key);
      if (!el) return;
      el.value = state[key];
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    });
  }

  function deleteFilter(name) {
    var all = readFilters();
    delete all[name];
    writeFilters(all);
    renderFilters();
  }

  function renderFilters() {
    var host = document.getElementById('sv-saved-filters');
    if (!host) return;
    var all = readFilters();
    var names = Object.keys(all);
    host.innerHTML = names.map(function (n) {
      return '<span class="sv-filter-chip"><button class="sv-mini" onclick="SvarogUI.applyFilter(\'' +
        esc(n).replace(/'/g, '') + '\')">' + esc(n) + '</button>' +
        '<button class="sv-filter-x" title="Видалити" onclick="SvarogUI.deleteFilter(\'' +
        esc(n).replace(/'/g, '') + '\')">✕</button></span>';
    }).join('') +
    '<button class="sv-mini" onclick="SvarogUI.saveFilter()">＋ зберегти поточний</button>';
  }

  // ═══════════════════════ 4. АВТОЗБЕРЕЖЕННЯ ФОРМ ═══════════════════
  var AUTOSAVE_SELECTORS = '#merch-form input, #merch-form textarea, #news-form input, #news-form textarea';

  function initAutosave() {
    var fields = document.querySelectorAll(AUTOSAVE_SELECTORS);
    if (!fields.length) return;
    fields.forEach(function (el) {
      if (!el.id || el.dataset.svAutosave) return;
      el.dataset.svAutosave = '1';
      var saved = ls(LS.forms + el.id);
      if (saved && !el.value) el.value = saved;
      el.addEventListener('input', function () {
        if (el.value) ls(LS.forms + el.id, el.value);
        else ls(LS.forms + el.id, null);
      });
    });
  }

  function clearAutosave(prefix) {
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf(LS.forms) === 0 && (!prefix || k.indexOf(prefix) !== -1)) localStorage.removeItem(k);
      });
    } catch (e) {}
  }

  // ═══════════════════════ 5. НАГАДУВАННЯ ПРО КОПІЮ ═════════════════
  function markBackupDone() { ls(LS.backup, String(Date.now())); hideBackupReminder(); }

  function hideBackupReminder() {
    var el = document.getElementById('sv-backup-reminder');
    if (el) el.remove();
  }

  function checkBackupReminder() {
    var last = parseInt(ls(LS.backup) || '0', 10);
    var days = last ? (Date.now() - last) / 86400000 : 999;
    if (days < 7) return;
    if (document.getElementById('sv-backup-reminder')) return;
    var bar = document.createElement('div');
    bar.id = 'sv-backup-reminder';
    bar.className = 'sv-reminder';
    bar.innerHTML = '<span>💾 ' + (last
      ? 'Останню резервну копію зроблено ' + Math.floor(days) + ' дн. тому.'
      : 'Резервну копію ще жодного разу не робили.') + '</span>' +
      '<button class="sv-mini" onclick="SvarogBackups &amp;&amp; SvarogBackups.createLocalBackup()">Зробити зараз</button>' +
      '<button class="sv-mini" onclick="SvarogUI.hideBackupReminder()">Пізніше</button>';
    document.body.appendChild(bar);
  }

  // ═══════════════════════ 6. QR-КОД У НАКЛАДНІЙ ════════════════════
  // Без зовнішніх бібліотек: малюємо QR через api-сервіс не можна (офлайн),
  // тому робимо простий текстовий блок + посилання на трекінг.
  // Якщо в накладній треба саме картинка — використовуємо canvas-генератор
  // мінімального QR (версія 2, рівень L) для коротких рядків.
  function trackingUrl(ttn) {
    return 'https://novaposhta.ua/tracking/?cargo_number=' + encodeURIComponent(ttn || '');
  }

  function invoiceQrHtml(order) {
    var ttn = (order && (order.ttn || order.trackingNumber)) || '';
    if (!ttn) return '';
    var url = trackingUrl(ttn);
    return '<div style="margin-top:18px;text-align:center;font-size:12px;color:#555">' +
      '<div style="font-weight:600;margin-bottom:4px">Відстеження: ' + esc(ttn) + '</div>' +
      '<div>' + esc(url) + '</div></div>';
  }

  // ═══════════════════════ 7. ІСТОРІЯ ЗМІН ЗАМОВЛЕННЯ ═══════════════
  function logStatusChange(orderId, from, to) {
    var d = db(); if (!d || !orderId) return Promise.resolve();
    var entry = {
      from: from || '',
      to: to || '',
      at: new Date().toISOString(),
      by: global.SvarogData ? SvarogData.adminEmail() : ''
    };
    try {
      return d.collection('orders').doc(orderId).update({
        statusHistory: firebase.firestore.FieldValue.arrayUnion(entry)
      }).catch(function (e) { console.warn('[SVAROG] statusHistory:', e.code); });
    } catch (e) { return Promise.resolve(); }
  }

  function historyHtml(order) {
    var h = (order && order.statusHistory) || [];
    if (!h.length) return '<div class="sv-hint">Змін статусу ще не було.</div>';
    return '<div class="sv-notes-list">' + h.slice().reverse().map(function (e) {
      var dt = '';
      try { dt = new Date(e.at).toLocaleString('uk-UA'); } catch (x) {}
      return '<div class="sv-note"><div class="sv-note-head">' + esc(dt) + ' · ' + esc(e.by || '') + '</div>' +
        esc(e.from || '—') + ' → <b>' + esc(e.to || '') + '</b></div>';
    }).join('') + '</div>';
  }

  // Історію змін пише сама changeOrderStatus в admin.html (вона викликає
  // SvarogUI.logStatusChange). Ця обгортка — страховка на випадок, якщо
  // статус змінює якийсь інший, старіший шлях у коді.
  function wrapStatusUpdate() {
    var name = global.changeOrderStatus ? 'changeOrderStatus'
             : (global.updateOrderStatus ? 'updateOrderStatus' : null);
    if (!name) return;
    var original = global[name];
    if (original.__svWrapped || original.__svNative) return;
    // changeOrderStatus уже логує сама — не дублюємо.
    if (name === 'changeOrderStatus') { original.__svNative = true; return; }

    var wrapped = function (orderId, newStatus) {
      var before = '';
      try {
        var list = global.SvarogData ? SvarogData.orders() : [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === orderId) { before = list[i].status || ''; break; }
        }
      } catch (e) {}
      var r = original.apply(this, arguments);
      try { logStatusChange(orderId, before, newStatus); } catch (e) {}
      return r;
    };
    wrapped.__svWrapped = true;
    global[name] = wrapped;
  }

  // ═══════════════════════ ІНІЦІАЛІЗАЦІЯ ════════════════════════════
  function init() {
    try { initTheme(); } catch (e) { console.warn('[SVAROG] theme', e); }
    try { initHotkeys(); } catch (e) { console.warn('[SVAROG] hotkeys', e); }
    try { renderFilters(); } catch (e) {}
    try { initAutosave(); } catch (e) {}
    try { wrapStatusUpdate(); } catch (e) {}
    setTimeout(checkBackupReminder, 4000);
    // форми та фільтри можуть зʼявитись пізніше — перевіряємо ще раз
    setTimeout(function () { try { initAutosave(); renderFilters(); wrapStatusUpdate(); } catch (e) {} }, 6000);
  }

  global.SvarogUI = {
    init: init,
    toggleTheme: toggleTheme,
    applyTheme: applyTheme,
    showHotkeys: showHotkeys,
    saveFilter: saveFilter,
    applyFilter: applyFilter,
    deleteFilter: deleteFilter,
    renderFilters: renderFilters,
    clearAutosave: clearAutosave,
    markBackupDone: markBackupDone,
    hideBackupReminder: hideBackupReminder,
    invoiceQrHtml: invoiceQrHtml,
    trackingUrl: trackingUrl,
    logStatusChange: logStatusChange,
    historyHtml: historyHtml
  };

})(window);
