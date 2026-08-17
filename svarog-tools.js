/**
 * SVAROG Tools v3.5.0
 * ═══════════════════════════════════════════════════════════════════
 * Інструменти щоденної роботи, вбудовані в наявну адмінку:
 *
 *   • масова зміна статусів із чекбоксами
 *   • нотатки до замовлення (внутрішні, клієнт не бачить)
 *   • друк накладної
 *   • пошук по всій адмінці
 *   • блоки на головній: завислі замовлення, склад, прогноз
 *
 * Наявний код не змінюється: renderOrdersList обгортається, а не
 * переписується. Якщо модуль не завантажиться — адмінка працює як була.
 * ═══════════════════════════════════════════════════════════════════
 */

(function (global) {
  'use strict';

  const A = global.SvarogAdapter;

  function svOrders() { return (global.SvarogData && global.SvarogData.orders()) || []; }
  function svMerch()  { return (global.SvarogData && global.SvarogData.merch())  || []; }

  const selected = new Set();

  const STATUSES = {
    new:       ['🆕', 'Нове'],
    on_review: ['👀', 'На розгляді'],
    accepted:  ['✅', 'Прийнято'],
    sent:      ['📦', 'Відправлено'],
    delivered: ['🎉', 'Доставлено'],
    cancelled: ['❌', 'Скасовано']
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function money(v) {
    return new Intl.NumberFormat('uk-UA').format(Math.round(v || 0)) + ' ₴';
  }

  function daysAgo(order) {
    const d = A.createdAt(order);
    if (!d) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  // ═══════════════════════════════════════════════════════════════
  // МАСОВІ ДІЇ НАД ЗАМОВЛЕННЯМИ
  // ═══════════════════════════════════════════════════════════════

  /**
   * Картки малює наявна renderOrdersList через innerHTML +=,
   * тому ідентифікатор замовлення дістаємо з розмітки: у кнопках
   * уже є onclick="...('ID')". Так не треба чіпати чужий код.
   */
  function cardOrderId(card) {
    const ids = svOrders().map(function (o) { return o.id; });
    const html = card.innerHTML;
    for (let i = 0; i < ids.length; i++) {
      if (html.indexOf("'" + ids[i] + "'") !== -1) return ids[i];
    }
    return null;
  }

  function enhanceOrderCards() {
    const box = document.getElementById('box-for-orders');
    if (!box) return;

    const cards = box.querySelectorAll('.admin-card');
    if (!cards.length) { renderBulkBar(0); return; }

    cards.forEach(function (card) {
      if (card.dataset.svEnhanced) return;
      const id = cardOrderId(card);
      if (!id) return;

      card.dataset.svEnhanced = '1';
      card.dataset.svOrderId = id;

      const panel = document.createElement('div');
      panel.className = 'sv-card-tools';
      panel.innerHTML =
        '<label class="sv-check">' +
          '<input type="checkbox" ' + (selected.has(id) ? 'checked' : '') +
          ' onchange="SvarogTools.toggle(\'' + id + '\', this.checked)"> обрати' +
        '</label>' +
        '<button class="sv-mini" onclick="SvarogTools.openNotes(\'' + id + '\')">📝 Нотатки<span id="sv-note-count-' + id + '"></span></button>' +
        '<button class="sv-mini" onclick="SvarogTools.printOrder(\'' + id + '\')">🖨 Друк</button>' +
        '<button class="sv-mini" onclick="SvarogTools.cloneOrder(\'' + id + '\')">📄 Повторити</button>';

      card.insertBefore(panel, card.firstChild);
      updateNoteBadge(id);
    });

    renderBulkBar(selected.size);
  }

  function toggle(id, on) {
    if (on) selected.add(id); else selected.delete(id);
    renderBulkBar(selected.size);
  }

  function selectAllVisible() {
    const box = document.getElementById('box-for-orders');
    if (!box) return;
    box.querySelectorAll('.admin-card').forEach(function (c) {
      const id = c.dataset.svOrderId;
      if (id) {
        selected.add(id);
        const cb = c.querySelector('.sv-check input');
        if (cb) cb.checked = true;
      }
    });
    renderBulkBar(selected.size);
  }

  function clearSelection() {
    selected.clear();
    const box = document.getElementById('box-for-orders');
    if (box) box.querySelectorAll('.sv-check input').forEach(function (cb) { cb.checked = false; });
    renderBulkBar(0);
  }

  function renderBulkBar(count) {
    let bar = document.getElementById('sv-bulk-bar');
    const box = document.getElementById('box-for-orders');
    if (!box) return;

    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'sv-bulk-bar';
      bar.className = 'sv-bulk-bar';
      box.parentNode.insertBefore(bar, box);
    }

    if (!count) {
      bar.innerHTML = '<button class="sv-mini" onclick="SvarogTools.selectAllVisible()">☑ Обрати всі видимі</button>';
      bar.classList.remove('active');
      return;
    }

    bar.classList.add('active');
    bar.innerHTML =
      '<span class="sv-bulk-count">Обрано: <b>' + count + '</b></span>' +
      '<select id="sv-bulk-status" class="sv-input" style="max-width:190px">' +
        '<option value="">— змінити статус на —</option>' +
        Object.keys(STATUSES).map(function (k) {
          return '<option value="' + k + '">' + STATUSES[k][0] + ' ' + STATUSES[k][1] + '</option>';
        }).join('') +
      '</select>' +
      '<button class="btn-primary btn-sm" onclick="SvarogTools.applyBulkStatus()">Застосувати</button>' +
      '<button class="sv-mini" onclick="SvarogTools.exportSelected()">⬇ CSV</button>' +
      '<button class="sv-mini" onclick="SvarogTools.printSelected()">🖨 Друк усіх</button>' +
      '<button class="sv-mini" onclick="SvarogTools.clearSelection()">✕ Зняти</button>';
  }

  async function applyBulkStatus() {
    const sel = document.getElementById('sv-bulk-status');
    const status = sel ? sel.value : '';
    if (!status) { toast('Оберіть статус', 'warning'); return; }
    if (!selected.size) return;

    const label = STATUSES[status] ? STATUSES[status][1] : status;
    const ids = Array.from(selected);

    // Масова дія розсилає сповіщення клієнтам — помилка тут дорога,
    // тому підтвердження обовʼязкове.
    if (!confirm(
      'Змінити статус на «' + label + '» для ' + ids.length + ' замовлень?\n\n' +
      'Кожен клієнт, який привʼязав Telegram, отримає сповіщення.\n' +
      'Скасувати розсилку буде неможливо.'
    )) return;

    let done = 0, failed = 0;
    for (const id of ids) {
      try {
        const patch = { status: status };
        if (status === 'sent') patch.sentAt = firebase.firestore.FieldValue.serverTimestamp();
        if (status === 'delivered') patch.deliveredAt = firebase.firestore.FieldValue.serverTimestamp();
        await global.db.collection('orders').doc(id).update(patch);
        done++;
        if (typeof global.notifyCustomerOrderStatus === 'function') {
          global.notifyCustomerOrderStatus(id, status);
        }
      } catch (e) {
        failed++;
        console.error('[SVAROG] bulk', id, e);
      }
    }

    toast('Оновлено ' + done + (failed ? ', помилок ' + failed : ''), failed ? 'warning' : 'success');
    if (global.logAdminAction) {
      global.logAdminAction('orders', 'Масово змінив статус на «' + label + '» для ' + done + ' замовлень');
    }
    clearSelection();
  }

  function exportSelected() {
    const ids = new Set(selected);
    const rows = svOrders().filter(function (o) { return ids.has(o.id); });
    exportOrdersCsv(rows, 'svarog-orders');
  }

  function exportOrdersCsv(rows, prefix) {
    const header = ['Номер', 'Дата', 'Клієнт', 'Телефон', 'Місто', 'Сума', 'Статус', 'ТТН'];
    const lines = [header.join(',')].concat(rows.map(function (o) {
      const d = A.createdAt(o);
      return [
        o.id,
        d ? d.toLocaleDateString('uk-UA') : '',
        A.field(o, 'name', ''),
        A.field(o, 'phone', ''),
        A.field(o, 'city', ''),
        Math.round(A.total(o)),
        (STATUSES[o.status] || ['', o.status || ''])[1],
        o.ttn || ''
      ].map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
    }));

    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = prefix + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    toast('Вивантажено ' + rows.length + ' замовлень', 'success');
  }

  // ═══════════════════════════════════════════════════════════════
  // НОТАТКИ ДО ЗАМОВЛЕННЯ
  // ═══════════════════════════════════════════════════════════════

  function updateNoteBadge(id) {
    const el = document.getElementById('sv-note-count-' + id);
    if (!el) return;
    const order = svOrders().find(function (o) { return o.id === id; });
    const n = (order && order.adminNotes && order.adminNotes.length) || 0;
    el.innerHTML = n ? ' <b style="color:#ffb020">' + n + '</b>' : '';
  }

  function openNotes(id) {
    const order = svOrders().find(function (o) { return o.id === id; });
    if (!order) return;

    const notes = order.adminNotes || [];
    const modal = document.getElementById('sv-notes-modal');
    const body = document.getElementById('sv-notes-body');
    if (!modal || !body) return;

    body.innerHTML =
      '<h2 style="margin:0 0 4px">📝 Нотатки</h2>' +
      '<div style="color:#888;font-size:.85rem;margin-bottom:14px">' +
        'Замовлення <code>' + esc(id) + '</code> · ' + esc(A.field(order, 'name', '')) +
        '<br>Клієнт цих записів не бачить.' +
      '</div>' +
      (notes.length
        ? '<div class="sv-notes-list">' + notes.slice().reverse().map(function (n) {
            return '<div class="sv-note">' +
              '<div class="sv-note-head">' + esc(n.author || '—') + ' · ' +
                (n.at ? new Date(n.at).toLocaleString('uk-UA') : '') + '</div>' +
              '<div>' + esc(n.text) + '</div>' +
            '</div>';
          }).join('') + '</div>'
        : '<div style="color:#888;padding:12px 0">Записів ще немає</div>') +
      '<textarea id="sv-note-input" class="sv-input" rows="3" style="width:100%;margin-top:12px" ' +
        'placeholder="Наприклад: клієнт просив не дзвонити до 18:00"></textarea>' +
      '<button class="btn-primary" style="width:100%;margin-top:10px" ' +
        'onclick="SvarogTools.addNote(\'' + id + '\')">Додати запис</button>';

    modal.style.display = 'flex';
  }

  function closeNotes() {
    const m = document.getElementById('sv-notes-modal');
    if (m) m.style.display = 'none';
  }

  async function addNote(id) {
    const ta = document.getElementById('sv-note-input');
    const text = ta ? ta.value.trim() : '';
    if (!text) return;

    const note = {
      text: text,
      author: (global.SvarogData && global.SvarogData.adminEmail()) || 'admin',
      at: Date.now()
    };

    try {
      await global.db.collection('orders').doc(id).update({
        adminNotes: firebase.firestore.FieldValue.arrayUnion(note)
      });
      toast('Нотатку додано', 'success');
      closeNotes();
      setTimeout(function () { openNotes(id); }, 400);
    } catch (e) {
      toast('Помилка: ' + e.message, 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ДРУК НАКЛАДНОЇ
  // ═══════════════════════════════════════════════════════════════

  function orderPrintHtml(order) {
    const d = A.createdAt(order);
    const items = A.field(order, 'items', []) || [];

    const rows = (Array.isArray(items) ? items : []).map(function (it) {
      const title = A.field(it, 'name', 'Позиція');
      const qty = A.num(A.field(it, 'quantity', 1), 1);
      const sum = A.num(A.field(it, 'total', 0), 0);
      const extra = [it.color, it.size && it.size !== 'Універсальний' ? it.size : null]
        .filter(Boolean).join(', ');
      return '<tr><td>' + esc(title) + (extra ? ' <span style="color:#666">(' + esc(extra) + ')</span>' : '') +
             '</td><td style="text-align:center">' + qty + '</td>' +
             '<td style="text-align:right">' + money(sum) + '</td></tr>';
    }).join('');

    return '' +
      '<div class="sheet">' +
      '<div class="head">' +
        '<div><div class="brand">SVAROG TEAM</div>' +
        '<div class="sub">Замовлення ' + esc(order.id) + '</div></div>' +
        '<div class="date">' + (d ? d.toLocaleDateString('uk-UA') : '') + '</div>' +
      '</div>' +
      '<table class="info"><tr><td>Отримувач</td><td><b>' + esc(A.field(order, 'name', '')) + '</b></td></tr>' +
      '<tr><td>Телефон</td><td>' + esc(A.field(order, 'phone', '')) + '</td></tr>' +
      '<tr><td>Адреса</td><td>' + esc(A.field(order, 'address', '—')) + '</td></tr>' +
      (order.ttn ? '<tr><td>ТТН</td><td><b>' + esc(order.ttn) + '</b></td></tr>' : '') +
      '</table>' +
      (rows
        ? '<table class="items"><thead><tr><th>Позиція</th><th style="width:60px">К-сть</th>' +
          '<th style="width:110px">Сума</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="empty">' + esc(order.orderTextDetails || 'Склад замовлення не вказано') + '</div>') +
      '<div class="total">ДО СПЛАТИ: ' + money(A.total(order)) + '</div>' +
      '<div class="foot">Дякуємо за підтримку! Разом до перемоги. 🇺🇦</div>' +
      '</div>';
  }

  function printHtmlDocument(inner) {
    const win = window.open('', '_blank');
    if (!win) { toast('Браузер заблокував вікно друку', 'warning'); return; }
    win.document.write(
      '<!DOCTYPE html><html lang="uk"><head><meta charset="utf-8"><title>SVAROG — друк</title><style>' +
      'body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;padding:0;background:#fff}' +
      '.sheet{padding:26px 30px;page-break-after:always}' +
      '.sheet:last-child{page-break-after:auto}' +
      '.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px}' +
      '.brand{font-size:22px;font-weight:800;letter-spacing:2px}' +
      '.sub{font-size:12px;color:#555;margin-top:3px;font-family:monospace}' +
      '.date{font-size:12px;color:#555}' +
      '.info{width:100%;margin:16px 0;font-size:13px;border-collapse:collapse}' +
      '.info td{padding:4px 0}.info td:first-child{color:#666;width:110px}' +
      '.items{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}' +
      '.items th{text-align:left;border-bottom:1px solid #111;padding:6px 4px;font-size:11px;text-transform:uppercase}' +
      '.items td{padding:6px 4px;border-bottom:1px solid #ddd}' +
      '.empty{font-size:13px;white-space:pre-wrap;margin:10px 0;color:#333}' +
      '.total{margin-top:16px;text-align:right;font-size:17px;font-weight:800}' +
      '.foot{margin-top:26px;text-align:center;font-size:12px;color:#555}' +
      '@media print{body{-webkit-print-color-adjust:exact}}' +
      '</style></head><body>' + inner + '</body></html>'
    );
    win.document.close();
    setTimeout(function () { win.print(); }, 350);
  }

  function printOrder(id) {
    const order = svOrders().find(function (o) { return o.id === id; });
    if (!order) return;
    printHtmlDocument(orderPrintHtml(order));
  }

  function printSelected() {
    const ids = new Set(selected);
    const rows = svOrders().filter(function (o) { return ids.has(o.id); });
    if (!rows.length) return;
    printHtmlDocument(rows.map(orderPrintHtml).join(''));
  }

  // ═══════════════════════════════════════════════════════════════
  // ПОВТОРНЕ ЗАМОВЛЕННЯ
  // ═══════════════════════════════════════════════════════════════

  async function cloneOrder(id) {
    const src = svOrders().find(function (o) { return o.id === id; });
    if (!src) return;
    if (!confirm('Створити нове замовлення з тими самими даними клієнта?')) return;

    const copy = {
      name: A.field(src, 'name', ''),
      phone: A.field(src, 'phone', ''),
      address: A.field(src, 'address', ''),
      items: A.field(src, 'items', []) || [],
      totalPrice: A.total(src),
      status: 'new',
      paymentMethod: src.paymentMethod || 'card',
      clonedFrom: id,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      time: new Date().toLocaleString('uk-UA')
    };

    try {
      const ref = await global.db.collection('orders').add(copy);
      toast('Створено замовлення ' + ref.id, 'success');
      if (global.logAdminAction) {
        global.logAdminAction('orders', 'Повторив замовлення ' + id + ' → ' + ref.id);
      }
    } catch (e) {
      toast('Помилка: ' + e.message, 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ПОШУК ПО ВСІЙ АДМІНЦІ
  // ═══════════════════════════════════════════════════════════════

  function globalSearch(query) {
    const q = (query || '').trim().toLowerCase();
    const box = document.getElementById('sv-search-results');
    if (!box) return;

    if (q.length < 2) { box.style.display = 'none'; return; }

    const digits = q.replace(/\D/g, '');
    const results = [];

    svOrders().forEach(function (o) {
      const hay = [o.id, A.field(o, 'name', ''), A.field(o, 'phone', ''), o.ttn, A.field(o, 'city', '')]
        .filter(Boolean).join(' ').toLowerCase();
      const phoneHit = digits.length >= 5 &&
        String(A.field(o, 'phone', '')).replace(/\D/g, '').indexOf(digits) !== -1;
      if (hay.indexOf(q) !== -1 || phoneHit) {
        results.push({
          type: 'Замовлення',
          title: A.field(o, 'name', 'Без імені') + ' · ' + money(A.total(o)),
          sub: o.id + (o.ttn ? ' · ТТН ' + o.ttn : ''),
          action: "SvarogTools.goToOrder('" + o.id + "')"
        });
      }
    });

    svMerch().forEach(function (m) {
      const title = A.field(m, 'name', '');
      if (String(title).toLowerCase().indexOf(q) !== -1) {
        results.push({
          type: 'Товар',
          title: title,
          sub: (m.price || 0) + ' ₴',
          action: "switchTab('shop-management-tab', null, '🛍 Склад та Магазин')"
        });
      }
    });

    if (!results.length) {
      box.innerHTML = '<div class="sv-search-empty">Нічого не знайдено</div>';
      box.style.display = 'block';
      return;
    }

    box.innerHTML = results.slice(0, 12).map(function (r) {
      return '<div class="sv-search-item" onclick="' + r.action + '; SvarogTools.closeSearch()">' +
        '<span class="sv-search-type">' + r.type + '</span>' +
        '<span class="sv-search-title">' + esc(r.title) + '</span>' +
        '<span class="sv-search-sub">' + esc(r.sub) + '</span>' +
      '</div>';
    }).join('') + (results.length > 12
      ? '<div class="sv-search-empty">…і ще ' + (results.length - 12) + '</div>' : '');
    box.style.display = 'block';
  }

  function closeSearch() {
    const box = document.getElementById('sv-search-results');
    const inp = document.getElementById('sv-search-input');
    if (box) box.style.display = 'none';
    if (inp) inp.value = '';
  }

  function goToOrder(id) {
    if (typeof global.switchTab === 'function') {
      global.switchTab('orders-tab', null, '📦 Управління замовленнями');
    }
    const search = document.getElementById('orders-search-input');
    if (search) {
      search.value = id;
      if (typeof global.renderOrdersList === 'function') global.renderOrdersList();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // БЛОКИ НА ГОЛОВНІЙ
  // ═══════════════════════════════════════════════════════════════

  function stuckOrders() {
    const stuckNew = [], noTtn = [];
    svOrders().forEach(function (o) {
      if (o.deletedAt) return;
      const age = daysAgo(o);
      if (age === null) return;
      const st = o.status || 'new';
      if ((st === 'new' || st === 'on_review') && age >= 2) stuckNew.push({ o: o, age: age });
      if (st === 'sent' && !o.ttn) noTtn.push({ o: o, age: age });
    });
    stuckNew.sort(function (a, b) { return b.age - a.age; });
    return { stuckNew: stuckNew, noTtn: noTtn };
  }

  function stockAlerts() {
    const sold = {};
    const since = Date.now() - 30 * 86400000;

    svOrders().forEach(function (o) {
      const d = A.createdAt(o);
      if (!d || d.getTime() < since) return;
      if ((o.status || '') === 'cancelled' || o.deletedAt) return;
      (A.field(o, 'items', []) || []).forEach(function (it) {
        const title = A.field(it, 'name', null);
        if (!title) return;
        sold[title] = (sold[title] || 0) + A.num(A.field(it, 'quantity', 1), 1);
      });
    });

    const low = [], dead = [];
    svMerch().forEach(function (m) {
      if (m.hidden || m.deletedAt) return;
      const title = A.field(m, 'name', 'Без назви');

      let stock = m.stock;
      if (stock && typeof stock === 'object') {
        stock = Object.keys(stock).reduce(function (s, k) {
          return s + (typeof stock[k] === 'number' ? stock[k] : 0);
        }, 0);
      }
      if (typeof stock !== 'number') return;

      const perDay = (sold[title] || 0) / 30;
      const daysLeft = perDay > 0 ? Math.floor(stock / perDay) : null;

      if (stock <= 0) {
        low.push({ title: title, stock: 0, daysLeft: 0 });
      } else if (daysLeft !== null && daysLeft <= 14) {
        low.push({ title: title, stock: stock, daysLeft: daysLeft });
      } else if (!sold[title] && stock > 0) {
        dead.push({ title: title, stock: stock });
      }
    });

    low.sort(function (a, b) { return (a.daysLeft || 0) - (b.daysLeft || 0); });
    return { low: low, dead: dead };
  }

  function renderHomeBlocks() {
    const host = document.getElementById('sv-home-blocks');
    if (!host) return;

    const s = stuckOrders();
    const st = stockAlerts();
    const parts = [];

    if (s.stuckNew.length || s.noTtn.length) {
      parts.push(
        '<div class="sv-panel" style="border-left:3px solid #ffb020">' +
        '<h3 class="sv-panel-title">⏳ Потребує уваги</h3>' +
        (s.stuckNew.length
          ? '<div class="sv-alert-row"><b>' + s.stuckNew.length + '</b> нових замовлень чекають понад 2 дні</div>' +
            s.stuckNew.slice(0, 5).map(function (x) {
              return '<div class="sv-alert-item" onclick="SvarogTools.goToOrder(\'' + x.o.id + '\')">' +
                esc(A.field(x.o, 'name', 'Без імені')) + ' · ' + money(A.total(x.o)) +
                ' <span style="color:#ffb020">' + x.age + ' дн.</span></div>';
            }).join('')
          : '') +
        (s.noTtn.length
          ? '<div class="sv-alert-row" style="margin-top:10px"><b>' + s.noTtn.length +
            '</b> відправлених без ТТН</div>' +
            s.noTtn.slice(0, 5).map(function (x) {
              return '<div class="sv-alert-item" onclick="SvarogTools.goToOrder(\'' + x.o.id + '\')">' +
                esc(A.field(x.o, 'name', 'Без імені')) + ' · ' + esc(x.o.id) + '</div>';
            }).join('')
          : '') +
        '</div>'
      );
    }

    if (st.low.length || st.dead.length) {
      parts.push(
        '<div class="sv-panel" style="border-left:3px solid #ef4444">' +
        '<h3 class="sv-panel-title">📦 Склад</h3>' +
        (st.low.length
          ? st.low.slice(0, 8).map(function (x) {
              const label = x.stock <= 0
                ? '<span style="color:#ef4444">немає</span>'
                : '<span style="color:#ffb020">' + x.stock + ' шт · ~' + x.daysLeft + ' дн.</span>';
              return '<div class="sv-alert-item">' + esc(x.title) + ' — ' + label + '</div>';
            }).join('')
          : '<div style="color:#888;font-size:.85rem">Критичних залишків немає</div>') +
        (st.dead.length
          ? '<div class="sv-alert-row" style="margin-top:10px">Не продавалось 30 днів: <b>' +
            st.dead.length + '</b> позицій</div>' +
            '<div style="color:#888;font-size:.82rem">' +
            esc(st.dead.slice(0, 5).map(function (x) { return x.title; }).join(', ')) + '</div>'
          : '') +
        '</div>'
      );
    }

    host.innerHTML = parts.join('') ||
      '<div class="sv-panel"><div style="color:#888;font-size:.88rem">' +
      '✅ Завислих замовлень немає, залишки в нормі</div></div>';
  }

  // ═══════════════════════════════════════════════════════════════

  function toast(msg, type) {
    if (typeof global.showToast === 'function') global.showToast(msg, type);
    else console.log('[SVAROG]', msg);
  }

  let lastOrdersCount = -1;

  function init() {
    // Обгортаємо, а не переписуємо: наявна функція виконується як була,
    // ми лише дописуємо панель у вже намальовані картки.
    if (typeof global.renderOrdersList === 'function' && !global.renderOrdersList.__svWrapped) {
      const original = global.renderOrdersList;
      const wrapped = function () {
        const r = original.apply(this, arguments);
        try { enhanceOrderCards(); } catch (e) { console.error('[SVAROG] enhance:', e); }
        return r;
      };
      wrapped.__svWrapped = true;
      global.renderOrdersList = wrapped;
    }

    setInterval(function () {
      const n = svOrders().length;
      if (n !== lastOrdersCount) {
        lastOrdersCount = n;
        try { renderHomeBlocks(); } catch (e) { /* нічого */ }
      }
    }, 5000);

    setTimeout(renderHomeBlocks, 2500);
  }

  global.SvarogTools = {
    init: init,
    toggle: toggle,
    selectAllVisible: selectAllVisible,
    clearSelection: clearSelection,
    applyBulkStatus: applyBulkStatus,
    exportSelected: exportSelected,
    openNotes: openNotes,
    closeNotes: closeNotes,
    addNote: addNote,
    printOrder: printOrder,
    printSelected: printSelected,
    cloneOrder: cloneOrder,
    globalSearch: globalSearch,
    closeSearch: closeSearch,
    goToOrder: goToOrder,
    renderHomeBlocks: renderHomeBlocks,
    stuckOrders: stuckOrders,
    stockAlerts: stockAlerts
  };

})(window);
