/* ═══════════════════════════════════════════════════════════════════
   SVAROG · ФІНАНСИ  v3.6.0

   Витрати, каса, звіт для донорів, собівартість партій.

   Дані:
     expenses           (нова колекція) — витрати
     orders             — надходження (через SvarogData.orders())
   Все рахується у браузері адмінки, жодних платних сервісів.
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var CATEGORIES = [
    { id: 'fabric',    label: 'Тканина / матеріали' },
    { id: 'print',     label: 'Друк / вишивка' },
    { id: 'delivery',  label: 'Доставка' },
    { id: 'ads',       label: 'Реклама' },
    { id: 'equipment', label: 'Обладнання' },
    { id: 'fees',      label: 'Комісії банку' },
    { id: 'charity',   label: 'Передано на потреби' },
    { id: 'other',     label: 'Інше' }
  ];

  // Статуси, які вважаємо оплаченими надходженнями.
  // Це реальні коди з admin.html: new / on_review / accepted / sent /
  // delivered / cancelled / archived. Рядкові українські варіанти —
  // на випадок старих записів у базі.
  var PAID_STATUSES = ['accepted', 'sent', 'delivered', 'paid', 'completed',
                       'Оплачено', 'Відправлено', 'Доставлено'];

  var expenses = [];
  var unsub = null;

  function db() { return global.db || (global.firebase && firebase.firestore()); }
  function orders() { return (global.SvarogData ? SvarogData.orders() : []) || []; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function money(n) { return (Math.round(Number(n) || 0)).toLocaleString('uk-UA') + ' ₴'; }
  function catLabel(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i].label;
    return id || 'Інше';
  }
  function toDate(v) {
    if (!v) return null;
    if (v.toDate) { try { return v.toDate(); } catch (e) { return null; } }
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function ymd(d) {
    if (!d) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function isPaid(o) {
    var s = o.status || o.orderStatus || '';
    return PAID_STATUSES.indexOf(s) !== -1;
  }

  // ───────────────────────── завантаження витрат ─────────────────────
  function init() {
    var d = db();
    if (!d || unsub) return;
    try {
      unsub = d.collection('expenses').orderBy('date', 'desc').limit(300)
        .onSnapshot(function (snap) {
          expenses = [];
          snap.forEach(function (doc) {
            var x = doc.data() || {};
            x.id = doc.id;
            expenses.push(x);
          });
          render();
        }, function (err) {
          console.warn('[SVAROG] expenses:', err.code, err.message);
          var el = document.getElementById('fin-expenses');
          if (el) {
            el.innerHTML = '<div class="sv-empty">Немає доступу до колекції <code>expenses</code>. ' +
              'Онови правила Firestore (firestore.rules у комплекті) і перезайди.</div>';
          }
        });
    } catch (e) { console.error('[SVAROG] finance init', e); }
    fillCategorySelect();
  }

  function fillCategorySelect() {
    var sel = document.getElementById('fin-cat');
    var filt = document.getElementById('fin-filter-cat');
    if (sel && !sel.options.length) {
      CATEGORIES.forEach(function (c) {
        var o = document.createElement('option'); o.value = c.id; o.textContent = c.label; sel.appendChild(o);
      });
    }
    if (filt && !filt.options.length) {
      var all = document.createElement('option'); all.value = ''; all.textContent = 'Всі категорії'; filt.appendChild(all);
      CATEGORIES.forEach(function (c) {
        var o = document.createElement('option'); o.value = c.id; o.textContent = c.label; filt.appendChild(o);
      });
    }
  }

  // ───────────────────────── додавання витрати ───────────────────────
  function addExpense() {
    var d = db();
    if (!d) return;
    var sum = parseFloat((document.getElementById('fin-sum') || {}).value);
    var cat = (document.getElementById('fin-cat') || {}).value || 'other';
    var note = ((document.getElementById('fin-note') || {}).value || '').trim();
    var dateStr = (document.getElementById('fin-date') || {}).value || ymd(new Date());

    if (!sum || sum <= 0) { alert('Вкажи суму більше нуля.'); return; }
    if (!note) { alert('Опиши, за що витрата — інакше у звіті буде порожньо.'); return; }

    var payload = {
      amount: Math.round(sum * 100) / 100,
      category: cat,
      note: note,
      date: dateStr,
      createdAt: new Date().toISOString(),
      author: global.SvarogData ? SvarogData.adminEmail() : ''
    };

    d.collection('expenses').add(payload).then(function () {
      var s = document.getElementById('fin-sum'); if (s) s.value = '';
      var n = document.getElementById('fin-note'); if (n) n.value = '';
      if (global.logAdminAction) {
        try { logAdminAction('Витрата', 'Додано витрату ' + money(payload.amount) + ' — ' + note, 'finance'); } catch (e) {}
      }
    }).catch(function (err) {
      alert('Не вдалося зберегти: ' + (err.message || err.code));
    });
  }

  function deleteExpense(id) {
    if (!confirm('Видалити цю витрату?')) return;
    var d = db(); if (!d) return;
    d.collection('expenses').doc(id).delete().catch(function (err) {
      alert('Не вдалося видалити: ' + (err.message || err.code));
    });
  }

  // ───────────────────────── розрахунки ──────────────────────────────
  function periodBounds() {
    var v = (document.getElementById('fin-period') || {}).value || '30';
    var now = new Date();
    if (v === 'all') return { from: new Date(2000, 0, 1), to: now, label: 'за весь час' };
    if (v === 'month') {
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now, label: 'цього місяця' };
    }
    var days = parseInt(v, 10) || 30;
    var f = new Date(now.getTime() - days * 86400000);
    return { from: f, to: now, label: 'за ' + days + ' днів' };
  }

  function summary() {
    var b = periodBounds();
    var income = 0, ordersCount = 0, unpaid = 0;
    orders().forEach(function (o) {
      var dt = toDate(o.createdAt || o.date || o.timestamp);
      if (dt && (dt < b.from || dt > b.to)) return;
      var sum = Number(o.totalPrice || o.total || 0) || 0;
      if (isPaid(o)) { income += sum; ordersCount++; }
      else unpaid += sum;
    });

    var spent = 0, byCat = {};
    expenses.forEach(function (x) {
      var dt = toDate(x.date || x.createdAt);
      if (dt && (dt < b.from || dt > b.to)) return;
      var a = Number(x.amount) || 0;
      spent += a;
      byCat[x.category || 'other'] = (byCat[x.category || 'other'] || 0) + a;
    });

    return {
      period: b, income: income, spent: spent, net: income - spent,
      ordersCount: ordersCount, unpaid: unpaid, byCat: byCat,
      avgCheck: ordersCount ? income / ordersCount : 0
    };
  }

  // ───────────────────────── рендер ──────────────────────────────────
  function render() {
    fillCategorySelect();
    renderSummary();
    renderExpenses();
  }

  function renderSummary() {
    var el = document.getElementById('fin-summary');
    if (!el) return;
    var s = summary();

    var cards = [
      { t: 'Надходження ' + s.period.label, v: money(s.income), c: '#30d158' },
      { t: 'Витрати', v: money(s.spent), c: '#ff453a' },
      { t: 'Залишок', v: money(s.net), c: s.net >= 0 ? '#0a84ff' : '#ff453a' },
      { t: 'Середній чек', v: money(s.avgCheck), c: '#8a8f98' },
      { t: 'Очікує оплати', v: money(s.unpaid), c: '#ffb020' }
    ];

    var html = '<div class="fin-cards">' + cards.map(function (c) {
      return '<div class="fin-card"><div class="fin-card-t">' + esc(c.t) + '</div>' +
             '<div class="fin-card-v" style="color:' + c.c + '">' + c.v + '</div></div>';
    }).join('') + '</div>';

    var cats = Object.keys(s.byCat).sort(function (a, b) { return s.byCat[b] - s.byCat[a]; });
    if (cats.length) {
      var max = s.byCat[cats[0]] || 1;
      html += '<div class="fin-bars">' + cats.map(function (k) {
        var w = Math.max(3, Math.round(s.byCat[k] / max * 100));
        return '<div class="fin-bar-row"><div class="fin-bar-label">' + esc(catLabel(k)) + '</div>' +
               '<div class="fin-bar-track"><div class="fin-bar-fill" style="width:' + w + '%"></div></div>' +
               '<div class="fin-bar-val">' + money(s.byCat[k]) + '</div></div>';
      }).join('') + '</div>';
    }
    el.innerHTML = html;
  }

  function renderExpenses() {
    var el = document.getElementById('fin-expenses');
    if (!el) return;
    var filt = (document.getElementById('fin-filter-cat') || {}).value || '';
    var b = periodBounds();

    var list = expenses.filter(function (x) {
      if (filt && (x.category || 'other') !== filt) return false;
      var dt = toDate(x.date || x.createdAt);
      if (dt && (dt < b.from || dt > b.to)) return false;
      return true;
    });

    if (!list.length) {
      el.innerHTML = '<div class="sv-empty">Витрат за цей період немає.</div>';
      return;
    }

    el.innerHTML = '<table class="fin-table"><thead><tr>' +
      '<th>Дата</th><th>Категорія</th><th>Опис</th><th style="text-align:right">Сума</th><th></th>' +
      '</tr></thead><tbody>' +
      list.map(function (x) {
        return '<tr><td>' + esc(x.date || '') + '</td>' +
               '<td>' + esc(catLabel(x.category)) + '</td>' +
               '<td>' + esc(x.note || '') + '</td>' +
               '<td style="text-align:right">' + money(x.amount) + '</td>' +
               '<td><button class="btn-sm btn-danger" onclick="SvarogFinance.deleteExpense(\'' + esc(x.id) + '\')">✕</button></td></tr>';
      }).join('') + '</tbody></table>';
  }

  function refresh() { render(); }

  // ───────────────────────── звіт для донорів ────────────────────────
  function donorReport() {
    var s = summary();
    var lines = [];
    lines.push('ЗВІТ SVAROG TEAM');
    lines.push('Період: ' + ymd(s.period.from) + ' — ' + ymd(s.period.to));
    lines.push('');
    lines.push('Надходження від продажу мерчу: ' + money(s.income));
    lines.push('Кількість оплачених замовлень: ' + s.ordersCount);
    lines.push('');
    lines.push('ВИТРАТИ:');
    Object.keys(s.byCat).sort(function (a, b) { return s.byCat[b] - s.byCat[a]; })
      .forEach(function (k) { lines.push('  ' + catLabel(k) + ': ' + money(s.byCat[k])); });
    lines.push('  ────────────');
    lines.push('  Разом витрат: ' + money(s.spent));
    lines.push('');
    lines.push('ЗАЛИШОК: ' + money(s.net));
    lines.push('');
    lines.push('Сформовано ' + new Date().toLocaleString('uk-UA'));

    var txt = lines.join('\n');
    download('svarog-zvit-' + ymd(new Date()) + '.txt', txt, 'text/plain');
  }

  function exportCsv() {
    var b = periodBounds();
    var rows = [['Дата', 'Категорія', 'Опис', 'Сума', 'Хто вніс']];
    expenses.forEach(function (x) {
      var dt = toDate(x.date || x.createdAt);
      if (dt && (dt < b.from || dt > b.to)) return;
      rows.push([x.date || '', catLabel(x.category), x.note || '', x.amount || 0, x.author || '']);
    });
    var csv = '﻿' + rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(';');
    }).join('\n');
    download('svarog-vytraty-' + ymd(new Date()) + '.csv', csv, 'text/csv');
  }

  function download(name, content, type) {
    try {
      var blob = new Blob([content], { type: type + ';charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { alert('Не вдалося завантажити файл: ' + e.message); }
  }

  global.SvarogFinance = {
    init: init,
    refresh: refresh,
    addExpense: addExpense,
    deleteExpense: deleteExpense,
    donorReport: donorReport,
    exportCsv: exportCsv,
    summary: summary,
    CATEGORIES: CATEGORIES
  };

})(window);
