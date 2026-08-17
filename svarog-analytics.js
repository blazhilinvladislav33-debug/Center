/**
 * SVAROG Analytics v3.5.0
 * Динаміка продажів, конверсія, топ товарів, географія.
 * Рахує все на клієнті з уже завантажених замовлень — окремих запитів
 * до Firestore не робить, тому не витрачає квоту.
 */

(function (global) {
  'use strict';

  // Дані беремо через міст: у admin.html вони оголошені через let
  // і тому недоступні як window.globalOrdersData.
  function svOrders()     { return (global.SvarogData && global.SvarogData.orders())     || []; }
  function svNewsletter() { return (global.SvarogData && global.SvarogData.newsletter()) || []; }

  const A = global.SvarogAdapter;
  let charts = {};
  let period = 30;              // днів

  function money(v) {
    return new Intl.NumberFormat('uk-UA').format(Math.round(v || 0)) + ' ₴';
  }

  function isCancelled(o) {
    const s = (A.field(o, 'status', '') || '').toLowerCase();
    return s === 'cancelled' || s === 'canceled' || s === 'відмова';
  }

  function ordersInPeriod() {
    const since = Date.now() - period * 86400000;
    return svOrders().filter(function (o) {
      if (o.deletedAt) return false;
      const d = A.createdAt(o);
      return d && d.getTime() >= since;
    });
  }

  // ───────────────────────────────────────────────────────────────
  // ПОКАЗНИКИ
  // ───────────────────────────────────────────────────────────────
  function computeKpi() {
    const list = ordersInPeriod();
    const paid = list.filter(function (o) { return !isCancelled(o); });

    const revenue = paid.reduce(function (s, o) { return s + A.total(o); }, 0);
    const count = paid.length;
    const avg = count ? revenue / count : 0;
    const cancelRate = list.length ? (list.length - paid.length) / list.length * 100 : 0;

    // порівняння з попереднім періодом
    const prevSince = Date.now() - period * 2 * 86400000;
    const prevUntil = Date.now() - period * 86400000;
    const prev = svOrders().filter(function (o) {
      if (o.deletedAt || isCancelled(o)) return false;
      const d = A.createdAt(o);
      return d && d.getTime() >= prevSince && d.getTime() < prevUntil;
    });
    const prevRevenue = prev.reduce(function (s, o) { return s + A.total(o); }, 0);
    const growth = prevRevenue ? (revenue - prevRevenue) / prevRevenue * 100 : null;

    return { revenue: revenue, count: count, avg: avg, cancelRate: cancelRate, growth: growth };
  }

  function renderKpi() {
    const box = document.getElementById('analytics-kpi');
    if (!box) return;
    const k = computeKpi();

    const growthHtml = k.growth === null ? ''
      : '<span style="color:' + (k.growth >= 0 ? '#22c55e' : '#ef4444') + ';font-size:.8em">' +
        (k.growth >= 0 ? '▲ ' : '▼ ') + Math.abs(k.growth).toFixed(1) + '%</span>';

    box.innerHTML =
      kpiCard('Оборот', money(k.revenue), growthHtml, '#22c55e') +
      kpiCard('Замовлень', k.count, '', '#0a84ff') +
      kpiCard('Середній чек', money(k.avg), '', '#ffb020') +
      kpiCard('Відмов', k.cancelRate.toFixed(1) + '%', '', '#ef4444');
  }

  function kpiCard(label, value, extra, color) {
    return '<div class="an-card" style="border-left:3px solid ' + color + '">' +
             '<div class="an-card-label">' + label + '</div>' +
             '<div class="an-card-value">' + value + ' ' + extra + '</div>' +
           '</div>';
  }

  // ───────────────────────────────────────────────────────────────
  // ГРАФІК ДИНАМІКИ
  // ───────────────────────────────────────────────────────────────
  function renderRevenueChart() {
    const canvas = document.getElementById('an-revenue-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    const buckets = {};
    const days = Math.min(period, 90);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      buckets[d.toISOString().slice(0, 10)] = { revenue: 0, count: 0 };
    }

    ordersInPeriod().forEach(function (o) {
      if (isCancelled(o)) return;
      const d = A.createdAt(o);
      if (!d) return;
      const key = d.toISOString().slice(0, 10);
      if (buckets[key]) {
        buckets[key].revenue += A.total(o);
        buckets[key].count += 1;
      }
    });

    const labels = Object.keys(buckets);
    if (charts.revenue) charts.revenue.destroy();

    charts.revenue = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels.map(function (l) { return l.slice(5); }),
        datasets: [
          {
            label: 'Оборот, ₴',
            data: labels.map(function (l) { return buckets[l].revenue; }),
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34,197,94,.12)',
            fill: true, tension: .3, yAxisID: 'y'
          },
          {
            label: 'Замовлень',
            data: labels.map(function (l) { return buckets[l].count; }),
            borderColor: '#0a84ff',
            backgroundColor: 'transparent',
            tension: .3, yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          y:  { position: 'left',  beginAtZero: true, title: { display: true, text: '₴' } },
          y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false },
                ticks: { precision: 0 }, title: { display: true, text: 'шт' } }
        }
      }
    });
  }

  // ───────────────────────────────────────────────────────────────
  // ТОП ТОВАРІВ
  // ───────────────────────────────────────────────────────────────
  function topProducts(limit) {
    const stats = {};
    ordersInPeriod().forEach(function (o) {
      if (isCancelled(o)) return;
      const items = A.field(o, 'items', []) || [];
      (Array.isArray(items) ? items : []).forEach(function (it) {
        const title = A.field(it, 'name', null) || it.title || it.sku || 'Без назви';
        const qty = A.num(A.field(it, 'quantity', 1), 1);
        const price = A.num(A.field(it, 'total', 0), 0);
        if (!stats[title]) stats[title] = { qty: 0, revenue: 0 };
        stats[title].qty += qty;
        stats[title].revenue += price * (price && qty > 1 && price < 1000 ? qty : 1);
      });
    });

    return Object.keys(stats)
      .map(function (k) { return { title: k, qty: stats[k].qty, revenue: stats[k].revenue }; })
      .sort(function (a, b) { return b.qty - a.qty; })
      .slice(0, limit || 10);
  }

  function renderTopProducts() {
    const box = document.getElementById('an-top-products');
    if (!box) return;
    const top = topProducts(10);

    if (!top.length) {
      box.innerHTML = '<div style="color:#888;padding:20px;text-align:center">' +
        'Немає даних про товари в замовленнях за цей період</div>';
      return;
    }

    const max = top[0].qty || 1;
    box.innerHTML = top.map(function (p) {
      const pct = Math.round(p.qty / max * 100);
      return '<div class="an-bar-row">' +
               '<div class="an-bar-label" title="' + esc(p.title) + '">' + esc(p.title) + '</div>' +
               '<div class="an-bar-track"><div class="an-bar-fill" style="width:' + pct + '%"></div></div>' +
               '<div class="an-bar-value">' + p.qty + ' шт</div>' +
             '</div>';
    }).join('');
  }

  // ───────────────────────────────────────────────────────────────
  // СТАТУСИ І ГЕОГРАФІЯ
  // ───────────────────────────────────────────────────────────────
  function renderStatusChart() {
    const canvas = document.getElementById('an-status-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    const counts = {};
    ordersInPeriod().forEach(function (o) {
      const s = A.field(o, 'status', 'new') || 'new';
      counts[s] = (counts[s] || 0) + 1;
    });

    const labels = Object.keys(counts);
    if (charts.status) charts.status.destroy();
    if (!labels.length) return;

    charts.status = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: labels.map(function (l) { return counts[l]; }),
          backgroundColor: ['#0a84ff', '#22c55e', '#ffb020', '#ef4444', '#a855f7', '#888', '#14b8a6']
        }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
  }

  function renderGeography() {
    const box = document.getElementById('an-geography');
    if (!box) return;

    const cities = {};
    ordersInPeriod().forEach(function (o) {
      if (isCancelled(o)) return;
      const city = (A.field(o, 'city', '') || '').trim() || 'Не вказано';
      if (!cities[city]) cities[city] = { count: 0, revenue: 0 };
      cities[city].count++;
      cities[city].revenue += A.total(o);
    });

    const list = Object.keys(cities)
      .map(function (k) { return { city: k, count: cities[k].count, revenue: cities[k].revenue }; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, 12);

    if (!list.length) {
      box.innerHTML = '<div style="color:#888;padding:20px;text-align:center">Немає даних</div>';
      return;
    }

    box.innerHTML = '<table class="an-table"><thead><tr><th>Місто</th><th>Замовлень</th><th>Оборот</th></tr></thead><tbody>' +
      list.map(function (c) {
        return '<tr><td>' + esc(c.city) + '</td><td>' + c.count + '</td><td>' + money(c.revenue) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // ───────────────────────────────────────────────────────────────
  function refresh() {
    renderKpi();
    renderRevenueChart();
    renderTopProducts();
    renderStatusChart();
    renderGeography();
  }

  function setPeriod(days) {
    period = parseInt(days, 10) || 30;
    document.querySelectorAll('.an-period-btn').forEach(function (b) {
      b.classList.toggle('active', parseInt(b.dataset.days, 10) === period);
    });
    refresh();
  }

  function exportReport() {
    const k = computeKpi();
    const top = topProducts(20);
    const lines = [
      'SVAROG — звіт за ' + period + ' днів',
      'Сформовано: ' + new Date().toLocaleString('uk-UA'),
      '',
      'Оборот,' + Math.round(k.revenue),
      'Замовлень,' + k.count,
      'Середній чек,' + Math.round(k.avg),
      'Відмов %,' + k.cancelRate.toFixed(1),
      '',
      'Топ товарів', 'Назва,Кількість,Оборот'
    ].concat(top.map(function (p) {
      return '"' + p.title.replace(/"/g, '""') + '",' + p.qty + ',' + Math.round(p.revenue);
    }));

    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'svarog-report-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    if (typeof global.showToast === 'function') global.showToast('Звіт вивантажено', 'success');
  }

  global.SvarogAnalytics = {
    refresh: refresh,
    setPeriod: setPeriod,
    exportReport: exportReport,
    computeKpi: computeKpi,
    topProducts: topProducts
  };

})(window);
