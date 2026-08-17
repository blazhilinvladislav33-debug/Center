# 🛡️ SVAROG Command Center v2.0.0

**Electron-додаток для управління SVAROG TEAM з інтеграцією Telegram, автооновленнями та Cloud Functions.**

---

## 📋 Що змінилось у версії 2.0.0

- ✅ **Telegram Bot Integration** — автоматичні сповіщення про замовлення, звернення, важливу інформацію
- ✅ **Cloud Functions** — webhook для Firestore triggers
- ✅ **Auto-versioning** — версія оновлюється автоматично при пушах
- ✅ **Settings Panel** — управління Telegram налаштуваннями прямо в адмінці
- ✅ **Improved UI** — новий дизайн вкладок і меню

---

## 🚀 Швидкий старт

### 1️⃣ **Розгортання Electron App (Windows/Mac)**

```bash
# Установка залежностей
npm install

# Запуск в dev-режимі
npm start

# Збірка для Windows
npm run dist:win

# Збірка для Mac
npm run dist:mac
```

### 2️⃣ **Розгортання Cloud Functions (Firebase)**

```bash
cd functions
npm install
firebase login
firebase deploy --only functions
```

**Встав env vars у Firebase Console:**
```
TELEGRAM_BOT_TOKEN = ВАШ_ТОКЕН_ВІД_BOTFATHER
ADMIN_CHAT_ID = -1004110475608
```

### 3️⃣ **Запуск Telegram Bot (Render)**

**Сервіс:** `botsvarog-1`

**Build Command:**
```bash
pip install -r requirements.txt
```

**Start Command:**
```bash
python bot.py
```

**Environment Variables на Render:**
- `BOT_TOKEN` = `ВАШ_ТОКЕН_ВІД_BOTFATHER`
- `ADMIN_CHAT_ID` = `-1004110475608`
- `WEBHOOK_SECRET` = `svarog-secret-2026`

---

## 📂 Структура проекту

```
svarog-center/
├── admin.html                 # Головне вікно адмінки
├── auth.html                  # Форма логіну
├── splash.html                # Splash screen
├── main.js                    # Electron main process
├── bot.py                     # Telegram bot (для Render)
├── requirements.txt           # Python залежності
├── package.json               # Node.js залежності
├── .env.example              # Шаблон env vars
│
├── functions/
│   ├── index.js              # Cloud Functions (Telegram webhooks)
│   └── package.json          # Functions залежності
│
├── .github/
│   └── workflows/
│       └── auto-version.yml  # GitHub Actions для версіонування
│
├── build/                     # Іконки для інсталяції
├── installer-assets/          # Елементи інсталяції Windows
│
├── TELEGRAM_SETUP.md          # Докладна інструкція Telegram
├── FIREBASE_CONTENT_MAP.md    # Карта Firestore колекцій
└── README.md                  # Цей файл
```

---

## 🤖 Telegram Integration

### Дані бота:
- **Bot:** @SvarogBot
- **Token:** `ВАШ_ТОКЕН_ВІД_BOTFATHER`
- **Admin Chat:** `-1004110475608`

### Що робить:
1. **Прямий чат користувачів** → автоматично потрапляє в адмін-групу
2. **Типи повідомлень:**
   - 🛡️ Звернення (запитання, проблеми)
   - 📢 Важлива інформація (новини, оголошення)
3. **Адмін отримує сповіщення** про:
   - ✅ Нові замовлення
   - 📦 Зміни статусу замовлення
   - 🛡️ Нові звернення
   - 💬 Прямі повідомлення від користувачів

---

## ⚙️ Налаштування в адмінці

Нова вкладка **"⚙️ Налаштування"** дозволяє:
- Включати/вимикати Telegram
- Менювати Bot Token (якщо потрібно)
- Менювати Admin Chat ID
- Тестувати сповіщення (кнопка "🧪 Test")

Все зберігається у `config/telegram` в Firestore.

---

## 📊 Cloud Functions

### Автоматичні триггери:

#### 1. **Нове замовлення** (`notifyNewOrder`)
```
Trigger: orders collection (CREATE)
Відправляє: Детальну інформацію про замовлення
```

#### 2. **Зміна статусу** (`notifyOrderStatusChange`)
```
Trigger: orders collection (UPDATE)
Відправляє: Старий статус → Новий статус з емодзі
```

#### 3. **Нове звернення** (`notifyNewFeedback`)
```
Trigger: feedback collection (CREATE)
Відправляє: Ім'я, email, телефон, тему, текст
```

#### 4. **Тест** (`testNotification`)
```
HTTP функція для перевірки роботи бота
```

---

## 🔄 Автооновлення версії

**GitHub Actions workflow** (`auto-version.yml`) автоматично:
1. Перевіряє зміни у ключових файлах
2. Оновлює версію в `package.json` (patch версія)
3. Створює commit з новою версією
4. Видає Release на GitHub

**Триггер:** Пуш в main/master з змінами в:
- `admin.html`
- `main.js`
- `bot.py`
- `functions/**`
- `package.json`

---

## 🔐 Безпека

- ✅ **Bot Token** не зберігається в репо (лише env vars)
- ✅ **Webhook Secret** обов'язковий для Telegram
- ✅ **Firestore Rules** обмежують доступ до даних
- ✅ **Admin Check** на кожну операцію
- ✅ **Logging** всіх дій адмінів

---

## 📝 Файлові налаштування

### `.env` файл
```bash
cp .env.example .env
# Заповни свої дані
```

### Firestore `config/telegram`
```json
{
  "enabled": true,
  "botToken": "ВАШ_ТОКЕН_ВІД_BOTFATHER",
  "adminChatId": "-1004110475608",
  "infoChannelId": ""
}
```

---

## 🐛 Debugging

### Electron App
```bash
npm start  # Запуск в dev-режимі з логами
```

### Cloud Functions
```bash
firebase functions:log  # Дивись логи функцій
```

### Telegram Bot
```bash
# Локально
python bot.py

# На Render - дивись "Logs" в dashboard
```

---

## 📞 Контакти

**Адмін-група Telegram:** `-1004110475608`

Вся комунікація з користувачами йде туди.

---

## 📜 Лiцензія

ISC © 2026 SVAROG TEAM

---

## 🚀 Наступні кроки

- [ ] Додати Nova Poshta інтеграцію
- [ ] Додати SMS сповіщення (Twilio)
- [ ] Додати статистику/аналітику
- [ ] Додати мобільну версію
- [ ] Додати експорт звітів (Excel/PDF)

