/**
 * SVAROG Campaigns v3.4.0 — шаблони й розсилки email / SMS
 *
 * Адмінка тільки СТВОРЮЄ завдання в колекції campaigns.
 * Реальну відправку робить Cloud Function (functions/index.js),
 * бо API-ключі Mailgun/Twilio не можна тримати в браузері.
 */

(function (global) {
  'use strict';

  const A = global.SvarogAdapter;

  let templates = [];
  let campaigns = [];
  let unsubTemplates = null;
  let unsubCampaigns = null;

  // Змінні, які підставляються у шаблон
  const VARIABLES = [
    { key: '{name}',      desc: "Імʼя отримувача" },
    { key: '{email}',     desc: 'Email' },
    { key: '{phone}',     desc: 'Телефон' },
    { key: '{orderId}',   desc: 'Номер замовлення' },
    { key: '{total}',     desc: 'Сума замовлення' },
    { key: '{status}',    desc: 'Статус замовлення' },
    { key: '{ttn}',       desc: 'ТТН Нової Пошти' },
    { key: '{promocode}', desc: 'Промокод' }
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // ───────────────────────────────────────────────────────────────
  // ШАБЛОНИ
  // ───────────────────────────────────────────────────────────────
  function renderTemplates() {
    const box = document.getElementById('camp-templates-list');
    if (!box) return;

    if (!templates.length) {
      box.innerHTML = '<div style="color:#888;padding:24px;text-align:center">' +
        'Шаблонів ще немає.<br><button class="btn-primary" style="margin-top:10px" ' +
        'onclick="SvarogCampaigns.createDefaults()">Створити стандартні шаблони</button></div>';
      return;
    }

    box.innerHTML = templates.map(function (t) {
      const icon = t.type === 'sms' ? '💬' : '✉️';
      const len = (t.body || '').length;
      const smsInfo = t.type === 'sms'
        ? '<span style="color:' + (len > 160 ? '#ef4444' : '#888') + '">' + len + '/160</span>'
        : '';
      return '<div class="camp-tpl">' +
        '<div class="camp-tpl-head">' +
          '<span>' + icon + ' <strong>' + esc(t.name) + '</strong></span>' +
          '<span>' + smsInfo +
            ' <button class="btn-sm" onclick="SvarogCampaigns.editTemplate(\'' + t.id + '\')">Змінити</button>' +
            ' <button class="btn-sm btn-danger" onclick="SvarogCampaigns.deleteTemplate(\'' + t.id + '\')">✕</button>' +
          '</span>' +
        '</div>' +
        (t.subject ? '<div class="camp-tpl-subject">' + esc(t.subject) + '</div>' : '') +
        '<div class="camp-tpl-body">' + esc((t.body || '').slice(0, 180)) + ((t.body || '').length > 180 ? '…' : '') + '</div>' +
      '</div>';
    }).join('');
  }

  function openTemplateModal(id) {
    const t = id ? templates.find(function (x) { return x.id === id; }) : null;
    document.getElementById('tpl-id').value = t ? t.id : '';
    document.getElementById('tpl-name').value = t ? t.name : '';
    document.getElementById('tpl-type').value = t ? t.type : 'email';
    document.getElementById('tpl-subject').value = t ? (t.subject || '') : '';
    document.getElementById('tpl-body').value = t ? t.body : '';
    onTypeChange();
    document.getElementById('tpl-modal').style.display = 'flex';
  }

  function closeTemplateModal() {
    document.getElementById('tpl-modal').style.display = 'none';
  }

  function onTypeChange() {
    const type = document.getElementById('tpl-type').value;
    const subjRow = document.getElementById('tpl-subject-row');
    if (subjRow) subjRow.style.display = type === 'sms' ? 'none' : 'block';
    updateCounter();
  }

  function updateCounter() {
    const type = document.getElementById('tpl-type').value;
    const body = document.getElementById('tpl-body').value || '';
    const el = document.getElementById('tpl-counter');
    if (!el) return;
    if (type === 'sms') {
      const parts = Math.ceil(body.length / 160) || 1;
      el.style.display = 'block';
      el.style.color = body.length > 160 ? '#ffb020' : '#888';
      el.innerText = body.length + ' символів · ' + parts + ' SMS';
    } else {
      el.style.display = 'none';
    }
  }

  function insertVariable(v) {
    const ta = document.getElementById('tpl-body');
    if (!ta) return;
    const start = ta.selectionStart;
    ta.value = ta.value.slice(0, start) + v + ta.value.slice(ta.selectionEnd);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = start + v.length;
    updateCounter();
  }

  async function saveTemplate() {
    const id = document.getElementById('tpl-id').value;
    const data = {
      name: document.getElementById('tpl-name').value.trim(),
      type: document.getElementById('tpl-type').value,
      subject: document.getElementById('tpl-subject').value.trim(),
      body: document.getElementById('tpl-body').value,
      updatedAt: Date.now()
    };

    if (!data.name || !data.body) {
      if (global.showToast) global.showToast('Заповніть назву і текст', 'error');
      return;
    }

    try {
      if (id) {
        await global.db.collection('templates').doc(id).update(data);
      } else {
        data.createdAt = Date.now();
        await global.db.collection('templates').add(data);
      }
      closeTemplateModal();
      if (global.showToast) global.showToast('Шаблон збережено', 'success');
      if (global.logAdminAction) global.logAdminAction('templates', 'Зберіг шаблон "' + data.name + '"');
    } catch (e) {
      if (global.showToast) global.showToast('Помилка: ' + e.message, 'error');
    }
  }

  async function deleteTemplate(id) {
    if (!confirm('Видалити шаблон?')) return;
    try {
      await global.db.collection('templates').doc(id).delete();
      if (global.showToast) global.showToast('Видалено', 'success');
    } catch (e) {
      if (global.showToast) global.showToast('Помилка: ' + e.message, 'error');
    }
  }

  async function createDefaults() {
    const defaults = [
      { name: 'Замовлення прийнято', type: 'email',
        subject: 'Ваше замовлення {orderId} прийнято',
        body: 'Вітаємо, {name}!\n\nДякуємо за замовлення {orderId} на суму {total}.\nМи вже беремось за нього і повідомимо про відправку.\n\nSVAROG TEAM' },
      { name: 'Замовлення відправлено', type: 'email',
        subject: 'Замовлення {orderId} у дорозі',
        body: 'Вітаємо, {name}!\n\nВаше замовлення відправлено.\nТТН: {ttn}\n\nSVAROG TEAM' },
      { name: 'SMS: відправлено', type: 'sms', subject: '',
        body: 'SVAROG: замовлення {orderId} відправлено. ТТН {ttn}' },
      { name: 'SMS: код підтвердження', type: 'sms', subject: '',
        body: 'SVAROG: ваш код {promocode}. Нікому його не повідомляйте.' }
    ];

    try {
      const batch = global.db.batch();
      defaults.forEach(function (d) {
        const ref = global.db.collection('templates').doc();
        batch.set(ref, Object.assign({ createdAt: Date.now(), updatedAt: Date.now() }, d));
      });
      await batch.commit();
      if (global.showToast) global.showToast('Створено ' + defaults.length + ' шаблонів', 'success');
    } catch (e) {
      if (global.showToast) global.showToast('Помилка: ' + e.message, 'error');
    }
  }

  // ───────────────────────────────────────────────────────────────
  // КАМПАНІЇ
  // ───────────────────────────────────────────────────────────────
  function audienceCount(segment) {
    const crm = global.SvarogCRM;
    if (segment === 'newsletter') {
      return (global.globalNewsletterData || []).length;
    }
    if (!crm) return 0;
    const all = crm.getData();
    if (segment === 'all') return all.length;
    return all.filter(function (c) { return crm.segmentOf(c) === segment; }).length;
  }

  function refreshAudience() {
    const seg = document.getElementById('camp-segment');
    const out = document.getElementById('camp-audience-count');
    if (!seg || !out) return;
    const n = audienceCount(seg.value);
    out.innerText = n;
    const btn = document.getElementById('camp-send-btn');
    if (btn) btn.disabled = n === 0;
  }

  function buildRecipients(segment) {
    if (segment === 'newsletter') {
      return (global.globalNewsletterData || []).map(function (s) {
        return { email: A.field(s, 'email', ''), name: A.field(s, 'name', ''), phone: '' };
      }).filter(function (r) { return r.email; });
    }
    const crm = global.SvarogCRM;
    if (!crm) return [];
    return crm.getData()
      .filter(function (c) { return segment === 'all' || crm.segmentOf(c) === segment; })
      .map(function (c) { return { email: c.email, name: c.name, phone: c.phone }; });
  }

  async function sendCampaign() {
    const tplId = document.getElementById('camp-template').value;
    const segment = document.getElementById('camp-segment').value;
    const tpl = templates.find(function (t) { return t.id === tplId; });

    if (!tpl) { if (global.showToast) global.showToast('Оберіть шаблон', 'error'); return; }

    const recipients = buildRecipients(segment)
      .filter(function (r) { return tpl.type === 'sms' ? r.phone : r.email; });

    if (!recipients.length) {
      if (global.showToast) global.showToast('У цьому сегменті немає отримувачів із потрібним контактом', 'error');
      return;
    }

    if (!confirm('Надіслати "' + tpl.name + '" на ' + recipients.length + ' контактів?\n\n' +
                 'Відправку виконає Cloud Function. Скасувати після запуску буде неможливо.')) return;

    try {
      await global.db.collection('campaigns').add({
        templateId: tpl.id,
        templateName: tpl.name,
        type: tpl.type,
        subject: tpl.subject || '',
        body: tpl.body,
        segment: segment,
        recipients: recipients,
        recipientsCount: recipients.length,
        status: 'queued',              // Cloud Function підхопить саме цей статус
        sentCount: 0,
        failedCount: 0,
        createdAt: Date.now(),
        createdBy: (global.firebase && firebase.auth().currentUser)
          ? firebase.auth().currentUser.email : 'unknown'
      });

      if (global.showToast) global.showToast('Кампанію поставлено в чергу (' + recipients.length + ')', 'success');
      if (global.logAdminAction) global.logAdminAction('campaigns', 'Запустив розсилку "' + tpl.name + '" на ' + recipients.length);
    } catch (e) {
      if (global.showToast) global.showToast('Помилка: ' + e.message, 'error');
    }
  }

  function renderCampaigns() {
    const box = document.getElementById('camp-history');
    if (!box) return;

    if (!campaigns.length) {
      box.innerHTML = '<div style="color:#888;padding:20px;text-align:center">Розсилок ще не було</div>';
      return;
    }

    const statusLabel = {
      queued: ['У черзі', '#ffb020'], sending: ['Відправляється', '#0a84ff'],
      sent: ['Надіслано', '#22c55e'], failed: ['Помилка', '#ef4444']
    };

    box.innerHTML = '<table class="an-table"><thead><tr><th>Дата</th><th>Шаблон</th><th>Тип</th>' +
      '<th>Отримувачів</th><th>Надіслано</th><th>Статус</th></tr></thead><tbody>' +
      campaigns.map(function (c) {
        const st = statusLabel[c.status] || [c.status, '#888'];
        return '<tr>' +
          '<td>' + new Date(c.createdAt).toLocaleString('uk-UA') + '</td>' +
          '<td>' + esc(c.templateName || '—') + '</td>' +
          '<td>' + (c.type === 'sms' ? '💬 SMS' : '✉️ Email') + '</td>' +
          '<td>' + (c.recipientsCount || 0) + '</td>' +
          '<td>' + (c.sentCount || 0) + (c.failedCount ? ' <span style="color:#ef4444">(-' + c.failedCount + ')</span>' : '') + '</td>' +
          '<td><span class="crm-badge" style="background:' + st[1] + '22;color:' + st[1] + '">' + st[0] + '</span></td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
  }

  function fillTemplateSelect() {
    const sel = document.getElementById('camp-template');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">— оберіть шаблон —</option>' +
      templates.map(function (t) {
        return '<option value="' + t.id + '">' + (t.type === 'sms' ? '💬 ' : '✉️ ') + esc(t.name) + '</option>';
      }).join('');
    if (current) sel.value = current;
  }

  function renderVariables() {
    const box = document.getElementById('tpl-variables');
    if (!box) return;
    box.innerHTML = VARIABLES.map(function (v) {
      return '<button type="button" class="camp-var" title="' + v.desc +
             '" onclick="SvarogCampaigns.insertVariable(\'' + v.key + '\')">' + v.key + '</button>';
    }).join('');
  }

  // ───────────────────────────────────────────────────────────────
  function init() {
    if (!global.db) return;
    renderVariables();

    if (unsubTemplates) unsubTemplates();
    unsubTemplates = global.db.collection('templates').onSnapshot(function (snap) {
      templates = [];
      snap.forEach(function (d) { templates.push(Object.assign({ id: d.id }, d.data())); });
      renderTemplates();
      fillTemplateSelect();
    }, function (err) {
      console.error('[SVAROG] templates:', err);
      const box = document.getElementById('camp-templates-list');
      if (box) box.innerHTML = '<div style="color:#ef4444;padding:20px">Немає доступу до шаблонів (' +
        err.code + '). Опублікуйте оновлені firestore.rules.</div>';
    });

    if (unsubCampaigns) unsubCampaigns();
    unsubCampaigns = global.db.collection('campaigns').onSnapshot(function (snap) {
      campaigns = [];
      snap.forEach(function (d) { campaigns.push(Object.assign({ id: d.id }, d.data())); });
      campaigns.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      renderCampaigns();
    }, function (err) {
      console.error('[SVAROG] campaigns:', err);
    });
  }

  global.SvarogCampaigns = {
    init: init,
    openTemplateModal: openTemplateModal,
    closeTemplateModal: closeTemplateModal,
    editTemplate: openTemplateModal,
    saveTemplate: saveTemplate,
    deleteTemplate: deleteTemplate,
    createDefaults: createDefaults,
    onTypeChange: onTypeChange,
    updateCounter: updateCounter,
    insertVariable: insertVariable,
    refreshAudience: refreshAudience,
    sendCampaign: sendCampaign,
    VARIABLES: VARIABLES
  };

})(window);
