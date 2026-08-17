/* ═══════════════════════════════════════════════════════════════════
   SVAROG · ДОСТАВКА  v3.6.0

   Перевірка адреси/відділення Нової Пошти, масова перевірка статусів
   ТТН і автозакриття доставлених, вивантаження списку відправлень,
   планова дата відправки.

   Ключ береться з config/delivery (поле npApiKey) — той самий, що
   вводиться в «Контент та Налаштування».

   ВАЖЛИВО: запити йдуть напряму з браузера адмінки на api.novaposhta.ua.
   Ліміти безкоштовні, окремий сервер не потрібен.
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var API = 'https://api.novaposhta.ua/v2.0/json/';

  function key() { return global.NP_API_KEY || ''; }
  function db() { return global.db || (global.firebase && firebase.firestore()); }
  function orders() { return (global.SvarogData ? SvarogData.orders() : []) || []; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function call(model, method, props) {
    if (!key()) return Promise.reject(new Error('Не вказано ключ API Нової Пошти (Контент та Налаштування).'));
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: key(), modelName: model, calledMethod: method, methodProperties: props || {}
      })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.success) {
        var msg = (j.errors && j.errors.join('; ')) || (j.warnings && j.warnings.join('; ')) || 'невідома помилка';
        throw new Error(msg);
      }
      return j.data || [];
    });
  }

  // ═══════════════ 1. ПЕРЕВІРКА МІСТА Й ВІДДІЛЕННЯ ══════════════════
  var cityCache = {};

  function findCity(name) {
    name = (name || '').trim();
    if (!name) return Promise.resolve([]);
    if (cityCache[name]) return Promise.resolve(cityCache[name]);
    return call('Address', 'searchSettlements', { CityName: name, Limit: 5 })
      .then(function (data) {
        var addrs = (data[0] && data[0].Addresses) || [];
        cityCache[name] = addrs;
        return addrs;
      });
  }

  function findWarehouse(cityRef, query) {
    return call('Address', 'getWarehouses', { CityRef: cityRef, FindByString: String(query || ''), Limit: 20 });
  }

  function validateAddress() {
    var city = ((document.getElementById('np-check-city') || {}).value || '').trim();
    var wh = ((document.getElementById('np-check-wh') || {}).value || '').trim();
    var out = document.getElementById('np-check-result');
    if (!out) return;
    if (!city) { out.innerHTML = '<div class="sv-empty">Введи місто.</div>'; return; }
    out.innerHTML = '<div class="sv-hint">Перевіряю…</div>';

    findCity(city).then(function (list) {
      if (!list.length) {
        out.innerHTML = '<div class="sv-empty">Нова Пошта не знає такого населеного пункту. ' +
          'Перевір написання — часто це «смт», «село» або районний центр з іншою назвою.</div>';
        return;
      }
      var best = list[0];
      var cityRef = best.DeliveryCity || best.Ref;
      var head = '<p class="sv-hint">Знайдено: <b>' + esc(best.Present || best.MainDescription) + '</b>' +
        (list.length > 1 ? ' (і ще ' + (list.length - 1) + ' схожих)' : '') + '</p>';
      if (!wh) { out.innerHTML = head; return; }

      findWarehouse(cityRef, wh).then(function (whs) {
        if (!whs.length) {
          out.innerHTML = head + '<div class="sv-empty">Відділення «' + esc(wh) + '» у цьому місті не знайдено.</div>';
          return;
        }
        out.innerHTML = head + '<table class="fin-table"><tbody>' + whs.slice(0, 8).map(function (w) {
          return '<tr><td>' + esc(w.Number) + '</td><td>' + esc(w.Description) + '</td></tr>';
        }).join('') + '</tbody></table>';
      }).catch(function (e) {
        out.innerHTML = head + '<div class="sv-empty">Помилка відділень: ' + esc(e.message) + '</div>';
      });
    }).catch(function (e) {
      out.innerHTML = '<div class="sv-empty">Помилка: ' + esc(e.message) + '</div>';
    });
  }

  // ═══════════════ 2. МАСОВА ПЕРЕВІРКА ТТН ══════════════════════════
  // Статуси НП: 9 = «Відправлення отримано», 10/11 = отримано/повернуто
  var DELIVERED_CODES = ['9', '10', '11'];

  function activeTtnOrders() {
    return orders().filter(function (o) {
      var t = o.ttn || o.trackingNumber;
      if (!t || String(t).replace(/\D/g, '').length !== 14) return false;
      var st = o.status || '';
      return ['delivered', 'completed', 'Доставлено', 'cancelled', 'archived'].indexOf(st) === -1;
    });
  }

  function checkAllTtn() {
    var out = document.getElementById('np-track-result');
    var list = activeTtnOrders();
    if (!out) return;
    if (!list.length) { out.innerHTML = '<div class="sv-empty">Немає активних ТТН для перевірки.</div>'; return; }
    if (!key()) {
      out.innerHTML = '<div class="sv-empty">Спочатку внеси ключ API Нової Пошти в «Контент та Налаштування».</div>';
      return;
    }
    out.innerHTML = '<div class="sv-hint">Перевіряю ' + list.length + ' відправлень…</div>';

    var docs = list.map(function (o) {
      return { DocumentNumber: String(o.ttn || o.trackingNumber), Phone: '' };
    });

    call('TrackingDocument', 'getStatusDocuments', { Documents: docs })
      .then(function (data) {
        var byTtn = {};
        data.forEach(function (d) { byTtn[d.Number] = d; });
        var rows = [], toClose = [];
        list.forEach(function (o) {
          var t = String(o.ttn || o.trackingNumber);
          var d = byTtn[t];
          var status = d ? (d.Status || '') : 'немає відповіді';
          var code = d ? String(d.StatusCode || '') : '';
          if (DELIVERED_CODES.indexOf(code) !== -1) toClose.push(o);
          rows.push('<tr><td>' + esc(o.orderNumber || o.id) + '</td><td><code>' + esc(t) + '</code></td>' +
            '<td>' + esc(status) + '</td></tr>');
        });
        out.innerHTML = '<table class="fin-table"><thead><tr><th>№</th><th>ТТН</th><th>Статус НП</th></tr></thead>' +
          '<tbody>' + rows.join('') + '</tbody></table>' +
          (toClose.length
            ? '<button class="btn-primary" style="margin-top:12px" onclick="SvarogDelivery.closeDelivered()">' +
              '✓ Позначити доставленими (' + toClose.length + ')</button>'
            : '<p class="sv-hint">Отриманих відправлень серед них немає.</p>');
        global.__svToClose = toClose;
      })
      .catch(function (e) {
        out.innerHTML = '<div class="sv-empty">Не вдалося перевірити: ' + esc(e.message) + '</div>';
      });
  }

  function closeDelivered() {
    var list = global.__svToClose || [];
    var d = db();
    if (!list.length || !d) return;
    if (!confirm('Позначити ' + list.length + ' замовлень як доставлені? Клієнтам піде сповіщення.')) return;

    var done = 0;
    list.forEach(function (o) {
      d.collection('orders').doc(o.id).update({
        status: 'delivered',
        deliveredAt: new Date().toISOString(),
        closedBy: 'auto-np'
      }).then(function () {
        done++;
        if (global.notifyCustomerOrderStatus) {
          try { notifyCustomerOrderStatus(o.id, 'delivered'); } catch (e) {}
        }
        if (global.SvarogUI) {
          try { SvarogUI.logStatusChange(o.id, o.status || '', 'delivered'); } catch (e) {}
        }
        if (done === list.length) {
          var out = document.getElementById('np-track-result');
          if (out) out.innerHTML = '<div class="sv-hint">Готово: закрито ' + done + ' замовлень.</div>';
        }
      }).catch(function (e) { console.warn('[SVAROG] closeDelivered', o.id, e.code); });
    });
  }

  // ═══════════════ 3. ВИВАНТАЖЕННЯ СПИСКУ ВІДПРАВЛЕНЬ ═══════════════
  function exportShipments() {
    var list = orders().filter(function (o) {
      var st = o.status || '';
      // Готові до відправки — прийняті замовлення без ТТН.
      return (st === 'accepted' || st === 'paid' || st === 'Оплачено') &&
             !(o.ttn || o.trackingNumber);
    });
    if (!list.length) { alert('Немає замовлень, готових до відправки.'); return; }

    var rows = [['Одержувач', 'Телефон', 'Місто', 'Відділення', 'Опис', 'Сума', 'Оплата', 'ТТН', '№ замовлення']];
    list.forEach(function (o) {
      var items = (o.items || o.cart || []).map(function (i) {
        return (i.merchTitle || i.title || i.name || '') + (i.size ? ' (' + i.size + ')' : '') +
               (i.quantity > 1 ? ' ×' + i.quantity : '');
      }).join(', ');
      rows.push([
        o.customerName || o.name || '',
        o.customerPhone || o.phone || '',
        o.city || o.deliveryCity || '',
        o.warehouse || o.department || o.novaPoshtaBranch || '',
        items || 'Мерч',
        o.totalPrice || o.total || '',
        o.paidAt ? 'Передплата' : 'Накладений платіж',
        o.ttn || o.trackingNumber || '',
        o.orderNumber || o.id
      ]);
    });

    var csv = '﻿' + rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(';');
    }).join('\n');

    try {
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'svarog-vidpravlennya-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { alert('Не вдалося: ' + e.message); }
  }

  // ═══════════════ 4. ПЛАНОВА ДАТА ВІДПРАВКИ ════════════════════════
  function setPlannedDate(orderId, dateStr) {
    var d = db(); if (!d) return;
    d.collection('orders').doc(orderId).update({ plannedShipDate: dateStr || '' })
      .catch(function (e) { alert('Не збереглось: ' + (e.message || e.code)); });
  }

  function renderPlanned() {
    var el = document.getElementById('np-planned');
    if (!el) return;
    var today = new Date().toISOString().slice(0, 10);
    var list = orders().filter(function (o) { return o.plannedShipDate; })
      .sort(function (a, b) { return String(a.plannedShipDate).localeCompare(String(b.plannedShipDate)); });
    if (!list.length) {
      el.innerHTML = '<div class="sv-empty">Планових дат ще не проставлено. Їх можна виставити ' +
        'у картці замовлення — зручно, коли товар ще шиється.</div>';
      return;
    }
    el.innerHTML = '<table class="fin-table"><thead><tr><th>Дата</th><th>№</th><th>Клієнт</th></tr></thead><tbody>' +
      list.map(function (o) {
        var late = String(o.plannedShipDate) < today;
        return '<tr' + (late ? ' style="color:#ff453a"' : '') + '><td>' + esc(o.plannedShipDate) + '</td>' +
          '<td>' + esc(o.orderNumber || o.id) + '</td>' +
          '<td>' + esc(o.customerName || o.name || '') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function refresh() {
    try { renderPlanned(); } catch (e) {}
  }

  global.SvarogDelivery = {
    refresh: refresh,
    validateAddress: validateAddress,
    findCity: findCity,
    findWarehouse: findWarehouse,
    checkAllTtn: checkAllTtn,
    closeDelivered: closeDelivered,
    exportShipments: exportShipments,
    setPlannedDate: setPlannedDate,
    renderPlanned: renderPlanned,
    call: call
  };

})(window);
