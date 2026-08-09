# Reusable Playbook — Kingdom Sponsor (Carpso Solutions)

This document captures the **how we did it** notes for components that are
reusable in other apps: the intruder-detection system, the Lipila payment
gateway integration, the SMS/sender-ID setup, and the Android release build
process. It is a backup reference, not app documentation.

---

## 1. Intruder detection & alerting

**Goal:** detect brute-force/abusive login attempts and alert the operator
through every channel (SMS, FCM push, email, Telegram).

### How it works
1. **Recording failures.** `POST /api/auth/verify-otp` inserts a row into
   `failed_logins (phone, ip, user_agent, reason, notified)` on every bad OTP:
   - `reason` values: `otp_expired`, `too_many_attempts`, `wrong_code`.
   - IP comes from `CF-Connecting-IP` / `X-Forwarded-For`.
   - A successful login clears `failed_logins` for that phone.
2. **Per-phone OTP throttle.** `request-otp` allows at most 5 codes/hour/phone
   (`otps` table count in the last 3600s) → HTTP 429.
3. **Per-IP OTP throttle** (`otp_attempts` table, migration_v30): at most 10
   OTP requests per IP per 10 minutes → HTTP 429. This is the SMS-bomb shield.
4. **Scheduled scan.** Cron `*/15 * * * *` runs `runIntruderAlerts`:
   - reads `intruder_alert_telegram` from `admin_settings` (toggles the whole
     system; `"1"` = on);
   - selects `failed_logins WHERE notified = 0` (limit 20);
   - sends one alert bundling them, then marks `notified = 1`.
5. **Alert channels** (`notifyIntruderAlert`):
   - **Telegram** — `POST https://api.telegram.org/bot<TOKEN>/sendMessage` to
     `chat_id` (reads `telegram_bot_token` + `telegram_chat_id` from
     `admin_settings`).
   - **SMS + FCM push** to superadmins via `pushAndSmsAdmins`.
   - **Email** via MailChannels (`send.mailchannels.net/api/v1/send`).

### Config (no code changes needed)
Store these in `admin_settings`:
- `intruder_alert_telegram` = `1` (master toggle)
- `telegram_bot_token` = `<bot token>`
- `telegram_chat_id` = `<chat id>`

Getting the chat id: create a bot via @BotFather, message it once, then call
`https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id`.

### Wiring
```
app.post /api/auth/verify-otp     -> INSERT failed_logins (reasons)
app.post /api/auth/request-otp    -> ipOtpAllowed() + recordOtpAttempt()
cron */15 * * * *                 -> runIntruderAlerts() -> notifyIntruderAlert()
```

---

## 2. Lipila payment gateway (MoMo + cards, production)

**Goal:** collect mobile-money and card donations, and disburse payouts to
hosts, with correct fee math and idempotency.

### Base
- Production base: `https://blz.lipila.io/api/v1` (sandbox: `api.lipila.dev`),
  selected by `LIPILA_ENV`.
- Auth: header `x-api-key: <LIPILA_API_KEY>`.
- Narration must be sanitized: only letters, numbers and spaces
  (`sanitizeNarration`) — otherwise Lipila returns 400.

### Collection (MoMo)
`POST /collections/mobile-money` with `{referenceId, amount (string ZMW),
accountNumber (E.164 no +), narration, callbackUrl}`. Returns an identifier;
the user then approves the prompt on their phone. Webhook confirms later.

### Card
`POST /collections/card` → returns `cardRedirectionUrl` (hosted checkout).
Card numbers never touch the worker.

### Disbursement (payouts)
`POST /disbursements/mobile-money` → moves wallet money to a host's MoMo.
Confirmed by webhook or the `runWithdrawalStatusChecks` cron
(`/disbursements/check-status?referenceId=`).

### Wallet balance
`GET /merchants/balance` → used to guard fee sweeps and payouts.

### Webhook security
`/api/webhooks/lipila`:
- Auth by HMAC signature (`verifyLipilaSignature`) with a 5-minute replay
  window, OR the legacy `?secret=` query param.
- Confirms `confirmContribution` / `confirmWithdrawal` / `confirmFeeSweep` /
  `confirmAirtimePayment` — each flips a `pending → success` row **only when
  still pending** (idempotency; a replay or cron race cannot double-process).

### Fee math (integer cents — never floats)
- Donation fees: platform = `max(minFee, 1% )` (K3 min / K0.24 add-on) + Lipila
  collection fee (2.5%). Donor pays fees **on top** of the gift amount.
- Payout fees: Lipila disbursement fee (1.5%) + platform payout fee.
- `runFeeSweep` moves earned platform fees to `SETTLEMENT_PHONE` only above K50
  and only when the wallet covers it; `pendingDonationFees` counts
  `success + pending` sweeps so a missed webhook can't double-sweep.

### Money-safety rules (learned the hard way)
- Always use integer cents (`Math.round` once at boundaries).
- Make every state transition conditional: `UPDATE ... WHERE status='pending'`
  and check `changes === 0` to bail.
- Atomic insert guard for payouts: `INSERT ... SELECT ... WHERE NOT EXISTS
  (pending/processing for this campaign)` — prevents double payout under
  concurrent cron/webhook/admin triggers.
- Log every collection/disbursement attempt + result to `lipila_logs`.

---

## 3. SMS / sender ID (Africa's Talking)

- **Sender ID:** `KSPONSOR` is approved. All SMS (OTP + notifications) send
  `from=KSPONSOR`. Set `AT_FROM=KSPONSOR` in wrangler vars; the code also
  defaults to `KSPONSOR` if `AT_FROM` is empty, and falls back to AT's default
  sender if Lipila/AT returns a 400 `Invalid senderId`.
- **Credentials:** `AT_API_KEY` (secret) + `AT_USERNAME` (`ChurchOnApp`).
- **OTP template:** `KSPONSOR: Your Kingdom Sponsor verification code is <code>.
  It expires in 5 minutes. Do not share it.`
- **E.164:** all numbers normalized to `+260...`.
- All SMS templates live in `src/messages.ts` (donation, payout, pledge,
  promotion, delete/edit requests, support, milestones, campaign end).

---

## 3b. Africa's Talking airtime + instant status callback

- **Send:** `POST https://api.africastalking.com/version1/airtime/send` with
  `Apikey` header + form body `{username, recipients:[{phoneNumber, amount:"ZMW X"}]}`.
  The response includes a per-recipient `requestId` (only when `status:"Sent"`).
- **Store the requestId** on the order (`airtime_orders.at_request_id`,
  migration_v33) when the send succeeds — the status callback matches on it.
- **Register the Status callback** in the AT dashboard:
  `Airtime → Callback URLs → Status` =
  `https://<worker>/api/webhooks/at-airtime/status`.
  AT POSTs `{phoneNumber, description, status: "Success"|"Failed", requestId,
  discount, value}` the instant the MNO reports delivery.
- **Handler:** reads the raw body (text → JSON with form fallback), matches the
  order by `at_request_id`, and only transitions `sent|paid → completed`
  (Success) or `sent → failed` (Failed) — idempotent. Then pushes + SMSes the
  user with branded templates (`airtimeDeliveredSms` / `airtimeFailedSms`).
- **Order states:** `pending → paid → sent → completed | failed`.
  `runAirtimeFulfillment` (daily cron) retries `paid` orders, resends `sent`
  orders with no callback after 30 min, and retries `failed` orders (attempts<3).
- **Zambia limits:** K5–K1,000 per airtime transaction; AT retries failed
  deliveries itself (default 8h window) unless you set `maxNumRetry`.

---

## 4. Android release build (always clean)

```
flutter clean
flutter pub get
flutter build apk --release        # -> build/app/outputs/flutter-apk/app-release.apk
flutter build appbundle --release  # -> build/app/outputs/bundle/release/app-release.aab
```

Rules:
- **Bump versionCode** in `android/app/build.gradle.kts` to an unused number
  before a store build (Google Play rejects duplicates). `versionName` comes
  from `pubspec.yaml`.
- **Always `flutter clean` first** — stale incremental artifacts or the
  previously-renamed "Kingdom Sponsor.apk" must never ship.
- Verify: `aapt dump badging build/app/outputs/flutter-apk/app-release.apk | findstr versionCode`.
- Upload the **AAB** to Play Console.
- Add `.env` (production `API_URL`) as an asset in `pubspec.yaml`.

### Secrets (never committed)
`wrangler secret put`: `AT_API_KEY`, `FIREBASE_CLIENT_EMAIL`,
`FIREBASE_PRIVATE_KEY`, `JWT_SECRET`, `LIPILA_API_KEY`,
`LIPILA_WEBHOOK_SECRET`, `SETTLEMENT_PHONE`, `SUPERADMIN_PHONES`, `TWILIO_AUTH`,
`TWILIO_SID`.

---

## 5. Admin-staff / restore / audit (v1 trust toolkit)

- `admin_assistants` — superadmin grants scoped access
  (`campaigns/donations/tickets/users/settings/finance/restore`); `requireStaff(...)`
  gates endpoints; superadmins always pass.
- Soft deletes: campaigns → `status='deleted'`, restorable via
  `POST /api/admin/campaigns/:id/restore`.
- Host **edit requests**: hosts cannot edit campaigns directly (fraud
  protection). They submit proposed changes (`campaign_edit_requests`); a
  superadmin approves/rejects from the admin dashboard.
- `admin_actions` audit log records every delete/restore/ban/reward/verify.
