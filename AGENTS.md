# AGENTS.md — Kingdom Sponsor API (Cloudflare Worker)

## Deploy

1. `npx tsc --noEmit` — verify TypeScript compiles
2. `npx wrangler deploy` — deploy to production
3. `npx wrangler tail` — view live logs

## Production API

`https://kingdom-sponsor-api.godfreymoseskalambo.workers.dev`

## Secrets (set via `npx wrangler secret put NAME`)

- `JWT_SECRET` — token signing key
- `AT_API_KEY` — Africa's Talking API key
- `AT_USERNAME` — Africa's Talking username
- `LIPILA_API_KEY` — Lipila payment API key
- `LIPILA_WEBHOOK_SECRET` — Lipila callback verification
- `FIREBASE_CLIENT_EMAIL` — FCM service account email
- `FIREBASE_PRIVATE_KEY` — FCM service account private key
- `SUPERADMIN_PHONES` — comma-separated admin phone numbers
- `SETTLEMENT_PHONE` — platform fee settlement number

## Cron Triggers

- `*/15 * * * *` — Intruder alert scan
- `0 2 * * *` — Daily sweeps (auto-disburse, fee sweep, pledges, promotion expiry)

## Database (D1)

- Database: `kingdom-sponsor-db` (id: `01c99f57-3f1b-4212-85db-261f86f90a24`)
- Remote queries: `npx wrangler d1 execute kingdom-sponsor-db --command="SQL" --remote`

## Migrations

Located in `sql/migration_vNN.sql`. Apply with:
`npx wrangler d1 execute kingdom-sponsor-db --file=./sql/migration_vNN.sql --remote`

- v35: referral_reward_threshold default → 10
- v36: campaign_views; campaigns.waive_payout_fees/event_tiers; users.org_type/last_login_at
- v37: lipila_logs status backfill
- v38: notifications table; campaigns.event_capacity/event_date/event_venue
- v39: team_messages table
- v40: event_attendees table
- v41: contributions.tier_name/ticket_qty; event_rsvps table
- v42: announcements.status/reviewer_user_id/reviewed_at/rejection_reason
- v43: contributions.email (card donor emails)
- v44: campaigns.waive_event_fees; app_settings for event commission + editable platform fees

Note: `getSetting`/`setSetting` read/write the **app_settings** table (used by fees,
airtime, promotions). Some legacy settings (referral threshold, sms-status, telegram,
email, intruder) read the **admin_settings** table directly — keep them separate.

## Fee Model

- Collection (donor pays on top): Platform **max(K3, 1%) + ZMW 0.48** (MoMo) or 2%/K5 + 0.48 (card)
  + Lipila 2.5%. Event tickets charge the same on collection.
- Disbursement (deducted from host payout): Lipila 1.5% + Platform max(K3,1%) + 0.48.
- **Event finder's commission**: event ticket payouts additionally deduct a flat **K10**
  (admin-set `event_commission_finder_fee_cents`, default 1000) on top of the normal cut
  + Lipila's 1.5%. Card variant: `event_commission_card_finder_fee_cents`.
- Admin can waive per event (`waive_event_fees`) or waive the whole payout side
  (`waive_payout_fees`).
- All fees are editable from Admin → Tools & settings → Fees & commissions
  (`/api/admin/event-commission`, settings scope) — stored in `app_settings`, applied live
  via `adminFeeConfig()` (no redeploy needed). wrangler vars remain the fallback defaults.

## Remote configuration (no rebuild needed)

Admins change all of the following from the dashboard; the app reads them live:
- Fees & commissions: `GET/PUT /api/admin/event-commission` (settings scope)
- Airtime: `GET /api/airtime/config`, `PUT /api/admin/airtime/config`
- Host badge: `PUT /api/admin/host/badge-config`
- Promotions: `GET/POST /api/admin/promotion-config`
- Referral threshold: `GET/PUT /api/admin/referral-threshold`
- Network status / SMS notice / intruder / Telegram / email: admin-dashboard settings
- Sample images: `GET /api/sample-images` (public), `GET/POST/DELETE /api/admin/sample-images` (settings scope)

## New Endpoints

### Airtime System
- `GET /api/airtime/config` — public config (enabled, limits)
- `POST /api/airtime/order` — create order (auth)
- `PUT /api/admin/airtime/config` — admin update settings

### Host Badge System
- `GET /api/host/badge-config` — pricing tiers
- `GET /api/host/badge-status` — user's active badge
- `POST /api/host/badge/subscribe` — subscribe to tier
- `PUT /api/admin/host/badge-config` — admin pricing

### Events
- `POST /api/campaigns/:id/contribute` — donate OR buy event ticket (MoMo; tierName + ticketQty)
- `POST /api/campaigns/:id/contribute-card` — card donation/ticket
- `POST /api/events/:id/rsvp` — RSVP to free event
- `GET /api/campaigns/:id/live/donations` — live feed (respects anonymous + hide_amount)
- `GET/PUT /api/admin/event-commission` — event finder's fee + editable platform fees (settings)
- `PUT /api/admin/campaigns/:id/waive-event-fees` — per-event waive (campaigns scope)
- `GET /api/admin/events/stats` — ticket sales analytics (any staff)

### Host → donor updates (moderated)
- `GET /api/campaigns/:id/announcements` — approved updates (public)
- `POST /api/campaigns/:id/announcements` — host submits an update (goes to moderation)
- `GET /api/admin/announcements?status=pending` — moderation queue (campaigns scope)
- `POST /api/admin/announcements/:id/approve|reject` — publish / decline + notify host

### Staff / assistants
- `GET/POST/PUT/DELETE /api/admin/assistants` — manage scoped assistants (superadmin)
- `GET /api/admin/users/search?q=` — find users to add as assistants
- `/api/host/me` + `/api/auth/verify-otp` return `assistantScopes` so the app gates by scope

### Personal backup
- `GET /api/me/backup` — user/host exports profile, giving, hosted campaigns, pledges, links, badges

### Admin exports
- `GET /api/admin/stats/export.csv`, `GET /api/admin/stats/export.pdf`
- `GET /api/admin/backup/export` — full DB backup (settings scope)

### Sample images
- `GET /api/sample-images` — public list of admin-uploaded posters
- `GET/POST/DELETE /api/admin/sample-images` — manage (settings scope)

### USSD
- `POST /api/ussd/callback` — Africa's Talking USSD callback
- Requires USSD code provisioning + MNO approval for production

### Disbursement
- `POST /api/admin/disburse` — trigger auto-disburse
- `POST /api/admin/disburse-now` — trigger now
- `POST /api/admin/withdraw` — manual withdrawal to phone

### Campaign Image
- `PUT /api/admin/campaigns/:id/image` — update campaign image/logo

### Push
- `GET /api/admin/push-status` — FCM config + token counts
- `POST /api/admin/test-push` — admin test push
- `POST /api/user/push/test` — user-level test push (Settings → Test notification; force-refreshes stale tokens)
