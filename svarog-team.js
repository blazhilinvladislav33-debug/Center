/* ═══════════════════════════════════════════════════════════════════
   SVAROG · КОМАНДА  v3.6.0

   Хто скільки обробив, графік чергувань, швидкі відповіді,
   чорний список, черга перевірки оплат, воронка заявок.

   Колекції:
     orders        — поле claimedBy / processedBy (хто взяв замовлення)
     duty          — графік чергувань (нова)
     quick_replies — шаблони відповідей (нова)
     blacklist     — проблемні клієнти (нова)
     recruiting_applications — воронка
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var quickReplies = [];
  var blacklist = [];
  var duty = [];
  var subs = [];

  var DAYS = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П’ятниця', 'Субота', 'Неділя'];

  function db() { return global.db || (global.firebase && firebase.firestore()); }
  function orders() { return (global.SvarogData ? SvarogData.orders() : []) || []; }
  function me() { return global.SvarogData ? SvarogData.adminEmail() : ''; }
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

  function watch(coll, limit, cb) {
    var d = db(); if (!d) return;
    try {
      subs.push(d.collection(coll).limit(limit).onSnapshot(function (snap) {
        var arr = [];
        snap.forEach(function (doc) { var x = doc.data() || {}; x.id = doc.id; arr.push(x); });
        cb(arr, null);
      }, function (err) {
        console.warn('[SVAROG] ' + coll + ':', err.code);
        cb([], err);
      }));
    } catch (e) { console.error('[SVAROG] watch ' + coll, e); }
  }

  function init() {
    if (subs.length) return;
    watch('quick_replies', 60, function (a, err) {
      quickReplies = a; renderQuickReplies(err);
    });
    watch('blacklist', 100, function (a, err) { blacklist = a; renderBlacklist(err); });
    watch('duty', 40, function (a, err) { duty = a; renderDuty(err); });
    renderTeamStats();
    renderPaymentQueue();
    renderFunnel();
  }

  // ───────────────────────── статистика команди ──────────────────────
  function renderTeamStats() {
    var el = document.getElementById('team-stats');
    if (!el) return;
    var days = parseInt((document.getElementById('team-period') || {}).value || '30', 10);
    var from = new Date(Date.now() - days * 86400000);

    var byPerson = {};
    orders().forEach(function (o) {
      var who = o.claimedBy || o.processedBy || o.assignedTo || '';
      if (!who) return;
      var dt = toDate(o.claimedAt || o.updatedAt || o.createdAt);
      if (dt && dt < from) return;
      if (!byPerson[who]) byPerson[who] = { n: 0, sum: 0, done: 0 };
      byPerson[who].n++;
      byPerson[who].sum += Number(o.totalPrice || o.total || 0) || 0;
      var st = o.status || '';
      if (st === 'delivered' || st === 'completed' || st === 'Доставлено') byPerson[who].done++;
    });

    var names = Object.keys(byPerson).sort(function (a, b) { return byPerson[b].n - byPerson[a].n; });
    if (!names.length) {
      el.innerHTML = '<div class="sv-empty">Поки жодне замовлення не має позначки, хто його взяв. ' +
        'Щойно адміни почнуть брати замовлення в роботу — статистика зʼявиться тут.</div>';
      return;
    }
    el.innerHTML = '<table class="fin-table"><thead><tr><th>Адмін</th><th>Взято</th>' +
      '<th>Доведено до доставки</th><th style="text-align:right">Сума</th></tr></thead><tbody>' +
      names.map(function (n) {
        var p = byPerson[n];
        return '<tr><td>' + esc(n) + '</td><td>' + p.n + '</td><td>' + p.done + '</td>' +
               '<td style="text-align:right">' + money(p.sum) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // ───────────────────────── графік чергувань ────────────────────────
  function renderDuty(err) {
    var el = document.getElementById('team-duty');
    if (!el) return;
    if (err) {
      el.innerHTML = '<div class="sv-empty">Немає доступу до <code>duty</code>. Онови правила Firestore.</div>';
      return;
    }
    var map = {};
    duty.forEach(function (d) { map[d.id] = d.who || ''; });
    el.innerHTML = '<div class="team-duty-grid">' + DAYS.map(function (name, i) {
      var key = 'day' + i;
      return '<div class="team-duty-cell"><div class="team-duty-day">' + name + '</div>' +
        '<input class="sv-input" id="duty-' + key + '" value="' + esc(map[key] || '') +
        '" placeholder="хто чергує" onchange="SvarogTeam.saveDuty(\'' + key + '\', this.value)"></div>';
    }).join('') + '</div>';
  }

  function saveDuty(key, who) {
    var d = db(); if (!d) return;
    d.collection('duty').doc(key).set({ who: (who || '').trim(), updatedAt: new Date().toISOString() }, { merge: true })
      .catch(function (e) { alert('Не збереглось: ' + (e.message || e.code)); });
  }

  function whoIsOnDuty() {
    var js = new Date().getDay();           // 0 = неділя
    var idx = js === 0 ? 6 : js - 1;        // наш масив починається з понеділка
    var rec = duty.filter(function (d) { return d.id === 'day' + idx; })[0];
    return rec ? (rec.who || '') : '';
  }

  // ───────────────────────── швидкі відповіді ────────────────────────
  function renderQuickReplies(err) {
    var el = document.getElementById('team-replies');
    if (!el) return;
    if (err) {
      el.innerHTML = '<div class="sv-empty">Немає доступу до <code>quick_replies</code>. Онови правила Firestore.</div>';
      return;
    }
    if (!quickReplies.length) {
      el.innerHTML = '<div class="sv-empty">Шаблонів ще немає. Додай перший — і він зʼявиться кнопкою над полем відповіді у чатах.</div>';
      return;
    }
    el.innerHTML = quickReplies.map(function (q) {
      return '<div class="team-reply"><div class="team-reply-title">' + esc(q.title || '') + '</div>' +
        '<div class="team-reply-text">' + esc(q.text || '') + '</div>' +
        '<button class="btn-sm btn-danger" onclick="SvarogTeam.deleteReply(\'' + esc(q.id) + '\')">Видалити</button></div>';
    }).join('');
    injectReplyBar();
  }

  function addReply() {
    var t = ((document.getElementById('team-reply-title') || {}).value || '').trim();
    var x = ((document.getElementById('team-reply-text') || {}).value || '').trim();
    if (!t || !x) { alert('Заповни і назву, і текст.'); return; }
    var d = db(); if (!d) return;
    d.collection('quick_replies').add({ title: t, text: x, createdAt: new Date().toISOString(), author: me() })
      .then(function () {
        document.getElementById('team-reply-title').value = '';
        document.getElementById('team-reply-text').value = '';
      })
      .catch(function (e) { alert('Не збереглось: ' + (e.message || e.code)); });
  }

  function deleteReply(id) {
    if (!confirm('Видалити шаблон?')) return;
    var d = db(); if (!d) return;
    d.collection('quick_replies').doc(id).delete().catch(function (e) { alert(e.message || e.code); });
  }

  // Кнопки шаблонів над полем вводу в чатах.
  function injectReplyBar() {
    var input = document.getElementById('chat-message-input') ||
                document.getElementById('admin-chat-input') ||
                document.querySelector('#chats-tab textarea, #chats-tab input[type="text"]');
    if (!input || !quickReplies.length) return;
    var existing = document.getElementById('team-reply-bar');
    if (existing) existing.remove();

    var bar = document.createElement('div');
    bar.id = 'team-reply-bar';
    bar.className = 'team-reply-bar';
    quickReplies.slice(0, 12).forEach(function (q) {
      var b = document.createElement('button');
      b.className = 'sv-mini';
      b.type = 'button';
      b.textContent = q.title;
      b.onclick = function () {
        input.value = (input.value ? input.value + ' ' : '') + q.text;
        input.focus();
        try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      };
      bar.appendChild(b);
    });
    if (input.parentNode) input.parentNode.insertBefore(bar, input);
  }

  // ───────────────────────── чорний список ───────────────────────────
  function renderBlacklist(err) {
    var el = document.getElementById('team-blacklist');
    if (!el) return;
    if (err) {
      el.innerHTML = '<div class="sv-empty">Немає доступу до <code>blacklist</code>. Онови правила Firestore.</div>';
      return;
    }
    if (!blacklist.length) {
      el.innerHTML = '<div class="sv-empty">Список порожній.</div>';
      return;
    }
    el.innerHTML = blacklist.map(function (b) {
      return '<div class="team-bl-row"><div><b>' + esc(b.phone || b.id) + '</b>' +
        (b.name ? ' — ' + esc(b.name) : '') +
        '<div class="sv-hint">' + esc(b.reason || '') + '</div></div>' +
        '<button class="btn-sm" onclick="SvarogTeam.removeFromBlacklist(\'' + esc(b.id) + '\')">Прибрати</button></div>';
    }).join('');
  }

  function addToBlacklist() {
    var p = ((document.getElementById('team-bl-phone') || {}).value || '').trim();
    var r = ((document.getElementById('team-bl-reason') || {}).value || '').trim();
    if (digits(p).length < 9) { alert('Вкажи телефон повністю.'); return; }
    var d = db(); if (!d) return;
    d.collection('blacklist').doc(phoneKey(p)).set({
      phone: p, reason: r, addedAt: new Date().toISOString(), author: me()
    }).then(function () {
      document.getElementById('team-bl-phone').value = '';
      document.getElementById('team-bl-reason').value = '';
    }).catch(function (e) { alert('Не збереглось: ' + (e.message || e.code)); });
  }

  function removeFromBlacklist(id) {
    var d = db(); if (!d) return;
    d.collection('blacklist').doc(id).delete().catch(function (e) { alert(e.message || e.code); });
  }

  function isBlacklisted(phone) {
    var k = phoneKey(phone);
    if (!k) return null;
    for (var i = 0; i < blacklist.length; i++) if (blacklist[i].id === k) return blacklist[i];
    return null;
  }

  // ───────────────────────── черга перевірки оплат ───────────────────
  function renderPaymentQueue() {
    var el = document.getElementById('team-payments');
    if (!el) return;
    var list = orders().filter(function (o) {
      var st = o.status || '';
      var hasProof = !!(o.paymentProof || o.receiptUrl || o.paymentScreenshot);
      // Чек є, але замовлення ще не прийняте в роботу — треба звірити оплату.
      return hasProof && ['accepted', 'sent', 'delivered', 'cancelled', 'archived'].indexOf(st) === -1;
    });
    if (!list.length) {
      el.innerHTML = '<div class="sv-empty">Немає чеків, що чекають перевірки.</div>';
      return;
    }
    el.innerHTML = list.map(function (o) {
      var url = o.paymentProof || o.receiptUrl || o.paymentScreenshot;
      return '<div class="team-pay-row">' +
        '<div><b>№' + esc(o.orderNumber || o.id) + '</b> — ' + esc(o.customerName || o.name || '') +
        ' · ' + money(o.totalPrice || o.total) + '</div>' +
        '<div><a class="sv-mini" href="' + esc(url) + '" target="_blank" rel="noopener">Відкрити чек</a>' +
        '<button class="sv-mini" onclick="SvarogTeam.markPaid(\'' + esc(o.id) + '\')">✓ Оплачено</button></div></div>';
    }).join('');
  }

  function markPaid(orderId) {
    var d = db(); if (!d) return;
    d.collection('orders').doc(orderId).update({
      status: 'accepted', paidAt: new Date().toISOString(), paidConfirmedBy: me()
    }).then(function () {
      if (global.notifyCustomerOrderStatus) {
        try { notifyCustomerOrderStatus(orderId, 'accepted'); } catch (e) {}
      }
      if (global.SvarogUI) { try { SvarogUI.logStatusChange(orderId, '', 'accepted'); } catch (e) {} }
    }).catch(function (e) { alert('Не вдалося: ' + (e.message || e.code)); });
  }

  // ───────────────────────── воронка заявок ──────────────────────────
  function renderFunnel() {
    var el = document.getElementById('team-funnel');
    if (!el) return;
    var d = db(); if (!d) return;
    d.collection('recruiting_applications').limit(200).get().then(function (snap) {
      var byStage = {};
      var total = 0;
      snap.forEach(function (doc) {
        var s = (doc.data() || {}).status || 'нова';
        byStage[s] = (byStage[s] || 0) + 1;
        total++;
      });
      if (!total) { el.innerHTML = '<div class="sv-empty">Заявок немає.</div>'; return; }
      var keys = Object.keys(byStage).sort(function (a, b) { return byStage[b] - byStage[a]; });
      el.innerHTML = '<div class="fin-bars">' + keys.map(function (k) {
        var w = Math.max(3, Math.round(byStage[k] / total * 100));
        return '<div class="fin-bar-row"><div class="fin-bar-label">' + esc(k) + '</div>' +
          '<div class="fin-bar-track"><div class="fin-bar-fill" style="width:' + w + '%"></div></div>' +
          '<div class="fin-bar-val">' + byStage[k] + ' (' + w + '%)</div></div>';
      }).join('') + '</div>';
    }).catch(function (err) {
      el.innerHTML = '<div class="sv-empty">Не вдалося прочитати заявки: ' + esc(err.code) + '</div>';
    });
  }

  function refresh() {
    renderTeamStats();
    renderPaymentQueue();
    renderFunnel();
  }

  global.SvarogTeam = {
    init: init,
    refresh: refresh,
    saveDuty: saveDuty,
    whoIsOnDuty: whoIsOnDuty,
    addReply: addReply,
    deleteReply: deleteReply,
    injectReplyBar: injectReplyBar,
    addToBlacklist: addToBlacklist,
    removeFromBlacklist: removeFromBlacklist,
    isBlacklisted: isBlacklisted,
    markPaid: markPaid,
    renderTeamStats: renderTeamStats
  };

})(window);
