/* ═══════════════════════════════════════════════════════════════════
   SVAROG · КЕРУВАННЯ  v3.7.0

   Те, що замикає ланцюг «сайт → бот → адмінка»:

     · модерація відгуків (без неї відгуки з сайту й бота нікуди не йдуть)
     · збори, до яких привʼязаний мерч
     · редактор підписів статусів — один на всі три системи
     · створення замовлення вручну (телефоном, з виставки)
     · картка клієнта і планова дата просто в замовленні
     · екран «потребує уваги»
     · сповіщення в браузері про нове замовлення
     · щотижнева резервна копія без нагадувань
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var reviews = [];
  var fundraisers = [];
  var customersCache = {};
  var subs = [];
  var lastSeenOrderCount = null;

  function db() { return global.db || (global.firebase && firebase.firestore()); }
  function orders() { return (global.SvarogData ? SvarogData.orders() : []) || []; }
  function me() { return global.SvarogData ? SvarogData.adminEmail() : ''; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function money(n) { return (Math.round(Number(n) || 0)).toLocaleString('uk-UA') + ' ₴'; }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function phoneKey(p) { var d = digits(p); return d.length > 9 ? d.slice(-9) : d; }
  function toMs(v) {
    if (!v) return 0;
    if (v.toMillis) { try { return v.toMillis(); } catch (e) { return 0; } }
    if (typeof v === 'number') return v;
    var t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  function log(cat, msg) {
    if (global.logAdminAction) { try { logAdminAction(cat, msg); } catch (e) {} }
  }
  function toast(msg, type) {
    if (global.showToast) { try { showToast(msg, type || 'success'); return; } catch (e) {} }
    console.log('[SVAROG]', msg);
  }

  // ═══════════════ 1. МОДЕРАЦІЯ ВІДГУКІВ ═══════════════
  // Відгуки з сайту й бота створюються з approved: false. Без цього
  // екрана вони просто накопичувались би невидимими.

  function watchReviews() {
    var d = db(); if (!d) return;
    subs.push(d.collection('reviews').limit(100).onSnapshot(function (snap) {
      reviews = [];
      snap.forEach(function (doc) {
        var r = doc.data() || {}; r.id = doc.id; reviews.push(r);
      });
      reviews.sort(function (a, b) { return toMs(b.timestamp) - toMs(a.timestamp); });
      renderReviews();
      updateBadge();
    }, function (err) {
      var el = document.getElementById('mg-reviews');
      if (el) el.innerHTML = '<div class="sv-empty">Немає доступу до відгуків: ' + esc(err.code) + '</div>';
    }));
  }

  function pendingReviews() {
    return reviews.filter(function (r) { return r.approved === false; });
  }

  function renderReviews() {
    var el = document.getElementById('mg-reviews');
    if (!el) return;
    var mode = (document.getElementById('mg-review-filter') || {}).value || 'pending';
    var list = mode === 'pending' ? pendingReviews()
             : mode === 'approved' ? reviews.filter(function (r) { return r.approved !== false; })
             : reviews;

    if (!list.length) {
      el.innerHTML = '<div class="sv-empty">' +
        (mode === 'pending' ? 'Немає відгуків, що чекають на перевірку.' : 'Порожньо.') + '</div>';
      return;
    }

    el.innerHTML = list.map(function (r) {
      var stars = r.rating ? '★'.repeat(Math.max(1, Math.min(5, r.rating))) : '';
      var when = toMs(r.timestamp) ? new Date(toMs(r.timestamp)).toLocaleString('uk-UA') : '';
      var src = r.source === 'telegram' ? 'Telegram' : 'сайт';
      return '<div class="mg-review">' +
        (r.photo ? '<img class="mg-review-photo" src="' + esc(r.photo) + '" onclick="SvarogManage.zoom(this.src)">' : '') +
        '<div class="mg-review-body">' +
          '<div class="mg-review-head"><b>' + esc(r.name || '') + '</b> ' +
            '<span class="mg-stars">' + stars + '</span> ' +
            '<span class="sv-hint">' + esc(when) + ' · ' + src +
            (r.orderId ? ' · замовлення ' + esc(r.orderId) : '') + '</span></div>' +
          (r.text ? '<div class="mg-review-text">' + esc(r.text) + '</div>' : '<div class="sv-hint">Без тексту — лише оцінка.</div>') +
          '<div class="mg-review-actions">' +
            (r.approved === false
              ? '<button class="sv-mini" onclick="SvarogManage.approveReview(\'' + esc(r.id) + '\')">✓ Опублікувати</button>'
              : '<button class="sv-mini" onclick="SvarogManage.hideReview(\'' + esc(r.id) + '\')">Прибрати з сайту</button>') +
            '<button class="btn-sm btn-danger" onclick="SvarogManage.deleteReview(\'' + esc(r.id) + '\')">Видалити</button>' +
          '</div>' +
        '</div></div>';
    }).join('');
  }

  function approveReview(id) {
    var d = db(); if (!d) return;
    d.collection('reviews').doc(id).update({ approved: true, approvedBy: me(), approvedAt: Date.now() })
      .then(function () { toast('Відгук опубліковано'); log('shop', 'Опублікував відгук ' + id); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function hideReview(id) {
    var d = db(); if (!d) return;
    d.collection('reviews').doc(id).update({ approved: false })
      .then(function () { toast('Прибрано з сайту'); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function deleteReview(id) {
    if (!confirm('Видалити відгук назавжди?')) return;
    var d = db(); if (!d) return;
    d.collection('reviews').doc(id).delete()
      .then(function () { toast('Видалено'); log('shop', 'Видалив відгук ' + id); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function zoom(src) {
    var w = global.open('', '_blank');
    if (w) w.document.write('<img src="' + src + '" style="max-width:100%">');
  }

  // ═══════════════ 2. ЗБОРИ ═══════════════

  function watchFundraisers() {
    var d = db(); if (!d) return;
    subs.push(d.collection('fundraisers').limit(50).onSnapshot(function (snap) {
      fundraisers = [];
      snap.forEach(function (doc) { var f = doc.data() || {}; f.id = doc.id; fundraisers.push(f); });
      renderFundraisers();
      fillFundraiserSelect();
    }, function (err) {
      var el = document.getElementById('mg-funds');
      if (el) el.innerHTML = '<div class="sv-empty">Немає доступу до зборів: ' + esc(err.code) +
        '. Онови правила Firestore.</div>';
    }));
  }

  function fillFundraiserSelect() {
    var sel = document.getElementById('merch-fundraiser');
    if (!sel) return;
    var current = sel.value;
    sel.innerHTML = '<option value="">Без привʼязки до збору</option>';
    fundraisers.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.title || f.id;
      sel.appendChild(o);
    });
    sel.value = current;
  }

  function renderFundraisers() {
    var el = document.getElementById('mg-funds');
    if (!el) return;
    if (!fundraisers.length) {
      el.innerHTML = '<div class="sv-empty">Зборів ще немає. Створіть перший — і зможете привʼязати до нього товари.</div>';
      return;
    }
    el.innerHTML = fundraisers.map(function (f) {
      var goal = Number(f.goal) || 0;
      var raised = Number(f.raised) || 0;
      var pct = goal ? Math.min(100, Math.round(raised / goal * 100)) : 0;
      return '<div class="mg-fund">' +
        '<div class="mg-fund-top"><b>' + esc(f.title || f.id) + '</b>' +
          '<span class="sv-hint">' + money(raised) + ' з ' + money(goal) + ' · ' + pct + '%</span></div>' +
        '<div class="fin-bar-track"><div class="fin-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="mg-fund-actions">' +
          '<input type="number" class="sv-input" style="max-width:150px" placeholder="ціль, ₴" value="' + goal + '" id="fund-goal-' + esc(f.id) + '">' +
          '<button class="sv-mini" onclick="SvarogManage.saveFundGoal(\'' + esc(f.id) + '\')">Змінити ціль</button>' +
          '<button class="sv-mini" onclick="SvarogManage.toggleFund(\'' + esc(f.id) + '\')">' +
            (f.active === false ? 'Увімкнути' : 'Призупинити') + '</button>' +
          '<button class="btn-sm btn-danger" onclick="SvarogManage.deleteFund(\'' + esc(f.id) + '\')">Видалити</button>' +
        '</div></div>';
    }).join('');
  }

  function addFundraiser() {
    var title = ((document.getElementById('mg-fund-title') || {}).value || '').trim();
    var goal = parseFloat((document.getElementById('mg-fund-goal') || {}).value) || 0;
    if (!title || goal <= 0) { toast('Вкажи назву й ціль збору', 'error'); return; }
    var d = db(); if (!d) return;
    d.collection('fundraisers').add({
      title: title, goal: goal, raised: 0, active: true,
      createdAt: Date.now(), author: me()
    }).then(function () {
      document.getElementById('mg-fund-title').value = '';
      document.getElementById('mg-fund-goal').value = '';
      toast('Збір створено');
      log('shop', 'Створив збір: ' + title);
    }).catch(function (e) { toast(e.message, 'error'); });
  }

  function saveFundGoal(id) {
    var v = parseFloat((document.getElementById('fund-goal-' + id) || {}).value);
    if (!v || v <= 0) { toast('Ціль має бути більше нуля', 'error'); return; }
    var d = db(); if (!d) return;
    d.collection('fundraisers').doc(id).update({ goal: v })
      .then(function () { toast('Ціль оновлено'); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function toggleFund(id) {
    var f = fundraisers.filter(function (x) { return x.id === id; })[0];
    if (!f) return;
    var d = db(); if (!d) return;
    d.collection('fundraisers').doc(id).update({ active: f.active === false })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function deleteFund(id) {
    if (!confirm('Видалити збір? Товари, привʼязані до нього, лишаться, але смужка зникне.')) return;
    var d = db(); if (!d) return;
    d.collection('fundraisers').doc(id).delete().catch(function (e) { toast(e.message, 'error'); });
  }

  // ═══════════════ 3. ПІДПИСИ СТАТУСІВ ═══════════════
  // Один документ config/statuses читають сайт, бот і адмінка.
  // Саме через три окремі копії клієнти колись отримали «accepted».

  var STATUS_CODES = ['new', 'on_review', 'accepted', 'sent', 'delivered', 'cancelled', 'archived'];

  // Значення за замовчуванням.
  //
  // ⚠️ Раніше вони бралися з global.SV_STATUS_TEXT — а це const усередині
  // головного скрипта admin.html, і властивістю window він НЕ стає.
  // Модуль отримував порожнечу й підставляв у поля самі коди: замість
  // «Прийнято» в редакторі стояло «accepted». Та сама пастка з const,
  // на яку я вже наступав з globalOrdersData.
  //
  // Ці значення збігаються з вбудованими в боті й на сайті.
  var DEFAULT_STATUSES = {
    'new':       ['🆕', 'Нове',         'Ми отримали замовлення і скоро підтвердимо.'],
    'on_review': ['👀', 'На перевірці', 'Менеджер опрацьовує ваше замовлення.'],
    'accepted':  ['✅', 'Прийнято',     'Замовлення прийнято в роботу. Готуємо до відправки.'],
    'sent':      ['📦', 'Відправлено',  'Посилка вже в дорозі.'],
    'delivered': ['🎉', 'Доставлено',   'Замовлення отримано. Дякуємо!'],
    'cancelled': ['❌', 'Скасовано',    'Замовлення скасовано.'],
    'archived':  ['🗄', 'В архіві',     'Замовлення перенесено в архів.']
  };

  function loadStatuses() {
    var d = db(); if (!d) return;
    d.collection('config').doc('statuses').get().then(function (doc) {
      renderStatuses(doc.exists ? (doc.data() || {}) : {});
    }).catch(function (err) {
      var el = document.getElementById('mg-statuses');
      if (el) el.innerHTML = '<div class="sv-empty">Не вдалося прочитати: ' + esc(err.code) + '</div>';
    });
  }

  function renderStatuses(map) {
    var el = document.getElementById('mg-statuses');
    if (!el) return;
    var base = global.SV_STATUS_TEXT || DEFAULT_STATUSES;
    el.innerHTML = STATUS_CODES.map(function (code) {
      var cur = map[code] || {};
      var fallback = base[code] || DEFAULT_STATUSES[code] || ['📋', code, ''];
      return '<div class="mg-status-row">' +
        '<code style="min-width:92px" title="технічний код — не змінюється">' + code + '</code>' +
        '<input class="sv-input" style="max-width:60px" id="st-emoji-' + code + '" value="' + esc(cur.emoji || fallback[0]) + '">' +
        '<input class="sv-input" style="max-width:170px" id="st-ua-' + code + '" value="' + esc(cur.ua || fallback[1]) + '">' +
        '<input class="sv-input" id="st-hint-' + code + '" placeholder="пояснення для клієнта" value="' + esc(cur.hint || fallback[2]) + '">' +
        '</div>';
    }).join('') +
    '<button class="btn-primary" style="margin-top:12px" onclick="SvarogManage.saveStatuses()">Зберегти підписи</button>' +
    '<p class="sv-hint">Ці підписи одразу побачать і сайт, і бот, і ця адмінка.</p>';
  }

  function saveStatuses() {
    var d = db(); if (!d) return;
    var payload = {};
    STATUS_CODES.forEach(function (code) {
      var ua = ((document.getElementById('st-ua-' + code) || {}).value || '').trim();
      if (!ua) return;                       // порожній підпис не зберігаємо
      payload[code] = {
        ua: ua,
        emoji: ((document.getElementById('st-emoji-' + code) || {}).value || '').trim() || '📋',
        hint: ((document.getElementById('st-hint-' + code) || {}).value || '').trim()
      };
    });
    d.collection('config').doc('statuses').set(payload)
      .then(function () { toast('Підписи збережено — сайт і бот підхоплять їх самі'); log('settings', 'Змінив підписи статусів'); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  // ═══════════════ 4. ЗАМОВЛЕННЯ ВРУЧНУ ═══════════════
  // Телефоном, з виставки, від знайомого — раніше такі замовлення
  // не було куди вписати взагалі.

  var ORDER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function makeOrderNumber() {
    var out = '';
    var rnd = new Uint32Array(8);
    (global.crypto || global.msCrypto).getRandomValues(rnd);
    for (var i = 0; i < 8; i++) out += ORDER_ALPHABET[rnd[i] % ORDER_ALPHABET.length];
    return 'SV-' + out.slice(0, 4) + '-' + out.slice(4);
  }

  function renderManualItems() {
    var el = document.getElementById('mg-manual-items');
    if (!el) return;
    var merch = (global.SvarogData ? SvarogData.merch() : []) || [];
    var options = merch.map(function (m) {
      return '<option value="' + esc(m.id) + '">' + esc(m.title || m.id) +
             ' — ' + (m.discountPrice || m.price || 0) + ' ₴</option>';
    }).join('');
    el.innerHTML = '<div class="mg-manual-row">' +
      '<select class="sv-input" id="mg-item-select"><option value="">— оберіть товар —</option>' + options + '</select>' +
      '<input class="sv-input" id="mg-item-size" placeholder="розмір" style="max-width:110px">' +
      '<input class="sv-input" id="mg-item-qty" type="number" value="1" min="1" style="max-width:90px">' +
      '<button class="sv-mini" onclick="SvarogManage.addManualItem()">Додати</button></div>' +
      '<div id="mg-manual-list"></div>';
    renderManualList();
  }

  var manualItems = [];

  function addManualItem() {
    var id = (document.getElementById('mg-item-select') || {}).value;
    if (!id) { toast('Оберіть товар', 'error'); return; }
    var merch = (global.SvarogData ? SvarogData.merch() : []) || [];
    var m = merch.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    var qty = Math.max(1, parseInt((document.getElementById('mg-item-qty') || {}).value) || 1);
    var price = Number(m.discountPrice || m.price) || 0;
    manualItems.push({
      merchId: m.id, merchTitle: m.title || m.id,
      size: ((document.getElementById('mg-item-size') || {}).value || '').trim(),
      quantity: qty, price: price, totalPrice: price * qty
    });
    renderManualList();
  }

  function removeManualItem(i) { manualItems.splice(i, 1); renderManualList(); }

  function renderManualList() {
    var el = document.getElementById('mg-manual-list');
    if (!el) return;
    if (!manualItems.length) { el.innerHTML = '<div class="sv-hint">Товарів ще не додано.</div>'; return; }
    var total = manualItems.reduce(function (a, i) { return a + i.totalPrice; }, 0);
    el.innerHTML = manualItems.map(function (i, idx) {
      return '<div class="mg-manual-item">' + esc(i.merchTitle) +
        (i.size ? ' (' + esc(i.size) + ')' : '') + ' ×' + i.quantity +
        ' — ' + money(i.totalPrice) +
        ' <button class="sv-mini" onclick="SvarogManage.removeManualItem(' + idx + ')">✕</button></div>';
    }).join('') + '<div class="mg-manual-total">Разом: <b>' + money(total) + '</b></div>';
  }

  function createManualOrder() {
    var d = db(); if (!d) return;
    var name = ((document.getElementById('mg-order-name') || {}).value || '').trim();
    var phone = ((document.getElementById('mg-order-phone') || {}).value || '').trim();
    var address = ((document.getElementById('mg-order-address') || {}).value || '').trim();

    if (!name || digits(phone).length < 9) { toast('Потрібні імʼя і телефон', 'error'); return; }
    if (!manualItems.length) { toast('Додайте хоча б один товар', 'error'); return; }

    var total = manualItems.reduce(function (a, i) { return a + i.totalPrice; }, 0);
    var id = makeOrderNumber();

    // Правила Firestore пропускають створення тільки зі статусом 'new' —
    // те саме обмеження, що й для замовлень із сайту.
    d.collection('orders').doc(id).set({
      name: name, phone: phone, address: address,
      items: manualItems.slice(),
      totalPrice: total,
      status: 'new',
      paymentMethod: 'manual',
      source: 'admin',
      createdBy: me(),
      claimedBy: me(),
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      createdAt: new Date().toISOString()
    }).then(function () {
      manualItems = [];
      ['mg-order-name', 'mg-order-phone', 'mg-order-address'].forEach(function (f) {
        var el = document.getElementById(f); if (el) el.value = '';
      });
      renderManualList();
      toast('Замовлення ' + id + ' створено');
      log('orders', 'Створив замовлення вручну: ' + id + ' на ' + money(total));
    }).catch(function (e) { toast('Не вдалося: ' + (e.message || e.code), 'error'); });
  }

  // ═══════════════ 5. ЕКРАН «ПОТРЕБУЄ УВАГИ» ═══════════════

  function attentionGroups() {
    var now = Date.now();
    var list = orders();
    var day = 86400000;

    return [
      {
        title: 'Склад не списано',
        hint: 'Замовлення прийнято, але залишок товару не зменшився — ' +
              'база відхилила запис. Найчастіше це означає, що в Firebase ' +
              'опубліковані старі правила. Перевірте склад вручну.',
        items: list.filter(function (o) {
          return o.needsStockFix === true && o.status !== 'cancelled';
        })
      },
      {
        title: 'Скасовані клієнтом',
        hint: 'Клієнт натиснув «Скасувати» на сайті або в боті',
        items: list.filter(function (o) {
          return o.status === 'cancelled' &&
                 (o.cancelledBy === 'customer' || o.cancelledBy === 'customer-telegram') &&
                 !o.cancelSeen;
        })
      },
      {
        title: 'Чекають оплати понад 2 дні',
        hint: 'Варто нагадати або скасувати',
        items: list.filter(function (o) {
          return o.status === 'new' && !o.paymentProof &&
                 toMs(o.timestamp || o.createdAt) &&
                 now - toMs(o.timestamp || o.createdAt) > 2 * day;
        })
      },
      {
        title: 'Прийняті, але без ТТН понад 3 дні',
        hint: 'Клієнт заплатив і чекає',
        items: list.filter(function (o) {
          return o.status === 'accepted' && !(o.ttn || o.trackingNumber) &&
                 toMs(o.paidAt || o.timestamp) &&
                 now - toMs(o.paidAt || o.timestamp) > 3 * day;
        })
      },
      {
        title: 'Ніхто не взяв у роботу',
        hint: 'Замовлення висить без відповідального',
        items: list.filter(function (o) {
          return !o.claimedBy && ['new', 'on_review'].indexOf(o.status) !== -1 &&
                 toMs(o.timestamp || o.createdAt) &&
                 now - toMs(o.timestamp || o.createdAt) > day;
        })
      }
    ];
  }

  function renderAttention() {
    var el = document.getElementById('mg-attention');
    if (!el) return;

    var groups = attentionGroups();
    var pending = pendingReviews().length;
    var total = groups.reduce(function (a, g) { return a + g.items.length; }, 0) + pending;

    var html = '';
    if (!total) {
      html = '<div class="sv-empty">✅ Нічого не горить. Усі замовлення в роботі.</div>';
    } else {
      groups.forEach(function (g) {
        if (!g.items.length) return;
        html += '<div class="mg-att-group"><h4 class="sv-sub">' + esc(g.title) +
          ' <span class="acc-badge">' + g.items.length + '</span></h4>' +
          '<p class="sv-hint">' + esc(g.hint) + '</p>' +
          g.items.slice(0, 15).map(function (o) {
            return '<div class="mg-att-item">' +
              '<b>' + esc(o.id) + '</b> · ' + esc(o.name || o.customerName || '') +
              ' · ' + money(o.totalPrice) +
              (o.cancelReason ? ' <span class="sv-hint">(' + esc(o.cancelReason) + ')</span>' : '') +
              // Діагноз, який сайт записав у момент збою: яка колекція
              // не пустила запис. Позбавляє потреби гадати.
              (o.deniedWrite ? ' <span class="sv-hint">— правила заборонили запис у: <code>' +
                               esc(o.deniedWrite) + '</code></span>' : '') +
              '</div>';
          }).join('') + '</div>';
      });
      if (pending) {
        html += '<div class="mg-att-group"><h4 class="sv-sub">Відгуки на перевірці ' +
          '<span class="acc-badge">' + pending + '</span></h4>' +
          '<p class="sv-hint">Доки не схвалите — на сайті їх не видно.</p></div>';
      }
    }
    el.innerHTML = html;
    updateBadge(total);
  }

  function updateBadge(count) {
    var badge = document.getElementById('badge-attention');
    if (!badge) return;
    var n = count;
    if (n === undefined) {
      n = attentionGroups().reduce(function (a, g) { return a + g.items.length; }, 0) + pendingReviews().length;
    }
    badge.innerText = n;
    badge.style.display = n ? 'flex' : 'none';
  }

  // ═══════════════ 6. СПОВІЩЕННЯ ПРО НОВЕ ЗАМОВЛЕННЯ ═══════════════
  // Працює, поки адмінка відкрита. Безкоштовно, без жодного сервера.

  function askNotifyPermission() {
    if (!('Notification' in global)) { toast('Браузер не вміє сповіщення', 'error'); return; }
    Notification.requestPermission().then(function (p) {
      toast(p === 'granted' ? 'Сповіщення увімкнено' : 'Сповіщення заборонені в браузері',
            p === 'granted' ? 'success' : 'error');
    });
  }

  function checkNewOrders() {
    var list = orders();
    if (lastSeenOrderCount === null) { lastSeenOrderCount = list.length; return; }
    if (list.length <= lastSeenOrderCount) { lastSeenOrderCount = list.length; return; }

    var fresh = list.length - lastSeenOrderCount;
    lastSeenOrderCount = list.length;

    try {
      if ('Notification' in global && Notification.permission === 'granted') {
        var newest = list.slice().sort(function (a, b) {
          return toMs(b.timestamp || b.createdAt) - toMs(a.timestamp || a.createdAt);
        })[0] || {};
        var n = new Notification('SVAROG — нове замовлення', {
          body: (newest.name || newest.customerName || '') + ' · ' + money(newest.totalPrice),
          tag: 'svarog-order'
        });
        n.onclick = function () { global.focus(); n.close(); };
      }
    } catch (e) {}
    toast('Нових замовлень: ' + fresh);
  }

  // ═══════════════ 7. ЩОТИЖНЕВА КОПІЯ ═══════════════

  function maybeAutoBackup() {
    try {
      var last = parseInt(localStorage.getItem('svarog.lastBackup') || '0', 10);
      if (last && (Date.now() - last) < 7 * 86400000) return;
      if (!global.SvarogBackups || !SvarogBackups.createLocalBackup) return;
      // Копія вивантажується файлом, тому робимо це тихо, але один раз
      // на тиждень і лише коли адмінка вже прогрілась.
      SvarogBackups.createLocalBackup();
      localStorage.setItem('svarog.lastBackup', String(Date.now()));
      toast('Зроблено щотижневу резервну копію');
    } catch (e) {}
  }

  // ═══════════════ 8. КАРТКА КЛІЄНТА Й ПЛАНОВА ДАТА ═══════════════
  // Дані, які клієнт вписав у кабінеті, лежать у customers — але в
  // замовленні їх не було видно. Підтягуємо по телефону.

  function loadCustomers() {
    var d = db(); if (!d) return;
    d.collection('customers').limit(300).get().then(function (snap) {
      customersCache = {};
      snap.forEach(function (doc) {
        var c = doc.data() || {};
        var k = phoneKey(c.phone);
        if (k) customersCache[k] = c;
      });
      enhanceOrders();
    }).catch(function (err) {
      console.warn('[SVAROG] customers:', err.code);
    });
  }

  function enhanceOrders() {
    document.querySelectorAll('[data-order-id]').forEach(function (card) {
      if (card.dataset.mgDone) return;
      var id = card.dataset.orderId;
      var o = orders().filter(function (x) { return x.id === id; })[0];
      if (!o) return;
      card.dataset.mgDone = '1';

      var box = document.createElement('div');
      box.className = 'mg-order-extra';

      var c = customersCache[phoneKey(o.phone || o.customerPhone)];
      if (c && (c.npCity || c.npWarehouse || c.telegramChatId)) {
        var bits = [];
        if (c.npCity || c.npWarehouse) {
          bits.push('📍 ' + esc([c.npCity, c.npWarehouse ? '№ ' + c.npWarehouse : ''].filter(Boolean).join(', ')));
        }
        if (c.telegramChatId) bits.push('📱 Telegram привʼязано');
        box.innerHTML += '<div class="sv-hint">З кабінету: ' + bits.join(' · ') + '</div>';
      }

      // Кнопка «видати знижку» — тільки для доведених до кінця замовлень
      if (['delivered', 'sent', 'accepted'].indexOf(o.status) !== -1) {
        box.innerHTML += o.personalPromo
          ? '<div class="sv-hint">🎁 Персональна знижка вже видана: <code>' +
            esc(o.personalPromo) + '</code></div>'
          : '<div class="mg-plan-row"><button class="sv-mini" ' +
            'onclick="SvarogManage.issuePersonalPromo(\'' + esc(o.id) + '\')">' +
            '🎁 Видати знижку на наступне замовлення</button></div>';
      }

      var planned = o.plannedShipDate || '';
      box.innerHTML += '<div class="mg-plan-row"><span class="sv-hint">Планова відправка:</span>' +
        '<input type="date" class="sv-input" style="max-width:170px" value="' + esc(planned) + '" ' +
        'onchange="SvarogManage.setPlanned(\'' + esc(id) + '\', this.value)"></div>';

      card.appendChild(box);
    });
  }

  function setPlanned(orderId, date) {
    var d = db(); if (!d) return;
    d.collection('orders').doc(orderId).update({ plannedShipDate: date || '' })
      .then(function () { toast(date ? 'Дату збережено' : 'Дату прибрано'); })
      .catch(function (e) { toast(e.message, 'error'); });
  }

  function wrapOrdersRender() {
    if (!global.renderOrdersList || global.renderOrdersList.__mgWrapped) return;
    var original = global.renderOrdersList;
    var wrapped = function () {
      var r = original.apply(this, arguments);
      try { setTimeout(enhanceOrders, 30); } catch (e) {}
      return r;
    };
    wrapped.__mgWrapped = true;
    global.renderOrdersList = wrapped;
  }

  // ═══════════════ 9. ПЕРСОНАЛЬНА ЗНИЖКА КЛІЄНТУ ═══════════════
  //
  // Класичний сценарій: людина зробила перше замовлення — видаємо їй
  // знижку на наступне. Код прив'язується до її телефону полем
  // assignedPhone, тому переслати його друзям не вийде: на касі
  // звіряється номер.
  //
  // Бот показує такий код тільки цій людині — команда /promo більше
  // не вивалює всі знижки підряд.

  var PROMO_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function makePromoCode(name) {
    // Читабельний префікс з імені, щоб у списку було видно, чий це код
    var base = (name || '').trim().toUpperCase()
      .replace(/[^A-ZА-ЯЄІЇҐ]/g, '').slice(0, 4);
    var tail = '';
    var rnd = new Uint32Array(4);
    (global.crypto || global.msCrypto).getRandomValues(rnd);
    for (var i = 0; i < 4; i++) tail += PROMO_ALPHABET[rnd[i] % PROMO_ALPHABET.length];
    return (base ? base + '-' : 'SV-') + tail;
  }

  function issuePersonalPromo(orderId) {
    var d = db(); if (!d) return;
    var o = orders().filter(function (x) { return x.id === orderId; })[0];
    if (!o) { toast('Замовлення не знайдено', 'error'); return; }

    var phone = phoneKey(o.phone || o.customerPhone);
    if (!phone) { toast('У замовленні немає телефону — код нема до чого привʼязати', 'error'); return; }

    var pct = parseInt(prompt('Знижка у відсотках для наступного замовлення:', '10'), 10);
    if (!pct || pct < 1 || pct > 90) {
      if (pct !== undefined) toast('Знижка має бути від 1 до 90 %', 'error');
      return;
    }

    var days = parseInt(prompt('Скільки днів діятиме код?', '60'), 10) || 60;
    var code = makePromoCode(o.name || o.customerName);

    d.collection('promocodes').doc(code).set({
      active: true,
      discount: pct,
      assignedPhone: phone,              // ← через це поле код іменний
      assignedName: o.name || o.customerName || '',
      isPublic: false,                   // у загальний список не потрапить
      note: 'Персональна знижка за замовлення ' + orderId,
      forOrder: orderId,
      expiresAt: Date.now() + days * 86400000,
      createdAt: Date.now(),
      author: me()
    }).then(function () {
      // Позначаємо саме замовлення, щоб не видати другу знижку за те саме
      d.collection('orders').doc(orderId).update({ personalPromo: code }).catch(function () {});
      toast('Код ' + code + ' видано на ' + pct + '%');
      log('shop', 'Видав персональну знижку ' + code + ' (' + pct + '%) клієнту ' + phone);
      alert('Код: ' + code + '\n\nЗнижка ' + pct + '% на ' + days + ' днів.\n' +
            'Спрацює тільки з номером ' + (o.phone || o.customerPhone) + '.\n\n' +
            'Клієнт побачить його сам, написавши боту /promo.');
    }).catch(function (e) {
      toast('Не вдалося: ' + (e.message || e.code), 'error');
    });
  }

  // ═══════════════ ІНІЦІАЛІЗАЦІЯ ═══════════════
  function init() {
    if (subs.length) return;
    watchReviews();
    watchFundraisers();
    loadStatuses();
    loadCustomers();
    renderManualItems();
    wrapOrdersRender();
    renderAttention();

    setInterval(function () {
      try { checkNewOrders(); renderAttention(); } catch (e) {}
    }, 20000);

    setTimeout(maybeAutoBackup, 20000);
  }

  function refresh() {
    try { renderAttention(); } catch (e) {}
    try { renderReviews(); } catch (e) {}
    try { renderManualItems(); } catch (e) {}
  }

  global.SvarogManage = {
    init: init,
    refresh: refresh,
    renderReviews: renderReviews,
    approveReview: approveReview,
    hideReview: hideReview,
    deleteReview: deleteReview,
    zoom: zoom,
    addFundraiser: addFundraiser,
    saveFundGoal: saveFundGoal,
    toggleFund: toggleFund,
    deleteFund: deleteFund,
    loadStatuses: loadStatuses,
    renderStatuses: renderStatuses,
    saveStatuses: saveStatuses,
    addManualItem: addManualItem,
    removeManualItem: removeManualItem,
    createManualOrder: createManualOrder,
    makeOrderNumber: makeOrderNumber,
    attentionGroups: attentionGroups,
    renderAttention: renderAttention,
    askNotifyPermission: askNotifyPermission,
    setPlanned: setPlanned,
    issuePersonalPromo: issuePersonalPromo,
    makePromoCode: makePromoCode,
    pendingReviews: pendingReviews,
    _manualItems: function () { return manualItems; }
  };

})(window);
