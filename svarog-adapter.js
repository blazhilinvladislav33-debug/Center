/**
 * SVAROG Adapter v3.4.0
 * ═══════════════════════════════════════════════════════════════════
 * Шар сумісності зі СТАРИМИ даними.
 *
 * Проблема: у Firestore документи створювались у різний час різними
 * версіями сайту, тому одне й те саме поле може називатись по-різному:
 *   timestamp / createdAt / created_at / date / dateCreated
 *   name / customerName / clientName / fullName
 *   totalPrice / total / sum / amount
 *
 * Firestore не вміє це нормалізувати, а orderBy по неіснуючому полю
 * МОВЧКИ викидає документ із результату.
 *
 * Цей модуль дає єдиний спосіб читати поле незалежно від його назви.
 * Нічого в базі не переписує — працює на льоту при читанні.
 * ═══════════════════════════════════════════════════════════════════
 */

(function (global) {
  'use strict';

  // ───────────────────────────────────────────────────────────────
  // СЛОВНИК СИНОНІМІВ
  // Порядок важливий: перший знайдений виграє.
  // Якщо у вашій базі є ще якась назва — просто допишіть її в масив.
  // ───────────────────────────────────────────────────────────────
  const FIELD_ALIASES = {
    createdAt:  ['timestamp', 'createdAt', 'created_at', 'date', 'dateCreated', 'time', 'orderDate'],
    updatedAt:  ['lastUpdate', 'updatedAt', 'updated_at', 'modifiedAt', 'lastModified'],

    name:       ['name', 'customerName', 'clientName', 'fullName', 'userName', "ім'я", 'title'],
    email:      ['email', 'mail', 'userEmail', 'customerEmail', 'e_mail'],
    phone:      ['phone', 'tel', 'telephone', 'phoneNumber', 'customerPhone', 'mobile'],

    total:      ['totalPrice', 'total', 'sum', 'amount', 'price', 'orderTotal', 'totalSum'],
    status:     ['status', 'state', 'orderStatus'],
    items:      ['items', 'products', 'cart', 'goods', 'positions'],

    city:       ['city', 'town', 'settlement', 'npCity'],
    address:    ['address', 'addr', 'deliveryAddress', 'npBranch', 'branch'],

    text:       ['text', 'message', 'msg', 'body', 'content', 'comment'],
    author:     ['author', 'sender', 'from', 'senderEmail', 'userId'],

    quantity:   ['quantity', 'qty', 'count', 'amount'],
    sku:        ['sku', 'article', 'code', 'productCode', 'id']
  };

  // Синоніми назв колекцій — на випадок, якщо сайт пише в іншу
  const COLLECTION_ALIASES = {
    orders:   ['orders', 'zamovlennya', 'purchases'],
    feedback: ['feedback', 'contacts', 'contact_forms', 'requests', 'messages'],
    chats:    ['chats', 'chat', 'conversations', 'dialogs'],
    customers:['customers', 'clients', 'users', 'buyers']
  };

  /**
   * Дістати значення поля з документа незалежно від його назви.
   * @param {object} doc      документ Firestore
   * @param {string} logical  логічна назва: createdAt, name, total...
   * @param {*}      fallback що повернути, якщо нічого не знайдено
   */
  function field(doc, logical, fallback) {
    if (!doc) return fallback;
    const candidates = FIELD_ALIASES[logical] || [logical];
    for (let i = 0; i < candidates.length; i++) {
      const key = candidates[i];
      if (doc[key] !== undefined && doc[key] !== null && doc[key] !== '') {
        return doc[key];
      }
    }
    return fallback;
  }

  /**
   * Привести будь-яке представлення дати до JS Date.
   * Розуміє: Firestore Timestamp, number (ms і seconds), ISO-рядок, Date.
   */
  function toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value.toDate === 'function') return value.toDate();       // Firestore Timestamp
    if (typeof value === 'object' && typeof value.seconds === 'number') {
      return new Date(value.seconds * 1000);
    }
    if (typeof value === 'number') {
      // 10 цифр = секунди, 13 = мілісекунди
      return new Date(value < 1e11 ? value * 1000 : value);
    }
    if (typeof value === 'string') {
      const parsed = new Date(value);
      return isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }

  /** Дата створення документа з будь-якою назвою поля */
  function createdAt(doc) {
    return toDate(field(doc, 'createdAt'));
  }

  /** Число з будь-якого представлення ("1 250 ₴", "1250.50", 1250) */
  function num(value, fallback) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const cleaned = value.replace(/[^\d.,-]/g, '').replace(',', '.');
      const parsed = parseFloat(cleaned);
      if (!isNaN(parsed)) return parsed;
    }
    return fallback === undefined ? 0 : fallback;
  }

  /** Сума замовлення незалежно від назви поля і формату */
  function total(order) {
    return num(field(order, 'total', 0));
  }

  /**
   * Нормалізувати документ до передбачуваної форми.
   * Оригінальні поля зберігаються — додаються лише зручні псевдоніми з _.
   */
  function normalize(doc) {
    if (!doc) return doc;
    return Object.assign({}, doc, {
      _createdAt: createdAt(doc),
      _name:      field(doc, 'name', ''),
      _email:     field(doc, 'email', ''),
      _phone:     field(doc, 'phone', ''),
      _total:     total(doc),
      _status:    field(doc, 'status', 'new'),
      _city:      field(doc, 'city', ''),
      _text:      field(doc, 'text', '')
    });
  }

  /** Нормалізувати масив документів */
  function normalizeAll(docs) {
    return (docs || []).map(normalize);
  }

  /** Сортування за датою (нові зверху), стійке до відсутніх полів */
  function sortByDateDesc(docs) {
    return (docs || []).slice().sort(function (a, b) {
      const da = createdAt(a);
      const db_ = createdAt(b);
      if (!da && !db_) return 0;
      if (!da) return 1;      // без дати — вниз
      if (!db_) return -1;
      return db_ - da;
    });
  }

  /**
   * Знайти, яка з колекцій-синонімів реально існує і має документи.
   * Повертає Promise з назвою або null.
   */
  async function detectCollection(logicalName, db) {
    const candidates = COLLECTION_ALIASES[logicalName] || [logicalName];
    for (let i = 0; i < candidates.length; i++) {
      try {
        const snap = await db.collection(candidates[i]).limit(1).get();
        if (!snap.empty) return candidates[i];
      } catch (e) { /* немає доступу або колекції — пробуємо наступну */ }
    }
    return null;
  }

  /**
   * Діагностика: які поля реально є в колекції.
   * Викликати з консолі: svarogInspect('orders')
   */
  async function inspect(collectionName, limit) {
    const db = global.db || (global.firebase && global.firebase.firestore());
    if (!db) { console.error('[Adapter] Firestore недоступний'); return; }

    const snap = await db.collection(collectionName).limit(limit || 50).get();
    if (snap.empty) {
      console.warn('[Adapter] Колекція "' + collectionName + '" порожня або недоступна');
      return { collection: collectionName, count: 0, fields: {} };
    }

    const fieldStats = {};
    snap.forEach(function (doc) {
      Object.keys(doc.data()).forEach(function (k) {
        fieldStats[k] = (fieldStats[k] || 0) + 1;
      });
    });

    const totalDocs = snap.size;
    console.group('%c[SVAROG] Колекція "' + collectionName + '" — ' + totalDocs + ' документів',
                  'color:#0a84ff;font-weight:bold');
    Object.keys(fieldStats).sort(function (a, b) { return fieldStats[b] - fieldStats[a]; })
      .forEach(function (k) {
        const pct = Math.round(fieldStats[k] / totalDocs * 100);
        const warn = pct < 100 ? '  ⚠️ є не всюди' : '';
        console.log('  ' + k.padEnd(22) + fieldStats[k] + '/' + totalDocs + ' (' + pct + '%)' + warn);
      });
    console.groupEnd();

    return { collection: collectionName, count: totalDocs, fields: fieldStats };
  }

  /** Перевірити всі основні колекції одразу */
  async function inspectAll() {
    const names = ['orders', 'chats', 'feedback', 'customers', 'merch',
                   'volunteers', 'recruiting_applications', 'newsletter_subscribers'];
    const result = {};
    for (const n of names) {
      try { result[n] = await inspect(n, 50); } catch (e) { result[n] = { error: e.code || e.message }; }
    }
    console.log('%c[SVAROG] Перевірка завершена. Надішліть цей вивід розробнику.',
                'color:#0a0;font-weight:bold');
    return result;
  }

  // ───────────────────────────────────────────────────────────────
  // ЕКСПОРТ
  // ───────────────────────────────────────────────────────────────
  global.SvarogAdapter = {
    field: field,
    toDate: toDate,
    createdAt: createdAt,
    num: num,
    total: total,
    normalize: normalize,
    normalizeAll: normalizeAll,
    sortByDateDesc: sortByDateDesc,
    detectCollection: detectCollection,
    inspect: inspect,
    inspectAll: inspectAll,
    FIELD_ALIASES: FIELD_ALIASES,
    COLLECTION_ALIASES: COLLECTION_ALIASES
  };

  // Короткі команди для консолі
  global.svarogInspect = inspect;
  global.svarogInspectAll = inspectAll;

})(window);
