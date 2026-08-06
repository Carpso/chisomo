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

- v21: notifications_enabled, airtime_credits_cents on users
- v22: host_badges, airtime_orders tables; admin_settings for airtime/badge config

## Fee Model

- Platform fee: max(K3, 1%) + ZMW 0.24 per donation (donor pays on top)
- Lipila collection: 2.5% (included in platform fee display)
- Disbursement: Lipila 1.5% + Platform max(K3, 1%) deducted from payout

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

### USSD
- `POST /api/ussd/callback` — Africa's Talking USSD callback
- Requires USSD code provisioning + MNO approval for production

### Disbursement
- `POST /api/admin/disburse` — trigger auto-disburse
- `POST /api/admin/disburse-now` — trigger now
- `POST /api/admin/withdraw` — manual withdrawal to phone

### Campaign Image
- `PUT /api/admin/campaigns/:id/image` — update campaign image/logo

### Push Status
- `GET /api/admin/push-status` — FCM config + token counts
- `POST /api/admin/test-push` — send test notification
