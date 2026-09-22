# ربات تلگرامی شبیه‌ساز Infinity Grid

یک ربات تلگرامی **Serverless** برای Vercel است که فهرست توکن‌ها و گریدهای شبیه‌سازی را مدیریت می‌کند. اطلاعات پایدار در **Upstash Redis** ذخیره می‌شود؛ بنابراین به VPS یا سرور دائمی نیاز ندارد.

> **مهم:** این پروژه فقط Paper Trading / شبیه‌سازی است. هیچ کلید API صرافی نمی‌گیرد، هیچ سفارش واقعی ثبت نمی‌کند و نباید مبنای تصمیم سرمایه‌گذاری باشد.

## امکانات

- منوی فارسی تلگرام با Inline Button
- افزودن، مشاهده، ویرایش و حذف توکن‌های Spot با جفت `USDT`
- اعتبارسنجی توکن و قیمت از Binance Spot عمومی (با fallback به Binance Vision)
- ساخت گرید با این ورودی‌ها:
  - نام توکن
  - `Deposit` برحسب USDT
  - `Lower price`
  - `Total grid number` بین ۲ تا ۵۰۰
  - `Grid interval` درصدی بین ۰.۱ تا ۵۰
- شبیه‌سازی گرید صعودیِ توسعه‌پذیر (Infinity Grid)
- نمایش قیمت، ارزش پورتفو، سود/زیان کل، سود تحقق‌یافته، سود/زیان باز، موجودی‌ها، کارمزد شبیه‌سازی، تعداد معامله و ۵ رویداد آخر
- توقف، شروع مجدد، به‌روزرسانی و حذف گرید
- محافظت کامل تک‌ادمین با `ADMIN_TELEGRAM_ID`
- Cron serverless برای به‌روزرسانی دوره‌ای گریدهای فعال
- بدون هیچ وابستگی npm در زمان اجرا؛ فقط Node.js 20+ و APIهای HTTP

## منطق دقیق شبیه‌سازی

این بخش را پیش از استفاده بخوانید تا رفتار «Infinity Grid» شفاف باشد:

1. برای هر گرید، مقدار هر tranche برابر `deposit / totalGridNumber` است.
2. هنگام ساخت، نیمی از ظرفیت گرید به‌صورت فرضی به دارایی پایه در قیمت فعلی تبدیل می‌شود و برای پله‌های فروش بالاتر توزیع می‌گردد؛ مابقی USDT آزاد می‌ماند. کارمزد اولیه هم در PnL منظور می‌شود.
3. هر بار که قیمت در حرکت نزولی از یک پله عبور کند، ربات یک tranche فرضی می‌خرد؛ آن lot فقط در پلهٔ بعدی بالاتر هدف فروش دارد.
4. هر بار که قیمت در حرکت صعودی از پلهٔ هدف عبور کند، lot متناظر فروخته و سود/زیان تحقق‌یافته محاسبه می‌شود.
5. گرید سقف عملیاتی ندارد: پله‌ها با فرمول `lowerPrice × (1 + interval)^n` به سمت بالا توسعه می‌یابند. `totalGridNumber` اندازهٔ tranche و حداکثر lotهای باز را کنترل می‌کند، نه سقف دائمی قیمت.
6. `Lower price` کف سخت است. زیر آن خرید جدیدی ثبت نمی‌شود و با بازگشت قیمت، موتور دوباره از همان محدوده رصد را آغاز می‌کند.
7. PnL کل برابر است با `USDT آزاد + ارزش لحظه‌ای توکن − Deposit اولیه`. PnL تحقق‌یافته و PnL باز جداگانه نمایش داده می‌شوند.
8. کارمزد پیش‌فرض `0.1%` برای هر خرید و فروش است و از متغیر محیطی قابل تغییر است.

چون قیمت بین دو اجرای Cron ممکن است چندین پله بپرد، این یک **شبیه‌ساز تقریبی بر مبنای قیمت‌های مشاهده‌شده** است، نه موتور matching یک صرافی. اگر جهش بسیار بزرگ‌تر از ۱٬۰۰۰ پله رخ دهد، در جزئیات گرید هشدار «پله‌های پردازش‌نشده» ثبت می‌شود.

## معماری

```text
Telegram update / button
          │ HTTPS webhook
          ▼
Vercel Function: /api/webhook ───► Upstash Redis (tokens, grids, sessions)
          │
          └──────────────────────► Binance public Spot API (USDT price)

Vercel Cron: /api/cron ──────────► sync all active grids
```

هیچ پردازش همیشه‌روشن یا سرور خریداری‌شده‌ای وجود ندارد. Function فقط هنگام webhook، بازکردن منو یا Cron اجرا می‌شود.

---

## راه‌اندازی رایگان

### 1) ساخت Bot در Telegram

1. در تلگرام به [@BotFather](https://t.me/BotFather) بروید.
2. دستور `/newbot` را بزنید و نام و username ربات را بسازید.
3. توکن BotFather را فقط برای متغیر `TELEGRAM_BOT_TOKEN` نگه دارید؛ آن را در Git یا پیام عمومی قرار ندهید.
4. Telegram numeric user ID خود را با یک ربات اطلاعات کاربر مانند `@userinfobot` دریافت کنید. این مقدار را برای `ADMIN_TELEGRAM_ID` لازم دارید.

### 2) ساخت دیتابیس رایگان Upstash Redis

1. در [Upstash](https://upstash.com/) یک حساب و یک **Redis database** بسازید.
2. از صفحهٔ دیتابیس، این دو مقدار را کپی کنید:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. داده‌های توکن، گرید و مراحل گفت‌وگوی ربات در همین دیتابیس ذخیره می‌شوند.

### 3) آماده‌سازی کد

```bash
git clone <YOUR_REPOSITORY_URL>
cd telegram-infinity-grid-bot
cp .env.example .env.local
```

مقادیر نمونه را با مقادیر واقعی جایگزین کنید. برای ساخت دو secret می‌توانید استفاده کنید:

```bash
openssl rand -hex 32
```

- `TELEGRAM_WEBHOOK_SECRET`: حداقل ۳۲ کاراکتر تصادفی
- `CRON_SECRET`: یک مقدار تصادفی متفاوت

### 4) تست منطق محلی

نیازی به نصب پکیج نیست. فقط Node.js 20 یا جدیدتر لازم است:

```bash
npm test
npm run check
```

> اجرای webhook واقعی در محیط local نیازمند tunnel HTTPS است. ساده‌ترین روش، deploy مستقیم روی Vercel است.

### 5) Deploy روی Vercel

1. مخزن را در GitHub/GitLab/Bitbucket push کنید یا از Vercel CLI استفاده کنید.
2. در [Vercel](https://vercel.com/new) مخزن را import کنید.
3. در **Project → Settings → Environment Variables** این مقادیر را اضافه کنید:

| Variable | مقدار |
|---|---|
| `TELEGRAM_BOT_TOKEN` | توکن BotFather |
| `ADMIN_TELEGRAM_ID` | شناسهٔ عددی تلگرام ادمین |
| `TELEGRAM_WEBHOOK_SECRET` | secret تصادفی اول |
| `UPSTASH_REDIS_REST_URL` | REST URL از Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | REST Token از Upstash |
| `CRON_SECRET` | secret تصادفی دوم |
| `DEFAULT_FEE_RATE_PCT` | اختیاری؛ پیش‌فرض `0.1` |

4. Environment را حداقل برای **Production** انتخاب و Deploy کنید.
5. URL پروژه را یادداشت کنید؛ مثال:

```text
https://my-grid-bot.vercel.app
```

با CLI نیز می‌توانید deploy کنید:

```bash
npx vercel --prod
```

### 6) تنظیم Webhook تلگرام

پس از deploy موفق، این درخواست را در ترمینال اجرا کنید. مقدارها را در همان دستگاه جایگزین کنید و توکن را جایی publish نکنید:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<YOUR-VERCEL-DOMAIN>/api/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"message\",\"callback_query\"]"
```

خروجی باید `"ok":true` باشد. برای بررسی وضعیت:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

حالا به ربات پیام `/start` بفرستید.

---

## Cron و دقت شبیه‌سازی

فایل `vercel.json` به‌طور پیش‌فرض هر ساعت endpoint زیر را فراخوانی می‌کند:

```text
/api/cron   →   0 * * * *
```

هنگامی که `CRON_SECRET` در Vercel تنظیم باشد، Vercel درخواست Cron را با هدر `Authorization: Bearer <CRON_SECRET>` ارسال می‌کند و endpoint عمومی قابل سوءاستفاده نیست.

دقت و کمینهٔ زمان‌بندی Vercel Cron به پلن و سیاست‌های روز Vercel بستگی دارد. اگر پلن رایگان شما اجرای ساعتی را قبول نکرد:

- زمان‌بندی مجاز پلن خود را در `vercel.json` انتخاب کنید و دوباره deploy کنید، **یا**
- از یک زمان‌بند HTTP رایگان خارجی استفاده کنید که بتواند `GET https://<domain>/api/cron` را با هدر زیر بفرستد:

```text
Authorization: Bearer <CRON_SECRET>
```

هرچه اجرای Cron کوتاه‌تر باشد، شبیه‌سازی به عبورهای واقعی پله‌ها نزدیک‌تر است. همچنین هر بار که منوی گریدها یا دکمهٔ refresh را می‌زنید، قیمت‌ها و گریدهای فعال تازه می‌شوند.

## نحوهٔ استفاده در تلگرام

- `/start` یا `/menu`: منوی اصلی
- `/cancel`: لغو مرحلهٔ در حال انجام
- **فهرست توکن‌ها**: افزودن نمادهایی مثل `BTC`، `ETH` یا `PEPE`؛ امکان ویرایش/حذف تا قبل از ایجاد گرید وابسته
- **فهرست گریدها و سود**: نمایش خلاصهٔ تمام گریدها، ساخت گرید جدید، مشاهدهٔ جزئیات، refresh، pause/resume و حذف

برای حفظ تاریخچه، توکنی که گرید وابسته دارد قابل تغییر نام یا حذف نیست؛ ابتدا گریدهای وابسته را حذف کنید.

## نکات امنیتی

- `.env.local` و `.env` در `.gitignore` هستند؛ هرگز secretهای واقعی را commit نکنید.
- Webhook با `TELEGRAM_WEBHOOK_SECRET` اعتبارسنجی می‌شود.
- تمام پیام‌ها و دکمه‌ها قبل از اجرا با `ADMIN_TELEGRAM_ID` کنترل می‌شوند؛ کاربران دیگر نادیده گرفته می‌شوند.
- endpoint Cron بدون `Authorization: Bearer <CRON_SECRET>` پاسخ 401 می‌دهد.
- این پروژه هیچ کلید API صرافی، seed phrase یا private key نیاز ندارد و **نباید** چنین اطلاعاتی به آن اضافه کنید.

## ساختار پروژه

```text
api/
  webhook.js              # Telegram webhook و منوها
  cron.js                 # همگام‌سازی زمان‌بندی‌شده
  _lib/
    simulator.js          # موتور Paper Trading و PnL
    market.js              # Binance public price API
    repository.js          # مدل دادهٔ Upstash Redis
    grid-service.js        # همگام‌سازی گریدها
    telegram.js            # Telegram Bot API
    ui.js                  # متن‌ها و دکمه‌های فارسی
    config.js, redis.js
test/simulator.test.js    # تست‌های منطق گرید
vercel.json               # Vercel Function/Cron settings
```

## محدودیت‌های آگاهانهٔ نسخهٔ اول

- فقط جفت‌های `USDT` در Spot Binance پشتیبانی می‌شوند.
- این پروژه شبیه‌سازی می‌کند؛ slippage، نقدشوندگی، حداقل اندازه سفارش و candle/tick تاریخی صرافی را مدل نمی‌کند.
- دریافت قیمت عمومی Binance ممکن است در برخی مناطق یا هنگام اختلال Binance ناموفق شود؛ آخرین دادهٔ ذخیره‌شده در منو نشان داده می‌شود.
- برای چندکاربره‌کردن، باید namespace داده‌ها با Telegram user ID جدا شود و لایهٔ پرداخت/مجوز طراحی شود؛ این نسخه عمداً تک‌ادمین است.
