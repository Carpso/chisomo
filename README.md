# Kingdom Sponsor API

Backend for the Kingdom Sponsor fundraising platform: Cloudflare Worker + D1 (SQLite) + Lipila payments + Africa's Talking SMS + USSD.

- **Backend repo**: https://github.com/Carpso/chisomo
- **Flutter app repo**: https://github.com/Carpso/chisomo_flutter
- **Privacy Policy**: https://kingdom-sponsor-api.godfreymoseskalambo.workers.dev/privacy

## Quick start (local dev)

```powershell
npm install
npx wrangler d1 execute Kingdom Sponsor-db --local --file=./sql/schema.sql   # create local DB
npm run dev                                                          # http://localhost:8787
```

In sandbox mode (default `ENV = "sandbox"`) with no Africa's Talking keys set,
OTP responses include a `debugCode` you can use to log in without SMS.

## One-time setup

### 1. Lipila (payments)
1. Create a merchant account at https://dashboard.lipila.dev (sandbox) / https://dashboard.lipila.io (live).
2. Grab your API key from **Wallets → view more details → API Keys** (`lsk_...` sandbox, `lpk_...` live).
3. Confirm your collection/disbursement fee percentages in your dashboard and update `LIPILA_COLLECTION_FEE_PCT` / `LIPILA_DISBURSEMENT_FEE_PCT` in `wrangler.toml`.
4. Set the secret:
   ```powershell
   npx wrangler secret put LIPILA_API_KEY
   ```
5. Set `APP_URL` in `wrangler.toml` to your deployed Worker URL. The webhook is `POST {APP_URL}/api/webhooks/lipila?secret=LIPILA_WEBHOOK_SECRET` — every collection and disbursement includes it, so you don't need to register it in the Lipila dashboard.

### 2. Africa's Talking (OTP SMS + USSD)
1. Sign up at https://africastalking.com and create a sandbox app (production: create a live app, buy a shortcode or register a sender ID).
2. Set secrets:
   ```powershell
   npx wrangler secret put AT_USERNAME   # your AT app username
   npx wrangler secret put AT_API_KEY
   ```
3. Set the USSD callback URL in your Africa's Talking dashboard to:
   `https://kingdom-sponsor-api.godfreymoseskalambo.workers.dev/api/ussd`
4. Optional: set `AT_FROM` as a var in `wrangler.toml` if you have a registered sender ID/shortcode.
5. Sandbox test numbers are e.g. `+254711XXXYYY` style numbers provided by AT.

### 3. Cloudflare D1 (database)
```powershell
npx wrangler d1 create Kingdom Sponsor-db
```
Paste the returned `database_id` into `wrangler.toml`, then:
```powershell
npm run db:remote
```

### 4. Secrets to set before going live
```powershell
npx wrangler secret put LIPILA_API_KEY
npx wrangler secret put LIPILA_WEBHOOK_SECRET
npx wrangler secret put JWT_SECRET
npx wrangler secret put AT_USERNAME
npx wrangler secret put AT_API_KEY
```
Production secrets override the dev placeholders in `[vars]`. Switch `ENV = "production"` only when using the `lpk_` key.

## Deploy
```powershell
npm run deploy
```

## Fee model
- `PLATFORM_FEE_PCT` (default 1%): your cut on collections AND disbursements — with a flat `PLATFORM_MIN_FEE_CENTS` (default K3) minimum, so Kingdom Sponsor always earns at least K3 per transaction (or 1% when that is higher).
- `LIPILA_COLLECTION_FEE_PCT` (default 2.5%): Lipila's MoMo collection fee — the customer pays `PLATFORM_FEE_PCT + LIPILA_COLLECTION_FEE_PCT` (3.5%) total on MoMo.
- `LIPILA_DISBURSEMENT_FEE_PCT` (default 1.5%): Lipila's MoMo disbursement fee, deducted from the host's payout at payout time.
- Payouts deduct both Lipila's disbursement fee and Kingdom Sponsor's payout cut (K3 min / 1%); the cut is then disbursed to `SETTLEMENT_PHONE` (the platform settlement number).
- Hosts receive: raised − platform collection fee (K3 min, else 1%) − Lipila collection fees − Lipila disbursement fees − platform payout cut − prior withdrawals.

## Superadmin
Anyone approved as a superadmin phone in `SUPERADMIN_PHONES` (international format, comma-separated) can log into the same app and gets the shield icon opening the admin dashboard (stats, host approvals, top campaigns/donors). Set it in production with:
```powershell
npx wrangler secret put SUPERADMIN_PHONES   # e.g. +260968551110
npx wrangler secret put SETTLEMENT_PHONE    # e.g. +260976847775 (where fee earnings go)
```

## Auto-disbursement
After each confirmed donation, if the campaign's available balance ≥ `min_withdraw_cents` (default K200, set per campaign), the backend immediately pays the host via Lipila mobile-money disbursement (near-instant). Campaign hosts can also withdraw on demand, and ending a campaign sweeps any remainder below the threshold.

## API surface
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/request-otp | – | Send OTP to phone |
| POST | /api/auth/verify-otp | – | Verify OTP, returns JWT |
| GET | /api/campaigns | – | Public campaign list with totals |
| GET | /api/campaigns/:id | – | Campaign detail + recent donors |
| POST | /api/campaigns | Bearer | Create campaign (host) |
| POST | /api/campaigns/:id/contribute | optional | Start Lipila collection |
| GET | /api/contributions/status/:referenceId | – | Poll donation status |
| POST | /api/campaigns/:id/withdraw | Bearer (host) | Manual payout |
| POST | /api/campaigns/:id/end | Bearer (host) | End + sweep balance |
| GET | /api/host/me | Bearer | Host dashboard data |
| POST | /api/ussd | – | Africa's Talking USSD webhook |
| POST | /api/webhooks/lipila | ?secret= | Lipila callbacks |

## Notes
- Money is stored as integer ngwee (cents). 100 = K1.
- All contributions require a phone number for the Lipila prompt; phone numbers are never exposed publicly.
- Test the full payment loop with Lipila sandbox before switching to live keys.
