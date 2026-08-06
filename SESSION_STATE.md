# Session State — Kingdom Sponsor

**Last Updated**: 2026-08-07
**Version**: 0.4.1 (versionCode 49)
**Flutter Commit**: `a97a652`
**Backend Commit**: `fcaa5e3`

---

## Project Structure

```
D:\Explorer\MAYUNDO\KEY PROJECTS\
├── chisomo_flutter\     # Flutter app (Dart)
│   ├── lib\
│   │   ├── core\        # Theme, router, API client, widgets
│   │   └── features\    # Screens by feature
│   ├── android\         # Android config
│   ├── test\            # Tests
│   └── pubspec.yaml     # Dependencies
└── chisomo\             # Cloudflare Worker API (TypeScript)
    ├── src\             # Source code
    ├── sql\             # D1 migrations
    └── wrangler.toml    # Worker config
```

---

## Environment

- **OS**: Windows 11, PowerShell 5.1
- **Flutter**: 3.35.1 / Dart 3.9.0
- **Android SDK**: `C:\Users\User\AppData\Local\Android\Sdk` (36.1.0)
- **Production API**: `https://kingdom-sponsor-api.godfreymoseskalambo.workers.dev`
- **D1 Database**: `kingdom-sponsor-db` (id: `01c99f57-3f1b-4212-85db-261f86f90a24`)
- **Firebase**: `kingdom-sponsor` project (FCM push configured)
- **Lipila**: production environment

---

## Build Commands

```bash
# Flutter
cd D:\Explorer\MAYUNDO\KEY PROJECTS\chisomo_flutter
flutter clean
flutter pub get
flutter build apk --release    # -> build/app/outputs/flutter-apk/app-release.apk
flutter build appbundle --release  # -> build/app/outputs/bundle/release/app-release.aab

# Backend
cd D:\Explorer\MAYUNDO\KEY PROJECTS\chisomo
npx tsc --noEmit              # Type check
npx wrangler deploy           # Deploy to production
npx wrangler tail             # View live logs

# D1 Migrations
npx wrangler d1 execute kingdom-sponsor-db --file=./sql/migration_vNN.sql --remote

# Verify APK version
aapt dump badging build/app/outputs/flutter-apk/app-release.apk | findstr versionCode
```

---

## Secrets & Configuration

### Backend Secrets (Cloudflare Workers)
Set via `npx wrangler secret put NAME`:
- `JWT_SECRET`
- `AT_API_KEY` / `AT_USERNAME` (Africa's Talking)
- `LIPILA_API_KEY` / `LIPILA_WEBHOOK_SECRET`
- `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` (FCM)
- `SUPERADMIN_PHONES` (+260968551110)
- `SETTLEMENT_PHONE` (+260976847775)

### Flutter Config
- `.env` file: `API_URL=https://kingdom-sponsor-api.godfreymoseskalambo.workers.dev`
- `google-services.json`: Firebase config (project: kingdom-sponsor, package: com.kingdomsponsor.app)

---

## Features Implemented

### Core Features
- [x] User auth (OTP via Africa's Talking SMS)
- [x] Campaign CRUD (create, read, edit)
- [x] Donations via Lipila mobile money
- [x] Auto-disbursement (daily cron at 02:00 UTC)
- [x] Push notifications (Firebase FCM)
- [x] Campaign carousel (auto-slide with pause)
- [x] Support tickets with admin replies
- [x] Linked accounts (family, friend, couple, team)
- [x] PDF receipts
- [x] Short links for sharing

### Premium Features
- [x] Verified Host Badge (3 tiers: Basic K50, Pro K150, Annual K1,200)
- [x] Airtime purchase system (admin-controlled enable/disable)
- [x] USSD service (backend ready, needs MNO approval)
- [x] Campaign image editing (admin endpoint)

### Admin Features
- [x] Dashboard with stats
- [x] User management (ban/unban)
- [x] Campaign management (delete, edit image)
- [x] Promotion management
- [x] Ticket management with replies
- [x] Manual disbursement trigger
- [x] Push notification status + test
- [x] Airtime config (enable/disable, pricing)
- [x] Badge config (enable/disable, tier pricing)
- [x] SMS status message editor

---

## Database Schema (Key Tables)

- `users` — user accounts (phone, username, is_host, notifications_enabled)
- `campaigns` — fundraising campaigns
- `contributions` — donations
- `withdrawals` — host payouts
- `fee_sweeps` — platform fee settlements
- `device_tokens` — FCM push tokens
- `user_links` — linked accounts
- `support_tickets` — support messages
- `host_badges` — verified host subscriptions
- `airtime_orders` — airtime purchase orders
- `admin_settings` — admin config key-value store

---

## Migrations Applied

| Version | Description |
|---------|-------------|
| v18 | short_links.clicks |
| v19 | failed_logins.notified |
| v20 | short_links.clicks |
| v21 | users.notifications_enabled, users.airtime_credits_cents |
| v22 | host_badges, airtime_orders tables + admin_settings |

---

## Fee Model

- **Collection**: Platform max(K3, 1%) + ZMW 0.24 + Lipila 2.5% (donor pays on top)
- **Disbursement**: Lipila 1.5% + Platform max(K3, 1%) (deducted from payout)

---

## Cron Schedule

- `*/15 * * * *` — Intruder alert scan
- `0 2 * * *` — Daily: fee sweep, auto-disburse, pledge reminders, promotion expiry, ticket auto-close

---

## Known Issues / TODO

### Active
- [ ] USSD needs Africa Talking dashboard setup + MNO approval (2-4 weeks)
- [ ] Airtime needs funding before enabling
- [ ] Badge system needs Lipila payment integration for production

### Future
- [ ] Orange splash screen branding
- [ ] Phone number auto-format input
- [ ] Multi-device sign-out handling
- [ ] Real-time disbursement (instant on donation)

---

## Important Notes

1. **Version code must be unique** for each Play Store upload — bump before building
2. **Firebase secrets** are set in Cloudflare Workers (production) and .dev.vars (local)
3. **API_URL** in .env must match the production worker URL
4. **USSD** requires formal MNO approval — unlike SMS sender ID which is instant
5. **Lipila** is in production mode — real money flows through it
6. **Africa's Talking** sandbox is for testing; production needs separate credentials

---

## API Endpoints Reference

### Public
- `GET /api/campaigns` — List active campaigns
- `GET /api/campaigns/:id` — Campaign detail
- `POST /api/campaigns/:id/contribute` — Donate (auth)

### Auth Required
- `POST /api/airtime/order` — Buy airtime
- `POST /api/host/badge/subscribe` — Subscribe to badge
- `GET /api/host/badge-status` — Check badge status

### Admin Only
- `GET /api/admin/push-status` — FCM config + token counts
- `POST /api/admin/test-push` — Send test notification
- `POST /api/admin/disburse-now` — Trigger disbursement
- `PUT /api/admin/airtime/config` — Update airtime settings
- `PUT /api/admin/host/badge-config` — Update badge pricing
- `PUT /api/admin/campaigns/:id/image` — Update campaign image

### Webhooks
- `POST /api/webhooks/lipila` — Lipila payment callback
- `POST /api/ussd/callback` — Africa's Talking USSD callback

---

## Next Session Checklist

1. Check Cloudflare Worker logs for any errors
2. Verify push notifications are being received
3. Test airtime order flow (when enabled)
4. Configure USSD via Africa Talking dashboard
5. Update version code for next release build
