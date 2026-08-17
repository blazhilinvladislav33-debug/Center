/* ═══════════════════════════════════════════════════════════════════
   SVAROG · ГЛИБША АНАЛІТИКА  v3.6.0

   Час обробки, розподіл замовлень по годинах і днях,
   що натискають на хабі, статистика промокодів,
   пошук дублів клієнтів, єдина картка клієнта.

   Рахує з уже завантажених даних — додаткових читань Firestore не
   робить, крім hub_clicks і promocodes (по одному разу за відкриття).
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  function db() { return global.db || (global.firebase && firebase.firestore()); }
  function orders() { return (global.SvarogData ? SvarogData.orders() : []) || []; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function money(n) { return (Math.round(Number(n) || 0)).toLocaleString('uk-UA') + ' ₴'; }
  function toDate(v) {
    if (!v) return null;
    if (v.toDate) { try { return v.toDate(); } catch (e) { return null; } }
    var d = new Date(v); return isNaN(d.getTime()) ? null : d;
  }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function phoneKey(p) { var d = digits(p); return d.length > 9 ? d.slice(-9) : d; }
  function hours(ms) {
    var h = ms / 3600000;
    if (h < 24) return h.toFixed(1) + ' год';
    return (h / 24).toFixed(1) + ' дн';
  }
  function bars(pairs, fmt) {
    if (!pairs.length) return '<div class="sv-empty">Немає даних.</div>';
    var max = Math.max.apply(null, pairs.map(function (p) { return p[1]; })) || 1;
    return '<div class="fin-bars">' + pairs.map(function (p) {
      var w = Math.max(2, Math.round(p[1] / max * 100));
      return '<div class="fin-bar-row"><div class="fin-bar-label">' + esc(p[0]) + '</div>' +
        '<div class="fin-bar-track"><div class="fin-bar-fill" style="width:' + w + '%"></div></div>' +
        '<div class="fin-bar-val">' + (fmt ? fmt(p[1]) : p[1]) + '</div></div>';
    }).join('') + '</div>';
  }

  // ═══════════════════ 1. ЧАС ОБРОБКИ ═══════════════════════════════
  function processingTimes() {
    var toPaid = [], toSent = [], toDelivered = [];
    orders().forEach(function (o) {
      var created = toDate(o.createdAt || o.date || o.timestamp);
      if (!created) return;
      var paid = toDate(o.paidAt);
      var sent = toDate(o.sentAt || o.shippedAt);
      var del = toDate(o.deliveredAt);
      if (paid && paid > created) toPaid.push(paid - created);
      if (sent && sent > created) toSent.push(sent - created);
      if (del && del > created) toDelivered.push(del - created);
    });
    function avg(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }
    function med(a) {
      if (!a.length) return 0;
      var s = a.slice().sort(function (x, y) { return x - y; });
      return s[Math.floor(s.length / 2)];
    }
    return {
      paid:      { n: toPaid.length,      avg: avg(toPaid),      med: med(toPaid) },
      sent:      { n: toSent.length,      avg: avg(toSent),      med: med(toSent) },
      delivered: { n: toDelivered.length, avg: avg(toDelivered), med: med(toDelivered) }
    };
  }

  function renderProcessing() {
    var el = document.getElementById('ins-processing');
    if (!el) return;
    var t = processingTimes();
    var rows = [
      ['Замовлення → оплата', t.paid],
      ['Замовлення → відправка', t.sent],
      ['Замовлення → доставка', t.delivered]
    ];
    var anyData = rows.some(function (r) { return r[1].n > 0; });
    if (!anyData) {
      el.innerHTML = '<div class="sv-empty">Поки немає позначок часу (<code>paidAt</code>, <code>sentAt</code>, ' +
        '<code>deliveredAt</code>). Вони почнуть проставлятись автоматично, щойно ти зміниш статус ' +
        'замовлення в новій версії — і через тиждень тут зʼявляться реальні цифри.</div>';
      return;
    }
    el.innerHTML = '<table class="fin-table"><thead><tr><th>Етап</th><th>Замовлень</th>' +
      '<th>Середній час</th><th>Типовий (медіана)</th></tr></thead><tbody>' +
      rows.map(function (r) {
        if (!r[1].n) return '<tr><td>' + r[0] + '</td><td colspan="3" class="sv-hint">даних ще немає</td></tr>';
        return '<tr><td>' + r[0] + '</td><td>' + r[1].n + '</td><td>' + hours(r[1].avg) + '</td><td>' + hours(r[1].med) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // ═══════════════════ 2. КОЛИ ЗАМОВЛЯЮТЬ ═══════════════════════════
  var WD = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

  function renderWhen() {
    var el = document.getElementById('ins-when');
    if (!el) return;
    var byHour = new Array(24).fill(0);
    var byDay = new Array(7).fill(0);
    var n = 0;
    orders().forEach(function (o) {
      var d = toDate(o.createdAt || o.date || o.timestamp);
      if (!d) return;
      byHour[d.getHours()]++;
      byDay[d.getDay()]++;
      n++;
    });
    if (!n) { el.innerHTML = '<div class="sv-empty">Немає замовлень з датою.</div>'; return; }

    var hourPairs = [];
    for (var h = 0; h < 24; h++) if (byHour[h]) hourPairs.push([String(h).padStart(2, '0') + ':00', byHour[h]]);
    var dayPairs = [];
    for (var i = 1; i <= 7; i++) { var k = i % 7; dayPairs.push([WD[k], byDay[k]]); }

    var bestH = byHour.indexOf(Math.max.apply(null, byHour));
    var bestD = byDay.indexOf(Math.max.apply(null, byDay));

    el.innerHTML = '<p class="sv-hint">Найактивніша година — <b>' + String(bestH).padStart(2, '0') +
      ':00</b>, найактивніший день — <b>' + WD[bestD] + '</b>. Це найкращий час для розсилки й публікацій.</p>' +
      '<h4 class="sv-sub">По годинах</h4>' + bars(hourPairs) +
      '<h4 class="sv-sub">По днях тижня</h4>' + bars(dayPairs);
  }

  // ═══════════════════ 3. ХАБ: ЩО НАТИСКАЮТЬ ════════════════════════
  function renderHub() {
    var el = document.getElementById('ins-hub');
    if (!el) return;
    var d = db(); if (!d) return;
    el.innerHTML = '<div class="sv-hint">Завантажую…</div>';
    d.collection('hub_clicks').limit(500).get().then(function (snap) {
      var byLink = {};
      snap.forEach(function (doc) {
        var x = doc.data() || {};
        var key = x.linkTitle || x.title || x.linkId || doc.id;
        byLink[key] = (byLink[key] || 0) + (Number(x.count) || 1);
      });
      var pairs = Object.keys(byLink).map(function (k) { return [k, byLink[k]]; })
        .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 20);
      el.innerHTML = pairs.length ? bars(pairs)
        : '<div class="sv-empty">Кліків ще не зафіксовано.</div>';
    }).catch(function (err) {
      el.innerHTML = '<div class="sv-empty">Не вдалося прочитати <code>hub_clicks</code>: ' + esc(err.code) + '</div>';
    });
  }

  // ═══════════════════ 4. ПРОМОКОДИ ═════════════════════════════════
  function renderPromo() {
    var el = document.getElementById('ins-promo');
    if (!el) return;
    var used = {};
    var revenue = {};
    var discount = {};
    orders().forEach(function (o) {
      var code = o.promoCode || o.promocode || o.coupon;
      if (!code) return;
      code = String(code).toUpperCase();
      used[code] = (used[code] || 0) + 1;
      revenue[code] = (revenue[code] || 0) + (Number(o.totalPrice || o.total) || 0);
      discount[code] = (discount[code] || 0) + (Number(o.discount || o.discountAmount) || 0);
    });
    var codes = Object.keys(used).sort(function (a, b) { return used[b] - used[a]; });
    if (!codes.length) {
      el.innerHTML = '<div class="sv-empty">Жодне замовлення поки не містить промокоду.</div>';
      return;
    }
    el.innerHTML = '<table class="fin-table"><thead><tr><th>Код</th><th>Застосовано</th>' +
      '<th style="text-align:right">Виручка</th><th style="text-align:right">Знижка</th></tr></thead><tbody>' +
      codes.map(function (c) {
        return '<tr><td><code>' + esc(c) + '</code></td><td>' + used[c] + '</td>' +
          '<td style="text-align:right">' + money(revenue[c]) + '</td>' +
          '<td style="text-align:right">' + money(discount[c]) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // ═══════════════════ 5. ДУБЛІ КЛІЄНТІВ ════════════════════════════
  function findDuplicates() {
    var byPhone = {};
    orders().forEach(function (o) {
      var k = phoneKey(o.customerPhone || o.phone);
      if (!k) return;
      var name = (o.customerName || o.name || '').trim();
      if (!byPhone[k]) byPhone[k] = { names: {}, count: 0, phone: o.customerPhone || o.phone };
      byPhone[k].count++;
      if (name) byPhone[k].names[name] = (byPhone[k].names[name] || 0) + 1;
    });
    var dupes = [];
    Object.keys(byPhone).forEach(function (k) {
      var names = Object.keys(byPhone[k].names);
      if (names.length > 1) dupes.push({ phone: byPhone[k].phone, names: names, count: byPhone[k].count });
    });
    return dupes;
  }

  function renderDuplicates() {
    var el = document.getElementById('ins-dupes');
    if (!el) return;
    var d = findDuplicates();
    if (!d.length) {
      el.innerHTML = '<div class="sv-empty">Один телефон — одне імʼя. Дублів немає.</div>';
      return;
    }
    el.innerHTML = '<p class="sv-hint">На один номер записані різні імена. Найчастіше це та сама людина ' +
      '(вписали по-різному) — але буває, що замовляли для друга.</p>' +
      d.map(function (x) {
        return '<div class="team-bl-row"><div><b>' + esc(x.phone) + '</b> · ' + x.count + ' замовл.' +
          '<div class="sv-hint">' + x.names.map(esc).join(' / ') + '</div></div>' +
          '<button class="sv-mini" onclick="SvarogInsights.openCustomer(\'' + esc(phoneKey(x.phone)) + '\')">Картка</button></div>';
      }).join('');
  }

  // ═══════════════════ 6. ЄДИНА КАРТКА КЛІЄНТА ══════════════════════
  function customerData(key) {
    var list = orders().filter(function (o) { return phoneKey(o.customerPhone || o.phone) === key; });
    list.sort(function (a, b) {
      return (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0);
    });
    var sum = list.reduce(function (s, o) { return s + (Number(o.totalPrice || o.total) || 0); }, 0);
    var names = {};
    list.forEach(function (o) {
      var n = (o.customerName || o.name || '').trim();
      if (n) names[n] = 1;
    });
    return { orders: list, sum: sum, names: Object.keys(names), phone: list[0] ? (list[0].customerPhone || list[0].phone) : key };
  }

  function openCustomer(key) {
    var c = customerData(key);
    var box = document.getElementById('sv-customer-modal');
    if (!box) {
      box = document.createElement('div');
      box.id = 'sv-customer-modal';
      box.className = 'sv-modal';
      box.onclick = function (e) { if (e.target === box) box.style.display = 'none'; };
      document.body.appendChild(box);
    }
    var bl = null;
    try { bl = global.SvarogTeam ? SvarogTeam.isBlacklisted(c.phone) : null; } catch (e) {}

    box.innerHTML = '<div class="sv-modal-box">' +
      '<button class="sv-modal-close" onclick="document.getElementById(\'sv-customer-modal\').style.display=\'none\'">✕</button>' +
      '<h3 class="sv-panel-title">' + esc(c.names.join(' / ') || 'Клієнт') + '</h3>' +
      '<p class="sv-hint">' + esc(c.phone) + ' · ' + c.orders.length + ' замовлень на ' + money(c.sum) + '</p>' +
      (bl ? '<p style="color:#ff453a">⛔ У чорному списку: ' + esc(bl.reason || '') + '</p>' : '') +
      '<table class="fin-table"><thead><tr><th>№</th><th>Дата</th><th>Статус</th>' +
      '<th style="text-align:right">Сума</th></tr></thead><tbody>' +
      c.orders.map(function (o) {
        var dt = toDate(o.createdAt);
        return '<tr><td>' + esc(o.orderNumber || o.id) + '</td>' +
          '<td>' + (dt ? dt.toLocaleDateString('uk-UA') : '') + '</td>' +
          '<td>' + esc(o.status || '') + '</td>' +
          '<td style="text-align:right">' + money(o.totalPrice || o.total) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    box.style.display = 'flex';
  }

  function refresh() {
    try { renderProcessing(); } catch (e) { console.warn(e); }
    try { renderWhen(); } catch (e) { console.warn(e); }
    try { renderPromo(); } catch (e) { console.warn(e); }
    try { renderDuplicates(); } catch (e) { console.warn(e); }
  }

  global.SvarogInsights = {
    refresh: refresh,
    renderProcessing: renderProcessing,
    renderWhen: renderWhen,
    renderHub: renderHub,
    renderPromo: renderPromo,
    renderDuplicates: renderDuplicates,
    findDuplicates: findDuplicates,
    openCustomer: openCustomer,
    customerData: customerData,
    processingTimes: processingTimes
  };

})(window);
