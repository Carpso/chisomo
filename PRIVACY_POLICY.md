# Privacy Policy — Kingdom Sponsor

**Last updated:** August 2026

Kingdom Sponsor ("we," "our," or "us") operates a fundraising platform that allows users to donate to campaigns and hosts to create and manage fundraising campaigns. This privacy policy describes how we collect, use, and protect your personal data.

## 1. Information We Collect

### 1.1 Account Data
- **Phone number** — required for registration and OTP-based authentication via Africa's Talking SMS
- **Username** — chosen during registration
- **User ID** — internally generated identifier

### 1.2 Donation Data
- **Amount donated** (in ngwee/cents)
- **Donor name** (optional, can be anonymous)
- **Phone number** — used for Lipila payment prompts and SMS notifications
- **Transaction reference ID** — unique identifier for each donation
- **Campaign ID** — the campaign being supported

### 1.3 Campaign Data
- **Campaign title, description, and goal**
- **Campaign status** (active, draft, ended)
- **Logo URL** (if uploaded by the host)
- **Sponsor count and amounts**

### 1.4 Payment Data
- **Lipila collection and disbursement references**
- **Payment status** (pending, success, failed, cancelled)
- **Platform fees and Lipila fees** (calculated automatically)

### 1.5 USSD Session Data
- **Session ID** — temporary identifier for USSD interactions
- **Phone number** — the user's phone dialing the USSD code
- **Menu selections** — choices made during the USSD flow
- **Donation amount and reference** — recorded when a USSD donation is confirmed

### 1.6 Technical Data
- **IP address** — logged automatically by Cloudflare
- **User agent and device information** — collected by the Flutter app
- **FCM tokens** — used for push notifications (stored per device)

## 2. How We Use Your Data

- **Authentication** — your phone number is used to send and verify OTPs via Africa's Talking SMS
- **Payment processing** — donation amounts and phone numbers are sent to Lipila for mobile money transactions
- **SMS notifications** — we send transaction confirmations and pledge reminders via Africa's Talking
- **USSD interactions** — your USSD session data is processed in real time to provide the interactive menu experience
- **Campaign management** — campaign data is displayed publicly (except donor phone numbers, which are never exposed)
- **Analytics and reporting** — aggregated, anonymised data is used for platform statistics and admin dashboards
- **Fee calculation** — platform fees and Lipila fees are calculated and deducted automatically from each transaction

## 3. Data Storage

- All data is stored in **Cloudflare D1** (SQLite) databases
- Media files (campaign logos) are stored in **Cloudflare R2**
- No data is stored on our own servers — all infrastructure is provided by Cloudflare

## 4. Data Retention

- **Contributions and transactions** — retained indefinitely for financial records
- **USSD session data** — not persisted; processed in real time and discarded after the session ends
- **User accounts** — retained until the account is deleted
- **Campaigns** — retained until the host ends the campaign
- **Payout/withdrawal records** — retained indefinitely

## 5. Data Sharing

We do not sell your personal data. We share data only with:

- **Lipila** — for payment processing (phone number, amount, reference ID)
- **Africa's Talking** — for SMS and USSD services (phone number, session data)
- **Cloudflare** — as our infrastructure provider (IP address, technical data)
- **Firebase** — for FCM push notifications (device tokens)

## 6. Your Rights

You have the right to:

- **Access** — request a copy of your personal data
- **Rectification** — correct inaccurate information
- **Erasure** — request deletion of your account and associated data
- **Portability** — receive your data in a machine-readable format
- **Object** — object to processing of your data for direct marketing

To exercise any of these rights, contact us through the platform or reach out to the superadmin.

## 7. Security

- All API endpoints are protected by JWT authentication
- Phone numbers are never exposed publicly
- Payment data is processed by Lipila and never stored in full
- USSD session data is processed in real time and not persisted
- We use HTTPS for all data transmission

## 8. Children's Privacy

Kingdom Sponsor is not intended for users under the age of 13. We do not knowingly collect data from children.

## 9. Changes to This Policy

We may update this privacy policy from time to time. Changes will be posted on this page with a new "Last updated" date.

## 10. Contact

For privacy-related inquiries, contact the platform administrator or the superadmin phone number configured in the backend.

**Platform:** Kingdom Sponsor
**Backend:** https://kingdom-sponsor-api.godfreymoseskalambo.workers.dev
**GitHub:** https://github.com/Carpso/chisomo