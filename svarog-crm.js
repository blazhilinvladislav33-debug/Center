/**
 * SVAROG CRM v3.4.0 — клієнти, сегменти, історія замовлень
 *
 * Будує базу клієнтів із ДВОХ джерел:
 *   1. колекція customers (якщо є)
 *   2. самі замовлення — клієнти зводяться за email/телефоном
 * Тому працює навіть коли customers порожня.
 */

(function (global) {
  'use strict';

  const A = global.SvarogAdapter;

  let crmData = [];
  let crmFilter = { search: '', segment: 'all' };

  // ───────────────────────────────────────────────────────────────
  // СЕГМЕНТИ
  // ───────────────────────────────────────────────────────────────
  const SEGMENTS = {
    vip:      { label: 'VIP',        color: '#ffb020', min: 5000 },
    regular:  { label: 'Постійний',  color: '#22c55e', min: 1500 },
    new:      { label: 'Новий',      color: '#0a84ff', min: 0    },
    sleeping: { label: 'Сплячий',    color: '#888',    min: 0    }
  };

  function segmentOf(customer) {
    const daysSince = customer.lastOrderAt
      ? Math.floor((Date.now() - customer.lastOrderAt) / 86400000)
      : 999;
    if (daysSince > 120 && customer.ordersCount > 0) return 'sleeping';
    if (customer.totalSpent >= SEGMENTS.vip.min) return 'vip';
    if (customer.totalSpent >= SEGMENTS.regular.min || customer.ordersCount > 1) return 'regular';
    return 'new';
  }

  // ───────────────────────────────────────────────────────────────
  // ПОБУДОВА БАЗИ КЛІЄНТІВ
  // ───────────────────────────────────────────────────────────────
  function buildFromOrders(orders) {
    const map = {};

    (orders || []).forEach(function (order) {
      const email = (A.field(order, 'email', '') || '').toLowerCase().trim();
      const phone = (A.field(order, 'phone', '') || '').replace(/[\s\-()]/g, '');
      const key = email || phone;
      if (!key) return;                      // без контакту клієнта не звести

      if (!map[key]) {
        map[key] = {
          id: key,
          name: A.field(order, 'name', 'Без імені'),
          email: email,
          phone: phone,
          city: A.field(order, 'city', ''),
          ordersCount: 0,
          totalSpent: 0,
          firstOrderAt: null,
          lastOrderAt: null,
          orders: [],
          source: 'orders'
        };
      }

      const c = map[key];
      const when = A.createdAt(order);
      const sum = A.total(order);
      const status = A.field(order, 'status', '');

      // Скасовані й видалені не рахуємо у витрати
      const counts = status !== 'cancelled' && status !== 'canceled' && !order.deletedAt;

      c.ordersCount += counts ? 1 : 0;
      c.totalSpent += counts ? sum : 0;
      c.orders.push({ id: order.id, date: when, total: sum, status: status });

      if (when) {
        const t = when.getTime();
        if (!c.firstOrderAt || t < c.firstOrderAt) c.firstOrderAt = t;
        if (!c.lastOrderAt || t > c.lastOrderAt) c.lastOrderAt = t;
      }
      if (!c.city && A.field(order, 'city', '')) c.city = A.field(order, 'city', '');
    });

    return Object.values(map);
  }

  function mergeWithCustomersCollection(fromOrders, customersDocs) {
    const byKey = {};
    fromOrders.forEach(function (c) { byKey[c.id] = c; });

    (customersDocs || []).forEach(function (doc) {
      const email = (A.field(doc, 'email', '') || '').toLowerCase().trim();
      const phone = (A.field(doc, 'phone', '') || '').replace(/[\s\-()]/g, '');
      const key = email || phone || doc.id;

      if (byKey[key]) {
        // доповнюємо те, що вже зібрали із замовлень
        const c = byKey[key];
        if (!c.name || c.name === 'Без імені') c.name = A.field(doc, 'name', c.name);
        if (!c.city) c.city = A.field(doc, 'city', '');
        c.notes = doc.notes || c.notes || '';
        c.docId = doc.id;
        c.source = 'both';
      } else {
        byKey[key] = {
          id: key,
          docId: doc.id,
          name: A.field(doc, 'name', 'Без імені'),
          email: email,
          phone: phone,
          city: A.field(doc, 'city', ''),
          notes: doc.notes || '',
          ordersCount: 0,
          totalSpent: 0,
          firstOrderAt: A.createdAt(doc) ? A.createdAt(doc).getTime() : null,
          lastOrderAt: null,
          orders: [],
          source: 'customers'
        };
      }
    });

    return Object.values(byKey);
  }

  // ───────────────────────────────────────────────────────────────
  // РЕНДЕР
  // ───────────────────────────────────────────────────────────────
  function money(v) {
    return new Intl.NumberFormat('uk-UA').format(Math.round(v || 0)) + ' ₴';
  }

  function dateStr(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function renderStats() {
    const box = document.getElementById('crm-stats');
    if (!box) return;

    const totalRevenue = crmData.reduce(function (s, c) { return s + c.totalSpent; }, 0);
    const withOrders = crmData.filter(function (c) { return c.ordersCount > 0; });
    const avgCheck = withOrders.length
      ? totalRevenue / withOrders.reduce(function (s, c) { return s + c.ordersCount; }, 0)
      : 0;
    const counts = { vip: 0, regular: 0, new: 0, sleeping: 0 };
    crmData.forEach(function (c) { counts[segmentOf(c)]++; });

    box.innerHTML =
      card('Всього клієнтів', crmData.length, '#0a84ff') +
      card('Загальний оборот', money(totalRevenue), '#22c55e') +
      card('Середній чек', money(avgCheck), '#ffb020') +
      card('VIP', counts.vip, SEGMENTS.vip.color) +
      card('Сплячі', counts.sleeping, '#888');
  }

  function card(label, value, color) {
    return '<div class="crm-card" style="border-left:3px solid ' + color + '">' +
             '<div class="crm-card-label">' + label + '</div>' +
             '<div class="crm-card-value">' + value + '</div>' +
           '</div>';
  }

  function applyFilter(list) {
    const q = crmFilter.search.toLowerCase().trim();
    return list.filter(function (c) {
      if (crmFilter.segment !== 'all' && segmentOf(c) !== crmFilter.segment) return false;
      if (!q) return true;
      return (c.name + ' ' + c.email + ' ' + c.phone + ' ' + c.city).toLowerCase().indexOf(q) !== -1;
    });
  }

  function render() {
    const body = document.getElementById('crm-table-body');
    if (!body) return;

    renderStats();

    const rows = applyFilter(crmData).sort(function (a, b) { return b.totalSpent - a.totalSpent; });

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:#888">' +
        (crmData.length ? 'Нічого не знайдено за фільтром' :
         'Клієнтів ще немає. Вони з\'являться автоматично після перших замовлень.') +
        '</td></tr>';
      return;
    }

    body.innerHTML = rows.map(function (c) {
      const seg = segmentOf(c);
      const s = SEGMENTS[seg];
      return '<tr onclick="SvarogCRM.openCard(\'' + c.id.replace(/'/g, "\\'") + '\')" style="cursor:pointer">' +
        '<td><strong>' + esc(c.name) + '</strong><br><span style="font-size:.8em;color:#888">' + esc(c.email || c.phone) + '</span></td>' +
        '<td><span class="crm-badge" style="background:' + s.color + '22;color:' + s.color + '">' + s.label + '</span></td>' +
        '<td>' + c.ordersCount + '</td>' +
        '<td><strong>' + money(c.totalSpent) + '</strong></td>' +
        '<td>' + (c.ordersCount ? money(c.totalSpent / c.ordersCount) : '—') + '</td>' +
        '<td>' + esc(c.city || '—') + '</td>' +
        '<td>' + dateStr(c.lastOrderAt) + '</td>' +
      '</tr>';
    }).join('');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // ───────────────────────────────────────────────────────────────
  // КАРТКА КЛІЄНТА
  // ───────────────────────────────────────────────────────────────
  function openCard(id) {
    const c = crmData.find(function (x) { return x.id === id; });
    if (!c) return;

    const seg = SEGMENTS[segmentOf(c)];
    const modal = document.getElementById('crm-modal');
    const body = document.getElementById('crm-modal-body');
    if (!modal || !body) return;

    const history = c.orders.slice().sort(function (a, b) {
      return (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0);
    });

    body.innerHTML =
      '<h2 style="margin:0 0 4px">' + esc(c.name) + '</h2>' +
      '<span class="crm-badge" style="background:' + seg.color + '22;color:' + seg.color + '">' + seg.label + '</span>' +
      '<div class="crm-contact">' +
        (c.email ? '<div>✉️ <a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a></div>' : '') +
        (c.phone ? '<div>📞 <a href="tel:' + esc(c.phone) + '">' + esc(c.phone) + '</a></div>' : '') +
        (c.city  ? '<div>📍 ' + esc(c.city) + '</div>' : '') +
      '</div>' +
      '<div class="crm-metrics">' +
        metric('Замовлень', c.ordersCount) +
        metric('Витрачено', money(c.totalSpent)) +
        metric('Середній чек', c.ordersCount ? money(c.totalSpent / c.ordersCount) : '—') +
        metric('Перше', dateStr(c.firstOrderAt)) +
        metric('Останнє', dateStr(c.lastOrderAt)) +
      '</div>' +
      '<h3 style="margin:18px 0 8px">Історія замовлень</h3>' +
      (history.length
        ? '<table class="crm-history"><thead><tr><th>Дата</th><th>Сума</th><th>Статус</th></tr></thead><tbody>' +
          history.map(function (o) {
            return '<tr><td>' + (o.date ? dateStr(o.date.getTime()) : '—') + '</td>' +
                   '<td>' + money(o.total) + '</td><td>' + esc(o.status || '—') + '</td></tr>';
          }).join('') + '</tbody></table>'
        : '<div style="color:#888">Замовлень ще немає</div>');

    modal.style.display = 'flex';
  }

  function metric(label, value) {
    return '<div class="crm-metric"><div class="crm-metric-label">' + label + '</div>' +
           '<div class="crm-metric-value">' + value + '</div></div>';
  }

  function closeCard() {
    const m = document.getElementById('crm-modal');
    if (m) m.style.display = 'none';
  }

  // ───────────────────────────────────────────────────────────────
  // ОНОВЛЕННЯ ДАНИХ
  // ───────────────────────────────────────────────────────────────
  function refresh() {
    const orders = global.globalOrdersData || [];
    const fromOrders = buildFromOrders(orders);

    const db = global.db;
    if (!db) { crmData = fromOrders; render(); return; }

    db.collection('customers').get()
      .then(function (snap) {
        const docs = [];
        snap.forEach(function (d) { docs.push(Object.assign({ id: d.id }, d.data())); });
        crmData = mergeWithCustomersCollection(fromOrders, docs);
        render();
      })
      .catch(function () {
        // немає доступу до customers — працюємо тільки на замовленнях
        crmData = fromOrders;
        render();
      });
  }

  function setSearch(value) { crmFilter.search = value || ''; render(); }
  function setSegment(seg)  { crmFilter.segment = seg || 'all'; render(); }

  function exportCsv() {
    const rows = applyFilter(crmData);
    const header = ['Імʼя', 'Email', 'Телефон', 'Місто', 'Сегмент', 'Замовлень', 'Витрачено', 'Останнє замовлення'];
    const lines = [header.join(',')].concat(rows.map(function (c) {
      return [c.name, c.email, c.phone, c.city, SEGMENTS[segmentOf(c)].label,
              c.ordersCount, Math.round(c.totalSpent), dateStr(c.lastOrderAt)]
        .map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; })
        .join(',');
    }));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'svarog-clients-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    if (typeof global.showToast === 'function') global.showToast('Експортовано ' + rows.length + ' клієнтів', 'success');
  }

  global.SvarogCRM = {
    refresh: refresh,
    render: render,
    openCard: openCard,
    closeCard: closeCard,
    setSearch: setSearch,
    setSegment: setSegment,
    exportCsv: exportCsv,
    getData: function () { return crmData; },
    segmentOf: segmentOf,
    SEGMENTS: SEGMENTS
  };

})(window);
