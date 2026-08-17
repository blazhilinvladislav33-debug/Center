const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

// Telegram Bot API
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "-1004110475608";

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

/**
 * Відправляє Telegram-сповіщення при зміні статусу замовлення
 */
// ═══════════════════════════════════════════════════════════════════════
// СТАТУСИ ЗАМОВЛЕНЬ — єдиний словник для бота, сайту й сповіщень
// Взято з реальних значень у admin.html
// ═══════════════════════════════════════════════════════════════════════

const ORDER_STATUSES = {
  new:       { emoji: "🆕", label: "Нове",              hint: "Ми отримали замовлення і скоро підтвердимо." },
  on_review: { emoji: "👀", label: "На розгляді",       hint: "Менеджер опрацьовує ваше замовлення." },
  sent:      { emoji: "📦", label: "Відправлено",       hint: "Посилка вже в дорозі." },
  delivered: { emoji: "🎉", label: "Доставлено",        hint: "Замовлення отримано. Дякуємо!" },
  cancelled: { emoji: "❌", label: "Скасовано",         hint: "Замовлення скасовано." },
  closed:    { emoji: "🔒", label: "Закрито",           hint: "Замовлення завершено." }
};

function statusInfo(code) {
  return ORDER_STATUSES[code] || { emoji: "📋", label: code || "невідомо", hint: "" };
}

/** Останні 9 цифр — так порівнює і сайт, і бот */
function phoneKey(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length > 9 ? digits.slice(-9) : digits;
}

/** Надіслати повідомлення в Telegram, не валячи виклик при помилці */
async function tg(chatId, text, extra) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return false;
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, Object.assign({
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    }, extra || {}));
    return true;
  } catch (e) {
    console.error("Telegram:", e.response && e.response.data ? JSON.stringify(e.response.data) : e.message);
    return false;
  }
}

/** Знайти Telegram-чати, привʼязані до телефону замовлення */
async function findCustomerChats(phone) {
  const key = phoneKey(phone);
  if (!key) return [];
  try {
    const snap = await db.collection("telegram_links").doc(key).get();
    if (!snap.exists) return [];
    const data = snap.data();
    // підтримуємо і один чат, і кілька
    if (Array.isArray(data.chats)) return data.chats;
    return data.chat_id ? [data.chat_id] : [];
  } catch (e) {
    console.error("findCustomerChats:", e.message);
    return [];
  }
}

/** Блок з ТТН для повідомлення */
function ttnBlock(ttn) {
  if (!ttn) return "";
  return `\n\n📮 <b>ТТН Нової Пошти:</b> <code>${ttn}</code>` +
         `\n🔗 <a href="https://novaposhta.ua/tracking/?cargo_number=${encodeURIComponent(ttn)}">Відстежити посилку</a>`;
}

// ═══════════════════════════════════════════════════════════════════════
// ЗМІНА СТАТУСУ ЗАМОВЛЕННЯ
// Сповіщає адмінів І клієнта, якщо він привʼязав Telegram.
// Окремо реагує на появу/зміну ТТН.
// ═══════════════════════════════════════════════════════════════════════

exports.notifyOrderStatusChange = functions.firestore
  .document("orders/{orderId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    const orderId = context.params.orderId;

    const statusChanged = before.status !== after.status;
    const ttnChanged = (before.ttn || "") !== (after.ttn || "") && !!after.ttn;

    if (!statusChanged && !ttnChanged) return null;

    const info = statusInfo(after.status);
    const customerName = after.name || "Клієнт";
    const customerPhone = after.phone || "невідомо";

    // ─── Адмінам ───
    const adminLines = [];
    if (statusChanged) {
      adminLines.push(`${info.emoji} <b>Статус замовлення змінено</b>`);
      adminLines.push("");
      adminLines.push(`<b>Замовлення:</b> <code>${orderId}</code>`);
      adminLines.push(`<b>Клієнт:</b> ${customerName}`);
      adminLines.push(`<b>Телефон:</b> ${customerPhone}`);
      adminLines.push(`<b>Було:</b> ${statusInfo(before.status).label}`);
      adminLines.push(`<b>Стало:</b> <b>${info.label}</b>`);
    } else {
      adminLines.push(`📮 <b>Додано ТТН до замовлення</b>`);
      adminLines.push("");
      adminLines.push(`<b>Замовлення:</b> <code>${orderId}</code>`);
      adminLines.push(`<b>Клієнт:</b> ${customerName}`);
      adminLines.push(`<b>ТТН:</b> <code>${after.ttn}</code>`);
    }
    await tg(ADMIN_CHAT_ID, adminLines.join("\n"));

    // ─── Клієнту ───
    const chats = await findCustomerChats(customerPhone);
    if (!chats.length) {
      console.log(`Замовлення ${orderId}: Telegram клієнта не привʼязаний`);
      return null;
    }

    let text;
    if (statusChanged) {
      text =
        `${info.emoji} <b>Ваше замовлення ${info.label.toLowerCase()}</b>\n\n` +
        `<b>Номер:</b> <code>${orderId}</code>\n` +
        (after.totalPrice ? `<b>Сума:</b> ${after.totalPrice} ₴\n` : "") +
        (info.hint ? `\n${info.hint}` : "") +
        ttnBlock(after.ttn);
    } else {
      text =
        `📮 <b>Ваша посилка відправлена</b>\n\n` +
        `<b>Замовлення:</b> <code>${orderId}</code>` +
        ttnBlock(after.ttn);
    }

    let sent = 0;
    for (const chatId of chats) {
      if (await tg(chatId, text)) sent++;
    }
    console.log(`Замовлення ${orderId}: сповіщено ${sent} чатів клієнта`);
    return null;
  });

/**
 * Відправляє сповіщення при новому звернені
 */
exports.notifyNewFeedback = functions.firestore
  .document("feedback/{feedbackId}")
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const feedbackId = context.params.feedbackId;

    const message = `
🛡 <b>Нове звернення!</b>

<b>ID:</b> <code>${feedbackId}</code>
<b>Від:</b> ${data.name || "Невідомо"}
<b>Email:</b> ${data.email || "не вказано"}
<b>Телефон:</b> ${data.phone || "не вказано"}
<b>Тема:</b> ${data.subject || "без теми"}
<b>Повідомлення:</b>
<pre>${data.message || "(порожньо)"}</pre>
<b>Час:</b> ${new Date().toLocaleString("uk-UA")}
    `.trim();

    try {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: ADMIN_CHAT_ID,
        text: message,
        parse_mode: "HTML"
      });
      console.log(`✅ Сповіщення про звернення ${feedbackId} відправлено`);
    } catch (error) {
      console.error("❌ Помилка при відправці Telegram:", error.message);
    }
  });

/**
 * Відправляє сповіщення при новому замовленні
 */
exports.notifyNewOrder = functions.firestore
  .document("orders/{orderId}")
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const orderId = context.params.orderId;

    let itemsText = "";
    if (data.items && Array.isArray(data.items)) {
      itemsText = data.items
        .map(item => `• ${item.name} x${item.quantity} (${item.price}₴)`)
        .join("\n");
    }

    const message = `
📋 <b>Нове замовлення!</b>

<b>ID:</b> <code>${orderId}</code>
<b>Клієнт:</b> ${data.name || "невідомо"}
<b>Телефон:</b> ${data.phone || "невідомо"}
<b>Email:</b> ${data.email || "не вказано"}
<b>Адреса:</b> ${data.address || "не вказано"}
<b>Товари:</b>
${itemsText || "(порожньо)"}
<b>Сума:</b> ${data.total || "0"}₴
<b>Статус:</b> ${data.status || "очікування"}
<b>Час:</b> ${new Date().toLocaleString("uk-UA")}
    `.trim();

    try {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: ADMIN_CHAT_ID,
        text: message,
        parse_mode: "HTML"
      });
      console.log(`✅ Сповіщення про нове замовлення ${orderId} відправлено`);
    } catch (error) {
      console.error("❌ Помилка при відправці Telegram:", error.message);
    }
  });

/**
 * Тестовий endpoint для перевірки
 */
exports.testNotification = functions.https.onRequest(async (req, res) => {
  const message = `
🧪 <b>Тест Telegram бота</b>

Бот працює і готовий відправляти сповіщення!
Час: ${new Date().toLocaleString("uk-UA")}
    `.trim();

  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: ADMIN_CHAT_ID,
      text: message,
      parse_mode: "HTML"
    });
    res.json({ success: true, message: "✅ Тестове сповіщення відправлено" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════
// РОЗСИЛКИ EMAIL / SMS  (SVAROG v3.4.0)
//
// Адмінка лише створює документ у campaigns зі статусом "queued".
// Ця функція його підхоплює і виконує відправку. Ключі Mailgun/Twilio
// живуть тільки тут, у браузер не потрапляють.
//
// Налаштування (Firebase Console → Functions → Environment variables):
//   MAILGUN_API_KEY, MAILGUN_DOMAIN, MAIL_FROM
//   TWILIO_SID, TWILIO_TOKEN, TWILIO_PHONE
// ═══════════════════════════════════════════════════════════════════════

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY || "";
const MAILGUN_DOMAIN  = process.env.MAILGUN_DOMAIN  || "";
const MAIL_FROM       = process.env.MAIL_FROM       || "SVAROG <noreply@svarog.team>";

const TWILIO_SID   = process.env.TWILIO_SID   || "";
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || "";
const TWILIO_PHONE = process.env.TWILIO_PHONE || "";

/** Підставляє {name}, {orderId} тощо у текст шаблону */
function applyVariables(text, recipient) {
  if (!text) return "";
  const values = {
    "{name}":      recipient.name  || "друже",
    "{email}":     recipient.email || "",
    "{phone}":     recipient.phone || "",
    "{orderId}":   recipient.orderId   || "",
    "{total}":     recipient.total     || "",
    "{status}":    recipient.status    || "",
    "{ttn}":       recipient.ttn       || "",
    "{promocode}": recipient.promocode || ""
  };
  return Object.keys(values).reduce(
    (acc, key) => acc.split(key).join(values[key]),
    text
  );
}

async function sendEmail(to, subject, body) {
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    throw new Error("Mailgun не налаштований (MAILGUN_API_KEY / MAILGUN_DOMAIN)");
  }
  const params = new URLSearchParams();
  params.append("from", MAIL_FROM);
  params.append("to", to);
  params.append("subject", subject || "Повідомлення від SVAROG");
  params.append("text", body);

  await axios.post(
    `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
    params,
    { auth: { username: "api", password: MAILGUN_API_KEY }, timeout: 20000 }
  );
}

async function sendSms(to, body) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_PHONE) {
    throw new Error("Twilio не налаштований (TWILIO_SID / TWILIO_TOKEN / TWILIO_PHONE)");
  }
  const params = new URLSearchParams();
  params.append("From", TWILIO_PHONE);
  params.append("To", to);
  params.append("Body", body);

  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    params,
    { auth: { username: TWILIO_SID, password: TWILIO_TOKEN }, timeout: 20000 }
  );
}

/**
 * Обробляє нову кампанію зі статусом "queued".
 * Відправляє пачками по 20, щоб не впертись у ліміти провайдерів.
 */
exports.processCampaign = functions
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .firestore.document("campaigns/{campaignId}")
  .onCreate(async (snap) => {
    const campaign = snap.data();
    if (campaign.status !== "queued") return null;

    const recipients = Array.isArray(campaign.recipients) ? campaign.recipients : [];
    if (!recipients.length) {
      await snap.ref.update({ status: "failed", error: "Список отримувачів порожній" });
      return null;
    }

    await snap.ref.update({ status: "sending", startedAt: Date.now() });

    let sent = 0;
    let failed = 0;
    const errors = [];
    const BATCH = 20;

    for (let i = 0; i < recipients.length; i += BATCH) {
      const chunk = recipients.slice(i, i + BATCH);

      await Promise.all(chunk.map(async (r) => {
        try {
          const body = applyVariables(campaign.body, r);
          if (campaign.type === "sms") {
            if (!r.phone) throw new Error("немає телефону");
            await sendSms(r.phone, body);
          } else {
            if (!r.email) throw new Error("немає email");
            await sendEmail(r.email, applyVariables(campaign.subject, r), body);
          }
          sent++;
        } catch (e) {
          failed++;
          if (errors.length < 20) {
            errors.push(`${r.email || r.phone}: ${e.message}`);
          }
        }
      }));

      await snap.ref.update({ sentCount: sent, failedCount: failed });
      // пауза між пачками — бережемо ліміти
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    await snap.ref.update({
      status: failed === recipients.length ? "failed" : "sent",
      sentCount: sent,
      failedCount: failed,
      errors: errors,
      finishedAt: Date.now()
    });

    // Звіт у Telegram
    if (TELEGRAM_BOT_TOKEN) {
      try {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: ADMIN_CHAT_ID,
          parse_mode: "HTML",
          text: `📣 <b>Розсилка завершена</b>\n\n` +
                `Шаблон: ${campaign.templateName || "—"}\n` +
                `Тип: ${campaign.type === "sms" ? "SMS" : "Email"}\n` +
                `✅ Надіслано: ${sent}\n` +
                `❌ Помилок: ${failed}`
        });
      } catch (e) { /* звіт не критичний */ }
    }

    return null;
  });

/**
 * Автоматична резервна копія раз на добу о 03:00 за Києвом.
 * Пише знімок основних колекцій у колекцію backups_data.
 */
exports.scheduledBackup = functions
  .runWith({ timeoutSeconds: 540, memory: "1GB" })
  .pubsub.schedule("0 3 * * *")
  .timeZone("Europe/Kyiv")
  .onRun(async () => {
    const collections = [
      "orders", "customers", "chats", "feedback", "merch",
      "promocodes", "volunteers", "recruiting_applications",
      "newsletter_subscribers", "templates", "config"
    ];

    const stamp = new Date().toISOString().slice(0, 10);
    let totalDocs = 0;
    const included = [];

    for (const name of collections) {
      try {
        const snapshot = await db.collection(name).get();
        if (snapshot.empty) continue;

        const docs = [];
        snapshot.forEach((d) => docs.push({ _id: d.id, ...d.data() }));

        // Firestore обмежує документ 1 МБ — ріжемо на частини по 200 записів
        for (let i = 0; i < docs.length; i += 200) {
          await db.collection("backups_data")
            .doc(`${stamp}_${name}_${i / 200}`)
            .set({
              collection: name,
              part: i / 200,
              createdAt: Date.now(),
              docs: JSON.stringify(docs.slice(i, i + 200))
            });
        }

        totalDocs += docs.length;
        included.push(name);
      } catch (e) {
        console.error(`Бекап "${name}" не вдався:`, e.message);
      }
    }

    await db.collection("backups").add({
      filename: `auto-${stamp}`,
      documents: totalDocs,
      collections: included,
      type: "scheduled",
      createdAt: Date.now(),
      createdBy: "system"
    });

    // Прибираємо копії, старші за 30 днів
    const cutoff = Date.now() - 30 * 86400000;
    const old = await db.collection("backups_data")
      .where("createdAt", "<", cutoff).limit(400).get();

    if (!old.empty) {
      const batch = db.batch();
      old.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    console.log(`Резервна копія готова: ${totalDocs} документів`);
    return null;
  });


// ═══════════════════════════════════════════════════════════════════════
// ПЕРЕВІРКА ПОСТІЙНОГО КЛІЄНТА  (для shop.html)
//
// Раніше сайт робив це напряму:
//   db.collection("orders").where("phone","==",phone).limit(1).get()
//
// Проблема: щоб такий запит працював, довелось би відкрити колекцію
// orders на публічне читання. А правила Firestore НЕ вміють перевіряти
// фільтр запиту — тобто будь-хто міг би вивантажити всі замовлення
// разом з іменами, телефонами й адресами.
//
// Ця функція повертає лише true/false і не віддає жодних даних.
// ═══════════════════════════════════════════════════════════════════════

exports.checkRepeatCustomer = functions.https.onCall(async (data) => {
  const rawPhone = (data && data.phone) ? String(data.phone) : "";
  const phone = rawPhone.replace(/[\s\-()]/g, "");

  // Мінімальна валідація — щоб функцію не використовували для перебору
  if (phone.length < 9 || phone.length > 15 || !/^\+?\d+$/.test(phone)) {
    return { isRepeat: false };
  }

  try {
    const snap = await db.collection("orders")
      .where("phone", "==", rawPhone)
      .limit(1)
      .get();

    // Повертаємо ТІЛЬКИ факт наявності
    return { isRepeat: !snap.empty };
  } catch (e) {
    console.error("checkRepeatCustomer:", e.message);
    return { isRepeat: false };
  }
});


// ═══════════════════════════════════════════════════════════════════════
// ПОШУК ЗАМОВЛЕННЯ — для САЙТУ і для БОТА
//
// Раніше shop.html робив db.collection('orders').get() — тобто качав
// УСІ замовлення в браузер і фільтрував на клієнті. Це означало:
//   • повний доступ будь-кого до імен, телефонів і адрес усіх клієнтів
//   • оплата читання кожного документа при кожній перевірці
//
// Ця функція повертає лише безпечні поля: статус, суму, ТТН, дату.
// Імені, телефону й адреси в відповіді немає взагалі.
// ═══════════════════════════════════════════════════════════════════════

/** Приводимо документ до безпечного вигляду */
function publicOrderView(doc) {
  const d = doc.data();
  const info = statusInfo(d.status);
  let created = null;
  const ts = d.timestamp || d.createdAt || d.date;
  if (ts) {
    if (typeof ts.toMillis === "function") created = ts.toMillis();
    else if (typeof ts === "number") created = ts < 1e11 ? ts * 1000 : ts;
    else if (ts.seconds) created = ts.seconds * 1000;
  }
  return {
    id: doc.id,
    status: d.status || "new",
    statusLabel: info.label,
    statusEmoji: info.emoji,
    statusHint: info.hint,
    totalPrice: d.totalPrice || d.total || 0,
    ttn: d.ttn || null,
    ttnUrl: d.ttn ? `https://novaposhta.ua/tracking/?cargo_number=${encodeURIComponent(d.ttn)}` : null,
    createdAt: created
  };
}

async function findOrders(query, mode) {
  const q = String(query || "").trim();
  if (!q) return [];

  // Пошук за номером замовлення
  if (mode === "number") {
    const doc = await db.collection("orders").doc(q).get();
    if (!doc.exists || doc.data().deletedAt) return [];
    return [publicOrderView(doc)];
  }

  // Пошук за телефоном — порівнюємо останні 9 цифр
  const key = phoneKey(q);
  if (key.length < 9) return [];

  const snap = await db.collection("orders").limit(3000).get();
  const matches = [];
  snap.forEach((doc) => {
    const d = doc.data();
    if (d.deletedAt) return;
    if (phoneKey(d.phone) === key) matches.push(publicOrderView(doc));
  });

  matches.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return matches.slice(0, 20);
}

/** Виклик із сайту (firebase.functions().httpsCallable) */
exports.trackOrder = functions.https.onCall(async (data) => {
  const mode = data && data.mode === "number" ? "number" : "phone";
  try {
    const orders = await findOrders(data && data.query, mode);
    return { ok: true, orders: orders };
  } catch (e) {
    console.error("trackOrder:", e.message);
    return { ok: false, orders: [], error: "Не вдалося виконати пошук" };
  }
});
