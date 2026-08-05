// Kingdom Sponsor API - neutral fundraising platform.
// Stack: Cloudflare Worker + D1 + Lipila (payments) + Africa's Talking (OTP SMS).
// Money is stored in ngwee (integer cents). 100 ngwee = K1.

import { Hono } from "hono";
import { cors } from "hono/cors";
import * as Sentry from "@sentry/cloudflare";
import { signToken, verifyToken, sha256Hex, type TokenPayload } from "./jwt";
import { createCollection, checkCollectionStatus, checkDisbursementStatus, createDisbursement, getWalletBalance, type LipilaEnv } from "./lipila";
import { sendOtpSms, sendSms } from "./sms";
import { loadFeeConfig, donationFees, payoutAmountCents, disbursementFeeCents, platformDisbursementFeeCents, feeConfigPublic, formatKwacha } from "./fees";
import { generateUsername, ensureUser, donorTotalCents, donorVisibleCents, tierFor } from "./donors";
import { sendPushNotification, sendMulticastPush } from "./firebase";
import {
  donationConfirmedSms, donationReceivedSms, payoutSentSms, payoutFailedSms, pledgeReminderSms,
  promotionActiveSms, promotionRejectedSms, campaignDeletedSms, deleteRequestReceivedSms,
  deleteRequestRejectedSms, supportReplySms, supportReceivedSms, promotionRefundedSms,
  promotionExpiredSms, milestoneSms, campaignEndedSms,
} from "./messages";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

type Bindings = LipilaEnv & SmsEnv2 & {
  DB: D1Database;
  MEDIA: R2Bucket;
  JWT_SECRET: string;
  APP_URL: string;
  PLATFORM_FEE_PCT?: string;
  PLATFORM_MIN_FEE_CENTS?: string;
  LIPILA_COLLECTION_FEE_PCT?: string;
  LIPILA_DISBURSEMENT_FEE_PCT?: string;
  SETTLEMENT_PHONE?: string;
  LIPILA_ENV?: string;
  OTP_TTL_MINUTES?: string;
  SUPERADMIN_PHONES?: string;
  PROMO_PRICE_CENTS?: string;
  PROMO_DAYS?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  SENTRY_DSN?: string;
};

interface SmsEnv2 {
  AT_USERNAME: string;
  AT_API_KEY: string;
  AT_FROM?: string;
  ENV: string;
}

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", cors());

// ---------- helpers ----------

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("260")) return `+${digits}`;
  if (digits.startsWith("0")) return `+260${digits.slice(1)}`;
  return `+${digits}`;
}

async function hostStatusOf(env: Bindings, userId: number): Promise<Record<string, any>> {
  return (await env.DB.prepare(
    "SELECT host_status, host_org, host_role, host_rejection FROM users WHERE id = ?"
  ).bind(userId).first<Record<string, any>>()) ?? {};
}

function isAdminPhone(env: Bindings, phone: string | undefined): boolean {
  if (!phone) return false;
  const admins = (env.SUPERADMIN_PHONES ?? "")
    .split(",")
    .map((p) => normalizePhone(p));
  return admins.includes(normalizePhone(phone));
}

function envPushConfigured(env: Bindings): boolean {
  return !!env.FIREBASE_CLIENT_EMAIL && !!env.FIREBASE_PRIVATE_KEY;
}

function fbEnv(env: Bindings) {
  return { FIREBASE_CLIENT_EMAIL: env.FIREBASE_CLIENT_EMAIL!, FIREBASE_PRIVATE_KEY: env.FIREBASE_PRIVATE_KEY! };
}

/** Best-effort push to every device registered to a user (no-op when FCM isn't configured). */
async function pushToUser(env: Bindings, userId: number | null, title: string, body: string, data?: Record<string, string>): Promise<void> {
  if (!envPushConfigured(env) || !userId) return;
  const rows = await env.DB.prepare(
    "SELECT token FROM device_tokens WHERE user_id = ?"
  ).bind(userId).all<{ token: string }>();
  const tokens = rows.results.map((r) => r.token);
  if (!tokens.length) return;
  await sendMulticastPush(fbEnv(env), tokens, title, body, data)
    .catch((e) => console.error("push failed:", e));
}

/** Push to every user whose phone is on the superadmin list (used for urgent admin alerts). */
async function pushAndSmsAdmins(env: Bindings, smsText: string, pushTitle: string, pushBody: string): Promise<void> {
  const phones = (env.SUPERADMIN_PHONES ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  for (const p of phones) {
    await sendSms(env, normalizePhone(p), smsText).catch((e) => console.error("admin sms failed:", e));
  }
  if (envPushConfigured(env) && phones.length) {
    const placeholders = phones.map(() => "?").join(",");
    const admins = await env.DB.prepare(
      `SELECT fcm_token FROM users WHERE fcm_token IS NOT NULL AND phone IN (${placeholders})`
    ).bind(...phones).all<{ fcm_token: string }>();
    const tokens = admins.results.map((a) => a.fcm_token);
    if (tokens.length) {
      await sendMulticastPush(fbEnv(env), tokens, pushTitle, pushBody, { type: "admin_alert" })
        .catch((e) => console.error("admin push failed:", e));
    }
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function authUser(c: any): Promise<TokenPayload | null> {
  const header = c.req.header("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  const payload = await verifyToken(token, c.env.JWT_SECRET as string);
  if (!payload) return null;
  return payload;
}

// ---------- referral codes ----------

const REF_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function makeReferralCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += REF_CHARS[b % REF_CHARS.length];
  return out;
}

/** Ensure the user has a referral code (generate lazily for pre-existing accounts). */
async function ensureReferralCode(env: Bindings, userId: number): Promise<string> {
  const existing = await env.DB.prepare("SELECT referral_code FROM users WHERE id = ?")
    .bind(userId).first<{ referral_code: string | null }>();
  if (existing?.referral_code) return existing.referral_code;
  let code = makeReferralCode();
  for (let i = 0; i < 5; i++) {
    const clash = await env.DB.prepare("SELECT id FROM users WHERE referral_code = ?")
      .bind(code).first();
    if (!clash) break;
    code = makeReferralCode();
  }
  await env.DB.prepare("UPDATE users SET referral_code = ? WHERE id = ?").bind(code, userId).run();
  return code;
}

/** Attach a new signup to their referrer (only when the referrer is a different real user). */
async function attachReferral(env: Bindings, newUserId: number, rawCode?: string): Promise<void> {
  const code = String(rawCode ?? "").trim().toUpperCase();
  if (code.length < 4) return;
  const referrer = await env.DB.prepare("SELECT id FROM users WHERE referral_code = ?")
    .bind(code).first<{ id: number }>();
  if (!referrer || referrer.id === newUserId) return;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO referrals (referrer_user_id, referred_user_id) VALUES (?, ?)"
  ).bind(referrer.id, newUserId).run();
}

/** Confirm a contribution (webhook or polling) and credit the campaign. */
async function confirmContribution(env: Bindings, referenceId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM contributions WHERE lipila_reference = ?"
  ).bind(referenceId).first<Record<string, any>>();
  if (!row || row.status === "confirmed") return;

  const raisedBefore = (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
  ).bind(row.campaign_id).first<{ s: number }>())?.s ?? 0;

  await env.DB.prepare(
    "UPDATE contributions SET status = 'confirmed', confirmed_at = datetime('now', '+2 hours') WHERE id = ?"
  ).bind(row.id).run();

  const campaign = await env.DB.prepare(
    "SELECT c.*, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(row.campaign_id).first<Record<string, any>>();
  const available = await availableBalance(env, row.campaign_id);
  if (campaign?.host_phone) {
    await sendSms(env, campaign.host_phone, donationReceivedSms(campaign.title, row.amount_cents, available))
      .catch((e) => console.error("host sms failed:", e));
    await pushToUser(env, campaign.host_user_id, "New gift received",
      `Someone gave ${(row.amount_cents / 100).toLocaleString()} ZMW to "${campaign.title}".`,
      { type: "donation_received", campaignId: String(campaign.id) })
      .catch((e) => console.error("host push failed:", e));
  }
  if (row.phone) {
    await sendSms(env, row.phone, donationConfirmedSms(campaign?.title ?? "campaign", row.amount_cents, referenceId))
      .catch((e) => console.error("donor sms failed:", e));
    await pushToUser(env, row.donor_user_id, "Gift confirmed",
      `Thank you! Your gift of ${(row.amount_cents / 100).toLocaleString()} ZMW to "${campaign?.title ?? "campaign"}" is confirmed.`,
      { type: "donation_confirmed", campaignId: String(campaign?.id ?? ""), contributionId: String(row.id) })
      .catch((e) => console.error("donor push failed:", e));
  }

  // Milestone notifications: alert a campaign's donors when it crosses 25/50/75/100% of its goal.
  await maybeNotifyMilestones(env, campaign, raisedBefore, row.amount_cents);

  await maybeAutoDisburse(env, row.campaign_id);
}

const MILESTONES = [0.25, 0.5, 0.75, 1];

/** Push + SMS the campaign's donors when a goal milestone is crossed. */
async function maybeNotifyMilestones(env: Bindings, campaign: Record<string, any> | null, raisedBefore: number, addedCents: number): Promise<void> {
  if (!campaign || !campaign.goal_cents || campaign.goal_cents <= 0) return;
  const after = raisedBefore + addedCents;
  const beforePct = raisedBefore / campaign.goal_cents;
  const afterPct = after / campaign.goal_cents;

  const crossed = MILESTONES.filter((m) => beforePct < m && afterPct >= m);
  if (!crossed.length) return;

  const pct = Math.round(crossed[crossed.length - 1] * 100);
  const title = `"${campaign.title}" reached ${pct}%`;
  const body = `It's ${pct}% of its ${(campaign.goal_cents / 100).toLocaleString()} ZMW goal. Keep the momentum going!`;

  // Push to all confirmed donors of this campaign with a registered device.
  if (envPushConfigured(env)) {
    const donors = await env.DB.prepare(
      `SELECT DISTINCT dt.token FROM device_tokens dt
       JOIN contributions co ON co.donor_user_id = dt.user_id
       WHERE co.campaign_id = ? AND co.status = 'confirmed'`
    ).bind(campaign.id).all<{ token: string }>();
    const tokens = donors.results.map((d) => d.token);
    if (tokens.length) {
      await sendMulticastPush(fbEnv(env), tokens, title, body,
        { type: "milestone", campaignId: String(campaign.id) })
        .catch((e) => console.error("milestone push failed:", e));
    }
  }

  // SMS only at 100% (keeps costs in check) + always notify the host.
  await pushToUser(env, campaign.host_user_id, title, body, { type: "milestone", campaignId: String(campaign.id) })
    .catch(() => {});
  if (pct === 100 && campaign.host_phone) {
    await sendSms(env, campaign.host_phone, `🎉 ${campaign.title} has reached its goal of ${(campaign.goal_cents / 100).toLocaleString()} ZMW!`)
      .catch((e) => console.error("milestone host sms failed:", e));
  }
}

/** If the campaign's available balance >= minimum threshold, pay it out to the host immediately. */
async function maybeAutoDisburse(env: Bindings, campaignId: number): Promise<void> {
  const campaign = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(campaignId).first<Record<string, any>>();
  if (!campaign) return;

  await createWithdrawal(env, campaignId);
}

/** raised - platform fees (collection) - Lipila collection fees - already withdrawn - payout fees (Lipila + platform) */
async function availableBalance(env: Bindings, campaignId: number): Promise<number> {
  const [raised, platformFees, lipilaFees, withdrawn, disbursementFees, payoutPlatformFees] = await env.DB.batch([
    env.DB.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM contributions WHERE campaign_id = ? AND status = 'confirmed'").bind(campaignId),
    env.DB.prepare("SELECT COALESCE(SUM(platform_fee_cents),0) AS s FROM contributions WHERE campaign_id = ? AND status = 'confirmed'").bind(campaignId),
    env.DB.prepare("SELECT COALESCE(SUM(lipila_fee_cents),0) AS s FROM contributions WHERE campaign_id = ? AND status = 'confirmed'").bind(campaignId),
    env.DB.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','success')").bind(campaignId),
    env.DB.prepare("SELECT COALESCE(SUM(disbursement_fee_cents),0) AS s FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','success')").bind(campaignId),
    env.DB.prepare("SELECT COALESCE(SUM(platform_fee_cents),0) AS s FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','success')").bind(campaignId),
  ]);
  const g = (r: any) => (r?.results?.[0]?.s ?? r?.[0]?.s ?? 0);
  return g(raised) - g(platformFees) - g(lipilaFees) - g(withdrawn) - g(disbursementFees) - g(payoutPlatformFees);
}

/** Create a payout of the campaign's available balance, deducting Lipila's disbursement fee and Kingdom Sponsor's payout cut. Returns the host payout cents sent (0 if none). */
async function createWithdrawal(env: Bindings, campaignId: number): Promise<number> {
  const cfg = loadFeeConfig(env);
  const campaign = await env.DB.prepare(
    "SELECT c.*, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(campaignId).first<Record<string, any>>();
  if (!campaign) return 0;

  const available = await availableBalance(env, campaignId);
  if (available < campaign.min_withdraw_cents) return 0; // honour the host's set payout minimum

  const payoutCents = payoutAmountCents(available, cfg);
  const lipilaFee = disbursementFeeCents(available, cfg);
  const platformFee = platformDisbursementFeeCents(available, cfg);
  if (payoutCents <= 0) return 0;

  const referenceId = `PAY-${campaignId}-${Date.now()}`;
  try {
    await env.DB.prepare(
      "INSERT INTO withdrawals (campaign_id, amount_cents, disbursement_fee_cents, platform_fee_cents, lipila_reference, status) VALUES (?, ?, ?, ?, ?, 'pending')"
    ).bind(campaignId, payoutCents, lipilaFee, platformFee, referenceId).run();

    const result = await createDisbursement(env, {
      referenceId,
      amountCents: payoutCents,
      accountNumber: campaign.host_phone.replace("+", ""),
      narration: `Kingdom Sponsor payout: ${campaign.title}`,
      callbackUrl: `${env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(env.LIPILA_WEBHOOK_SECRET)}`,
    });

    await env.DB.prepare(
      "UPDATE withdrawals SET lipila_identifier = ? WHERE lipila_reference = ?"
    ).bind(result.identifier, referenceId).run();
    return payoutCents;
  } catch (e) {
    await env.DB.prepare(
      "UPDATE withdrawals SET status = 'failed' WHERE lipila_reference = ?"
    ).bind(referenceId).run();
    console.error("disbursement failed:", e);
    if (campaign.host_phone) {
      await sendSms(env, campaign.host_phone, payoutFailedSms(campaign.title, payoutCents))
        .catch((err) => console.error("payout-failed sms failed:", err));
      await pushToUser(env, campaign.host_user_id, "Payout delayed",
        `We'll retry your payout of ${(payoutCents / 100).toLocaleString()} ZMW for "${campaign.title}" automatically.`,
        { type: "payout_failed", campaignId: String(campaign.id) })
        .catch((err) => console.error("payout-failed push failed:", err));
    }
    return 0;
  }
}

/** Disburse Kingdom Sponsor's payout cut to the platform settlement number (best-effort). */
async function settlePlatformFees(
  env: Bindings,
  payoutReference: string,
  amountCents: number,
  kind: "payout" | "sweep" = "payout"
): Promise<void> {
  const phone = env.SETTLEMENT_PHONE;
  if (!phone || amountCents <= 0) return;
  const ref = `${kind === "sweep" ? "SWEEP" : "SET"}-${payoutReference}`;
  await env.DB.prepare(
    "INSERT INTO fee_sweeps (kind, amount_cents, lipila_reference, status) VALUES (?, ?, ?, 'pending')"
  ).bind(kind, amountCents, ref).run();
  try {
    await createDisbursement(env, {
      referenceId: ref,
      amountCents,
      accountNumber: phone.replace("+", ""),
      narration: "Kingdom Sponsor platform fee settlement",
      callbackUrl: `${env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(env.LIPILA_WEBHOOK_SECRET)}`,
    });
  } catch (e) {
    await env.DB.prepare(
      "UPDATE fee_sweeps SET status = 'failed' WHERE lipila_reference = ?"
    ).bind(ref).run();
    console.error("fee settlement failed:", e);
  }
}

/** Mark a fee settlement/sweep disbursement as confirmed. */
async function confirmFeeSweep(env: Bindings, referenceId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE fee_sweeps SET status = 'success' WHERE lipila_reference = ? AND status = 'pending'"
  ).bind(referenceId).run();
}

/** Accumulated platform fees (collection + payout cuts) earned but not yet settled to Kingdom Sponsor. */
async function pendingDonationFees(env: Bindings): Promise<number> {
  const earnedDonations = (await env.DB.prepare(
    "SELECT COALESCE(SUM(platform_fee_cents),0) AS s FROM contributions WHERE status = 'confirmed'"
  ).first<{ s: number }>())?.s ?? 0;
  const earnedPayouts = (await env.DB.prepare(
    "SELECT COALESCE(SUM(platform_fee_cents),0) AS s FROM withdrawals WHERE status = 'success'"
  ).first<{ s: number }>())?.s ?? 0;
  const settled = (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM fee_sweeps WHERE status = 'success'"
  ).first<{ s: number }>())?.s ?? 0;
  return earnedDonations + earnedPayouts - settled;
}

/** Scheduled: sweep accumulated donation platform fees to SETTLEMENT_PHONE (only when worthwhile). */
async function runFeeSweep(env: Bindings): Promise<void> {
  const phone = env.SETTLEMENT_PHONE;
  if (!phone) return;
  try {
    let due = await pendingDonationFees(env);
    if (due < 5000) return; // below K50, not worth the disbursement fee
    const balance = await getWalletBalance(env);
    const available = Math.floor(balance * 100);
    if (available < 5000) return;
    due = Math.min(due, available);
    await settlePlatformFees(env, `SWEEP-${Date.now()}`, due, "sweep");
    console.log(`fee sweep: settled ${due} cents`);
  } catch (e) {
    console.error("fee sweep failed:", e);
  }
}

// ---------- promoted campaigns (top-5 paid slots) ----------

async function getSetting(env: Bindings, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setSetting(env: Bindings, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

/** Promotion price/days are set by the superadmin in the app (stored in app_settings, env as fallback). */
async function promoPrice(env: Bindings): Promise<number> {
  const v = await getSetting(env, "promo_price_cents");
  if (v) { const n = parseInt(v, 10); if (n > 0) return n; }
  return parseInt(env.PROMO_PRICE_CENTS ?? "", 10) > 0 ? parseInt(env.PROMO_PRICE_CENTS!, 10) : 15000;
}

async function promoDays(env: Bindings): Promise<number> {
  const v = await getSetting(env, "promo_days");
  if (v) { const n = parseInt(v, 10); if (n > 0) return n; }
  return parseInt(env.PROMO_DAYS ?? "", 10) > 0 ? parseInt(env.PROMO_DAYS!, 10) : 7;
}

const PROMO_SLOTS = 5;

/** Number of live promoted slots (excluding a specific campaign). */
async function activePromotionCount(env: Bindings, excludeCampaignId?: number): Promise<number> {
  const q = excludeCampaignId
    ? "SELECT COUNT(*) AS n FROM campaigns WHERE promoted = 1 AND id != ?"
    : "SELECT COUNT(*) AS n FROM campaigns WHERE promoted = 1";
  const stmt = env.DB.prepare(q);
  const row = excludeCampaignId
    ? await stmt.bind(excludeCampaignId).first<{ n: number }>()
    : await stmt.first<{ n: number }>();
  return row?.n ?? 0;
}

/** Called when Lipila confirms the promotion payment. */
async function confirmPromotion(env: Bindings, referenceId: string): Promise<void> {
  const promo = await env.DB.prepare(
    "SELECT * FROM promotions WHERE lipila_reference = ? AND status = 'pending'"
  ).bind(referenceId).first<Record<string, any>>();
  if (!promo) return;

  // Payment received: the promotion goes to the superadmin for approval
  // before it appears in the promoted top-5 list.
  await env.DB.prepare(
    "UPDATE promotions SET status = 'pending_approval' WHERE id = ?"
  ).bind(promo.id).run();

  const campaign = await env.DB.prepare(
    "SELECT c.title, u.phone AS host_phone FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(promo.campaign_id).first<Record<string, any>>();
  if (campaign?.host_phone) {
    await sendSms(
      env,
      campaign.host_phone,
      `Kingdom Sponsor: your K${(promo.amount_cents / 100).toLocaleString()} promotion payment for "${campaign.title}" was received and is pending approval. You'll be notified once it goes live.`
    ).catch((e) => console.error("promo pending sms failed:", e));
  }
}

/** Approve a paid promotion (superadmin). Makes it live in the top-5 list. */
async function approvePromotion(env: Bindings, promoId: number): Promise<void> {
  const promo = await env.DB.prepare(
    "SELECT * FROM promotions WHERE id = ? AND status = 'pending_approval'"
  ).bind(promoId).first<Record<string, any>>();
  if (!promo) return;

  const days = promo.days || (await promoDays(env));
  const until = new Date(Date.now() + days * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE promotions SET status = 'active', expires_at = ? WHERE id = ?"
    ).bind(until, promo.id),
    env.DB.prepare(
      "UPDATE campaigns SET promoted = 1, promoted_until = ? WHERE id = ?"
    ).bind(until, promo.campaign_id),
  ]);

  const campaign = await env.DB.prepare(
    "SELECT c.title, c.id, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(promo.campaign_id).first<Record<string, any>>();
  if (campaign?.host_phone) {
    await sendSms(env, campaign.host_phone, promotionActiveSms(campaign.title, days, until.slice(0, 10)))
      .catch((e) => console.error("promo sms failed:", e));
    await pushToUser(env, campaign.host_user_id, "Your campaign is promoted",
      `"${campaign.title}" is now at the top of Kingdom Sponsor for ${days} days.`,
      { type: "promotion_active", campaignId: String(campaign.id) })
      .catch((e) => console.error("promo push failed:", e));
  }
}

/** Reject a paid promotion (superadmin). */
async function rejectPromotion(env: Bindings, promoId: number): Promise<void> {
  const promo = await env.DB.prepare(
    "SELECT * FROM promotions WHERE id = ? AND status = 'pending_approval'"
  ).bind(promoId).first<Record<string, any>>();
  if (!promo) return;

  await env.DB.prepare(
    "UPDATE promotions SET status = 'rejected' WHERE id = ?"
  ).bind(promoId).run();

  const campaign = await env.DB.prepare(
    "SELECT c.title, c.id, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(promo.campaign_id).first<Record<string, any>>();
  if (campaign?.host_phone) {
    await sendSms(env, campaign.host_phone, promotionRejectedSms(campaign.title))
      .catch((e) => console.error("promo reject sms failed:", e));
    await pushToUser(env, campaign.host_user_id, "Promotion not approved",
      `Your promotion for "${campaign.title}" was declined. Contact support about a refund.`,
      { type: "promotion_rejected", campaignId: String(campaign.id) })
      .catch((e) => console.error("promo reject push failed:", e));
  }
}

/** Refund a paid promotion fee back to the payer's mobile money (used when rejecting an approved promo). */
async function refundPromotion(env: Bindings, promoId: number): Promise<void> {
  const promo = await env.DB.prepare("SELECT * FROM promotions WHERE id = ?")
    .bind(promoId).first<Record<string, any>>();
  if (!promo) throw new Error("Promotion not found");
  if (promo.status === "refunded" || promo.status === "refund_pending") return;

  const campaign = await env.DB.prepare(
    "SELECT c.title, c.id, c.host_user_id, u.phone AS host_phone FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(promo.campaign_id).first<Record<string, any>>();
  if (!campaign?.host_phone) throw new Error("Host not found");

  const referenceId = `REF-${promo.id}-${Date.now()}`;
  await env.DB.prepare(
    "INSERT INTO refunds (promo_id, amount_cents, lipila_reference, status) VALUES (?, ?, ?, 'pending')"
  ).bind(promo.id, promo.amount_cents, referenceId).run();
  await env.DB.prepare(
    "UPDATE promotions SET status = 'refund_pending' WHERE id = ? AND status NOT IN ('refunded', 'refund_pending')"
  ).bind(promoId).run();

  const result = await createDisbursement(env, {
    referenceId,
    amountCents: promo.amount_cents,
    accountNumber: campaign.host_phone.replace("+", ""),
    narration: `Kingdom Sponsor promotion refund for ${campaign.title}`,
    callbackUrl: `${env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(env.LIPILA_WEBHOOK_SECRET)}`,
  });
  await env.DB.prepare(
    "UPDATE refunds SET lipila_identifier = ? WHERE lipila_reference = ?"
  ).bind(result.identifier, referenceId).run();
}

/** Webhook: Lipila confirms the refund disbursement. */
async function confirmRefund(env: Bindings, referenceId: string): Promise<void> {
  const refund = await env.DB.prepare(
    "SELECT * FROM refunds WHERE lipila_reference = ?"
  ).bind(referenceId).first<Record<string, any>>();
  if (!refund) return;
  if (refund.status !== "success") {
    await env.DB.prepare("UPDATE refunds SET status = 'success' WHERE id = ?").bind(refund.id).run();
  }

  const promo = await env.DB.prepare("SELECT * FROM promotions WHERE id = ?")
    .bind(refund.promo_id).first<Record<string, any>>();
  if (!promo) return;
  await env.DB.prepare("UPDATE promotions SET status = 'refunded' WHERE id = ?").bind(promo.id).run();

  const campaign = await env.DB.prepare(
    "SELECT c.title, c.id, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(promo.campaign_id).first<Record<string, any>>();
  if (!campaign?.host_phone) return;
  await sendSms(env, campaign.host_phone, promotionRefundedSms(campaign.title, refund.amount_cents))
    .catch((e) => console.error("refund sms failed:", e));
  await pushToUser(env, campaign.host_user_id, "Promotion refunded",
    `Your promotion payment of ${formatKwacha(refund.amount_cents)} for "${campaign.title}" has been refunded to your mobile money.`,
    { type: "promotion_refunded", campaignId: String(campaign.id) })
    .catch((e) => console.error("refund push failed:", e));
}

/** Scheduled: expire promoted campaigns whose paid window has passed. */
async function runPromotionExpiry(env: Bindings): Promise<void> {
  const nowIso = new Date().toISOString();

  const expired = await env.DB.prepare(
    "SELECT c.id, c.title, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.promoted = 1 AND c.promoted_until IS NOT NULL AND c.promoted_until < ?"
  ).bind(nowIso).all<Record<string, any>>();
  await env.DB.prepare(
    "UPDATE campaigns SET promoted = 0 WHERE promoted = 1 AND promoted_until IS NOT NULL AND promoted_until < ?"
  ).bind(nowIso).run();
  await env.DB.prepare(
    "UPDATE promotions SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?"
  ).bind(nowIso).run();

  // Tell hosts their promotion window ended (and that they can renew).
  for (const row of expired.results) {
    if (row.host_phone) {
      await sendSms(env, row.host_phone, promotionExpiredSms(row.title))
        .catch((e) => console.error("promo expiry sms failed:", e));
    }
    await pushToUser(env, row.host_user_id, "Your promotion has ended",
      `"${row.title}" is no longer promoted. You can promote it again anytime in the app.`,
      { type: "promotion_expired", campaignId: String(row.id) })
      .catch((e) => console.error("promo expiry push failed:", e));
  }
}

/** Scheduled: auto-close support tickets with no activity for 7+ days. */
async function runTicketAutoClose(env: Bindings): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id, subject, phone, user_id, created_at, updated_at FROM support_tickets WHERE status = 'open'"
  ).all<Record<string, any>>();

  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  for (const row of rows.results) {
    if (new Date(row.updated_at ?? row.created_at).toISOString() >= cutoff) continue;
    const note = "Automatically closed after 7 days without a reply.";
    await env.DB.prepare(
      "UPDATE support_tickets SET status = 'closed', closed_at = datetime('now', '+2 hours'), admin_reply = CASE WHEN admin_reply IS NULL THEN ? ELSE admin_reply || char(10) || ? END WHERE id = ? AND status = 'open'"
    ).bind(note, note, row.id).run();
    if (row.phone) {
      await sendSms(env, row.phone, `Your support request #${row.id} ("${row.subject}") was closed after 7 days without a reply. Open it again in the app if you still need help. Kingdom Sponsor`)
        .catch((e) => console.error("ticket close sms failed:", e));
    }
  }
}

// ---------- recurring pledges (monthly reminders) ----------

/** Daily cron: SMS a reminder to donors whose pledge day is today (Zambia time, UTC+2). */
async function runPledgeReminders(env: Bindings): Promise<void> {
  const zambia = new Date(Date.now() + 2 * 3600000); // UTC+2
  const today = zambia.getUTCDate();
  const daysInMonth = new Date(Date.UTC(zambia.getUTCFullYear(), zambia.getUTCMonth() + 1, 0)).getUTCDate();

  // Due if: pledge day <= today (due today or late) OR pledge day > days in month (e.g. 31st in a 30-day month).
  // Remind at most once per month: only rows not yet reminded this month.
  const rows = await env.DB.prepare(
    `SELECT p.id, p.phone, p.amount_cents, p.day_of_month, p.user_id,
            c.title AS campaign_title, c.id AS campaign_id
     FROM recurring_pledges p JOIN campaigns c ON c.id = p.campaign_id
     WHERE p.active = 1
       AND (p.last_reminded_at IS NULL OR date(p.last_reminded_at) < date('now', '+2 hours'))
       AND (p.day_of_month <= ? OR p.day_of_month > ?)`
  ).bind(today, daysInMonth).all<Record<string, any>>();

  for (const row of rows.results) {
    const message = pledgeReminderSms(row.campaign_title, row.amount_cents, row.campaign_id);
    await sendSms(env, row.phone, message).catch((e) => console.error("pledge sms failed:", e));

    // Push notification
    await pushToUser(env, row.user_id, "Monthly pledge due",
      `Your pledge of ${(row.amount_cents / 100).toLocaleString()} ZMW to "${row.campaign_title}" is due.`,
      { type: "pledge_reminder", campaignId: String(row.campaign_id) })
      .catch((e) => console.error("push failed:", e));

    await env.DB.prepare("UPDATE recurring_pledges SET last_reminded_at = datetime('now', '+2 hours') WHERE id = ?")
      .bind(row.id).run();
  }
}

async function confirmWithdrawal(env: Bindings, referenceId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM withdrawals WHERE lipila_reference = ?"
  ).bind(referenceId).first<Record<string, any>>();
  if (!row) return;
  await env.DB.prepare(
    "UPDATE withdrawals SET status = 'success' WHERE id = ?"
  ).bind(row.id).run();
  if ((row.platform_fee_cents ?? 0) > 0) {
    await settlePlatformFees(env, referenceId, row.platform_fee_cents);
  }
  const campaign = await env.DB.prepare(
    "SELECT c.*, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(row.campaign_id).first<Record<string, any>>();
  if (campaign?.host_phone) {
    await sendSms(env, campaign.host_phone, payoutSentSms(campaign.title, row.amount_cents))
      .catch((e) => console.error("payout sms failed:", e));
    await pushToUser(env, campaign.host_user_id, "Payout sent",
      `Your payout of ${(row.amount_cents / 100).toLocaleString()} ZMW for "${campaign.title}" is on its way to your mobile money.`,
      { type: "payout_sent", campaignId: String(campaign.id) })
      .catch((e) => console.error("payout push failed:", e));
  }
}

/** Scheduled: re-check pending payouts with Lipila in case a webhook was missed. */
async function runWithdrawalStatusChecks(env: Bindings): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id, lipila_reference FROM withdrawals WHERE status = 'pending' AND lipila_reference IS NOT NULL ORDER BY created_at ASC LIMIT 50"
  ).all<{ id: number; lipila_reference: string }>();
  for (const row of rows.results) {
    try {
      const status = await checkDisbursementStatus(env, row.lipila_reference);
      const s = String(status.status ?? "").toLowerCase();
      if (s.includes("success") || s.includes("complete")) {
        await confirmWithdrawal(env, row.lipila_reference);
      } else if (s.includes("fail") || s.includes("cancel") || s.includes("reject")) {
        await env.DB.prepare("UPDATE withdrawals SET status = 'failed' WHERE id = ? AND status = 'pending'")
          .bind(row.id).run();
      }
    } catch (e) {
      console.error("withdrawal status check failed:", row.lipila_reference, e);
    }
  }
}

async function failContribution(env: Bindings, referenceId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE contributions SET status = 'failed' WHERE lipila_reference = ? AND status = 'pending'"
  ).bind(referenceId).run();
}

// ---------- auth ----------

app.post("/api/auth/request-otp", async (c) => {
  const { phone: rawPhone } = await c.req.json();
  const phone = normalizePhone(rawPhone);
  if (!/^\+260\d{9}$/.test(phone)) {
    return c.json({ error: "Enter a valid Zambian phone number (e.g. 0977123456)" }, 400);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const recent = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM otps WHERE phone = ? AND sent_at > ?"
  ).bind(phone, nowSec - 3600).first<{ n: number }>()) ?? { n: 0 };
  if (recent.n >= 5) {
    return c.json({ error: "Too many codes. Try again in an hour." }, 429);
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
  const codeHash = await sha256Hex(code);
  const ttlMin = parseInt(c.env.OTP_TTL_MINUTES ?? "5", 10) || 5;

  await c.env.DB.prepare(
    "INSERT INTO otps (phone, code_hash, expires_at, sent_at) VALUES (?, ?, ?, ?)"
  ).bind(phone, codeHash, nowSec + ttlMin * 60, nowSec).run();

  // Send the real SMS via Twilio when live (ENV=production). In sandbox the
  // code is logged server-side and surfaced to the app as `debugCode`, so any
  // number can still complete login without AT/Twilio sandbox restrictions.
  if (c.env.ENV === "production") {
    try {
      await sendOtpSms(c.env, phone, code);
    } catch (e) {
      console.error("SMS failed:", e);
      return c.json({ error: "Could not send SMS. Try again." }, 502);
    }
  } else {
    try {
      await sendOtpSms(c.env, phone, code);
    } catch (e) {
      console.error(`SMS to ${phone} skipped (sandbox):`, e);
    }
  }

  const debugCode = c.env.ENV === "production" ? undefined : code;
  return c.json({ message: "Code sent", expiresInSeconds: ttlMin * 60, ...(debugCode ? { debugCode } : {}) });
});

app.post("/api/auth/verify-otp", async (c) => {
  const { phone: rawPhone, code, referralCode } = await c.req.json();
  const phone = normalizePhone(rawPhone);
  const nowSec = Math.floor(Date.now() / 1000);

  const otp = await c.env.DB.prepare(
    "SELECT * FROM otps WHERE phone = ? ORDER BY id DESC LIMIT 1"
  ).bind(phone).first<Record<string, any>>();
  if (!otp || otp.expires_at < nowSec) {
    return c.json({ error: "Code expired. Request a new one." }, 400);
  }
  if (otp.attempts >= 5) {
    return c.json({ error: "Too many attempts. Request a new code." }, 429);
  }
  const codeHash = await sha256Hex(String(code));
  if (codeHash !== otp.code_hash) {
    await c.env.DB.prepare("UPDATE otps SET attempts = attempts + 1 WHERE id = ?").bind(otp.id).run();
    return c.json({ error: "Wrong code." }, 400);
  }

  await c.env.DB.prepare("DELETE FROM otps WHERE phone = ?").bind(phone).run();

  let user = await c.env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first<Record<string, any>>();
  let isNewUser = !user;
  if (!user) {
    const username = await generateUsername(c.env.DB);
    const r = await c.env.DB.prepare("INSERT INTO users (phone, username) VALUES (?, ?)").bind(phone, username).run();
    user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(r.meta.last_row_id).first<Record<string, any>>();
  }
  if (!user) return c.json({ error: "Could not create user" }, 500);
  if (!user.username) {
    const username = await generateUsername(c.env.DB);
    await c.env.DB.prepare("UPDATE users SET username = ? WHERE id = ?").bind(username, user.id).run();
    user.username = username;
  }
  await ensureReferralCode(c.env, user.id);
  if (isNewUser) {
    await attachReferral(c.env, user.id, referralCode);
  }

  const token = await signToken({ sub: user.id, phone: user.phone, isHost: !!user.is_host }, c.env.JWT_SECRET);
  return c.json({
    token,
    user: {
      id: user.id,
      phone: user.phone,
      username: user.username,
      name: user.name,
      avatarUrl: user.avatar_url ?? null,
      isHost: !!user.is_host,
      isAdmin: isAdminPhone(c.env, user.phone),
      hostStatus: user.host_status ?? "none",
      referralCode: user.referral_code ?? await ensureReferralCode(c.env, user.id),
    },
  });
});

// ---------- public campaign views ----------

async function campaignPublic(env: Bindings, row: Record<string, any>): Promise<Record<string, any>> {
  // Single batched aggregate query instead of 4 separate ones (audit fix).
  const agg = (await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS n,
            COUNT(DISTINCT COALESCE(donor_user_id, phone)) AS d,
            COALESCE(AVG(amount_cents),0) AS avg
     FROM contributions WHERE campaign_id = ? AND status = 'confirmed'`
  ).bind(row.id).first<{ s: number; n: number; d: number; avg: number }>()) ?? { s: 0, n: 0, d: 0, avg: 0 };
  const withdrawn = (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','success')"
  ).bind(row.id).first<{ s: number }>()) ?? { s: 0 };

  const daysSince = Math.max(1, Math.floor((Date.now() - new Date(row.created_at.replace(" ", "T") + "Z").getTime()) / 86400000));
  const hasGoal = Number(row.goal_cents) > 0;
  const remaining = hasGoal ? Math.max(0, Number(row.goal_cents) - agg.s) : null;
  const donorsNeededAtAvg = hasGoal && agg.avg > 0 ? Math.ceil(remaining! / agg.avg) : null;
  const dailyRate = Math.round(agg.s / daysSince);
  const estDays = hasGoal && remaining! > 0 && dailyRate > 0 ? Math.ceil(remaining! / dailyRate) : null;
  const estimatedEndDate = estDays
    ? new Date(Date.now() + estDays * 86400000).toISOString().slice(0, 10)
    : null;

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    blurb: String(row.description ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140),
    imageUrl: row.image_url,
    logoUrl: row.logo_url ?? null,
    goalCents: Number(row.goal_cents),
    hasGoal: hasGoal,
    raisedCents: agg.s,
    withdrawnCents: withdrawn.s,
    donorCount: agg.d,
    donationCount: agg.n,
    avgDonationCents: Math.round(agg.avg),
    donorsNeededAtAvg: donorsNeededAtAvg,
    dailyRateCents: dailyRate,
    estimatedEndDate: estimatedEndDate,
    endsAt: row.ends_at ?? null,
    promoted: !!row.promoted,
    promotedUntil: row.promoted_until ?? null,
    status: row.status,
    createdAt: row.created_at,
  };
}

app.get("/api/campaigns", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE status = 'active' ORDER BY promoted DESC, created_at DESC"
  ).all<Record<string, any>>();
  const out = [];
  for (const row of rows.results) out.push(await campaignPublic(c.env, row));
  c.header("Cache-Control", "public, max-age=30");
  return c.json({ campaigns: out });
});

app.get("/api/campaigns/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "Campaign not found" }, 404);
  const pub = await campaignPublic(c.env, row);

  const donors = await c.env.DB.prepare(
    `SELECT co.donor_user_id, u.username, u.avatar_url, co.donor_name, co.is_anonymous, co.hide_amount, co.amount_cents, co.created_at
     FROM contributions co LEFT JOIN users u ON u.id = co.donor_user_id
     WHERE co.campaign_id = ? AND co.status = 'confirmed' ORDER BY co.created_at DESC LIMIT 100`
  ).bind(row.id).all<Record<string, any>>();

  // Merge donations from the same donor (same phone number): one row per donor,
  // totalling visible amounts and reporting how many donations / hidden amounts they have.
  const merged = new Map<string, Record<string, any>>();
  for (const d of donors.results) {
    const key = d.donor_user_id != null ? `u${d.donor_user_id}` : `p${d.phone}`;
    const g = merged.get(key);
    if (g) {
      g.count += 1;
      if (d.hide_amount) g.hidden += 1;
      if (!d.hide_amount) g.amount += d.amount_cents;
      if (g.latest < d.created_at) g.latest = d.created_at;
      if (!d.is_anonymous) g.is_anonymous = false;
      if (!d.is_anonymous && d.donor_name) g.name = d.donor_name;
    } else {
      merged.set(key, {
        donor_user_id: d.donor_user_id,
        username: d.username ?? "Giver",
        avatar_url: d.avatar_url ?? null,
        name: d.is_anonymous ? null : (d.donor_name ?? null),
        is_anonymous: !!d.is_anonymous,
        amount: d.hide_amount ? 0 : d.amount_cents,
        visible: d.hide_amount ? 0 : 1,
        count: 1,
        hidden: d.hide_amount ? 1 : 0,
        latest: d.created_at,
      });
    }
  }

  const donorList = [];
  for (const g of merged.values()) {
    const total = await donorVisibleCents(c.env.DB, g.donor_user_id);
    const allHidden = g.visible === 0;
    donorList.push({
      username: g.username,
      avatarUrl: g.is_anonymous ? null : (g.avatar_url ?? null),
      name: allHidden ? null : (g.name ?? null),
      isAnonymous: g.is_anonymous,
      amountCents: allHidden ? null : g.amount,
      tier: allHidden ? null : tierFor(total),
      date: g.latest,
      donationCount: g.count,
      hiddenCount: g.hidden,
    });
  }

  const leaderboard = await c.env.DB.prepare(
    `SELECT co.donor_user_id, u.username, SUM(co.amount_cents) AS total
     FROM contributions co LEFT JOIN users u ON u.id = co.donor_user_id
     WHERE co.campaign_id = ? AND co.status = 'confirmed' AND co.hide_amount = 0
     GROUP BY co.donor_user_id ORDER BY total DESC LIMIT 5`
  ).bind(row.id).all<Record<string, any>>();

  return c.json({
    campaign: pub,
    donors: donorList,
    leaderboard: leaderboard.results.map((l) => ({
      username: l.username ?? "Giver",
      totalCents: l.total,
      tier: tierFor(l.total),
    })),
    fees: feeConfigPublic(loadFeeConfig(c.env)),
  });
  // Short cache so donation totals update quickly but list/detail reads don't hammer D1.
  c.header("Cache-Control", "public, max-age=15");
  return c.json({
    campaign: pub,
    donors: donorList,
    leaderboard: leaderboard.results.map((l) => ({
      username: l.username ?? "Giver",
      totalCents: l.total,
      tier: tierFor(l.total),
    })),
    fees: feeConfigPublic(loadFeeConfig(c.env)),
  });
});

// ---------- host: apply & create campaign ----------

app.post("/api/host/apply", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const body = await c.req.json();
  const org = String(body.org ?? "").trim();
  const role = String(body.role ?? "").trim();
  const reason = String(body.reason ?? "").trim();
  if (!org) return c.json({ error: "Organization name is required" }, 400);

  const current = await hostStatusOf(c.env, user.sub);
  if (current.host_status === "approved") {
    return c.json({ message: "You are already an approved host", hostStatus: "approved" });
  }

  await c.env.DB.prepare(
    `UPDATE users SET host_status = 'pending', host_org = ?, host_role = ?, host_reason = ?, host_rejection = NULL WHERE id = ?`
  ).bind(org, role || null, reason || null, user.sub).run();

  return c.json({ message: "Application submitted. You will be notified once approved.", hostStatus: "pending" });
});

app.post("/api/campaigns", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const host = await hostStatusOf(c.env, user.sub);
  if (host.host_status !== "approved") {
    return c.json(
      {
        error:
          host.host_status === "pending"
            ? "Your host application is still under review."
            : "Apply to become an approved host before creating campaigns.",
        hostStatus: host.host_status ?? "none",
      },
      403
    );
  }

  const body = await c.req.json();
  const title = String(body.title ?? "").trim();
  const description = String(body.description ?? "").trim();
  const goalCents = Math.round(Number(body.goalCents) || 0);
  const minWithdrawCents = Math.round(Number(body.minWithdrawCents) || 1000);
  const minSponsors = Math.max(1, Math.round(Number(body.minSponsors) || 1));
  if (!title || !description) return c.json({ error: "Title and description are required" }, 400);

  let endsAt: string | null = null;
  if (body.endsAt) {
    const parsed = new Date(String(body.endsAt));
    if (isNaN(parsed.getTime())) return c.json({ error: "endsAt must be a valid date" }, 400);
    endsAt = parsed.toISOString().slice(0, 10);
  }

  const base = slugify(title) || `campaign-${Date.now()}`;
  let slug = base;
  let n = 2;
  while (await c.env.DB.prepare("SELECT id FROM campaigns WHERE slug = ?").bind(slug).first()) {
    slug = `${base}-${n++}`;
  }

  const r = await c.env.DB.prepare(
    "INSERT INTO campaigns (slug, title, description, goal_cents, min_withdraw_cents, host_user_id, ends_at, min_sponsors) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(slug, title, description, goalCents, minWithdrawCents, user.sub, endsAt, minSponsors).run();

  return c.json({ id: r.meta.last_row_id, slug }, 201);
});

// ---------- Group Campaigns (multi-sponsor unlock) ----------

app.post("/api/campaigns/:id/contribute", async (c) => {
  const user = await authUser(c);
  const body = await c.req.json();
  const amountCents = Math.round(Number(body.amountCents) || 0);
  if (amountCents < 100) return c.json({ error: "Minimum donation is K1.00" }, 400);

  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(c.req.param("id")).first();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.status !== "active") return c.json({ error: "Campaign is closed" }, 400);

  const phone = normalizePhone(body.phone ?? user?.phone ?? "");
  if (!/^\+260\d{9}$/.test(phone)) {
    return c.json({ error: "Enter a valid Zambian phone number" }, 400);
  }

  const donor = await ensureUser(c.env.DB, phone);
  const recent = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM contributions WHERE phone = ? AND created_at > datetime('now', '-1 minute')"
  ).bind(phone).first<{ n: number }>())?.n ?? 0;
  if (recent >= 3) return c.json({ error: "Too many attempts. Wait a moment and try again." }, 429);

  const cfg = loadFeeConfig(c.env);
  const fees = donationFees(amountCents, cfg);
  const referenceId = `CON-${campaign.id}-${Date.now()}`;

  const r = await c.env.DB.prepare(
    `INSERT INTO contributions (campaign_id, donor_user_id, donor_name, is_anonymous, hide_amount, phone, amount_cents, platform_fee_cents, lipila_fee_cents, lipila_reference, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(
    campaign.id,
    donor.id,
    String(body.donorName ?? "").trim() || null,
    body.isAnonymous ? 1 : 0,
    body.hideAmount ? 1 : 0,
    phone,
    amountCents,
    fees.platformFeeCents,
    fees.lipilaFeeCents,
    referenceId
  ).run();

  try {
    const result = await createCollection(c.env, {
      referenceId,
      amountCents,
      accountNumber: phone.replace("+", ""),
      narration: `Kingdom Sponsor donation to ${campaign.title}`,
      callbackUrl: `${c.env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(c.env.LIPILA_WEBHOOK_SECRET)}`,
    });
    await c.env.DB.prepare(
      "UPDATE contributions SET lipila_identifier = ? WHERE id = ?"
    ).bind(result.identifier, r.meta.last_row_id).run();
    return c.json({
      referenceId,
      message: "Check your phone and enter your PIN to complete the donation.",
      platformFeeCents: fees.platformFeeCents,
    });
  } catch (e) {
    await c.env.DB.prepare(
      "UPDATE contributions SET status = 'failed' WHERE id = ?"
    ).bind(r.meta.last_row_id).run();
    console.error("collection failed:", e);
    return c.json({ error: "Payment could not be started. Try again." }, 502);
  }
});

app.get("/api/contributions/status/:referenceId", async (c) => {
  const referenceId = c.req.param("referenceId");
  const row = await c.env.DB.prepare(
    "SELECT * FROM contributions WHERE lipila_reference = ?"
  ).bind(referenceId).first<Record<string, any>>();
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status === "pending") {
    try {
      const st = await checkCollectionStatus(c.env, referenceId);
      const s = String(st.status).toLowerCase();
      if (s.includes("success")) {
        await confirmContribution(c.env, referenceId);
        row.status = "confirmed";
      } else if (s.includes("fail") || s.includes("cancelled") || s.includes("canceled")) {
        await failContribution(c.env, referenceId);
        row.status = "failed";
      }
    } catch (e) {
      console.error("status check failed:", e);
    }
  }
  return c.json({
    referenceId,
    id: row.id,
    status: row.status,
    amountCents: row.amount_cents,
  });
});

// ---------- device tokens (FCM) ----------

app.post("/api/device/token", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const body = await c.req.json();
  const token = String(body.token ?? "").trim();
  const platform = String(body.platform ?? "android");
  if (!token) return c.json({ error: "Token required" }, 400);

  // Multi-device: keep a token per device; also mirror on users.fcm_token for legacy readers.
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO device_tokens (user_id, token, platform) VALUES (?, ?, ?) ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, last_seen_at = datetime('now')"
    ).bind(user.sub, token, platform),
    c.env.DB.prepare("UPDATE users SET fcm_token = ? WHERE id = ?").bind(token, user.sub),
  ]);

  return c.json({ ok: true });
});

// ---------- account deletion (Google Play compliance) ----------

app.delete("/api/account", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const hosted = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM campaigns WHERE host_user_id = ? AND status = 'active'"
  ).bind(user.sub).first<{ n: number }>();
  if ((hosted?.n ?? 0) > 0) {
    return c.json({ error: "End or close your active campaigns before deleting your account." }, 400);
  }

  await c.env.DB.batch([
    // Personal data: erase pledges, links, OTP records, device tokens, campaigns references.
    c.env.DB.prepare("DELETE FROM recurring_pledges WHERE user_id = ?").bind(user.sub),
    c.env.DB.prepare("DELETE FROM user_links WHERE user_id = ? OR linked_user_id = ?").bind(user.sub, user.sub),
    c.env.DB.prepare("DELETE FROM otps WHERE phone = ?").bind(user.phone),
    c.env.DB.prepare("DELETE FROM device_tokens WHERE user_id = ?").bind(user.sub),
    c.env.DB.prepare("UPDATE campaigns SET host_user_id = NULL WHERE host_user_id = ?").bind(user.sub),
    // Financial records are retained for compliance, but stripped of personal identity.
    c.env.DB.prepare(
      "UPDATE contributions SET donor_user_id = NULL, donor_name = NULL, is_anonymous = 1 WHERE donor_user_id = ?"
    ).bind(user.sub),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.sub),
  ]);

  return c.json({ ok: true, message: "Account deleted." });
});

// ---------- recurring pledges ----------

app.post("/api/campaigns/:id/pledge", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?")
    .bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign || campaign.status !== "active") return c.json({ error: "Campaign not found" }, 404);

  const body = await c.req.json();
  const amountCents = Math.round(Number(body.amountCents) || 0);
  if (amountCents < 100) return c.json({ error: "Minimum pledge is K1.00" }, 400);
  let day = Math.min(28, Math.max(1, Math.round(Number(body.dayOfMonth) || 1)));

  await envUpsertPledge(c.env, campaign.id, user.sub, user.phone, amountCents, day);
  return c.json({ ok: true, message: "Monthly reminder set. You will get an SMS on the day to give." });
});

app.delete("/api/campaigns/:id/pledge", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  await c.env.DB.prepare(
    "UPDATE recurring_pledges SET active = 0 WHERE campaign_id = ? AND user_id = ?"
  ).bind(c.req.param("id"), user.sub).run();
  return c.json({ ok: true, message: "Monthly reminder cancelled." });
});

app.get("/api/pledges", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.campaign_id, p.amount_cents, p.day_of_month, p.active, p.last_reminded_at,
            c.title AS campaign_title, c.slug AS campaign_slug
     FROM recurring_pledges p JOIN campaigns c ON c.id = p.campaign_id
     WHERE p.user_id = ? ORDER BY p.active DESC, p.created_at DESC`
  ).bind(user.sub).all<Record<string, any>>();

  return c.json({
    pledges: rows.results.map((p) => ({
      id: p.id,
      campaignId: p.campaign_id,
      campaignTitle: p.campaign_title,
      campaignSlug: p.campaign_slug,
      amountCents: p.amount_cents,
      dayOfMonth: p.day_of_month,
      active: !!p.active,
lastRemindedAt: p.last_reminded_at,
    })),
  });
});

// ---------- Joint Pledges (partner on recurring pledge) ----------

app.post("/api/campaigns/:id/joint-pledge", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ? AND status = 'active'")
    .bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const body = await c.req.json();
  const amountCents = Math.round(Number(body.amountCents) || 0);
  if (amountCents < 100) return c.json({ error: "Minimum pledge is K1.00" }, 400);
  const day = Math.min(28, Math.max(1, Math.round(Number(body.dayOfMonth) || 1)));
  const partnerPhone = normalizePhone(body.partnerPhone ?? "");
  if (!/^\+260\d{9}$/.test(partnerPhone)) {
    return c.json({ error: "Partner must have a valid Zambian phone number" }, 400);
  }
  if (partnerPhone === user.phone) {
    return c.json({ error: "Cannot partner with yourself" }, 400);
  }

  const partner = await ensureUser(c.env.DB, partnerPhone);
  if (partner.id === user.sub) {
    return c.json({ error: "Cannot partner with yourself" }, 400);
  }

  // Create joint pledge for both users
  await envUpsertPledge(c.env, campaign.id, user.sub, user.phone, amountCents, day, partner.id);
  await envUpsertPledge(c.env, campaign.id, partner.id, partner.phone, amountCents, day, user.sub);

  return c.json({ ok: true, message: "Joint monthly reminder created for both of you." });
});

app.get("/api/pledges/joint", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.campaign_id, p.amount_cents, p.day_of_month, p.active, p.last_reminded_at,
            p.partner_user_id, u2.username AS partner_name, u2.phone AS partner_phone,
            c.title AS campaign_title, c.slug AS campaign_slug
     FROM recurring_pledges p
     JOIN campaigns c ON c.id = p.campaign_id
     LEFT JOIN users u2 ON u2.id = p.partner_user_id
     WHERE p.user_id = ? ORDER BY p.active DESC, p.created_at DESC`
  ).bind(user.sub).all<Record<string, any>>();

  return c.json({
    pledges: rows.results.map((p) => ({
      id: p.id,
      campaignId: p.campaign_id,
      campaignTitle: p.campaign_title,
      campaignSlug: p.campaign_slug,
      amountCents: p.amount_cents,
      dayOfMonth: p.day_of_month,
      active: !!p.active,
      lastRemindedAt: p.last_reminded_at,
      partner: p.partner_user_id ? {
        userId: p.partner_user_id,
        username: p.partner_name,
        phone: p.partner_phone,
      } : null,
    })),
  });
});

// ---------- Gift Sponsorships (pay for someone else) ----------

app.post("/api/campaigns/:id/gift", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ? AND status = 'active'")
    .bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const body = await c.req.json();
  const amountCents = Math.round(Number(body.amountCents) || 0);
  if (amountCents < 100) return c.json({ error: "Minimum gift is K1.00" }, 400);

  const recipientPhone = normalizePhone(body.recipientPhone ?? "");
  if (!/^\+260\d{9}$/.test(recipientPhone)) {
    return c.json({ error: "Recipient must have a valid Zambian phone number" }, 400);
  }

  const recipient = await ensureUser(c.env.DB, recipientPhone);
  const phone = user.phone; // giver's phone for payment prompt
  const cfg = loadFeeConfig(c.env);
  const fees = donationFees(amountCents, cfg);
  const referenceId = `CON-GIFT-${campaign.id}-${Date.now()}`;

  const r = await c.env.DB.prepare(
    `INSERT INTO contributions (campaign_id, donor_user_id, giver_user_id, is_gift, donor_name, is_anonymous, hide_amount, phone, amount_cents, platform_fee_cents, lipila_fee_cents, lipila_reference, status)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(
    campaign.id,
    recipient.id,
    user.sub,
    String(body.donorName ?? "").trim() || null,
    body.isAnonymous ? 1 : 0,
    body.hideAmount ? 1 : 0,
    phone,
    amountCents,
    fees.platformFeeCents,
    fees.lipilaFeeCents,
    referenceId
  ).run();

  try {
    const result = await createCollection(c.env, {
      referenceId,
      amountCents,
      accountNumber: phone.replace("+", ""),
      narration: `Kingdom Sponsor gift to ${campaign.title}`,
      callbackUrl: `${c.env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(c.env.LIPILA_WEBHOOK_SECRET)}`,
    });
    await c.env.DB.prepare("UPDATE contributions SET lipila_identifier = ? WHERE id = ?")
      .bind(result.identifier, r.meta.last_row_id).run();
    return c.json({
      referenceId,
      message: "Check your phone and enter PIN to complete the gift.",
      platformFeeCents: fees.platformFeeCents,
    });
  } catch (e) {
    await c.env.DB.prepare("UPDATE contributions SET status = 'failed' WHERE id = ?")
      .bind(r.meta.last_row_id).run();
    console.error("gift collection failed:", e);
    return c.json({ error: "Gift payment could not be started. Try again." }, 502);
  }
});

app.post("/api/campaigns/:id/join-group", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ? AND status = 'active'")
    .bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (!campaign.min_sponsors || campaign.min_sponsors <= 1) {
    return c.json({ error: "This campaign does not require group sponsors" }, 400);
  }

  // Check if already a sponsor
  const existing = await c.env.DB.prepare(
    "SELECT id FROM campaign_sponsors WHERE campaign_id = ? AND user_id = ?"
  ).bind(campaign.id, user.sub).first();
  if (existing) return c.json({ error: "You are already a sponsor of this group" }, 400);

  // Add as sponsor (zero amount for now; actual donation happens separately)
  await c.env.DB.prepare(
    "INSERT INTO campaign_sponsors (campaign_id, user_id) VALUES (?, ?)"
  ).bind(campaign.id, user.sub).run();

  // Increment sponsor count
  await c.env.DB.prepare(
    "UPDATE campaigns SET sponsor_count = sponsor_count + 1 WHERE id = ?"
  ).bind(campaign.id).run();

  return c.json({ ok: true, message: "Joined group sponsorship. Complete a donation to activate." });
});

app.get("/api/campaigns/:id/group-status", async (c) => {
  const campaign = await c.env.DB.prepare("SELECT id, title, min_sponsors, sponsor_count, status FROM campaigns WHERE id = ?")
    .bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const sponsors = await c.env.DB.prepare(
    `SELECT cs.user_id, u.username, u.phone, cs.joined_at
     FROM campaign_sponsors cs JOIN users u ON u.id = cs.user_id
     WHERE cs.campaign_id = ?`
  ).bind(campaign.id).all<Record<string, any>>();

  return c.json({
    campaignId: campaign.id,
    title: campaign.title,
    minSponsors: campaign.min_sponsors,
    currentSponsors: campaign.sponsor_count,
    isUnlocked: campaign.sponsor_count >= (campaign.min_sponsors || 1),
    sponsors: sponsors.results.map((s) => ({
      userId: s.user_id,
      username: s.username,
      phone: s.phone,
      joinedAt: s.joined_at,
    })),
  });
});

// ---------- host announcements ----------

app.get("/api/campaigns/:id/announcements", async (c) => {
  const campaign = await c.env.DB.prepare("SELECT id, status FROM campaigns WHERE id = ?")
    .bind(c.req.param("id")).first<{ id: number; status: string }>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.status === "draft") return c.json({ error: "Campaign not found" }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.body, a.created_at, u.username AS author
     FROM announcements a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.campaign_id = ? ORDER BY a.created_at DESC LIMIT 50`
  ).bind(campaign.id).all<Record<string, any>>();

  return c.json({
    announcements: rows.results.map((a) => ({
      id: a.id,
      body: a.body,
      author: a.username ?? "Host",
      createdAt: a.created_at,
    })),
  });
});

app.post("/api/campaigns/:id/announcements", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const me = await c.env.DB.prepare("SELECT is_admin, is_host, host_status FROM users WHERE id = ?")
    .bind(user.sub).first<Record<string, any>>();
  const isHost = campaign.host_user_id === user.sub && me?.host_status === "approved";
  if (!isHost && me?.is_admin !== 1) {
    return c.json({ error: "Only the campaign host can post announcements" }, 403);
  }

  const body = await c.req.json();
  const text = String(body.body ?? "").trim();
  if (!text || text.length > 500) {
    return c.json({ error: "Announcement must be 1-500 characters" }, 400);
  }

  const r = await c.env.DB.prepare(
    "INSERT INTO announcements (campaign_id, user_id, body) VALUES (?, ?, ?)"
  ).bind(campaign.id, user.sub, text).run();

  // Push to every confirmed donor of this campaign with an FCM token.
  if (envPushConfigured(c.env)) {
    const donors = await c.env.DB.prepare(
      `SELECT DISTINCT u.fcm_token FROM contributions co
       JOIN users u ON u.id = co.donor_user_id
       WHERE co.campaign_id = ? AND co.status = 'confirmed' AND u.fcm_token IS NOT NULL`
    ).bind(campaign.id).all<{ fcm_token: string }>();
    const tokens = donors.results.map((d) => d.fcm_token);
    if (tokens.length) {
      await sendMulticastPush(
        { FIREBASE_CLIENT_EMAIL: c.env.FIREBASE_CLIENT_EMAIL!, FIREBASE_PRIVATE_KEY: c.env.FIREBASE_PRIVATE_KEY! },
        tokens,
        `${campaign.title} update`,
        text.slice(0, 100),
        { type: "announcement", campaignId: String(campaign.id) }
      ).catch((e) => console.error("announcement push failed:", e));
    }
  }

  return c.json({ ok: true, id: r.meta.last_row_id, createdAt: new Date().toISOString() });
});

// ---------- Couple/Family Account Linking ----------

app.post("/api/user/link", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const body = await c.req.json();
  const targetPhone = normalizePhone(body.targetPhone ?? "");
  if (!/^\+260\d{9}$/.test(targetPhone)) {
    return c.json({ error: "Valid Zambian phone number required" }, 400);
  }
  if (targetPhone === user.phone) {
    return c.json({ error: "Cannot link to yourself" }, 400);
  }

  const target = await ensureUser(c.env.DB, targetPhone);
  const linkType = String(body.linkType ?? "family"); // family | couple | team

  // Check existing link
  const existing = await c.env.DB.prepare(
    "SELECT * FROM user_links WHERE (user_id = ? AND linked_user_id = ?) OR (user_id = ? AND linked_user_id = ?)"
  ).bind(user.sub, target.id, target.id, user.sub).first();
  if (existing) {
    return c.json({ error: "Link already exists", status: existing.status }, 400);
  }

  await c.env.DB.prepare(
    "INSERT INTO user_links (user_id, linked_user_id, link_type, status) VALUES (?, ?, ?, 'pending')"
  ).bind(user.sub, target.id, linkType).run();

  // Send SMS to target user
  const me = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?").bind(user.sub).first<{ username: string }>();
  await sendSms(c.env, target.phone,
    `${me?.username ?? "A Kingdom Sponsor user"} wants to link accounts as ${linkType}. Open Kingdom Sponsor to accept.`
  ).catch((e) => console.error("link sms failed:", e));

  return c.json({ ok: true, message: "Link request sent. Waiting for acceptance." });
});

app.get("/api/user/links", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const rows = await c.env.DB.prepare(
    `SELECT ul.*, u.username AS other_username, u.phone AS other_phone
     FROM user_links ul
     JOIN users u ON u.id = CASE WHEN ul.linked_user_id = ? THEN ul.user_id ELSE ul.linked_user_id END
     WHERE ul.user_id = ? OR ul.linked_user_id = ?`
  ).bind(user.sub, user.sub, user.sub).all<Record<string, any>>();

  return c.json({
    links: rows.results.map((l) => ({
      id: l.id,
      linkType: l.link_type,
      status: l.status,
      isInitiator: l.user_id === user.sub,
      otherUser: {
        userId: l.user_id === user.sub ? l.linked_user_id : l.user_id,
        username: l.other_username ?? "Giver",
        phone: l.other_phone ?? "",
      },
      createdAt: l.created_at,
    })),
  });
});

app.post("/api/user/links/:id/accept", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  await c.env.DB.prepare(
    "UPDATE user_links SET status = 'accepted' WHERE id = ? AND linked_user_id = ? AND status = 'pending'"
  ).bind(c.req.param("id"), user.sub).run();

  return c.json({ ok: true, message: "Account linked successfully." });
});

app.post("/api/user/links/:id/reject", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  await c.env.DB.prepare(
    "UPDATE user_links SET status = 'rejected' WHERE id = ? AND linked_user_id = ? AND status = 'pending'"
  ).bind(c.req.param("id"), user.sub).run();

  return c.json({ ok: true, message: "Link request rejected." });
});

app.delete("/api/user/links/:id", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  await c.env.DB.prepare(
    "DELETE FROM user_links WHERE id = ? AND (user_id = ? OR linked_user_id = ?)"
  ).bind(c.req.param("id"), user.sub, user.sub).run();

  return c.json({ ok: true, message: "Link removed." });
});

// Update envUpsertPledge to support partner
/** Insert or update a pledge (one per donor per campaign). */
async function envUpsertPledge(env: Bindings, campaignId: number, userId: number, phone: string, amountCents: number, dayOfMonth: number, partnerUserId?: number): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT id FROM recurring_pledges WHERE campaign_id = ? AND user_id = ?"
  ).bind(campaignId, userId).first<Record<string, any>>();
  if (existing) {
    await env.DB.prepare(
      "UPDATE recurring_pledges SET amount_cents = ?, day_of_month = ?, active = 1, partner_user_id = ? WHERE id = ?"
    ).bind(amountCents, dayOfMonth, partnerUserId ?? null, existing.id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO recurring_pledges (campaign_id, user_id, phone, amount_cents, day_of_month, partner_user_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(campaignId, userId, phone, amountCents, dayOfMonth, partnerUserId ?? null).run();
  }
}

// ---------- promoted campaigns (paid top-5 slots) ----------

app.post("/api/campaigns/:id/promote", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ? AND host_user_id = ?")
    .bind(c.req.param("id"), user.sub).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.promoted) return c.json({ error: "This campaign is already promoted." }, 400);
  if (await activePromotionCount(c.env) >= PROMO_SLOTS) {
    return c.json({ error: "All promotion slots are taken. Wait for a slot to open." }, 409);
  }

  const price = await promoPrice(c.env);
  const days = await promoDays(c.env);
  const referenceId = `PRO-${campaign.id}-${Date.now()}`;

  const r = await c.env.DB.prepare(
    "INSERT INTO promotions (campaign_id, amount_cents, days, lipila_reference) VALUES (?, ?, ?, ?)"
  ).bind(campaign.id, price, days, referenceId).run();

  try {
    const result = await createCollection(c.env, {
      referenceId,
      amountCents: price,
      accountNumber: user.phone.replace("+", ""),
      narration: `Kingdom Sponsor promotion for ${campaign.title}`,
      callbackUrl: `${c.env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(c.env.LIPILA_WEBHOOK_SECRET)}`,
    });
    await c.env.DB.prepare("UPDATE promotions SET lipila_reference = ? WHERE id = ?")
      .bind(referenceId, r.meta.last_row_id).run();
    return c.json({
      referenceId,
      message: `Confirm the K${(price / 100).toLocaleString()} payment on your phone to go to the top for ${days} days.`,
      priceCents: price,
      days,
    });
  } catch (e) {
    await c.env.DB.prepare("UPDATE promotions SET status = 'failed' WHERE id = ?")
      .bind(r.meta.last_row_id).run();
    console.error("promotion collection failed:", e);
    return c.json({ error: "Promotion payment could not be started. Try again." }, 502);
  }
});

app.get("/api/promotions/info", async (c) => {
  const slots = PROMO_SLOTS;
  const active = await activePromotionCount(c.env);
  return c.json({
    slots,
    active,
    available: Math.max(0, slots - active),
    priceCents: await promoPrice(c.env),
    days: await promoDays(c.env),
    promotedIds: (await c.env.DB.prepare("SELECT id FROM campaigns WHERE promoted = 1").all()).results.map((r: any) => r.id),
  });
});

// ---------- superadmin promotion settings (paywall) ----------

app.get("/api/admin/promotion-config", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  return c.json({
    priceCents: await promoPrice(c.env),
    days: await promoDays(c.env),
    slots: PROMO_SLOTS,
  });
});

app.post("/api/admin/promotion-config", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const price = Math.round(Number(body.priceCents));
  const days = Math.round(Number(body.days));
  if (!Number.isFinite(price) || price < 1000 || price > 200000) {
    return c.json({ error: "Price must be between K10 and K2,000." }, 400);
  }
  if (!Number.isFinite(days) || days < 1 || days > 30) {
    return c.json({ error: "Days must be between 1 and 30." }, 400);
  }

  await c.env.DB.batch([
    envDB(c).prepare("INSERT INTO app_settings (key, value) VALUES ('promo_price_cents', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(price)),
    envDB(c).prepare("INSERT INTO app_settings (key, value) VALUES ('promo_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(days)),
  ]);
  return c.json({ ok: true, priceCents: price, days });
});

function envDB(c: any): D1Database {
  return c.env.DB;
}

// Host's own promotion history (paid + pending + rejected).
app.get("/api/me/promotions", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const rows = await c.env.DB.prepare(
    `SELECT p.*, c.title AS campaign_title
     FROM promotions p JOIN campaigns c ON c.id = p.campaign_id
     WHERE c.host_user_id = ? ORDER BY p.created_at DESC LIMIT 20`
  ).bind(user.sub).all<Record<string, any>>();

  return c.json({
    promotions: rows.results.map((p) => ({
      id: p.id,
      campaignId: p.campaign_id,
      campaignTitle: p.campaign_title,
      amountCents: p.amount_cents,
      days: p.days,
      status: p.status,
      reference: p.lipila_reference,
      expiresAt: p.expires_at,
      createdAt: p.created_at,
    })),
  });
});

// ---------- referrals ----------

app.get("/api/me/referral", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const code = await ensureReferralCode(c.env, user.sub);
  return c.json({ code, shareUrl: `${c.env.APP_URL}/share?ref=${code}` });
});

app.get("/api/me/referrals", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const stats = (await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM referrals WHERE referrer_user_id = ?) AS total,
       (SELECT COUNT(*) FROM referrals r WHERE r.referrer_user_id = ? AND r.created_at >= datetime('now', '-30 days')) AS last30d`
  ).bind(user.sub, user.sub).first<{ total: number; last30d: number }>()) ?? { total: 0, last30d: 0 };

  const rows = await c.env.DB.prepare(
    `SELECT r.created_at, u.username, u.phone
     FROM referrals r JOIN users u ON u.id = r.referred_user_id
     WHERE r.referrer_user_id = ? ORDER BY r.created_at DESC LIMIT 20`
  ).bind(user.sub).all<Record<string, any>>();

  return c.json({
    total: stats.total,
    last30d: stats.last30d,
    referrals: rows.results.map((r) => ({
      username: r.username ?? "Giver",
      phone: r.phone,
      date: r.created_at,
    })),
  });
});

// ---------- PDF receipts ----------

interface ReceiptInput {
  receiptNumber: string;
  donorName: string;
  donorPhone: string;
  campaignTitle: string;
  amountCents: number;
  platformFeeCents: number;
  lipilaFeeCents: number;
  reference: string;
  date: string;
  status: string;
}

async function buildReceiptPdf(i: ReceiptInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([540, 720]);
  const { width } = page.getSize();

  // Header band
  page.drawRectangle({
    x: 0, y: page.getSize().height - 80, width: width, height: 80,
    color: rgb(0.12, 0.38, 0.72),
  });
  page.drawText("Kingdom Sponsor", { x: 50, y: page.getSize().height - 30, size: 22, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Official Donation Receipt", { x: 50, y: page.getSize().height - 52, size: 13, font, color: rgb(0.9, 0.9, 0.95) });

  let y = page.getSize().height - 100;
  page.drawRectangle({
    x: 50, y: y - 4, width: width - 100, height: 1,
    color: rgb(0.8, 0.85, 0.92),
  });
  y -= 20;

  const row = (label: string, value: string) => {
    page.drawText(label, { x: 50, y, size: 11, font });
    page.drawText(value, { x: 240, y, size: 11, font: bold });
    y -= 20;
  };

  row("Receipt no.", i.receiptNumber);
  row("Donor", i.donorName);
  row("Donor phone", i.donorPhone);
  row("Campaign", i.campaignTitle);
  row("Reference", i.reference);
  row("Date", new Date(i.date).toLocaleDateString("en-ZM", { year: 'numeric', month: 'long', day: 'numeric' }));
  row("Status", i.status === "confirmed" ? "Confirmed" : i.status);

  y -= 8;
  page.drawRectangle({
    x: 50, y: y - 4, width: width - 100, height: 1,
    color: rgb(0.8, 0.85, 0.92),
  });
  y -= 24;
  page.drawText("Amount donated:", { x: 50, y, size: 12, font: bold, color: rgb(0.12, 0.38, 0.72) });
  page.drawText(`K${(i.amountCents / 100).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, { x: 330, y, size: 12, font: bold });

  y -= 20;
  page.drawText("Processing fee (payment gateway + platform):", { x: 50, y, size: 10, font, color: rgb(0.5, 0.5, 0.5) });
  y -= 16;
  const processingFee = i.platformFeeCents + i.lipilaFeeCents;
  page.drawText(`K${(processingFee / 100).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, { x: 330, y, size: 10, font: bold });

  y -= 16;
  page.drawRectangle({
    x: 50, y: y - 4, width: width - 100, height: 1,
    color: rgb(0.8, 0.85, 0.92),
  });
  y -= 22;
  const received = i.amountCents - processingFee;
  page.drawText("Campaign receives:", { x: 50, y, size: 11, font: bold, color: rgb(0.12, 0.38, 0.72) });
  page.drawText(`K${(received / 100).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, { x: 240, y, size: 11, font: bold });

  y -= 50;
  page.drawText("Thank you for giving to Zambia.", { x: 50, y, size: 10, font });
  y -= 14;
  page.drawText("This receipt was issued automatically and records your gift for your records.", { x: 50, y, size: 9, font, color: rgb(0.45, 0.5, 0.55) });
  y -= 12;
  page.drawText("Kingdom Sponsor  •  kingdom-sponsor.app  •  Built with purpose", { x: 50, y, size: 8, font, color: rgb(0.6, 0.6, 0.6) });

  return doc.save();
}

app.get("/api/contributions/:id/receipt", async (c) => {
  let user = await authUser(c);
  if (!user) {
    const qToken = String(c.req.query("token") ?? "");
    if (qToken) {
      const payload = await verifyToken(qToken, c.env.JWT_SECRET as string);
      if (payload) user = payload;
    }
  }
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const row = await c.env.DB.prepare(
    `SELECT co.*, cam.title AS campaign_title, cam.host_user_id
     FROM contributions co JOIN campaigns cam ON cam.id = co.campaign_id WHERE co.id = ?`
  ).bind(c.req.param("id")).first<Record<string, any>>();
  if (!row) return c.json({ error: "Not found" }, 404);

  const admin = await requireAdmin(c);
  if (row.phone !== user.phone && row.host_user_id !== user.sub && !admin) {
    return c.json({ error: "Not your receipt" }, 403);
  }

  // Track the download for growth stats (every generation counts as a download).
  await c.env.DB.prepare(
    "INSERT INTO receipt_downloads (contribution_id, downloaded_by, phone) VALUES (?, ?, ?)"
  ).bind(row.id, user.sub, user.phone).run();

  const donorName = row.is_anonymous ? "Anonymous" : (String(row.donor_name ?? "").trim() || "Anonymous");
  const pdf = await buildReceiptPdf({
    receiptNumber: `KS-${String(row.id).padStart(6, "0")}`,
    donorName,
    donorPhone: row.phone,
    campaignTitle: row.campaign_title,
    amountCents: row.amount_cents,
    platformFeeCents: row.platform_fee_cents,
    lipilaFeeCents: row.lipila_fee_cents,
    reference: row.lipila_reference,
    date: row.confirmed_at ?? row.created_at,
    status: row.status,
  });
  return new Response(pdf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="kingdom-sponsor-receipt-${row.id}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
});

/** Donor's own confirmed contributions (for the "My receipts" screen). */
app.get("/api/me/receipts", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const rows = await c.env.DB.prepare(
    `SELECT co.id, co.amount_cents, co.lipila_reference, co.confirmed_at, co.created_at,
            cam.title AS campaign_title
     FROM contributions co JOIN campaigns cam ON cam.id = co.campaign_id
     WHERE co.phone = ? AND co.status = 'confirmed'
     ORDER BY co.confirmed_at DESC LIMIT 100`
  ).bind(user.phone).all<Record<string, any>>();

  return c.json({
    receipts: rows.results.map((r) => ({
      id: r.id,
      campaignTitle: r.campaign_title,
      amountCents: r.amount_cents,
      reference: r.lipila_reference,
      date: r.confirmed_at ?? r.created_at,
    })),
  });
});

// ---------- support tickets ----------

app.post("/api/support/tickets", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const body = await c.req.json();
  const subject = String(body.subject ?? "").trim();
  const message = String(body.message ?? "").trim();
  if (!subject || subject.length > 120) return c.json({ error: "Subject is required (max 120 characters)." }, 400);
  if (!message || message.length > 2000) return c.json({ error: "Message is required (max 2000 characters)." }, 400);

  const r = await c.env.DB.prepare(
    "INSERT INTO support_tickets (user_id, phone, subject, message) VALUES (?, ?, ?, ?)"
  ).bind(user.sub, user.phone, subject, message).run();
  const ticketId = Number(r.meta.last_row_id);

  // Notify the superadmin(s) so tickets are answered fast.
  await pushAndSmsAdmins(c.env, supportReceivedSms(ticketId, subject),
    "New support request", `#${ticketId}: ${subject}`).catch(() => {});

  return c.json({ ok: true, id: ticketId });
});

app.get("/api/support/tickets", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const rows = await c.env.DB.prepare(
    `SELECT id, subject, message, status, admin_reply, created_at, updated_at
     FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(user.sub).all<Record<string, any>>();

  return c.json({
    tickets: rows.results.map((t) => ({
      id: t.id,
      subject: t.subject,
      message: t.message,
      status: t.status,
      adminReply: t.admin_reply,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    })),
  });
});

app.post("/api/support/tickets/:id/reply", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const body = await c.req.json();
  const text = String(body.message ?? "").trim();
  if (!text || text.length > 2000) return c.json({ error: "Message is required (max 2000 characters)." }, 400);

  const ticket = await c.env.DB.prepare(
    "SELECT * FROM support_tickets WHERE id = ?"
  ).bind(c.req.param("id")).first<Record<string, any>>();
  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  const me = await c.env.DB.prepare("SELECT is_admin FROM users WHERE id = ?")
    .bind(user.sub).first<{ is_admin: number | null }>();

  if (me?.is_admin === 1) {
    // Admin answers: mark answered and notify the user.
    await c.env.DB.prepare(
      "UPDATE support_tickets SET admin_reply = ?, status = 'answered', updated_at = datetime('now', '+2 hours') WHERE id = ?"
    ).bind(text, ticket.id).run();
    await sendSms(c.env, ticket.phone, supportReplySms(ticket.subject))
      .catch((e) => console.error("ticket reply sms failed:", e));
    await pushToUser(c.env, ticket.user_id, "Support replied",
      `Your request "${ticket.subject}" has a new reply.`, { type: "ticket_reply", ticketId: String(ticket.id) })
      .catch((e) => console.error("ticket reply push failed:", e));
  } else {
    // User replies: reopen the ticket.
    if (ticket.user_id !== user.sub) return c.json({ error: "Not your ticket" }, 403);
    await c.env.DB.prepare(
      "UPDATE support_tickets SET message = ?, status = 'open', updated_at = datetime('now', '+2 hours') WHERE id = ?"
    ).bind(text, ticket.id).run();
    await pushAndSmsAdmins(c.env, supportReceivedSms(ticket.id, `re: ${ticket.subject}`),
      "Ticket reopened", `#${ticket.id}: ${ticket.subject}`).catch(() => {});
  }

  return c.json({ ok: true });
});

app.get("/api/admin/tickets", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const status = String(c.req.query("status") ?? "").toLowerCase();
  const rows = await c.env.DB.prepare(
    `SELECT t.*, u.username
     FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id
     WHERE (? = '' OR lower(t.status) = ?)
     ORDER BY t.created_at DESC LIMIT 200`
  ).bind(status, status).all<Record<string, any>>();

  return c.json({
    tickets: rows.results.map((t) => ({
      id: t.id,
      phone: t.phone,
      username: t.username ?? null,
      subject: t.subject,
      message: t.message,
      status: t.status,
      adminReply: t.admin_reply,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    })),
  });
});

// ---------- campaign deletion (admin only) + host delete requests ----------

app.post("/api/campaigns/:id/delete-request", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ? AND host_user_id = ?")
    .bind(c.req.param("id"), user.sub).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.status === "deleted") return c.json({ error: "Campaign already deleted." }, 400);

  const existing = await c.env.DB.prepare(
    "SELECT id FROM campaign_delete_requests WHERE campaign_id = ? AND status = 'pending'"
  ).bind(campaign.id).first<Record<string, any>>();
  if (existing) return c.json({ error: "A delete request is already pending." }, 409);

  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason ?? "").trim().slice(0, 500);

  await c.env.DB.prepare(
    "INSERT INTO campaign_delete_requests (campaign_id, reason) VALUES (?, ?)"
  ).bind(campaign.id, reason || null).run();

  await sendSms(c.env, user.phone, deleteRequestReceivedSms(campaign.title))
    .catch((e) => console.error("delete-request sms failed:", e));
  await pushToUser(c.env, user.sub, "Delete request received",
    `We'll review your request to remove "${campaign.title}".`, { type: "delete_request", campaignId: String(campaign.id) })
    .catch((e) => console.error("delete-request push failed:", e));
  await pushAndSmsAdmins(c.env, `New delete request for campaign "${campaign.title}".`,
    "Campaign delete request", `"${campaign.title}" wants to be removed.`).catch(() => {});

  return c.json({ ok: true });
});

app.get("/api/admin/delete-requests", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const rows = await c.env.DB.prepare(
    `SELECT dr.id, dr.campaign_id, dr.reason, dr.status, dr.created_at,
            cam.title AS campaign_title, u.phone AS host_phone, u.username AS host_username
     FROM campaign_delete_requests dr
     JOIN campaigns cam ON cam.id = dr.campaign_id
     LEFT JOIN users u ON u.id = cam.host_user_id
     WHERE dr.status = 'pending' ORDER BY dr.created_at ASC LIMIT 100`
  ).all<Record<string, any>>();

  return c.json({
    requests: rows.results.map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      campaignTitle: r.campaign_title,
      reason: r.reason,
      status: r.status,
      hostPhone: r.host_phone,
      hostUsername: r.host_username,
      createdAt: r.created_at,
    })),
  });
});

/** Soft-delete a campaign (financial records are kept for compliance; campaign becomes invisible). */
async function deleteCampaign(env: Bindings, campaignId: number): Promise<void> {
  const campaign = await env.DB.prepare(
    "SELECT c.*, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(campaignId).first<Record<string, any>>();
  if (!campaign) return;

  await env.DB.batch([
    env.DB.prepare("UPDATE campaigns SET status = 'deleted', promoted = 0 WHERE id = ?").bind(campaignId),
    env.DB.prepare("UPDATE promotions SET status = 'cancelled' WHERE campaign_id = ? AND status IN ('pending','pending_approval','active')").bind(campaignId),
  ]);

  if (campaign.host_phone) {
    await sendSms(env, campaign.host_phone, campaignDeletedSms(campaign.title))
      .catch((e) => console.error("campaign-deleted sms failed:", e));
    await pushToUser(env, campaign.host_user_id, "Campaign removed",
      `"${campaign.title}" has been removed from Kingdom Sponsor.`, { type: "campaign_deleted", campaignId: String(campaignId) })
      .catch((e) => console.error("campaign-deleted push failed:", e));
  }
}

app.post("/api/admin/campaigns/:id/delete", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?")
    .bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.status === "deleted") return c.json({ error: "Campaign already deleted." }, 400);

  await deleteCampaign(c.env, campaign.id);
  await c.env.DB.prepare(
    "UPDATE campaign_delete_requests SET status = 'approved', resolved_at = datetime('now', '+2 hours') WHERE campaign_id = ? AND status = 'pending'"
  ).bind(campaign.id).run();

  return c.json({ ok: true });
});

app.post("/api/admin/delete-requests/:id/approve", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const req = await c.env.DB.prepare("SELECT * FROM campaign_delete_requests WHERE id = ? AND status = 'pending'")
    .bind(c.req.param("id")).first<Record<string, any>>();
  if (!req) return c.json({ error: "Request not found" }, 404);

  await deleteCampaign(c.env, req.campaign_id);
  await c.env.DB.prepare(
    "UPDATE campaign_delete_requests SET status = 'approved', resolved_at = datetime('now', '+2 hours') WHERE id = ?"
  ).bind(req.id).run();
  return c.json({ ok: true });
});

app.post("/api/admin/delete-requests/:id/reject", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const req = await c.env.DB.prepare("SELECT * FROM campaign_delete_requests WHERE id = ? AND status = 'pending'")
    .bind(c.req.param("id")).first<Record<string, any>>();
  if (!req) return c.json({ error: "Request not found" }, 404);

  await c.env.DB.prepare(
    "UPDATE campaign_delete_requests SET status = 'rejected', resolved_at = datetime('now', '+2 hours') WHERE id = ?"
  ).bind(req.id).run();

  const campaign = await c.env.DB.prepare(
    "SELECT c.title, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(req.campaign_id).first<Record<string, any>>();
  if (campaign?.host_phone) {
    await sendSms(c.env, campaign.host_phone, deleteRequestRejectedSms(campaign.title))
      .catch((e) => console.error("delete-reject sms failed:", e));
    await pushToUser(c.env, campaign.host_user_id, "Delete request declined",
      `Your request to remove "${campaign.title}" was declined.`, { type: "delete_request_rejected", campaignId: String(req.campaign_id) })
      .catch((e) => console.error("delete-reject push failed:", e));
  }
  return c.json({ ok: true });
});

// ---------- Lipila webhook (async confirmations + payout results) ----------

const _enc = new TextEncoder();

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify Lipila's HMAC-SHA256 webhook signature (Standard Webhooks scheme). */
async function verifyLipilaSignature(c: any, rawBody: string): Promise<boolean> {
  const id = c.req.header("webhook-id");
  const ts = c.req.header("webhook-timestamp");
  const sigHeader = c.req.header("webhook-signature");
  if (!id || !ts || !sigHeader) return false;
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return false;
  const age = Math.floor(Date.now() / 1000) - tsNum;
  if (age > 300 || age < -60) return false; // replay window

  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(c.env.LIPILA_WEBHOOK_SECRET);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, _enc.encode(`${id}.${ts}.${rawBody}`));
  const expected = "v1," + bytesToBase64(new Uint8Array(mac));
  for (const candidate of sigHeader.split(" ")) {
    const trimmed = candidate.trim();
    if (trimmed && constantTimeEq(expected, trimmed)) return true;
  }
  return false;
}

app.post("/api/webhooks/lipila", async (c) => {
  const qs = c.req.query("secret");
  let authed = !!(qs && qs === c.env.LIPILA_WEBHOOK_SECRET);
  let rawBody = "";
  if (!authed) {
    rawBody = await c.req.text().catch(() => "");
    authed = await verifyLipilaSignature(c, rawBody);
  }
  if (!authed) return c.json({ error: "Unauthorized" }, 401);

  const body = rawBody ? JSON.parse(rawBody) : await c.req.json().catch(() => ({}));
  const referenceId = body.referenceId ?? body.reference_id;
  if (!referenceId) return c.json({ ok: false, error: "No referenceId" }, 400);

  const status = String(body.status ?? "").toLowerCase();
  const type = String(body.type ?? body.transactionType ?? "").toLowerCase();
  const isDisbursement = type.includes("disburs") || referenceId.startsWith("PAY-") || referenceId.startsWith("SET-") || referenceId.startsWith("SWEEP-") || referenceId.startsWith("REF-");
  const isCollection = type.includes("collection") || referenceId.startsWith("CON-");

  if (referenceId.startsWith("REF-") && (status.includes("success") || status.includes("complete"))) {
    await confirmRefund(c.env, referenceId);
  } else if (referenceId.startsWith("PRO-") && (status.includes("success") || status.includes("complete"))) {
    await confirmPromotion(c.env, referenceId);
  } else if (isDisbursement && (status.includes("success") || status.includes("complete"))) {
    if (referenceId.startsWith("SET-") || referenceId.startsWith("SWEEP-")) {
      await confirmFeeSweep(c.env, referenceId);
    } else {
      await confirmWithdrawal(c.env, referenceId);
    }
  } else if (isCollection && (status.includes("success") || status.includes("complete"))) {
    await confirmContribution(c.env, referenceId);
  } else if (isCollection && (status.includes("fail") || status.includes("cancel"))) {
    await failContribution(c.env, referenceId);
  }

  return c.json({ ok: true });
});

// Africa's Talking SMS callbacks. One endpoint for every SMS callback field in
// the AT dashboard (SMS -> SMS Callback URLs): delivery reports, incoming
// messages, bulk SMS opt-outs, subscription notifications. AT POSTs
// form-encoded or JSON payloads; we only log and always answer 200 so AT never
// retries. (We don't act on inbound messages/opt-outs yet.)
app.post("/api/webhooks/at-sms", async (c) => {
  const body = await c.req.text().catch(() => "");
  const form = new URLSearchParams(body);
  let rec: Record<string, string | null> = {
    id: form.get("id"),
    status: form.get("status"),
    phoneNumber: form.get("phoneNumber") ?? form.get("from"),
    cost: form.get("cost"),
  };
  if (!rec.id && !rec.status) {
    try {
      const json = JSON.parse(body);
      if (json && typeof json === "object") {
        rec = {
          id: json.id ?? null,
          status: json.status ?? null,
          phoneNumber: json.phoneNumber ?? json.from ?? null,
          cost: json.cost ?? null,
        };
      }
    } catch {
      // not JSON; keep the empty form parse above
    }
  }
  if (rec.status && rec.status !== "Success") {
    console.error(`[AT SMS] delivery ${rec.status} for ${rec.id} -> ${rec.phoneNumber}`);
  }
  console.log("[AT SMS webhook]", JSON.stringify(rec));
  return c.text("OK", 200);
});

// ---------- host dashboard ----------

app.get("/api/host/me", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const me = (await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.sub).first<Record<string, any>>()) ?? {};
  const totalGiven = await donorTotalCents(c.env.DB, user.sub);

  const campaigns = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE host_user_id = ? AND status != 'deleted' ORDER BY created_at DESC"
  ).bind(user.sub).all<Record<string, any>>();
  const out = [];
  for (const row of campaigns.results) {
    const available = await availableBalance(c.env, row.id);
    out.push({ ...(await campaignPublic(c.env, row)), availableCents: available, minWithdrawCents: row.min_withdraw_cents });
  }

  const transactions = await c.env.DB.prepare(
    `SELECT co.id, co.campaign_id, c.title AS campaign_title, co.donor_name, co.is_anonymous, co.phone, co.amount_cents,
            co.platform_fee_cents, co.lipila_fee_cents, co.status, co.lipila_reference, co.created_at
     FROM contributions co JOIN campaigns c ON c.id = co.campaign_id
     WHERE c.host_user_id = ? AND co.status = 'confirmed' ORDER BY co.created_at DESC LIMIT 100`
  ).bind(user.sub).all<Record<string, any>>();

  const payouts = await c.env.DB.prepare(
    `SELECT w.id, w.campaign_id, c.title AS campaign_title, w.amount_cents, w.disbursement_fee_cents,
            w.platform_fee_cents, w.status, w.lipila_reference, w.created_at
     FROM withdrawals w JOIN campaigns c ON c.id = w.campaign_id
     WHERE c.host_user_id = ? ORDER BY w.created_at DESC LIMIT 100`
  ).bind(user.sub).all<Record<string, any>>();

  return c.json({
    user: {
      id: user.sub,
      phone: user.phone,
      username: me.username ?? "Giver",
      name: me.name ?? null,
      avatarUrl: me.avatar_url ?? null,
      isHost: user.isHost,
      isAdmin: isAdminPhone(c.env, user.phone),
      hostStatus: me.host_status ?? "none",
      hostOrg: me.host_org ?? null,
      hostRole: me.host_role ?? null,
      hostRejection: me.host_rejection ?? null,
      totalGivenCents: totalGiven,
      tier: tierFor(totalGiven),
    },
    campaigns: out,
    transactions: transactions.results.map((t) => ({
      id: t.id,
      campaignTitle: t.campaign_title,
      name: t.is_anonymous ? "Anonymous" : t.donor_name ?? t.phone,
      phone: t.phone,
      amountCents: t.amount_cents,
      platformFeeCents: t.platform_fee_cents,
      lipilaFeeCents: t.lipila_fee_cents,
      status: t.status,
      date: t.created_at,
    })),
    payouts: payouts.results.map((w) => ({
      id: w.id,
      campaignTitle: w.campaign_title,
      amountCents: w.amount_cents,
      disbursementFeeCents: w.disbursement_fee_cents,
      platformFeeCents: w.platform_fee_cents,
      status: w.status,
      reference: w.lipila_reference,
      date: w.created_at,
    })),
  });
});

// ---------- profile: edit display name / username ----------

app.post("/api/me", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const me = (await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.sub).first<Record<string, any>>()) ?? {};
  const body = await c.req.json();

  const name = String(body.name ?? "").trim();
  if (name.length > 60) {
    return c.json({ error: "Name must be 60 characters or fewer" }, 400);
  }

  let username: string | null = null;
  if (typeof body.username === "string" && body.username.trim() !== "") {
    username = String(body.username).trim();
    if (username.length < 3 || username.length > 24 || !/^[A-Za-z0-9_]+$/.test(username)) {
      return c.json({ error: "Username must be 3-24 letters, numbers or underscores" }, 400);
    }
    const clash = await c.env.DB.prepare(
      "SELECT id FROM users WHERE username = ? AND id != ?"
    ).bind(username, user.sub).first();
    if (clash) return c.json({ error: "That username is already taken" }, 400);
  }

  if (name !== (me.name ?? "") || (username !== null && username !== me.username)) {
    await c.env.DB.prepare("UPDATE users SET name = ?, username = COALESCE(?, username) WHERE id = ?")
      .bind(name || null, username, user.sub).run();
  }

  return c.json({
    ok: true,
    user: {
      id: user.sub,
      phone: user.phone,
      username: username ?? me.username ?? "Giver",
      name: name || null,
      isHost: !!me.is_host,
      isAdmin: isAdminPhone(c.env, user.phone),
      hostStatus: me.host_status ?? "none",
    },
  });
});

app.post("/api/campaigns/:id/withdraw", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ? AND host_user_id = ?")
    .bind(c.req.param("id"), user.sub).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const recentPayouts = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM withdrawals WHERE campaign_id = ? AND created_at > datetime('now', '-1 minute')"
  ).bind(campaign.id).first<{ n: number }>())?.n ?? 0;
  if (recentPayouts >= 2) return c.json({ error: "Too many payout requests. Wait a moment and try again." }, 429);

  const payoutCents = await createWithdrawal(c.env, campaign.id);
  const available = await availableBalance(c.env, campaign.id);
  return c.json({
    ok: payoutCents > 0,
    message: payoutCents > 0
      ? `Payout of ${formatKwacha(payoutCents)} sent to your mobile money.`
      : "Balance is below the minimum payout threshold.",
    availableCents: available,
  });
});

app.post("/api/campaigns/:id/end", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ? AND host_user_id = ?")
    .bind(c.req.param("id"), user.sub).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  await c.env.DB.prepare(
    "UPDATE campaigns SET status = 'ended', ended_at = datetime('now', '+2 hours') WHERE id = ?"
  ).bind(campaign.id).run();

  await createWithdrawal(c.env, campaign.id); // sweep any remainder below threshold

  // Final report to the campaign's donors (SMS for non-users + push for app users).
  const raised = (await c.env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS s FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
  ).bind(campaign.id).first<{ s: number }>())?.s ?? 0;
  const supporters = (await c.env.DB.prepare(
    "SELECT COUNT(DISTINCT COALESCE(phone, 'anon')) AS n FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
  ).bind(campaign.id).first<{ n: number }>())?.n ?? 0;

  const reportTitle = `"${campaign.title}" has ended`;
  const reportBody = `${formatKwacha(raised)} was raised from ${supporters} supporters. Thank you for giving!`;

  if (envPushConfigured(c.env)) {
    const donorTokens = await c.env.DB.prepare(
      `SELECT DISTINCT dt.token FROM device_tokens dt
       JOIN contributions co ON co.donor_user_id = dt.user_id
       WHERE co.campaign_id = ? AND co.status = 'confirmed'`
    ).bind(campaign.id).all<{ token: string }>();
    const tokens = donorTokens.results.map((d) => d.token);
    if (tokens.length) {
      await sendMulticastPush(fbEnv(c.env), tokens, reportTitle, reportBody,
        { type: "campaign_ended", campaignId: String(campaign.id) })
        .catch((e) => console.error("campaign end push failed:", e));
    }
  }

  // SMS to donors who gave by phone (deduped).
  const smsPhones = await c.env.DB.prepare(
    `SELECT DISTINCT phone FROM contributions
     WHERE campaign_id = ? AND status = 'confirmed' AND phone IS NOT NULL`
  ).bind(campaign.id).all<{ phone: string }>();
  for (const row of smsPhones.results) {
    await sendSms(c.env, row.phone, campaignEndedSms(campaign.title, raised, supporters))
      .catch((e) => console.error("campaign end sms failed:", e));
  }

  return c.json({ ok: true, message: "Campaign ended. Any remaining balance was swept to your mobile money." });
});

// ---------- superadmin ----------

async function requireAdmin(c: any): Promise<TokenPayload | null> {
  const user = await authUser(c);
  if (!user || !isAdminPhone(c.env, user.phone)) return null;
  return user;
}

app.get("/api/admin/applications", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const rows = await c.env.DB.prepare(
    `SELECT id, phone, username, host_status, host_org, host_role, host_reason, host_rejection, created_at
     FROM users WHERE host_status != 'none' ORDER BY
       CASE host_status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC`
  ).all<Record<string, any>>();

  return c.json({
    applications: rows.results.map((u) => ({
      id: u.id,
      phone: u.phone,
      username: u.username ?? "Giver",
      hostStatus: u.host_status,
      org: u.host_org,
      role: u.host_role,
      reason: u.host_reason,
      rejection: u.host_rejection,
      appliedAt: u.created_at,
    })),
  });
});

app.post("/api/admin/applications/:id/approve", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const r = await c.env.DB.prepare(
    "UPDATE users SET host_status = 'approved', is_host = 1, host_rejection = NULL WHERE id = ?"
  ).bind(c.req.param("id")).run();
  if (!r.meta.changes) return c.json({ error: "User not found" }, 404);
  return c.json({ ok: true });
});

app.post("/api/admin/applications/:id/reject", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason ?? "Not approved").trim();
  await c.env.DB.prepare(
    "UPDATE users SET host_status = 'rejected', is_host = 0, host_rejection = ? WHERE id = ?"
  ).bind(reason, c.req.param("id")).run();
  return c.json({ ok: true });
});

app.get("/api/admin/promotions", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const rows = await c.env.DB.prepare(
    `SELECT p.*, c.title AS campaign_title, u.phone AS host_phone
     FROM promotions p JOIN campaigns c ON c.id = p.campaign_id JOIN users u ON u.id = c.host_user_id
     ORDER BY p.created_at DESC LIMIT 50`
  ).all<Record<string, any>>();

  return c.json({
    promotions: rows.results.map((p) => ({
      id: p.id,
      campaignId: p.campaign_id,
      campaignTitle: p.campaign_title,
      hostPhone: p.host_phone,
      amountCents: p.amount_cents,
      days: p.days,
      status: p.status,
      reference: p.lipila_reference,
      expiresAt: p.expires_at,
      createdAt: p.created_at,
    })),
  });
});

app.post("/api/admin/promotions/:id/approve", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const id = Number(c.req.param("id"));
  const promo = await c.env.DB.prepare(
    "SELECT * FROM promotions WHERE id = ? AND status = 'pending_approval'"
  ).bind(id).first<Record<string, any>>();
  if (!promo) return c.json({ error: "No pending promotion with that id" }, 404);

  await approvePromotion(c.env, id);
  return c.json({ ok: true, message: "Promotion approved and now live." });
});

app.post("/api/admin/promotions/:id/reject", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const id = Number(c.req.param("id"));
  const promo = await c.env.DB.prepare(
    "SELECT * FROM promotions WHERE id = ? AND status = 'pending_approval'"
  ).bind(id).first<Record<string, any>>();
  if (!promo) return c.json({ error: "No pending promotion with that id" }, 404);

  await rejectPromotion(c.env, id);
  return c.json({ ok: true, message: "Promotion rejected. The host has been notified." });
});

// Refund the fee of a rejected or active promotion back to the host's mobile money.
app.post("/api/admin/promotions/:id/refund", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const id = Number(c.req.param("id"));
  const promo = await c.env.DB.prepare(
    "SELECT * FROM promotions WHERE id = ?"
  ).bind(id).first<Record<string, any>>();
  if (!promo) return c.json({ error: "Promotion not found" }, 404);
  if (!["pending", "pending_approval", "rejected", "active", "expired"].includes(promo.status)) {
    return c.json({ error: "This promotion cannot be refunded in its current state." }, 400);
  }

  try {
    await refundPromotion(c.env, id);
    return c.json({ ok: true, message: `Refund of ${formatKwacha(promo.amount_cents)} started. The host will be notified when it lands.` });
  } catch (e) {
    console.error("refund failed:", e);
    return c.json({ error: "Refund could not be started. Try again." }, 502);
  }
});

// Host payouts + sweep history for the admin ledger.
app.get("/api/admin/payouts", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), 500);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const rows = await c.env.DB.prepare(
    `SELECT w.*, cam.title AS campaign_title, u.phone AS host_phone
     FROM withdrawals w
     JOIN campaigns cam ON cam.id = w.campaign_id
     LEFT JOIN users u ON u.id = cam.host_user_id
     ORDER BY w.created_at DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all<Record<string, any>>();

  return c.json({
    payouts: rows.results.map((w) => ({
      id: w.id,
      campaignId: w.campaign_id,
      campaignTitle: w.campaign_title,
      hostPhone: w.host_phone,
      amountCents: w.amount_cents,
      disbursementFeeCents: w.disbursement_fee_cents,
      platformFeeCents: w.platform_fee_cents,
      status: w.status,
      lipilaReference: w.lipila_reference,
      createdAt: w.created_at,
    })),
  });
});

app.get("/api/admin/stats", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const total = (await c.env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS n, COUNT(DISTINCT donor_user_id) AS d FROM contributions WHERE status = 'confirmed'"
  ).first<{ s: number; n: number; d: number }>()) ?? { s: 0, n: 0, d: 0 };
  const platformFees = (await c.env.DB.prepare(
    "SELECT COALESCE(SUM(platform_fee_cents),0) AS s FROM contributions WHERE status = 'confirmed'"
  ).first<{ s: number }>()) ?? { s: 0 };
  const payoutPlatformFees = (await c.env.DB.prepare(
    "SELECT COALESCE(SUM(platform_fee_cents),0) AS s FROM withdrawals WHERE status = 'success'"
  ).first<{ s: number }>()) ?? { s: 0 };
  const activeCampaigns = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM campaigns WHERE status = 'active'"
  ).first<{ n: number }>()) ?? { n: 0 };
  const pending = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE host_status = 'pending'"
  ).first<{ n: number }>()) ?? { n: 0 };

  // Growth + activity counters (7d/30d windows). Indexed via created_at columns.
  const [users, campaigns, donations, receipts, pledges, tickets, deleteReqs] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM users) AS total, (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-7 days')) AS d7, (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-30 days')) AS d30"
    ),
    c.env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM campaigns WHERE status != 'deleted') AS total, (SELECT COUNT(*) FROM campaigns WHERE created_at >= datetime('now', '-7 days')) AS d7, (SELECT COUNT(*) FROM campaigns WHERE created_at >= datetime('now', '-30 days')) AS d30"
    ),
    c.env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM contributions WHERE status = 'confirmed') AS total, (SELECT COUNT(*) FROM contributions WHERE status = 'confirmed' AND confirmed_at >= datetime('now', '-7 days')) AS d7, (SELECT COUNT(*) FROM contributions WHERE status = 'confirmed' AND confirmed_at >= datetime('now', '-30 days')) AS d30"
    ),
    c.env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM receipt_downloads) AS total, (SELECT COUNT(*) FROM receipt_downloads WHERE created_at >= datetime('now', '-7 days')) AS d7, (SELECT COUNT(*) FROM receipt_downloads WHERE created_at >= datetime('now', '-30 days')) AS d30"
    ),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM recurring_pledges WHERE active = 1"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'open'"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM campaign_delete_requests WHERE status = 'pending'"),
  ]);
  const rc = (r: any) => (r?.results?.[0] ?? r?.[0] ?? {});
  const usersRow = rc(users), campaignsRow = rc(campaigns), donationsRow = rc(donations),
    receiptsRow = rc(receipts), pledgesRow = rc(pledges), ticketsRow = rc(tickets), deleteReqsRow = rc(deleteReqs);

  const firstCampaign = await c.env.DB.prepare(
    "SELECT created_at FROM campaigns ORDER BY created_at ASC LIMIT 1"
  ).first<{ created_at: string }>();
  const days = firstCampaign
    ? Math.max(1, Math.floor((Date.now() - new Date(firstCampaign.created_at.replace(" ", "T") + "Z").getTime()) / 86400000))
    : 1;

  const topCampaigns = await c.env.DB.prepare(
    "SELECT * FROM campaigns ORDER BY id DESC LIMIT 5"
  ).all<Record<string, any>>();
  const topList = [];
  for (const row of topCampaigns.results) {
    topList.push(await campaignPublic(c.env, row));
  }

  const topDonors = await c.env.DB.prepare(
    `SELECT u.username, SUM(co.amount_cents) AS total
     FROM contributions co LEFT JOIN users u ON u.id = co.donor_user_id
     WHERE co.status = 'confirmed' AND co.hide_amount = 0
     GROUP BY co.donor_user_id ORDER BY total DESC LIMIT 10`
  ).all<Record<string, any>>();

  const topReferrers = await c.env.DB.prepare(
    `SELECT u.username, COUNT(r.id) AS invites
     FROM referrals r JOIN users u ON u.id = r.referrer_user_id
     GROUP BY r.referrer_user_id ORDER BY invites DESC LIMIT 10`
  ).all<Record<string, any>>();

  const recent = await c.env.DB.prepare(
    `SELECT co.amount_cents, co.platform_fee_cents, co.created_at, u.username, cam.title AS campaign_title
     FROM contributions co
     LEFT JOIN users u ON u.id = co.donor_user_id
     JOIN campaigns cam ON cam.id = co.campaign_id
     WHERE co.status = 'confirmed' ORDER BY co.created_at DESC LIMIT 20`
  ).all<Record<string, any>>();

  const feeSettled = (await c.env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM fee_sweeps WHERE status = 'success'"
  ).first<{ s: number }>())?.s ?? 0;

  return c.json({
    stats: {
      totalRaisedCents: total.s,
      confirmedDonations: total.n,
      donors: total.d,
      platformFeesCents: platformFees.s + payoutPlatformFees.s,
      platformFeesSettledCents: feeSettled,
      platformFeesPendingCents: (platformFees.s + payoutPlatformFees.s) - feeSettled,
      activeCampaigns: activeCampaigns.n,
      pendingApplications: pending.n,
      dailyRateCents: Math.round(total.s / days),
      usersTotal: usersRow.total ?? 0,
      newUsers7d: usersRow.d7 ?? 0,
      newUsers30d: usersRow.d30 ?? 0,
      campaignsTotal: campaignsRow.total ?? 0,
      newCampaigns7d: campaignsRow.d7 ?? 0,
      newCampaigns30d: campaignsRow.d30 ?? 0,
      donationsTotal: donationsRow.total ?? 0,
      newDonations7d: donationsRow.d7 ?? 0,
      newDonations30d: donationsRow.d30 ?? 0,
      receiptsDownloaded: receiptsRow.total ?? 0,
      receiptsDownloaded7d: receiptsRow.d7 ?? 0,
      activePledges: pledgesRow.n ?? 0,
      openTickets: ticketsRow.n ?? 0,
      pendingDeleteRequests: deleteReqsRow.n ?? 0,
    },
    topCampaigns: topList,
    topDonors: topDonors.results.map((d) => ({
      username: d.username ?? "Giver",
      totalCents: d.total,
      tier: tierFor(d.total),
    })),
    topReferrers: topReferrers.results.map((r) => ({
      username: r.username ?? "Giver",
      invites: r.invites,
    })),
    recent: recent.results.map((r) => ({
      username: r.username ?? "Giver",
      amountCents: r.amount_cents,
      platformFeeCents: r.platform_fee_cents,
      campaignTitle: r.campaign_title,
      date: r.created_at,
    })),
  });
});

// ---------- superadmin ledger ----------

app.get("/api/admin/transactions", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const status = String(c.req.query("status") ?? "").toLowerCase();
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "500", 10) || 500, 1), 1000);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const rows = await c.env.DB.prepare(
    `SELECT co.id, co.campaign_id, cam.title AS campaign_title, co.donor_name, co.is_anonymous,
            co.phone, co.amount_cents, co.platform_fee_cents, co.lipila_fee_cents, co.status,
            co.lipila_reference, co.lipila_identifier, co.confirmed_at, co.created_at
     FROM contributions co JOIN campaigns cam ON cam.id = co.campaign_id
     WHERE (? = '' OR lower(co.status) = ?)
     ORDER BY co.created_at DESC LIMIT ? OFFSET ?`
  ).bind(status, status, limit, offset).all<Record<string, any>>();

  return c.json({
    transactions: rows.results.map((t) => ({
      id: t.id,
      campaignId: t.campaign_id,
      campaignTitle: t.campaign_title,
      donorName: t.is_anonymous ? null : t.donor_name,
      isAnonymous: !!t.is_anonymous,
      phone: t.phone,
      amountCents: t.amount_cents,
      platformFeeCents: t.platform_fee_cents,
      lipilaFeeCents: t.lipila_fee_cents,
      status: t.status,
      lipilaReference: t.lipila_reference,
      lipilaIdentifier: t.lipila_identifier,
      confirmedAt: t.confirmed_at,
      createdAt: t.created_at,
    })),
  });
});

app.get("/api/admin/transactions/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const t = await c.env.DB.prepare(
    `SELECT co.*, cam.title AS campaign_title, u.username AS donor_username
     FROM contributions co JOIN campaigns cam ON cam.id = co.campaign_id
     LEFT JOIN users u ON u.id = co.donor_user_id
     WHERE co.id = ?`
  ).bind(c.req.param("id")).first<Record<string, any>>();
  if (!t) return c.json({ error: "Transaction not found" }, 404);

  return c.json({
    transaction: {
      id: t.id,
      campaignId: t.campaign_id,
      campaignTitle: t.campaign_title,
      donorUsername: t.donor_username ?? null,
      donorName: t.is_anonymous ? null : t.donor_name,
      isAnonymous: !!t.is_anonymous,
      phone: t.phone,
      amountCents: t.amount_cents,
      platformFeeCents: t.platform_fee_cents,
      lipilaFeeCents: t.lipila_fee_cents,
      payoutCents: Math.max(0, t.amount_cents - (t.platform_fee_cents ?? 0) - (t.lipila_fee_cents ?? 0)),
      status: t.status,
      lipilaReference: t.lipila_reference,
      lipilaIdentifier: t.lipila_identifier,
      confirmedAt: t.confirmed_at,
      createdAt: t.created_at,
      hideAmount: !!t.hide_amount,
    },
  });
});

app.get("/api/admin/disbursements", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const payouts = await c.env.DB.prepare(
    `SELECT w.id, w.campaign_id, cam.title AS campaign_title, w.amount_cents, w.disbursement_fee_cents,
            w.platform_fee_cents, w.lipila_reference, w.status, w.created_at
     FROM withdrawals w LEFT JOIN campaigns cam ON cam.id = w.campaign_id
     ORDER BY w.created_at DESC LIMIT 500`
  ).all<Record<string, any>>();
  const settlements = await c.env.DB.prepare(
    `SELECT id, kind, amount_cents, lipila_reference, status, created_at
     FROM fee_sweeps ORDER BY created_at DESC LIMIT 500`
  ).all<Record<string, any>>();

  const out = [
    ...payouts.results.map((w) => ({
      kind: "payout" as const,
      id: `w-${w.id}`,
      campaignId: w.campaign_id,
      campaignTitle: w.campaign_title ?? "—",
      amountCents: w.amount_cents,
      lipilaFeeCents: w.disbursement_fee_cents,
      platformFeeCents: w.platform_fee_cents,
      lipilaReference: w.lipila_reference,
      status: w.status,
      createdAt: w.created_at,
    })),
    ...settlements.results.map((s) => ({
      kind: s.kind as "payout" | "sweep",
      id: `f-${s.id}`,
      campaignId: null,
      campaignTitle: "Kingdom Sponsor fees",
      amountCents: s.amount_cents,
      lipilaFeeCents: 0,
      platformFeeCents: s.amount_cents,
      lipilaReference: s.lipila_reference,
      status: s.status,
      createdAt: s.created_at,
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return c.json({ disbursements: out });
});

app.get("/api/admin/campaigns", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const rows = await c.env.DB.prepare(
    `SELECT cam.*, u.username AS host_username FROM campaigns cam
     JOIN users u ON u.id = cam.host_user_id ORDER BY cam.created_at DESC`
  ).all<Record<string, any>>();

  const out = [];
  for (const row of rows.results) {
    const pub = await campaignPublic(c.env, row);
    const available = await availableBalance(c.env, row.id);
    out.push({ ...pub, hostUsername: row.host_username, availableCents: available, minWithdrawCents: row.min_withdraw_cents });
  }
  return c.json({ campaigns: out });
});

// ---------- campaign branding media (logos via R2) ----------

const LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

app.get("/media/:key{.+}", async (c) => {
  const key = c.req.param("key");
  if (!/^[a-zA-Z0-9/_.-]+$/.test(key)) return c.json({ error: "Not found" }, 404);
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  const ext = key.split(".").pop()?.toLowerCase();
  const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=86400, immutable",
  });
  return new Response(obj.body, { headers });
});

// ---------- donor profile photos ----------

app.post("/api/me/avatar", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "Upload an image" }, 400);

  const type = file.type.toLowerCase();
  const ext = LOGO_TYPES[type];
  if (!ext) return c.json({ error: "Photo must be PNG, JPG or WebP" }, 400);
  if (file.size > 3_000_000) return c.json({ error: "Photo must be under 3 MB" }, 400);

  const key = `avatars/${user.sub}-${Date.now()}.${ext}`;
  await c.env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: type } });
  const avatarUrl = `${c.env.APP_URL}/media/${key}`;
  await c.env.DB.prepare("UPDATE users SET avatar_url = ? WHERE id = ?")
    .bind(avatarUrl, user.sub).run();

  return c.json({ ok: true, avatarUrl });
});

app.post("/api/campaigns/:id/logo", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const admin = await requireAdmin(c);
  if (campaign.host_user_id !== user.sub && !admin) {
    return c.json({ error: "You can only edit your own campaigns" }, 403);
  }

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "Upload a logo image" }, 400);

  const type = file.type.toLowerCase();
  const ext = LOGO_TYPES[type];
  if (!ext) return c.json({ error: "Logo must be PNG, JPG or WebP" }, 400);
  if (file.size > 3_000_000) return c.json({ error: "Logo must be under 3 MB" }, 400);

  const key = `logos/${campaign.id}-${Date.now()}.${ext}`;
  await c.env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: type } });
  const logoUrl = `${c.env.APP_URL}/media/${key}`;
  await c.env.DB.prepare("UPDATE campaigns SET logo_url = ? WHERE id = ?")
    .bind(logoUrl, campaign.id).run();

  return c.json({ ok: true, logoUrl });
});

// ---------- public share page (WhatsApp links + QR-friendly) ----------

const SHARE_STYLE = "body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}.card{max-width:420px;width:100%;background:#1e293b;border-radius:16px;padding:24px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#94a3b8;line-height:1.5;margin:0 0 20px}.amt{font-size:28px;font-weight:700;color:#34d399;margin-bottom:20px}a.btn{display:block;background:#25D366;color:#06281b;font-weight:700;text-decoration:none;padding:14px;border-radius:10px;margin:8px 0}a.btn2{display:block;background:#1d4ed8;color:#fff;font-weight:700;text-decoration:none;padding:14px;border-radius:10px;margin:8px 0}a.btn3{display:block;background:#334155;color:#cbd5e1;font-weight:700;text-decoration:none;padding:12px;border-radius:10px;margin:8px 0}.foot{color:#64748b;font-size:12px;margin-top:16px}";

function embedWidgetHtml(env: Bindings, campaign: Record<string, any>, pub: Record<string, any>): string {
  const id = campaign.id;
  const goalLine = pub.hasGoal
    ? `<div class="amt">${formatKwacha(pub.raisedCents)} of ${formatKwacha(pub.goalCents)} raised</div>`
    : `<div class="amt">${formatKwacha(pub.raisedCents)} raised</div>`;
  const img = pub.imageUrl ? `<img src="${pub.imageUrl}" alt="" style="width:64px;height:64px;border-radius:12px;margin-bottom:12px;object-fit:cover">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${pub.title} - Kingdom Sponsor</title><style>body{font-family:system-ui,sans-serif;margin:0;background:transparent;color:#e2e8f0;display:flex;min-height:100%;align-items:center;justify-content:center;padding:16px}.card{max-width:360px;width:100%;background:#1e293b;border:1px solid #334155;border-radius:16px;padding:20px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{color:#94a3b8;line-height:1.5;margin:0 0 16px}.amt{font-size:22px;font-weight:700;color:#34d399;margin-bottom:16px}a.btn{display:block;background:#25D366;color:#06281b;font-weight:700;text-decoration:none;padding:12px;border-radius:10px}a.btn2{display:block;background:#1d4ed8;color:#fff;font-weight:700;text-decoration:none;padding:12px;border-radius:10px;margin-top:8px}.foot{color:#64748b;font-size:11px;margin-top:12px}</style></head><body><div class="card">${img}<h1>${pub.title}</h1><p>${pub.blurb}</p>${goalLine}<a class="btn" href="${env.APP_URL}/share/${id}" target="_top">Give on Kingdom Sponsor</a><a class="btn2" href="kingdomsponsor://campaign/${id}">Open in app</a><div class="foot">${pub.donorCount ?? 0} givers</div></div></body></html>`;
}

app.get("/share/:id", async (c) => {
  const id = c.req.param("id");
  const ref = String(c.req.query("ref") ?? "").trim().toUpperCase().slice(0, 12);
  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ? AND status != 'draft'")
    .bind(id).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const pub = await campaignPublic(c.env, campaign);
  const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const pageUrl = c.env.APP_URL + "/share/" + id + refQuery;
  const wa = "https://wa.me/?text=" + encodeURIComponent(pub.title + " - " + pub.blurb + "\nGive here: " + pageUrl);
  const goalLine = pub.hasGoal
    ? "<div class=\"amt\">" + formatKwacha(pub.raisedCents) + " raised of " + formatKwacha(pub.goalCents) + "</div>"
    : "<div class=\"amt\">" + formatKwacha(pub.raisedCents) + " raised</div>";
  const endsLine = pub.endsAt ? "ends " + new Date(pub.endsAt).toLocaleDateString() : "";
  const ogImage = pub.imageUrl ? "<meta property=\"og:image\" content=\"" + pub.imageUrl + "\">" : "";
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta property=\"og:title\" content=\"" + pub.title + "\"><meta property=\"og:description\" content=\"" + pub.blurb + "\"><meta property=\"og:type\" content=\"website\"><meta property=\"og:url\" content=\"" + pageUrl + "\">" + ogImage + "<meta name=\"theme-color\" content=\"#1d4ed8\"><title>" + pub.title + " - Kingdom Sponsor</title><style>" + SHARE_STYLE + "</style></head><body><div class=\"card\">" + (pub.imageUrl ? "<img src=\"" + pub.imageUrl + "\" alt=\"\" style=\"width:96px;height:96px;border-radius:16px;margin-bottom:12px;object-fit:cover\">" : "") + "<h1>" + pub.title + "</h1><p>" + pub.blurb + "</p>" + goalLine + "<a class=\"btn\" href=\"" + wa + "\" target=\"_blank\">Share on WhatsApp</a><a class=\"btn2\" href=\"kingdomsponsor://campaign/" + id + (refQuery ? "&ref=" + encodeURIComponent(ref) : "") + "\">Open in app</a><a class=\"btn3\" href=\"https://play.google.com/store/apps/details?id=com.kingdomsponsor.app\" target=\"_blank\">Don't have the app? Get it on Play Store</a><div class=\"foot\">" + (pub.donorCount ?? 0) + " givers - " + endsLine + "</div></div></body></html>";
  return c.html(html);
});

// Lightweight widget for embedding a campaign on any website (use as <iframe src=".../share/:id/embed">).
app.get("/share/:id/embed", async (c) => {
  const id = c.req.param("id");
  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ? AND status != 'draft'")
    .bind(id).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  const pub = await campaignPublic(c.env, campaign);
  return c.html(embedWidgetHtml(c.env, campaign, pub));
});

// Referral landing page (works without a campaign id).
app.get("/share", async (c) => {
  const ref = String(c.req.query("ref") ?? "").trim().toUpperCase().slice(0, 12);
  const top = await c.env.DB.prepare(
    "SELECT id, title FROM campaigns WHERE status = 'active' ORDER BY created_at DESC LIMIT 5"
  ).all<{ id: number; title: string }>();
  const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const rows = top.results.map((t) => `<a class="btn2" href="${c.env.APP_URL}/share/${t.id}${refQuery}">${t.title}</a>`).join("");
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta property=\"og:title\" content=\"Kingdom Sponsor\"><meta property=\"og:description\" content=\"Give to campaigns in Zambia.\"><meta name=\"theme-color\" content=\"#1d4ed8\"><title>Kingdom Sponsor</title><style>" + SHARE_STYLE + "</style></head><body><div class=\"card\"><h1>Kingdom Sponsor</h1><p>Choose a campaign to support:</p>" + rows + "<div class=\"foot\">Kingdom Sponsor</div></div></body></html>";
  return c.html(html);
});

app.post("/api/ussd", async (c) => {
  const parsed = await c.req.parseBody().catch((): Record<string, string | File> => ({}));
  const sessionId = String(parsed.sessionId ?? c.req.query("sessionId") ?? "");
  const phone = String(parsed.phoneNumber ?? c.req.query("phoneNumber") ?? "");
  const text = String(parsed.text ?? c.req.query("text") ?? "");
  const serviceCode = String(parsed.serviceCode ?? c.req.query("serviceCode") ?? "");

  const parts = text.split("*");
  const level = parts.length;
  const choice = parts[parts.length - 1];

  async function topCampaigns() {
    return (await c.env.DB.prepare(
      "SELECT id, title FROM campaigns WHERE status = 'active' ORDER BY created_at DESC LIMIT 10"
    ).all<{ id: number; title: string }>()).results;
  }

  async function pendingUssdContribution() {
    return c.env.DB.prepare(
      "SELECT * FROM contributions WHERE lipila_reference = ?"
    ).bind(`USSD-${sessionId}`).first<Record<string, any>>();
  }

  async function startCollection(row: Record<string, any>, campaign: Record<string, any>) {
    try {
      const result = await createCollection(c.env, {
        referenceId: row.lipila_reference,
        amountCents: row.amount_cents,
        accountNumber: phone.replace("+", ""),
        narration: `Kingdom Sponsor donation to ${campaign.title}`,
        callbackUrl: `${c.env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(c.env.LIPILA_WEBHOOK_SECRET)}`,
      });
      await c.env.DB.prepare("UPDATE contributions SET lipila_identifier = ? WHERE id = ?")
        .bind(result.identifier, row.id).run();
      return true;
    } catch (e) {
      console.error("USSD collection failed:", e);
      await c.env.DB.prepare("UPDATE contributions SET status = 'failed' WHERE id = ?").bind(row.id).run();
      return false;
    }
  }

  if (level === 1 && choice === "") {
    return c.text("CON Kingdom Sponsor\n1. View campaigns\n2. Scan QR code\n3. Share event\n4. Download app\n0. Exit");
  }

  if (level === 1 && choice === "0") {
    return c.text("END Thank you for using Kingdom Sponsor. Goodbye!");
  }

  if (level === 1 && choice === "2") {
    return c.text("END Open your phone camera or WhatsApp and scan the QR code on the Kingdom Sponsor poster or flyer to access the fundraiser.");
  }

  if (level === 1 && choice === "3") {
    return c.text("END Share the Kingdom Sponsor app link: https://kingdom-sponsor.app. Copy the link and send it to your family and friends via WhatsApp.");
  }

  if (level === 1 && choice === "4") {
    return c.text("END Download Kingdom Sponsor from Google Play Store. Search for 'Kingdom Sponsor' or visit https://kingdom-sponsor.app to get the download link.");
  }

  const mainMenuText = "CON Kingdom Sponsor\n1. View campaigns\n2. Scan QR code\n3. Share event\n4. Download app\n0. Exit";

  async function campaignListText() {
    const campaigns = await topCampaigns();
    const menu = campaigns.map((camp, i) => `${i + 1}. ${camp.title}`).join("\n");
    return `CON Select a campaign\n${menu}\n0. Back`;
  }

  const scanText = "END Open your phone camera or WhatsApp and scan the QR code on the Kingdom Sponsor poster or flyer to access the fundraiser.";
  const shareText = "END Share the Kingdom Sponsor app link: https://kingdom-sponsor.app. Copy the link and send it to your family and friends via WhatsApp.";
  const downloadText = "END Download Kingdom Sponsor from Google Play Store. Search for 'Kingdom Sponsor' or visit https://kingdom-sponsor.app to get the download link.";

  async function makeContribution(campaignId: number, amountCents: number): Promise<boolean> {
    const referenceId = `USSD-${sessionId}`;
    await c.env.DB.prepare(
      "DELETE FROM contributions WHERE lipila_reference = ?"
    ).bind(referenceId).run();
    await c.env.DB.prepare(
      "INSERT INTO contributions (campaign_id, donor_user_id, giver_user_id, is_anonymous, phone, amount_cents, platform_fee_cents, lipila_fee_cents, lipila_reference, status) VALUES (?, NULL, NULL, 1, ?, ?, 0, 0, ?, 'pending')"
    ).bind(campaignId, phone, amountCents, referenceId).run();
    return true;
  }

  if (level === 1) {
    return c.text(await campaignListText());
  }

  if (level === 2 && choice === "0") {
    return c.text(mainMenuText);
  }

  if (level === 2) {
    const campaigns = await topCampaigns();
    const camp = campaigns[parseInt(choice, 10) - 1];
    if (!camp) return c.text("END Invalid selection.");
    return c.text(`CON ${camp.title}\n1. Donate K10\n2. Donate K50\n3. Donate K100\n4. Custom amount\n0. Back`);
  }

  if (level === 3 && parts[1] === "0") {
    if (choice === "2") return c.text(scanText);
    if (choice === "3") return c.text(shareText);
    if (choice === "4") return c.text(downloadText);
    if (choice === "0") return c.text("END Thank you for using Kingdom Sponsor. Goodbye!");
    return c.text(await campaignListText());
  }

  if (level === 3) {
    const campaigns = await topCampaigns();
    const camp = campaigns[parseInt(parts[0], 10) - 1];
    if (!camp) return c.text("END Invalid selection.");

    if (choice === "0") {
      return c.text(await campaignListText());
    }
    if (choice === "4") {
      return c.text("CON Enter amount in kwacha (e.g. 50)");
    }
    const amountMap: Record<string, number> = { "1": 1000, "2": 5000, "3": 10000 };
    const amountCents = amountMap[choice];
    if (!amountCents) return c.text("END Invalid amount.");

    await makeContribution(camp.id, amountCents);
    return c.text(`CON You are about to donate K${(amountCents / 100).toLocaleString()} to "${camp.title}".\nConfirm? 1. Yes 2. No`);
  }

  if (level === 4 && parts[1] === "0") {
    const campaigns = await topCampaigns();
    const camp = campaigns[parseInt(choice, 10) - 1];
    if (!camp) return c.text("END Invalid selection.");
    return c.text(`CON ${camp.title}\n1. Donate K10\n2. Donate K50\n3. Donate K100\n4. Custom amount\n0. Back`);
  }

  if (level === 4) {
    const campaigns = await topCampaigns();
    const camp = campaigns[parseInt(parts[0], 10) - 1];
    if (!camp) return c.text("END Invalid selection.");

    if (parts[2] === "0") {
      const camp2 = campaigns[parseInt(choice, 10) - 1];
      if (!camp2) return c.text("END Invalid selection.");
      return c.text(`CON ${camp2.title}\n1. Donate K10\n2. Donate K50\n3. Donate K100\n4. Custom amount\n0. Back`);
    }

    const row = await pendingUssdContribution();
    if (!row) return c.text("END Session expired. Please start again.");

    if (parts[2] === "4") {
      const kwacha = parseInt(choice.replace(/\D/g, ""), 10);
      const amountCents = (isFinite(kwacha) ? kwacha : 0) * 100;
      if (amountCents < 100) return c.text("END Minimum donation is K1.00.");
      await makeContribution(camp.id, amountCents);
      return c.text(`CON You are about to donate K${(amountCents / 100).toLocaleString()} to "${camp.title}".\nConfirm? 1. Yes 2. No`);
    }

    if (choice === "2") {
      await c.env.DB.prepare("UPDATE contributions SET status = 'failed' WHERE id = ?").bind(row.id).run();
      return c.text("END Donation cancelled. Thank you.");
    }
    if (choice === "1") {
      const ok = await startCollection(row, camp);
      return ok
        ? c.text("END Check your phone and enter your PIN to complete the donation. Thank you for your support!")
        : c.text("END Payment could not be started. Please try again later.");
    }
  }

  if (level === 5) {
    const row = await pendingUssdContribution();
    if (!row) return c.text("END Session expired. Please start again.");

    const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?")
      .bind(row.campaign_id).first<Record<string, any>>();
    if (!campaign) return c.text("END Campaign not found.");

    if (choice === "2") {
      await c.env.DB.prepare("UPDATE contributions SET status = 'failed' WHERE id = ?").bind(row.id).run();
      return c.text("END Donation cancelled. Thank you.");
    }
    if (choice === "1") {
      const ok = await startCollection(row, campaign);
      return ok
        ? c.text("END Check your phone and enter your PIN to complete the donation. Thank you for your support!")
        : c.text("END Payment could not be started. Please try again later.");
    }
  }

  return c.text("END Thank you for using Kingdom Sponsor. Goodbye!");
});

app.get("/privacy", (c) => {
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Privacy Policy — Kingdom Sponsor</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;padding:24px;max-width:800px;margin:0 auto;line-height:1.6}h1{font-size:24px;margin:0 0 16px;color:#34d399}h2{font-size:18px;margin:24px 0 8px;color:#94a3b8}p{margin:0 0 12px}ul{margin:0 0 12px;padding-left:20px}li{margin:4px 0}a{color:#34d399}</style></head><body><h1>Privacy Policy</h1><p><strong>Last updated:</strong> August 2026</p><p>Kingdom Sponsor (\"we,\" \"our,\" or \"us\") operates a fundraising platform that allows users to donate to campaigns and hosts to create and manage fundraising campaigns. This privacy policy describes how we collect, use, and protect your personal data.</p><h2>1. Information We Collect</h2><h3>1.1 Account Data</h3><ul><li><strong>Phone number</strong> — required for registration and OTP-based authentication via Africa's Talking SMS</li><li><strong>Username</strong> — chosen during registration</li><li><strong>User ID</strong> — internally generated identifier</li></ul><h3>1.2 Donation Data</h3><ul><li><strong>Amount donated</strong> (in ngwee/cents)</li><li><strong>Donor name</strong> (optional, can be anonymous)</li><li><strong>Phone number</strong> — used for Lipila payment prompts and SMS notifications</li><li><strong>Transaction reference ID</strong> — unique identifier for each donation</li><li><strong>Campaign ID</strong> — the campaign being supported</li></ul><h3>1.3 Campaign Data</h3><ul><li><strong>Campaign title, description, and goal</strong></li><li><strong>Campaign status</strong> (active, draft, ended)</li><li><strong>Logo URL</strong> (if uploaded by the host)</li><li><strong>Sponsor count and amounts</strong></li></ul><h3>1.4 Payment Data</h3><ul><li><strong>Lipila collection and disbursement references</strong></li><li><strong>Payment status</strong> (pending, success, failed, cancelled)</li><li><strong>Platform fees and Lipila fees</strong> (calculated automatically)</li></ul><h3>1.5 USSD Session Data</h3><ul><li><strong>Session ID</strong> — temporary identifier for USSD interactions</li><li><strong>Phone number</strong> — the user's phone dialing the USSD code</li><li><strong>Menu selections</strong> — choices made during the USSD flow</li><li><strong>Donation amount and reference</strong> — recorded when a USSD donation is confirmed</li></ul><h3>1.6 Technical Data</h3><ul><li><strong>IP address</strong> — logged automatically by Cloudflare</li><li><strong>User agent and device information</strong> — collected by the Flutter app</li><li><strong>FCM tokens</strong> — used for push notifications (stored per device)</li></ul><h2>2. How We Use Your Data</h2><ul><li><strong>Authentication</strong> — your phone number is used to send and verify OTPs via Africa's Talking SMS</li><li><strong>Payment processing</strong> — donation amounts and phone numbers are sent to Lipila for mobile money transactions</li><li><strong>SMS notifications</strong> — we send transaction confirmations and pledge reminders via Africa's Talking</li><li><strong>USSD interactions</strong> — your USSD session data is processed in real time to provide the interactive menu experience</li><li><strong>Campaign management</strong> — campaign data is displayed publicly (except donor phone numbers, which are never exposed)</li><li><strong>Analytics and reporting</strong> — aggregated, anonymised data is used for platform statistics and admin dashboards</li><li><strong>Fee calculation</strong> — platform fees and Lipila fees are calculated and deducted automatically from each transaction</li></ul><h2>3. Data Storage</h2><ul><li>All data is stored in <strong>Cloudflare D1</strong> (SQLite) databases</li><li>Media files (campaign logos) are stored in <strong>Cloudflare R2</strong></li><li>No data is stored on our own servers — all infrastructure is provided by Cloudflare</li></ul><h2>4. Data Retention</h2><ul><li><strong>Contributions and transactions</strong> — retained indefinitely for financial records</li><li><strong>USSD session data</strong> — not persisted; processed in real time and discarded after the session ends</li><li><strong>User accounts</strong> — retained until the account is deleted</li><li><strong>Campaigns</strong> — retained until the host ends the campaign</li><li><strong>Payout/withdrawal records</strong> — retained indefinitely</li></ul><h2>5. Data Sharing</h2><p>We do not sell your personal data. We share data only with:</p><ul><li><strong>Lipila</strong> — for payment processing (phone number, amount, reference ID)</li><li><strong>Africa's Talking</strong> — for SMS and USSD services (phone number, session data)</li><li><strong>Cloudflare</strong> — as our infrastructure provider (IP address, technical data)</li><li><strong>Firebase</strong> — for FCM push notifications (device tokens)</li></ul><h2>6. Your Rights</h2><p>You have the right to:</p><ul><li><strong>Access</strong> — request a copy of your personal data</li><li><strong>Rectification</strong> — correct inaccurate information</li><li><strong>Erasure</strong> — request deletion of your account and associated data</li><li><strong>Portability</strong> — receive your data in a machine-readable format</li><li><strong>Object</strong> — object to processing of your data for direct marketing</li></ul><p>To exercise any of these rights, contact us through the platform or reach out to the superadmin.</p><h2>7. Security</h2><ul><li>All API endpoints are protected by JWT authentication</li><li>Phone numbers are never exposed publicly</li><li>Payment data is processed by Lipila and never stored in full</li><li>USSD session data is processed in real time and not persisted</li><li>We use HTTPS for all data transmission</li></ul><h2>8. Children's Privacy</h2><p>Kingdom Sponsor is not intended for users under the age of 13. We do not knowingly collect data from children.</p><h2>9. Changes to This Policy</h2><p>We may update this privacy policy from time to time. Changes will be posted on this page with a new \"Last updated\" date.</p><h2>10. Contact</h2><p>For privacy-related inquiries, contact the platform administrator or the superadmin phone number configured in the backend.</p><p><strong>Platform:</strong> Kingdom Sponsor<br><strong>Backend:</strong> https://kingdom-sponsor-api.godfreymoseskalambo.workers.dev<br><strong>GitHub:</strong> https://github.com/Carpso/chisomo</p></body></html>";
  return c.html(html);
});

app.get("/delete-account", (c) => {
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Delete Account — Kingdom Sponsor</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;padding:24px;max-width:600px;margin:0 auto;line-height:1.6}h1{font-size:24px;margin:0 0 16px;color:#34d399}h2{font-size:18px;margin:24px 0 8px;color:#94a3b8}p{margin:0 0 12px}ul{margin:0 0 12px;padding-left:20px}li{margin:4px 0}a{color:#34d399}</style></head><body><h1>Delete Account</h1><h2>Kingdom Sponsor</h2><p><strong>In the app:</strong> open the app, tap the settings icon, then \"Delete account\". Your account and personal data are deleted immediately.</p><p><strong>By email:</strong> email <strong>support@kingdom-sponsor.app</strong> with the subject \"Delete Account\" and the phone number associated with your account. Requests are processed within 30 days.</p><h2>Data Deleted</h2><ul><li>Username and profile information</li><li>Pledge records</li><li>User links</li><li>FCM device tokens</li><li>Donor name and identity on contributions</li></ul><h2>Data Retained</h2><ul><li>Transaction records (required for financial compliance) — retained for 7 years</li><li>Anonymized analytics — retained indefinitely</li><li>Audit logs — retained for 1 year</li></ul><p>If you simply want to stop receiving SMS notifications, you can reply STOP to any SMS from us.</p></body></html>";
  return c.html(html);
});

app.get("/", (c) => c.json({ name: "Kingdom Sponsor API", version: "0.3.0" }));

/** Scheduled: sweep payout-eligible balances for every active campaign. */
async function runAutoDisburse(env: Bindings): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id FROM campaigns WHERE status = 'active'"
  ).all<{ id: number }>();
  for (const row of rows.results) {
    await createWithdrawal(env, row.id);
  }
  console.log(`auto-disburse: checked ${rows.results.length} active campaigns`);
}

const appObject = Sentry.withSentry(
  (env: Bindings) => ({
    dsn: env.SENTRY_DSN ?? "",
    environment: env.ENV ?? "sandbox",
    tracesSampleRate: 0.05,
  }),
  {
    fetch: app.fetch,
    scheduled: async (_: ScheduledController, env: Bindings, ctx: ExecutionContext) => {
      ctx.waitUntil(runFeeSweep(env));
      ctx.waitUntil(runPledgeReminders(env));
      ctx.waitUntil(runPromotionExpiry(env));
      ctx.waitUntil(runAutoDisburse(env));
      ctx.waitUntil(runWithdrawalStatusChecks(env));
      ctx.waitUntil(runTicketAutoClose(env));
    },
  }
);

export default appObject;
