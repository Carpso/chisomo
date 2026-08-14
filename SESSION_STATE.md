# Session State — Kingdom Sponsor

**Last Updated**: 2026-08-13
**Version**: 0.7.0 (versionCode 75)
**Flutter Commit**: `3586782` (+ latest unpushed)
**Backend Commit**: `dbfc5c4` (+ latest unpushed)
**Backend Deployed Version ID**: `1910173c-dbbc-478f-9c51-fbf3e62fd9f2`

---

## Project Structure

```
D:\Explorer\MAYUNDO\KEY PROJECTS\
├── chisomo_flutter\     # Flutter app (Dart)
│   ├── lib\
│   │   ├── core\        # Theme, router, API client, push, FX, widgets
│   │   └── features\    # Screens by feature (campaigns, events, admin, host…)
│   ├── android\         # Android config
│   ├── test\            # Tests (26 passing)
│   └── pubspec.yaml     # Dependencies
└── chisomo\             # Cloudflare Worker API (TypeScript)
    ├── src\             # Source code + __tests__ (35 passing)
    ├── sql\             # D1 migrations (up to v42)
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
- **GitHub**: `Carpso/chisomo_flutter` and `Carpso/chisomo` (both on `master`)

---

## Build Commands

```bash
# Flutter (release build REQUIRES a fresh unused versionCode)
cd D:\Explorer\MAYUNDO\KEY PROJECTS\chisomo_flutter
flutter clean
flutter pub get
flutter build apk --release    # -> build/app/outputs/flutter-apk/app-release.apk
flutter build appbundle --release  # -> build/app/outputs/bundle/release/app-release.aab

# Backend
cd D:\Explorer\MAYUNDO\KEY PROJECTS\chisomo
npx tsc --noEmit              # Type check
npx vitest run                # Backend tests (35)
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
- Release keystore: `android/app/kingdom-sponsor-release.jks` (gitignored; passwords via `STORE_PASSWORD` / `KEY_PASSWORD` env)

---

## Features Implemented

### Core Features
- [x] User auth (OTP via Africa's Talking SMS)
- [x] Campaign CRUD (host edit requests go through admin moderation — hosts cannot edit directly)
- [x] Donations via Lipila mobile money + Card (Visa/Mastercard/Amex) hosted checkout
- [x] Auto-disbursement (cron) + manual admin trigger
- [x] Push notifications (Firebase FCM) — `device_tokens` multi-device, `giving_updates` channel
- [x] Campaign carousel (auto-slide with pause in Settings)
- [x] Support tickets with admin replies + status filtering
- [x] Linked accounts (family, friend, couple, team)
- [x] PDF receipts (donor name + title capitalized)
- [x] Short links + deep links (`kingdomsponsor://campaign/<id>`, `//event/<id>`, `//donate/<id>`, `//event/<id>/buy-ticket`)
- [x] Public/private campaigns + visibility
- [x] Category system (~31 curated) + category-specific sample images
- [x] Smart search + org grouping
- [x] Share with image (share_plus)

### Events (0.7.0 — first-class)
- [x] EventsScreen (Instagram-style feed) + EventDetailScreen + BuyTicketScreen (tier + qty, MoMo/card)
- [x] RSVP for free events, QR check-in for hosts
- [x] Event capacity with atomic oversell guard at confirmation
- [x] Event deep links + manifest intent-filter
- [x] Event campaigns auto-redirect away from campaign/donate UI
- [x] Admin events analytics (tickets sold, revenue, sell-through, RSVPs)

### Premium / Growth Features
- [x] Verified Host Badge (3 tiers) + Host KYC (R2 doc upload, admin review)
- [x] Airtime purchase system (admin-controlled)
- [x] USSD service (backend ready, needs MNO approval)
- [x] Referral rewards (threshold configurable, admin rewards)
- [x] Promotions (paid slots, admin approve/promote/refund)
- [x] Gamification (achievements, levels, badges)
- [x] Team chat (staff)
- [x] **Host → donor updates (0.7.0, moderated)** — hosts post, superadmin/assistants approve/reject, approved updates show on campaign/event pages + push donors

### Admin / Staff Features
- [x] Dashboard with stats + export CSV/PDF + full backup export
- [x] **Assistant admins with scoped permissions (0.7.0)** — `assistantScopes` returned by `/api/host/me`; ~50 endpoints converted to `requireStaff(scope)`; app gates tiles/routes by scope
- [x] User management (ban/unban, referral rewards)
- [x] Campaign management (edit, delete w/ reason, restore soft-deleted, audit log)
- [x] Host applications approval + verified badge + KYC review
- [x] Edit requests review (host-proposed changes)
- [x] Announcements moderation (`/admin/announcements`)
- [x] Push broadcast + test push + Settings "Test notification" (user-level)
- [x] Lipila logs, ledger, payouts, wallet balance, disburse
- [x] SMS status/network status, intruder alerts (Telegram/email), tax compliance
- [x] Airtime/badge/promotion config

---

## Database Schema (Key Tables)

- `users` — accounts (phone, username, is_host, host_kyc_*, notifications_enabled, last_login_at)
- `campaigns` — campaigns + events (event_tiers, event_capacity, event_date, event_venue, visibility, category, campaign_type, waive_payout_fees)
- `contributions` — donations + tickets (tier_name, ticket_qty)
- `withdrawals` — host payouts
- `fee_sweeps` — platform fee settlements
- `device_tokens` — FCM push tokens (multi-device)
- `user_links` — linked accounts
- `support_tickets` — support messages
- `host_badges` — verified host subscriptions
- `airtime_orders` — airtime purchase orders
- `announcements` — host updates (status/reviewer for moderation, v42)
- `admin_assistants` — assistant scoped permissions
- `admin_actions` — audit log
- `campaign_edit_requests`, `campaign_delete_requests` — moderation queues
- `event_rsvps`, `event_attendees` — events
- `notifications` — in-app bell history
- `team_messages` — staff chat
- `admin_settings` — config key-value store
- `lipila_logs` — gateway logging

---

## Migrations Applied (up to v42)

| Version | Description |
|---------|-------------|
| v35 | referral_reward_threshold default → 10 |
| v36 | campaign_views, campaigns.waive_payout_fees/event_tiers, users.org_type/last_login_at |
| v37 | lipila_logs status backfill |
| v38 | notifications table, campaigns.event_capacity/event_date/event_venue |
| v39 | team_messages table |
| v40 | event_attendees table |
| v41 | contributions.tier_name/ticket_qty, event_rsvps table |
| v42 | announcements.status/reviewer_user_id/reviewed_at/rejection_reason + index |

All applied to remote D1 (v36/v38/v41 were already present from the 0.6.3 deploy; v42 was newly applied).

---

## Fee Model

- **Platform fixed fee**: ZMW **0.48** per transaction (collection AND disbursement)
- **Collection**: Platform max(K3, 1%) + 0.48 + Lipila 2.5% (donor pays on top; cards K5 min / 2% + 0.48)
- **Disbursement**: Lipila 1.5% + Platform max(K3, 1%) + 0.48 (deducted from payout)
- Fee math lives in `src/fees.ts` (tested) — `moneyRef()` appends a random suffix to every money reference so same-ms collisions can't corrupt webhook idempotency

---

## Cron Schedule

- `*/15 * * * *` — Intruder alert scan
- `0 6 * * *` — Daily: fee sweep, auto-disburse, pledge reminders, promotion expiry, ticket auto-close

---

## Known Issues / TODO

### Active
- [ ] USSD needs Africa Talking dashboard setup + MNO approval (2-4 weeks)
- [ ] Airtime needs funding before enabling in production (sandbox logging only)
- [ ] iPhone users still use the web share page (no Apple Developer account yet) — page handles MoMo/card payments + tickets on-site
- [ ] Push notifications were broken in production until 0.7.0 (a failed FCM bulk send used to wipe all `device_tokens`); fixed + deployed — verify on a real device

### Future
- [ ] Broader widget/integration tests (only unit tests exist; money_test, fx_test, deep_links_test, promote_screen_test)
- [ ] Real-device QA pass on give-money + buy-ticket flows on MTN + Airtel
- [ ] Multi-device sign-out handling
- [ ] Apple Developer account → native iOS app

---

## Important Notes

1. **Version code must be unique** for each Play Store upload — bump `versionCode` in `android/app/build.gradle.kts` before every release build
2. **Always `flutter clean`** before release builds
3. **Firebase secrets** are set in Cloudflare Workers (production) and `.dev.vars` (local)
4. **API_URL** in `.env` must match the production worker URL
5. **USSD** requires formal MNO approval — unlike SMS sender ID which is instant
6. **Lipila** is in production mode — real money flows through it
7. **Never push a keystore or secret to GitHub** — release keystore is gitignored
8. Backend deploy is `npx tsc --noEmit && npx wrangler deploy`; run `npx vitest run` after payment-logic changes
9. `moneyRef()` refs changed format (timestamp now includes a random suffix) — old pending refs are unaffected (lookup is by exact string)

---

## API Endpoints Reference

### Public
- `GET /api/campaigns` — List active campaigns (`?category=`)
- `GET /api/campaigns/:id` — Campaign detail (returns `hostName`, `visibility`, `campaignType`, `hostVerified`, `hostOrg`)
- `GET /api/campaigns/:id/announcements` — Approved host updates
- `GET /api/events/:id/rsvp-count` — RSVP count
- `GET /api/campaign-categories` — Category list

### Auth Required
- `POST /api/campaigns/:id/contribute` — Donate / buy ticket (MoMo)
- `POST /api/campaigns/:id/contribute-card` — Card checkout
- `POST /api/campaigns/:id/announcements` — Post a host update (goes to moderation)
- `POST /api/events/:id/rsvp` — RSVP
- `POST /api/device/token` — Register FCM token
- `POST /api/user/push/test` — Test push to own devices (Settings button)
- `GET /api/host/me` — Returns `assistantScopes` for assistants
- `GET /api/host/badge-status`, `POST /api/host/badge/subscribe`

### Admin / Staff (requireStaff scope in parens)
- `GET /api/admin/stats`, `/api/admin/analytics`, `/api/admin/events/stats` (any staff)
- `GET /api/admin/campaigns`, `PUT /api/admin/campaigns/:id`, `DELETE`, restore (campaigns)
- `GET /api/admin/applications` + approve/reject, hosts verify/kyc (campaigns)
- `GET /api/admin/edit-requests` + approve/reject (campaigns)
- `GET /api/admin/delete-requests` + approve/reject (campaigns)
- `GET /api/admin/announcements` + approve/reject (campaigns)
- `GET /api/admin/transactions`, `/api/admin/disbursements`, `/api/admin/lipila-logs`, payouts, disburse (donations)
- `GET /api/admin/tickets` + resolve, support-config (tickets)
- `GET /api/admin/users`, ban/unban, referrals + reward (users)
- SMS/broadcast/airtime/badge/promo/push-status/network/intruder/telegram/email config (settings)
- Tax, wallet-balance, withdraw, lipila-diagnostic (finance)
- `GET /api/admin/campaigns/deleted`, `POST .../restore`, `GET /api/admin/actions` (restore)
- Assistant management + backup/restore: superadmin only

### Webhooks
- `POST /api/webhooks/lipila` — Lipila payment callback (idempotent; capacity-guarded)
- `POST /api/ussd/callback` — Africa's Talking USSD callback

---

## Next Session Checklist

1. **Wire up a real airtime provider** (AT doesn't support Zambia): get an MTN MoMo API
   subscription (momoapi.mtn.com), set `AIRTIME_PROVIDER=mtn_momo` + `MTN_MOMO_*` secrets/vars,
   redeploy, then use the admin airtime screen's "Test airtime delivery" to verify a real K1 top-up.
   Until then airtime stays in `manual` mode (admin fulfils + confirms).
2. Verify push notifications arrive on a real device (test via Settings → Test notification — it now force-refreshes stale FCM tokens and retries; if it still shows "0 of 1 device", the phone's POST_NOTIFICATIONS permission is off)
3. Confirm announcements moderation works end-to-end (host posts → admin approves → donors pushed)
4. Confirm assistant account can log in and sees only its scoped tiles
5. Upload `app-release.aab` (0.7.0/75) to the Play Console
6. Real-device QA on give-money + buy-ticket for MTN and Airtel
7. Consider starting the Apple developer account for iOS
8. Re-run migration_v44's app_settings inserts on any fresh DB (already applied to production; the ALTER TABLE part fails on re-run so apply the settings separately)

## Recent session highlights (0.7.0 hardening pass)
- **Push notifications overhauled** (like ChurchOnApp): per-category channels
  (`giving_updates`, `events`, `support`, `payments`, `admin`, `promotions`,
  `sponsor_desk`, `broadcast`, `referrals`, `host`, `links`) — every one
  Importance.max with sound + vibration so alerts ALWAYS pop, never silent.
  Backend `channelForType()` in firebase.ts picks the channel per push type.
  App: content-keyed dedup (30s) + burst coalescing (one summary per channel),
  action button ("Open"), app-icon + brand-orange colour, and an in-app
  slide-down banner overlay so foreground notifications are never missed.
- **Superadmin + team alerted for EVERYTHING**: `pushAdmins` (superadmins +
  admin assistants) now fires on new campaign/event posted, RSVP, event
  check-in, donation/ticket sale, payout, promotion requested, airtime order,
  badge purchase, host application, edit/delete requests, announcements,
  support tickets, new users — so the team sees everything users do.
- **Events never mix with campaigns**: `/api/campaigns` defaults to campaigns
  only; `?type=events` returns events only; search/USSD/share-page exclude
  events; events use their own category set (`EVENT_CATEGORIES`).
- **Airtime provider layer (pluggable)**: AT does NOT offer airtime for Zambia, so
  `src/airtime.ts` now abstracts suppliers — `manual` (default; admin fulfils by hand +
  `POST /api/admin/airtime-orders/:id/complete`), `mtn_momo` (MTN MoMo API airtime, the
  Zambia route), `africastalking` (other markets). New `GET /api/airtime/providers`;
  admin test is provider-aware; admin airtime screen shows a provider badge.
- **Sponsor Desk**: admin curates grant/empowerment opportunities (`sponsor_desk`
  table, migration_v45), publishes batches to active hosts (push + in-app
  `sponsor_desk` type → `/sponsor-desk` screen). Hosts get a Sponsor Desk banner
  on the Host tab + notification tap routing.
- **Notifications show time**: `safeDateTime()` in date_utils renders UTC
  `created_at` as local "14 Aug 2026 · 14:30" on the notifications list + detail.
- **Push banners fixed**: Settings → Test notification force-refreshes the FCM token when FCM reports 0 deliveries; backend test-push reports honest sentCount; `giving_updates` channel self-heals; FCM payload pins channelId + high priority + public visibility + sound.
- **Event finder's commission**: admin-set K10 (MoMo + card) deducted from event ticket host payouts on top of the normal cut + Lipila 1.5%; per-event waive (`waive_event_fees`); all editable from Admin → Fees & commissions. Migration v44.
- **Remote config**: fees (platform %/min/fixed, MoMo + card), airtime, badge, promotions, referral threshold, sample images — all changeable from the dashboard without redeploying (app_settings).
- **Dashboard speed**: admin calls parallelized; campaignPublic loops use Promise.all (admin campaigns 23s → ~3s).
- **Events first-class**: event-worded notifications ("Ticket confirmed", "New event posted"), live feed respects hide_amount/anonymous, admin/team event delete, event detail keeps one Share button.
- **Sample images**: admins upload posters (`/api/admin/sample-images`) that appear in the event create screen's sample picker.
- **Create templates**: campaign + event starter templates prefill title/description/category/goal/photo.
- **Personal backup**: `GET /api/me/backup` + Settings → Backup my data (JSON share).
- **Outreach copy**: `docs/OUTREACH_TEMPLATES.md` (hosts/donors/promoters) + 30-day Facebook calendar in the Flutter repo.
- **Share card is orange**, duplicate share buttons removed, "Go Live" casing.
- Tests: 51 backend (fees, webhook idempotency + handler, parse-tiers, moneyRef) + 29 Flutter (money, fx, payment screens, deep links, promote).
