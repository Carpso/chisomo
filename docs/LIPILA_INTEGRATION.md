# Lipila Integration Guide (Kingdom Sponsor)

Reusable reference for integrating Lipila payments — collections (mobile money
and card) and disbursements (mobile money). Covers the fixes that made
collections/disbursements work in production, so the same patterns can be
reused for other wallets and apps.

Docs: https://docs.lipila.dev · Sandbox dashboard: https://dashboard.lipila.dev
· Live dashboard: https://dashboard.lipila.io
API bases: sandbox `https://api.lipila.dev/api/v1` · production
`https://blz.lipila.io/api/v1`

---

## 1. Golden rules (learned the hard way)

1. **Sanitize every narration.** Lipila only accepts letters, numbers and
   spaces in `narration`. Colons, dashes, apostrophes, ampersands and emoji
   make it reject the whole request with HTTP 400:
   `"errors":{"narration":["Narration can only contain letters, numbers and spaces"]}`.
   Apply the same sanitizer to free-text customer fields (names, address,
   city, zip) on card collections.
   ```ts
   export function sanitizeNarration(s: string): string {
     return String(s ?? "")
       .normalize("NFKD")
       .replace(/[^A-Za-z0-9 ]/g, " ")
       .replace(/\s+/g, " ")
       .trim()
       .slice(0, 50);
   }
   ```
2. **Never send raw card details.** Card collections use Lipila's hosted
   checkout (`cardRedirectionUrl`) — the cardholder enters card details on
   Lipila's PCI-DSS page, never in your app.
3. **Store the reference id immediately.** Insert your DB row as `pending`
   BEFORE calling Lipila, then update it with Lipila's `identifier` on
   success and flip to `failed` on error. Never lose the reference.
4. **Log every Lipila event** (success AND failure) with the amount — see the
   `lipila_logs` pattern in section 5. Failure messages must include the URL
   and the raw response body so support can diagnose without tracing.
5. **Confirm only via webhook or status check** — never trust the client.
   Webhook auth: `?secret=` query param or Lipila's HMAC signature
   (verifyLipilaSignature).

## 2. Headers on every request

| Header | Value |
|---|---|
| `accept` | `application/json` |
| `Content-Type` | `application/json` |
| `x-api-key` | your secret API key |
| `callbackUrl` | your webhook URL (optional, but always set it) |

## 3. Collections

### 3a. Mobile money (USSD prompt to the payer's phone)

`POST {base}/collections/mobile-money`

```json
{
  "referenceId": "CON-9-1786224659143",
  "amount": 12.34,
  "narration": "Kingdom Sponsor donation to School Fees",
  "accountNumber": "260977123456",
  "currency": "ZMW",
  "email": "donor@example.com"
}
```

Response: `{ referenceId, identifier, status: "Pending", paymentType: "MtnMoney"|"AirtelMoney"|"ZamtelKwacha", amount }`.
The payer receives a USSD prompt and must enter their PIN.
Failure messages you may see: `LOW_BALANCE_OR_PAYEE_LIMIT_REACHED_OR_NOT_ALLOWED`,
`User didn't enter the pin.`, `System internal error.` — all are per-payment
failures; retry is safe.

### 3b. Card (hosted checkout)

`POST {base}/collections/card`

```json
{
  "customerInfo": {
    "firstName": "Jane",
    "lastName": "Doe",
    "phoneNumber": "260977123456",
    "city": "Lusaka",
    "country": "Zambia",
    "address": "123 Main Road",
    "email": "jane@example.com",
    "zip": "10101"
  },
  "collectionRequest": {
    "referenceId": "CON-9-1786224659143",
    "amount": 12.34,
    "narration": "Kingdom Sponsor donation to School Fees",
    "accountNumber": "jane@example.com",
    "currency": "ZMW",
    "backUrl": "https://your-app.com/share/9",
    "referenceData": "Kingdom Sponsor donation 9"
  }
}
```

Notes:
- `accountNumber` is an identifier, not the card number (the hosted page
  collects the card). Use the customer's email — Lipila echoes it back as
  `accountNumber` in the response.
- Response adds `cardRedirectionUrl` — open it in the user's browser
  (`LaunchMode.externalApplication`). Card is optional; user pays there.
- Cards: Visa, Mastercard, American Express.
- Confirmation arrives on the SAME webhook and status-check flow as mobile
  money (status `Successful`, paymentType `Card`).

### 3c. Status check (both collection types)

`GET {base}/collections/check-status?referenceId=...`

Response `status`: `Successful` | `Pending` | `Failed`. Error 429 = slow down.

## 4. Disbursements (mobile money only — host payouts)

`POST {base}/disbursements/mobile-money`

```json
{
  "referenceId": "PAY-9-1786224659143",
  "amount": 11.53,
  "narration": "Kingdom Sponsor payout School Fees",
  "accountNumber": "260977123456",
  "currency": "ZMW"
}
```

- Disbursements do NOT require the recipient to enter a PIN.
- Status check: `GET {base}/disbursements/check-status?referenceId=...`
- Bank disbursements also exist (`/disbursements/bank`); we don't use them.

## 5. Audit logging (the `lipila_logs` pattern)

Record every initiate + every failure so admins can see amounts and errors:

```sql
CREATE TABLE lipila_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- 'collection' | 'disbursement'
  reference_id TEXT,
  phone TEXT,
  amount_cents INTEGER,            -- ALWAYS the real amount, even on failure
  status TEXT,                     -- pending | success | failed | error
  lipila_status TEXT,
  message TEXT,                    -- full error incl. URL + response body
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

Log on success (with Lipila's identifier appended to the reference) AND on
failure (with the full `Error.message` — the error string already includes
HTTP status, URL and response body). Amount is always the real `amountCents`
from the request params — never derive it from the failed response.

## 6. Error handling (do this)

```ts
const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
const rawText = await res.text().catch(() => "");
let data: any;
try { data = JSON.parse(rawText); } catch { data = {}; }
if (!res.ok) {
  const detail = rawText.slice(0, 500) || JSON.stringify(data);
  throw new Error(`Lipila ${path} failed (${res.status}) url=${url}: ${detail}`);
}
```

- Always read the RAW text before parsing — JSON bodies that fail to parse
  silently become `{}` otherwise and you lose the real error.
- Include the URL in the error so you know which environment failed.

## 7. Limits (what we know)

- **No published Lipila daily/transaction limits.** The docs list no
  merchant collection/disbursement caps.
- **Rate limit:** HTTP 429 `TOO MANY REQUESTS` — slow down (our app also
  rate-limits per-phone: 3 donations/minute).
- **Operator-level limits apply to mobile money.** Airtel/MTN/Zamtel have
  their own per-transaction and daily wallet limits for payers (collections)
  and recipients (disbursements). A failed disbursement with
  `LOW_BALANCE_OR_PAYEE_LIMIT_REACHED_OR_NOT_ALLOWED` usually means the
  recipient's MoMo wallet hit an operator limit.
- **Retry policy:** 30-minute backoff after a failed payout, then
  auto-retry. Never hammer the endpoint.

## 8. Webhook

`POST {base}` callback with `referenceId`, `amount`, `status`
(`Successful`/`Failed`), `paymentType`, `type` (`Collection`/`Disbursement`),
`identifier`, `message`.

- Authenticate with `?secret=` query param OR HMAC signature.
- Match on `referenceId` prefix to route: `CON-` collection, `PAY-`/
  `SET-`/`SWEEP-`/`REF-` disbursement/refund, `PRO-` promotion.
- Idempotent: webhook may be delivered more than once.

## 9. Environment switching

`LIPILA_ENV=sandbox|production` picks the base URL. Sandbox dashboard
`dashboard.lipila.dev`, live `dashboard.lipila.io` — self-onboard on both.
API keys are per-environment; never share the production key.
