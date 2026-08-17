/**
 * SVAROG Backups & Logs v3.4.0
 *
 * Резервні копії: вивантаження всієї бази у JSON-файл прямо з адмінки
 * (працює без платних сервісів) + постановка задачі на серверний бекап.
 * Журнал: розширений перегляд admin_logs із фільтрами.
 */

(function (global) {
  'use strict';

  const A = global.SvarogAdapter;

  // Колекції, які входять у резервну копію
  const BACKUP_COLLECTIONS = [
    'orders', 'customers', 'chats', 'feedback', 'merch', 'bundles',
    'news', 'hub_links', 'partners', 'promocodes', 'reviews', 'sizeCharts',
    'volunteers', 'recruiting_applications', 'newsletter_subscribers',
    'stock_notifications', 'combat_report_history', 'reports',
    'templates', 'campaigns', 'admins', 'config'
  ];

  let logs = [];
  let logFilter = { admin: 'all', category: 'all', search: '' };
  let unsubLogs = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // ───────────────────────────────────────────────────────────────
  // ЛОКАЛЬНИЙ БЕКАП
  // ───────────────────────────────────────────────────────────────
  async function createLocalBackup() {
    const btn = document.getElementById('bk-create-btn');
    const progress = document.getElementById('bk-progress');
    if (btn) { btn.disabled = true; btn.innerText = 'Читаю базу…'; }

    const dump = {
      _meta: {
        createdAt: new Date().toISOString(),
        version: '3.4.0',
        createdBy: (global.firebase && firebase.auth().currentUser)
          ? firebase.auth().currentUser.email : 'unknown'
      }
    };

    let done = 0;
    let totalDocs = 0;
    const skipped = [];

    for (const name of BACKUP_COLLECTIONS) {
      if (progress) {
        progress.style.display = 'block';
        progress.innerHTML = 'Читаю <strong>' + name + '</strong> … (' +
          (++done) + '/' + BACKUP_COLLECTIONS.length + ')';
      }
      try {
        const snap = await global.db.collection(name).get();
        const docs = [];
        snap.forEach(function (d) { docs.push(Object.assign({ _id: d.id }, d.data())); });
        if (docs.length) {
          dump[name] = docs;
          totalDocs += docs.length;
        }
      } catch (e) {
        skipped.push(name + ' (' + (e.code || 'помилка') + ')');
      }
    }

    if (!totalDocs) {
      if (progress) progress.innerHTML = '<span style="color:#ef4444">Не вдалось прочитати жодної колекції. ' +
        'Перевірте права доступу.</span>';
      if (btn) { btn.disabled = false; btn.innerText = '💾 Створити резервну копію'; }
      return;
    }

    const json = JSON.stringify(dump, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const filename = 'svarog-backup-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();

    const sizeMb = (blob.size / 1048576).toFixed(2);
    if (progress) {
      progress.innerHTML = '<span style="color:#22c55e">✅ Готово: ' + totalDocs + ' документів, ' +
        sizeMb + ' МБ</span>' +
        (skipped.length ? '<br><span style="color:#ffb020">Пропущено: ' + esc(skipped.join(', ')) + '</span>' : '');
    }
    if (btn) { btn.disabled = false; btn.innerText = '💾 Створити резервну копію'; }

    // Записуємо факт бекапу в історію
    try {
      await global.db.collection('backups').add({
        filename: filename,
        documents: totalDocs,
        sizeBytes: blob.size,
        collections: Object.keys(dump).filter(function (k) { return k !== '_meta'; }),
        skipped: skipped,
        type: 'local',
        createdAt: Date.now(),
        createdBy: dump._meta.createdBy
      });
    } catch (e) { /* історія не критична */ }

    if (global.logAdminAction) global.logAdminAction('backups', 'Створив резервну копію (' + totalDocs + ' док.)');
  }

  // ───────────────────────────────────────────────────────────────
  // ВІДНОВЛЕННЯ
  // ───────────────────────────────────────────────────────────────
  function pickRestoreFile() {
    const input = document.getElementById('bk-restore-input');
    if (input) input.click();
  }

  async function handleRestoreFile(fileInput) {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    let dump;
    try {
      dump = JSON.parse(await file.text());
    } catch (e) {
      if (global.showToast) global.showToast('Файл пошкоджений або це не резервна копія', 'error');
      return;
    }

    const collections = Object.keys(dump).filter(function (k) { return k !== '_meta'; });
    const totalDocs = collections.reduce(function (s, k) { return s + dump[k].length; }, 0);

    const answer = prompt(
      'ВІДНОВЛЕННЯ З КОПІЇ\n\n' +
      'Копія від: ' + (dump._meta ? dump._meta.createdAt : 'невідомо') + '\n' +
      'Колекцій: ' + collections.length + '\n' +
      'Документів: ' + totalDocs + '\n\n' +
      'Наявні документи з такими ж ID будуть ПЕРЕЗАПИСАНІ.\n\n' +
      'Введіть ВІДНОВИТИ великими літерами, щоб підтвердити:'
    );
    if (answer !== 'ВІДНОВИТИ') {
      if (global.showToast) global.showToast('Скасовано', 'info');
      return;
    }

    const progress = document.getElementById('bk-progress');
    let written = 0;

    for (const name of collections) {
      const docs = dump[name];
      // Firestore batch — максимум 500 операцій
      for (let i = 0; i < docs.length; i += 400) {
        const batch = global.db.batch();
        docs.slice(i, i + 400).forEach(function (d) {
          const id = d._id;
          const data = Object.assign({}, d);
          delete data._id;
          batch.set(global.db.collection(name).doc(id), data, { merge: true });
        });
        try {
          await batch.commit();
          written += Math.min(400, docs.length - i);
          if (progress) {
            progress.style.display = 'block';
            progress.innerHTML = 'Відновлюю <strong>' + name + '</strong> … ' + written + '/' + totalDocs;
          }
        } catch (e) {
          if (progress) progress.innerHTML = '<span style="color:#ef4444">Помилка на "' + name + '": ' + esc(e.message) + '</span>';
          return;
        }
      }
    }

    if (progress) progress.innerHTML = '<span style="color:#22c55e">✅ Відновлено ' + written + ' документів</span>';
    if (global.logAdminAction) global.logAdminAction('backups', 'Відновив базу з копії (' + written + ' док.)');
    fileInput.value = '';
  }

  // ───────────────────────────────────────────────────────────────
  // ІСТОРІЯ БЕКАПІВ
  // ───────────────────────────────────────────────────────────────
  function renderBackupHistory(list) {
    const box = document.getElementById('bk-history');
    if (!box) return;

    if (!list.length) {
      box.innerHTML = '<div style="color:#888;padding:16px;text-align:center">Копій ще не створювали</div>';
      return;
    }

    box.innerHTML = '<table class="an-table"><thead><tr><th>Коли</th><th>Файл</th>' +
      '<th>Документів</th><th>Розмір</th><th>Хто</th></tr></thead><tbody>' +
      list.map(function (b) {
        return '<tr>' +
          '<td>' + new Date(b.createdAt).toLocaleString('uk-UA') + '</td>' +
          '<td style="font-size:.85em">' + esc(b.filename || '—') + '</td>' +
          '<td>' + (b.documents || 0) + '</td>' +
          '<td>' + ((b.sizeBytes || 0) / 1048576).toFixed(2) + ' МБ</td>' +
          '<td style="font-size:.85em">' + esc(b.createdBy || '—') + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
  }

  // ───────────────────────────────────────────────────────────────
  // ЖУРНАЛ ДІЙ
  // ───────────────────────────────────────────────────────────────
  function renderLogs() {
    const box = document.getElementById('bk-logs');
    if (!box) return;

    const q = logFilter.search.toLowerCase();
    const filtered = logs.filter(function (l) {
      if (logFilter.admin !== 'all' && l.admin !== logFilter.admin) return false;
      if (logFilter.category !== 'all' && l.category !== logFilter.category) return false;
      if (q && (l.details + ' ' + l.admin).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });

    const countEl = document.getElementById('bk-logs-count');
    if (countEl) countEl.innerText = filtered.length + ' із ' + logs.length;

    if (!filtered.length) {
      box.innerHTML = '<div style="color:#888;padding:20px;text-align:center">Записів не знайдено</div>';
      return;
    }

    box.innerHTML = filtered.slice(0, 300).map(function (l) {
      return '<div class="bk-log-row">' +
        '<span class="bk-log-time">' + new Date(l.time).toLocaleString('uk-UA') + '</span>' +
        '<span class="bk-log-cat">' + esc(l.category) + '</span>' +
        '<span class="bk-log-admin">' + esc(l.admin) + '</span>' +
        '<span class="bk-log-text">' + esc(l.details) + '</span>' +
      '</div>';
    }).join('');
  }

  function fillLogFilters() {
    const admins = {}, cats = {};
    logs.forEach(function (l) { admins[l.admin] = 1; cats[l.category] = 1; });

    const aSel = document.getElementById('bk-log-admin');
    const cSel = document.getElementById('bk-log-category');

    if (aSel) {
      const cur = aSel.value;
      aSel.innerHTML = '<option value="all">Всі адміни</option>' +
        Object.keys(admins).sort().map(function (a) { return '<option>' + esc(a) + '</option>'; }).join('');
      aSel.value = cur || 'all';
    }
    if (cSel) {
      const cur = cSel.value;
      cSel.innerHTML = '<option value="all">Всі дії</option>' +
        Object.keys(cats).sort().map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
      cSel.value = cur || 'all';
    }
  }

  function setLogFilter(key, value) {
    logFilter[key] = value;
    renderLogs();
  }

  function exportLogs() {
    const lines = ['Час,Категорія,Адмін,Дія'].concat(logs.map(function (l) {
      return [new Date(l.time).toLocaleString('uk-UA'), l.category, l.admin, l.details]
        .map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
    }));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'svarog-logs-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
  }

  // ───────────────────────────────────────────────────────────────
  function init() {
    if (!global.db) return;

    global.db.collection('backups').onSnapshot(function (snap) {
      const list = [];
      snap.forEach(function (d) { list.push(Object.assign({ id: d.id }, d.data())); });
      list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      renderBackupHistory(list.slice(0, 30));
    }, function (err) { console.warn('[SVAROG] backups:', err.code); });

    if (unsubLogs) unsubLogs();
    unsubLogs = global.db.collection('admin_logs').onSnapshot(function (snap) {
      logs = [];
      snap.forEach(function (d) {
        const x = d.data();
        logs.push({
          id: d.id,
          time: (A.createdAt(x) || new Date(0)).getTime(),
          admin: x.adminEmail || x.admin || x.email || '—',
          category: x.actionCategory || x.category || 'інше',
          details: x.actionDetails || x.details || x.action || ''
        });
      });
      logs.sort(function (a, b) { return b.time - a.time; });
      fillLogFilters();
      renderLogs();
    }, function (err) {
      const box = document.getElementById('bk-logs');
      if (box) box.innerHTML = '<div style="color:#ef4444;padding:20px">Немає доступу до журналу (' +
        err.code + '). Потрібна роль moderator або вище.</div>';
    });
  }

  global.SvarogBackups = {
    init: init,
    createLocalBackup: createLocalBackup,
    pickRestoreFile: pickRestoreFile,
    handleRestoreFile: handleRestoreFile,
    setLogFilter: setLogFilter,
    exportLogs: exportLogs,
    BACKUP_COLLECTIONS: BACKUP_COLLECTIONS
  };

})(window);
