/**
 * SVAROG Stock v3.6.0
 * ═══════════════════════════════════════════════════════════════════
 *   • артикул (SKU) з автогенерацією
 *   • історія цін
 *   • інвентаризація: звірка факт vs система
 *   • масова зміна цін
 *   • клон товару
 *   • маржа (закупівельна ціна)
 *   • «з цим купують»
 *   • черга передзамовлень
 *   • сповіщення тим, хто чекав товар
 * ═══════════════════════════════════════════════════════════════════
 */

(function (global) {
  'use strict';

  const A = global.SvarogAdapter;

  function svOrders() { return (global.SvarogData && global.SvarogData.orders()) || []; }
  function svMerch()  { return (global.SvarogData && global.SvarogData.merch())  || []; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function money(v) {
    return new Intl.NumberFormat('uk-UA').format(Math.round(v || 0)) + ' ₴';
  }
  function toast(m, t) { if (typeof global.showToast === 'function') global.showToast(m, t); }

  function totalStock(m) {
    const s = m.stock;
    if (s && typeof s === 'object') {
      return Object.keys(s).reduce(function (acc, k) {
        return acc + (typeof s[k] === 'number' ? s[k] : 0);
      }, 0);
    }
    return typeof s === 'number' ? s : null;
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. АРТИКУЛ (SKU)
  // ═══════════════════════════════════════════════════════════════

  const TRANSLIT = {
    а:'a',б:'b',в:'v',г:'h',ґ:'g',д:'d',е:'e',є:'ye',ж:'zh',з:'z',и:'y',і:'i',
    ї:'yi',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',
    ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ь:'',ю:'yu',я:'ya'
  };

  function makeSku(title, existing) {
    const base = String(title || 'item').toLowerCase()
      .split('').map(function (ch) { return TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch; })
      .join('').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 14) || 'item';

    const used = new Set(existing || []);
    let sku = base.toUpperCase();
    let n = 1;
    while (used.has(sku)) { n++; sku = (base + '-' + n).toUpperCase(); }
    return sku;
  }

  async function assignMissingSku() {
    const items = svMerch();
    const existing = items.map(function (m) { return m.sku; }).filter(Boolean);
    const without = items.filter(function (m) { return !m.sku; });

    if (!without.length) { toast('Усі товари вже мають артикул', 'info'); return; }
    if (!confirm('Згенерувати артикул для ' + without.length + ' товарів?')) return;

    let done = 0;
    for (const m of without) {
      const sku = makeSku(A.field(m, 'name', 'item'), existing);
      existing.push(sku);
      try {
        await global.db.collection('merch').doc(m.id).update({ sku: sku });
        done++;
      } catch (e) { console.error('[SVAROG] sku', m.id, e); }
    }
    toast('Артикул присвоєно ' + done + ' товарам', 'success');
    if (global.logAdminAction) global.logAdminAction('shop', 'Згенерував артикули для ' + done + ' товарів');
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. ІСТОРІЯ ЦІН
  // ═══════════════════════════════════════════════════════════════

  async function logPriceChange(merchId, oldPrice, newPrice) {
    if (Number(oldPrice) === Number(newPrice)) return;
    try {
      await global.db.collection('merch').doc(merchId).update({
        priceHistory: firebase.firestore.FieldValue.arrayUnion({
          from: Number(oldPrice) || 0,
          to: Number(newPrice) || 0,
          at: Date.now(),
          by: (global.SvarogData && global.SvarogData.adminEmail()) || ''
        })
      });
    } catch (e) { console.warn('[SVAROG] priceHistory:', e.code); }
  }

  function renderPriceHistory(merchId) {
    const m = svMerch().find(function (x) { return x.id === merchId; });
    const box = document.getElementById('sv-price-history');
    if (!box) return;
    const hist = (m && m.priceHistory) || [];

    if (!hist.length) {
      box.innerHTML = '<div style="color:#888;font-size:.85rem">Ціна ще не змінювалась</div>';
      return;
    }

    box.innerHTML = hist.slice().reverse().slice(0, 20).map(function (h) {
      const up = h.to > h.from;
      return '<div class="sv-alert-item">' +
        new Date(h.at).toLocaleDateString('uk-UA') + ' · ' +
        money(h.from) + ' → <b style="color:' + (up ? '#ffb020' : '#22c55e') + '">' + money(h.to) + '</b>' +
        ' <span style="color:#8a8f98;font-size:.78rem">' + esc(h.by) + '</span></div>';
    }).join('');
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. ІНВЕНТАРИЗАЦІЯ
  // ═══════════════════════════════════════════════════════════════

  function renderInventory() {
    const box = document.getElementById('sv-inventory');
    if (!box) return;

    const items = svMerch().filter(function (m) { return !m.hidden && !m.deletedAt; });
    if (!items.length) { box.innerHTML = '<div style="color:#888">Товарів немає</div>'; return; }

    box.innerHTML =
      '<div class="sv-hint">Впишіть фактичну кількість із полиці. ' +
      'Розбіжність підсвітиться, а після збереження залишок оновиться.</div>' +
      '<table class="an-table"><thead><tr><th>Товар</th><th>Артикул</th>' +
      '<th>У системі</th><th style="width:110px">Факт</th><th>Різниця</th></tr></thead><tbody>' +
      items.map(function (m) {
        const sys = totalStock(m);
        return '<tr data-id="' + m.id + '">' +
          '<td>' + esc(A.field(m, 'name', '')) + '</td>' +
          '<td style="font-family:monospace;font-size:.8rem">' + esc(m.sku || '—') + '</td>' +
          '<td>' + (sys === null ? '—' : sys) + '</td>' +
          '<td><input type="number" class="sv-input sv-inv-fact" style="width:90px;padding:5px" ' +
            'data-sys="' + (sys === null ? '' : sys) + '" oninput="SvarogStock.calcDiff(this)"></td>' +
          '<td class="sv-inv-diff">—</td></tr>';
      }).join('') + '</tbody></table>' +
      '<button class="btn-primary" style="margin-top:12px" onclick="SvarogStock.saveInventory()">' +
      'Зберегти результати звірки</button>';
  }

  function calcDiff(input) {
    const row = input.closest('tr');
    const cell = row.querySelector('.sv-inv-diff');
    const sys = parseFloat(input.dataset.sys);
    const fact = parseFloat(input.value);

    if (isNaN(fact) || isNaN(sys)) { cell.innerHTML = '—'; return; }
    const d = fact - sys;
    if (d === 0) cell.innerHTML = '<span style="color:#22c55e">збігається</span>';
    else cell.innerHTML = '<b style="color:' + (d < 0 ? '#ef4444' : '#ffb020') + '">' +
      (d > 0 ? '+' : '') + d + '</b>';
  }

  async function saveInventory() {
    const rows = document.querySelectorAll('#sv-inventory tr[data-id]');
    const changes = [];

    rows.forEach(function (row) {
      const input = row.querySelector('.sv-inv-fact');
      const fact = parseFloat(input.value);
      const sys = parseFloat(input.dataset.sys);
      if (!isNaN(fact) && !isNaN(sys) && fact !== sys) {
        changes.push({ id: row.dataset.id, sys: sys, fact: fact });
      }
    });

    if (!changes.length) { toast('Розбіжностей немає', 'info'); return; }
    if (!confirm('Оновити залишки для ' + changes.length + ' позицій?\n\n' +
                 'Поточні значення буде замінено фактичними.')) return;

    let done = 0;
    for (const c of changes) {
      try {
        await global.db.collection('merch').doc(c.id).update({
          stock: c.fact,
          lastInventory: {
            at: Date.now(),
            by: (global.SvarogData && global.SvarogData.adminEmail()) || '',
            was: c.sys, became: c.fact
          }
        });
        done++;
      } catch (e) { console.error('[SVAROG] inventory', c.id, e); }
    }

    toast('Оновлено ' + done + ' позицій', 'success');
    if (global.logAdminAction) {
      global.logAdminAction('shop', 'Інвентаризація: скориговано ' + done + ' позицій');
    }
    renderInventory();
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. МАСОВА ЗМІНА ЦІН
  // ═══════════════════════════════════════════════════════════════

  async function bulkPriceChange() {
    const percentEl = document.getElementById('sv-price-percent');
    const catEl = document.getElementById('sv-price-category');
    const percent = parseFloat(percentEl ? percentEl.value : '');
    const category = catEl ? catEl.value : '';

    if (isNaN(percent) || percent === 0) { toast('Вкажіть відсоток', 'warning'); return; }

    const items = svMerch().filter(function (m) {
      if (m.hidden || m.deletedAt) return false;
      return !category || m.category === category;
    });

    if (!items.length) { toast('Товарів не знайдено', 'warning'); return; }

    const dir = percent > 0 ? 'підняти' : 'знизити';
    if (!confirm(dir.charAt(0).toUpperCase() + dir.slice(1) + ' ціну на ' +
                 Math.abs(percent) + '% для ' + items.length + ' товарів' +
                 (category ? ' у категорії «' + category + '»' : '') + '?')) return;

    let done = 0;
    for (const m of items) {
      const oldPrice = Number(m.price) || 0;
      const newPrice = Math.round(oldPrice * (1 + percent / 100));
      if (newPrice === oldPrice) continue;
      try {
        await global.db.collection('merch').doc(m.id).update({ price: newPrice });
        await logPriceChange(m.id, oldPrice, newPrice);
        done++;
      } catch (e) { console.error('[SVAROG] price', m.id, e); }
    }

    toast('Ціну змінено для ' + done + ' товарів', 'success');
    if (global.logAdminAction) {
      global.logAdminAction('shop', 'Масова зміна цін: ' + percent + '% для ' + done + ' товарів');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. КЛОН ТОВАРУ
  // ═══════════════════════════════════════════════════════════════

  async function cloneProduct(merchId) {
    const src = svMerch().find(function (m) { return m.id === merchId; });
    if (!src) return;

    const title = prompt('Назва нового товару:', A.field(src, 'name', '') + ' (копія)');
    if (!title) return;

    const copy = Object.assign({}, src);
    delete copy.id;
    copy.title = title;
    copy.sku = makeSku(title, svMerch().map(function (m) { return m.sku; }).filter(Boolean));
    copy.stock = 0;
    copy.priceHistory = [];
    copy.createdAt = Date.now();

    try {
      const ref = await global.db.collection('merch').add(copy);
      toast('Створено товар ' + title, 'success');
      if (global.logAdminAction) global.logAdminAction('shop', 'Клонував товар → ' + title);
      return ref.id;
    } catch (e) {
      toast('Помилка: ' + e.message, 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 6. МАРЖА
  // ═══════════════════════════════════════════════════════════════

  function marginReport(days) {
    const since = Date.now() - (days || 30) * 86400000;
    const costByTitle = {};
    svMerch().forEach(function (m) {
      const t = A.field(m, 'name', '');
      if (t && m.costPrice) costByTitle[t] = Number(m.costPrice) || 0;
    });

    const stats = {};
    let revenue = 0, cost = 0, unknown = 0;

    svOrders().forEach(function (o) {
      const d = A.createdAt(o);
      if (!d || d.getTime() < since) return;
      if ((o.status || '') === 'cancelled' || o.deletedAt) return;

      (A.field(o, 'items', []) || []).forEach(function (it) {
        const title = A.field(it, 'name', null);
        if (!title) return;
        const qty = A.num(A.field(it, 'quantity', 1), 1);
        const sum = A.num(A.field(it, 'total', 0), 0);
        const c = costByTitle[title];

        revenue += sum;
        if (c === undefined) { unknown += sum; }
        else { cost += c * qty; }

        if (!stats[title]) stats[title] = { revenue: 0, cost: 0, qty: 0, known: c !== undefined };
        stats[title].revenue += sum;
        stats[title].qty += qty;
        if (c !== undefined) stats[title].cost += c * qty;
      });
    });

    const list = Object.keys(stats).map(function (k) {
      const s = stats[k];
      return {
        title: k, revenue: s.revenue, cost: s.cost, qty: s.qty, known: s.known,
        profit: s.known ? s.revenue - s.cost : null,
        margin: s.known && s.revenue ? Math.round((s.revenue - s.cost) / s.revenue * 100) : null
      };
    }).sort(function (a, b) { return (b.profit || 0) - (a.profit || 0); });

    return { revenue: revenue, cost: cost, profit: revenue - cost, unknown: unknown, items: list };
  }

  function renderMargin(days) {
    const box = document.getElementById('sv-margin');
    if (!box) return;
    const r = marginReport(days || 30);

    if (!r.items.length) {
      box.innerHTML = '<div style="color:#888">Немає продажів за період</div>';
      return;
    }

    box.innerHTML =
      '<div class="crm-cards">' +
        '<div class="an-card" style="border-left:3px solid #22c55e"><div class="an-card-label">Оборот</div>' +
          '<div class="an-card-value">' + money(r.revenue) + '</div></div>' +
        '<div class="an-card" style="border-left:3px solid #ffb020"><div class="an-card-label">Собівартість</div>' +
          '<div class="an-card-value">' + money(r.cost) + '</div></div>' +
        '<div class="an-card" style="border-left:3px solid #0a84ff"><div class="an-card-label">Прибуток</div>' +
          '<div class="an-card-value">' + money(r.profit) + '</div></div>' +
      '</div>' +
      (r.unknown
        ? '<div class="sv-hint" style="color:#ffb020">Для товарів на ' + money(r.unknown) +
          ' не вказано закупівельну ціну — прибуток занижений.</div>'
        : '') +
      '<table class="an-table"><thead><tr><th>Товар</th><th>Продано</th><th>Оборот</th>' +
      '<th>Прибуток</th><th>Маржа</th></tr></thead><tbody>' +
      r.items.slice(0, 25).map(function (i) {
        return '<tr><td>' + esc(i.title) + '</td><td>' + i.qty + '</td>' +
          '<td>' + money(i.revenue) + '</td>' +
          '<td>' + (i.profit === null ? '<span style="color:#8a8f98">—</span>' : money(i.profit)) + '</td>' +
          '<td>' + (i.margin === null ? '—' : i.margin + '%') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // ═══════════════════════════════════════════════════════════════
  // 7. «З ЦИМ КУПУЮТЬ»
  // ═══════════════════════════════════════════════════════════════

  function boughtTogether(minPairs) {
    const pairs = {};
    svOrders().forEach(function (o) {
      if (o.deletedAt || (o.status || '') === 'cancelled') return;
      const titles = (A.field(o, 'items', []) || [])
        .map(function (it) { return A.field(it, 'name', null); })
        .filter(Boolean);
      const uniq = Array.from(new Set(titles));
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          const key = [uniq[i], uniq[j]].sort().join(' + ');
          pairs[key] = (pairs[key] || 0) + 1;
        }
      }
    });

    return Object.keys(pairs)
      .map(function (k) { return { pair: k, count: pairs[k] }; })
      .filter(function (p) { return p.count >= (minPairs || 2); })
      .sort(function (a, b) { return b.count - a.count; });
  }

  function renderBoughtTogether() {
    const box = document.getElementById('sv-bought-together');
    if (!box) return;
    const list = boughtTogether(2);

    box.innerHTML = list.length
      ? list.slice(0, 15).map(function (p) {
          return '<div class="sv-alert-item">' + esc(p.pair) +
            ' <span style="color:#8a8f98">— ' + p.count + ' разів</span></div>';
        }).join('')
      : '<div style="color:#888;font-size:.85rem">Замало даних. ' +
        'Пари зʼявляться, коли в замовленнях буде по кілька позицій.</div>';
  }

  // ═══════════════════════════════════════════════════════════════
  // 8. ЧЕРГА ПЕРЕДЗАМОВЛЕНЬ + ХТО ЧЕКАВ ТОВАР
  // ═══════════════════════════════════════════════════════════════

  async function loadWaitingList() {
    if (!global.db) return {};
    const map = {};
    try {
      const snap = await global.db.collection('stock_notifications').limit(500).get();
      snap.forEach(function (d) {
        const x = d.data() || {};
        const key = x.merchTitle || x.merchId || '—';
        if (!map[key]) map[key] = [];
        map[key].push({ id: d.id, email: x.email || '', phone: x.phone || '', at: x.timestamp });
      });
    } catch (e) { console.warn('[SVAROG] stock_notifications:', e.code); }
    return map;
  }

  async function renderWaiting() {
    const box = document.getElementById('sv-waiting');
    if (!box) return;
    box.innerHTML = '<div style="color:#888;font-size:.85rem">Завантаження…</div>';

    const waiting = await loadWaitingList();
    const keys = Object.keys(waiting);

    if (!keys.length) {
      box.innerHTML = '<div style="color:#888;font-size:.85rem">Ніхто не чекає товарів</div>';
      return;
    }

    const merch = svMerch();
    box.innerHTML = keys.map(function (title) {
      const people = waiting[title];
      const item = merch.find(function (m) { return A.field(m, 'name', '') === title; });
      const stock = item ? totalStock(item) : null;
      const available = stock !== null && stock > 0;

      return '<div class="sv-panel" style="padding:12px;margin-bottom:10px;border-left:3px solid ' +
        (available ? '#22c55e' : '#8a8f98') + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">' +
          '<div><b>' + esc(title) + '</b><br>' +
          '<span style="font-size:.82rem;color:#8a8f98">' + people.length + ' чекають · ' +
          (available ? '<span style="color:#22c55e">є ' + stock + ' шт</span>' : 'немає в наявності') +
          '</span></div>' +
          (available
            ? '<button class="btn-primary btn-sm" onclick="SvarogStock.notifyWaiting(\'' +
              esc(title).replace(/'/g, "\\'") + '\')">Сповістити</button>'
            : '') +
        '</div></div>';
    }).join('');
  }

  /**
   * Сповістити тих, хто чекав товар.
   * У кого прив'язаний бот — у Telegram, решті показуємо email
   * для копіювання (розсилка email потребує сервера).
   */
  async function notifyWaiting(title) {
    const waiting = await loadWaitingList();
    const people = waiting[title] || [];
    if (!people.length) return;

    let links = {};
    try {
      const snap = await global.db.collection('telegram_links').get();
      snap.forEach(function (d) { links[d.id] = (d.data() || {}).chats || []; });
    } catch (e) { /* нічого */ }

    const phoneKey = function (p) {
      const d = String(p || '').replace(/\D/g, '');
      return d.length > 9 ? d.slice(-9) : d;
    };

    let sent = 0;
    const emails = [];

    for (const p of people) {
      const chats = links[phoneKey(p.phone)] || [];
      if (chats.length && typeof global.sendTelegramMessage === 'function') {
        for (const chatId of chats) {
          const ok = await global.sendTelegramMessage(chatId,
            '🎉 Товар «' + title + '», який ви чекали, знову в наявності!\n\nsvarogteam.com', false);
          if (ok) sent++;
        }
      } else if (p.email) {
        emails.push(p.email);
      }
    }

    let msg = 'Надіслано в Telegram: ' + sent;
    if (emails.length) {
      msg += '\n\nEmail для розсилки вручну (' + emails.length + '):\n' + emails.join(', ');
      try { await navigator.clipboard.writeText(emails.join(', ')); msg += '\n\n(скопійовано в буфер)'; }
      catch (e) { /* нічого */ }
    }
    alert(msg);

    if (global.logAdminAction) {
      global.logAdminAction('shop', 'Сповістив про наявність «' + title + '»: ' + sent + ' у Telegram');
    }
  }

  function preorderQueue() {
    const counts = {};
    svOrders().forEach(function (o) {
      if (o.deletedAt || (o.status || '') === 'cancelled') return;
      (A.field(o, 'items', []) || []).forEach(function (it) {
        const title = A.field(it, 'name', '');
        if (/\[ПЕРЕДЗАМОВЛЕННЯ\]|\[PRE\]/i.test(title) || it.isPreorder) {
          const clean = title.replace(/\[ПЕРЕДЗАМОВЛЕННЯ\]|\[PRE\]/gi, '').trim();
          counts[clean] = (counts[clean] || 0) + A.num(A.field(it, 'quantity', 1), 1);
        }
      });
    });
    return Object.keys(counts).map(function (k) { return { title: k, qty: counts[k] }; })
      .sort(function (a, b) { return b.qty - a.qty; });
  }

  function renderPreorders() {
    const box = document.getElementById('sv-preorders');
    if (!box) return;
    const list = preorderQueue();
    box.innerHTML = list.length
      ? list.map(function (p) {
          return '<div class="sv-alert-item"><b>' + esc(p.title) + '</b> — ' +
            '<span style="color:#ffb020">' + p.qty + ' у черзі</span></div>';
        }).join('')
      : '<div style="color:#888;font-size:.85rem">Передзамовлень немає</div>';
  }

  // ═══════════════════════════════════════════════════════════════

  function refreshAll() {
    try { renderInventory(); } catch (e) {}
    try { renderMargin(30); } catch (e) {}
    try { renderBoughtTogether(); } catch (e) {}
    try { renderPreorders(); } catch (e) {}
    try { renderWaiting(); } catch (e) {}
  }

  global.SvarogStock = {
    refreshAll: refreshAll,
    makeSku: makeSku,
    assignMissingSku: assignMissingSku,
    logPriceChange: logPriceChange,
    renderPriceHistory: renderPriceHistory,
    renderInventory: renderInventory,
    calcDiff: calcDiff,
    saveInventory: saveInventory,
    bulkPriceChange: bulkPriceChange,
    cloneProduct: cloneProduct,
    marginReport: marginReport,
    renderMargin: renderMargin,
    boughtTogether: boughtTogether,
    renderBoughtTogether: renderBoughtTogether,
    renderWaiting: renderWaiting,
    notifyWaiting: notifyWaiting,
    preorderQueue: preorderQueue,
    renderPreorders: renderPreorders,
    totalStock: totalStock
  };

})(window);
