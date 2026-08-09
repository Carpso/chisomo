// Kingdom Sponsor API - neutral fundraising platform.
// Stack: Cloudflare Worker + D1 + Lipila (payments) + Africa's Talking (OTP SMS).
// Money is stored in ngwee (integer cents). 100 ngwee = K1.

import { Hono } from "hono";
import { cors } from "hono/cors";
import * as Sentry from "@sentry/cloudflare";
import { signToken, verifyToken, sha256Hex, type TokenPayload } from "./jwt";
import { createCollection, createCardCollection, checkCollectionStatus, checkDisbursementStatus, createDisbursement, getWalletBalance, logLipilaEvent, lipilaBase, type LipilaEnv } from "./lipila";
import { sendOtpSms, sendSms, sendAirtime } from "./sms";
import { loadFeeConfig, donationFees, payoutAmountCents, disbursementFeeCents, platformDisbursementFeeCents, feeConfigPublic, formatKwacha } from "./fees";
import { generateUsername, ensureUser, donorTotalCents, donorVisibleCents, tierFor } from "./donors";
import { sendPushNotification, sendMulticastPush } from "./firebase";
import {
  donationConfirmedSms, donationReceivedSms, payoutSentSms, payoutFailedSms, pledgeReminderSms,
  promotionActiveSms, promotionRejectedSms, campaignDeletedSms, deleteRequestReceivedSms,
  deleteRequestRejectedSms, supportReplySms, supportReceivedSms, promotionRefundedSms,
  promotionExpiredSms, milestoneSms, campaignEndedSms, editRequestApprovedSms,
  airtimeSentSms, airtimeDeliveredSms, airtimeFailedSms,
} from "./messages";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createShortLink, resolveShortLink, shortBaseUrl, shortCodeFor } from "./shorten";
import { CAMPAIGN_CATEGORIES, isValidCategory } from "./categories";

const CAMPAIGN_TYPES = [
  "community", "ngo", "faith", "emergency", "medical", "sponsor",
] as const;

/** Valid KYC document types a host can submit for vetting. */
const HOST_KYC_TYPES = ["nrc", "ngo_cert", "endorsement"] as const;

type Bindings = LipilaEnv & SmsEnv2 & {
  DB: D1Database;
  MEDIA: R2Bucket;
  JWT_SECRET: string;
  APP_URL: string;
  SHORT_BASE_URL?: string;
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
   ALERT_FROM_EMAIL?: string;
   CORS_ORIGINS?: string;
 };

interface SmsEnv2 {
  AT_USERNAME: string;
  AT_API_KEY: string;
  AT_FROM?: string;
  ENV: string;
}

const app = new Hono<{ Bindings: Bindings }>();
// CORS: restrict to known origins. The allowed list is built from APP_URL
// plus the optional CORS_ORIGINS var (comma-separated extra origins, e.g.
// "https://kingdom-sponsor.app"). This prevents arbitrary sites from reading
// API responses. Credentials are allowed for the web dashboard.
function corsOrigins(env: Bindings): string[] {
  const extra = String(env.CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const list = [env.APP_URL, ...extra];
  return [...new Set(list)];
}
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      if (!origin) return "";
      return corsOrigins(c.env).includes(origin) ? origin : "";
    },
    credentials: true,
    maxAge: 86400,
  })
);

// ---------- helpers ----------

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("260")) return `+${digits}`;
  if (digits.startsWith("0")) return `+260${digits.slice(1)}`;
  return `+${digits}`;
}

/** Mask a phone number for public display: +260 97 * * * * 3 4 5 6. */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "â€¢â€¢â€¢â€¢";
  const last4 = digits.slice(-4);
  const tail = last4.length >= 4 ? ` ${last4.slice(0, 2)} ${last4.slice(2)}` : "";
  return `+260 â€¢â€¢ â€¢â€¢ â€¢â€¢${tail}`;
}

// Zambian mobile networks by leading digits (after +260, e.g. 0977...).
// Zambian mobile networks by 3-digit prefix (e.g. "097"). Per ZICTA's
// 2024 numbering-plan update the new 05X prefixes are live. Zed Mobile's
// 078/058 ranges are reserved but not yet officially enabled, so we still
// route them to Zed Mobile.
const ZM_NETWORKS = [
  { id: "airtel", prefixes: ["097", "077", "057"] },
  { id: "mtn", prefixes: ["096", "076", "056"] },
  { id: "zamtel", prefixes: ["095", "075", "055"] },
  { id: "zedmobile", prefixes: ["098", "078", "058"] },
] as const;

/** Which Zambian network a phone number belongs to (or null if unknown). */
function networkOf(phone: string): string | null {
  const n = phone.replace(/\D/g, "").replace(/^260/, "");
  const local = n.startsWith("0") ? n : `0${n}`;
  for (const net of ZM_NETWORKS) {
    if (net.prefixes.some((p) => local.startsWith(p))) return net.id;
  }
  return null;
}

/** Per-network SMS health: "ok" | "down" (admin-controlled). Defaults to ok. */
async function networkStatus(env: Bindings, networkId: string): Promise<string> {
  const v = await getSetting(env, `net_status_${networkId}`);
  return v === "down" ? "down" : "ok";
}

/** True when the phone's own network cannot receive SMS right now. */
async function phoneSmsDown(env: Bindings, phone: string): Promise<boolean> {
  const net = networkOf(phone);
  if (!net) return false;
  return (await networkStatus(env, net)) === "down";
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

/** Best-effort client IP from Cloudflare / forwarding headers. */
function clientIp(c: any): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/** Per-IP OTP throttle: max [limit] requests per [windowSec] seconds. */
async function ipOtpAllowed(env: Bindings, ip: string, limit: number, windowSec: number): Promise<boolean> {
  if (!ip || ip === "unknown") return true;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM otp_attempts WHERE ip = ? AND kind = 'otp' AND created_at > datetime('now', ?)"
  ).bind(ip, `-${windowSec} seconds`).first<{ n: number }>();
  return (row?.n ?? 0) < limit;
}

/** Records an OTP/verify attempt for IP throttling + intruder analysis. */
async function recordOtpAttempt(env: Bindings, ip: string, phone: string | null): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO otp_attempts (ip, phone, kind) VALUES (?, ?, 'otp')"
    ).bind(ip ?? "unknown", phone).run();
  } catch (e) {
    console.error("otp attempt record failed:", e);
  }
}

function envPushConfigured(env: Bindings): boolean {
  return !!env.FIREBASE_CLIENT_EMAIL && !!env.FIREBASE_PRIVATE_KEY;
}

function fbEnv(env: Bindings) {
  return { FIREBASE_CLIENT_EMAIL: env.FIREBASE_CLIENT_EMAIL!, FIREBASE_PRIVATE_KEY: env.FIREBASE_PRIVATE_KEY! };
}

/** Best-effort push to every device registered to a user (no-op when FCM isn't configured).
 *  Returns how many sends succeeded; invalid tokens are dropped from the DB. */
async function pushToUser(env: Bindings, userId: number | null, title: string, body: string, data?: Record<string, string>): Promise<number> {
  if (!envPushConfigured(env) || !userId) return 0;
  const row = await env.DB.prepare(
    "SELECT notifications_enabled FROM users WHERE id = ?"
  ).bind(userId).first<{ notifications_enabled: number }>();
  if (!row || row.notifications_enabled === 0) return 0;
  const rows = await env.DB.prepare(
    "SELECT token FROM device_tokens WHERE user_id = ?"
  ).bind(userId).all<{ token: string }>();
  const tokens = rows.results.map((r) => r.token);
  if (!tokens.length) return 0;
  const result = await sendMulticastPush(fbEnv(env), tokens, title, body, data)
    .catch((e) => { console.error("push failed:", e); return { success: 0, failure: tokens.length, failedTokens: tokens as string[] }; });
  if (result.failedTokens.length) {
    await pruneInvalidTokens(env, result.failedTokens);
  }
  return result.success;
}

/** Delete device tokens FCM no longer accepts so the push path stays clean. */
async function pruneInvalidTokens(env: Bindings, tokens: string[]): Promise<void> {
  for (const token of tokens) {
    await env.DB.prepare("DELETE FROM device_tokens WHERE token = ?").bind(token).run().catch(() => {});
  }
}

/** True when the user has at least one registered app device (push-reachable). */
async function userHasPush(env: Bindings, userId: number | null): Promise<boolean> {
  if (userId == null) return false;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM device_tokens WHERE user_id = ?"
  ).bind(userId).first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

/** Smart channel pick: app users already receive the matching push notification,
 *  so SMS is only sent as a fallback to users without the app installed
 *  (keeps SMS volume and cost in check). */
async function smsIfNoPush(env: Bindings, userId: number | null, phone: string | null, text: string): Promise<void> {
  if (!phone || !text) return;
  if (await userHasPush(env, userId)) return;
  await sendSms(env, phone, text).catch((e) => console.error("sms failed:", e));
}

/** Push-only alert to admins with the app installed (in-app notifications,
 *  never SMS). Used for support tickets and similar non-urgent admin alerts. */
async function pushAdmins(env: Bindings, title: string, body: string, data?: Record<string, string>): Promise<void> {
  if (!envPushConfigured(env)) return;
  const phones = (env.SUPERADMIN_PHONES ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!phones.length) return;
  const placeholders = phones.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT DISTINCT dt.token FROM device_tokens dt
     JOIN users u ON u.id = dt.user_id
     WHERE u.phone IN (${placeholders})`
  ).bind(...phones).all<{ token: string }>();
  const tokens = rows.results.map((r) => r.token);
  if (!tokens.length) return;
  const result = await sendMulticastPush(fbEnv(env), tokens, title, body, data)
    .catch((e) => { console.error("admin push failed:", e); return { success: 0, failure: tokens.length, failedTokens: tokens as string[] }; });
  if (result.failedTokens.length) {
    await pruneInvalidTokens(env, result.failedTokens);
  }
}

/** Push to every user whose phone is on the superadmin list (used for urgent admin alerts). */
async function pushAndSmsAdmins(env: Bindings, smsText: string, pushTitle: string, pushBody: string): Promise<void> {
  const phones = (env.SUPERADMIN_PHONES ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  for (const p of phones) {
    await sendSms(env, normalizePhone(p), smsText).catch((e) => console.error("admin sms failed:", e));
  }
  if (envPushConfigured(env) && phones.length) {
    const placeholders = phones.map(() => "?").join(",");
    // Use device_tokens table (multi-device) instead of legacy users.fcm_token
    const rows = await env.DB.prepare(
      `SELECT DISTINCT dt.token FROM device_tokens dt
       JOIN users u ON u.id = dt.user_id
       WHERE u.phone IN (${placeholders})`
    ).bind(...phones).all<{ token: string }>();
    const tokens = rows.results.map((r) => r.token);
    if (tokens.length) {
      await sendMulticastPush(fbEnv(env), tokens, pushTitle, pushBody, { type: "admin_alert" })
        .catch((e) => console.error("admin push failed:", e));
    }
  }
}

// ---------- intruder alerts (Telegram + SMS/push + email) ----------

interface FailedLoginRow {
  id: number;
  phone: string;
  ip?: string;
  user_agent?: string;
  reason: string;
  created_at?: string;
}

function intruderReasonLabel(reason: string): string {
  switch (reason) {
    case "wrong_code": return "wrong code entered";
    case "otp_expired": return "code expired";
    case "too_many_attempts": return "too many attempts";
    default: return reason || "unknown reason";
  }
}

/** Plain-text draft of the intruder alert warning message. */
function buildIntruderAlertText(rows: FailedLoginRow[]): string {
  const n = rows.length;
  const when = rows[0]?.created_at ? ` (${rows[0].created_at})` : "";
  const details = rows
    .map((r) => {
      const ua = r.user_agent ? ` Â· ${r.user_agent.slice(0, 80)}` : "";
      return `â€¢ ${r.created_at ?? "?"} â€” ${r.phone} â€” ${intruderReasonLabel(r.reason)} â€” IP ${r.ip ?? "?"}${ua}`;
    })
    .join("\n");
  return [
    `ðŸš¨ SECURITY ALERT â€” ${n} failed login attempt${n === 1 ? "" : "s"} on Kingdom Sponsor${when}`,
    ``,
    `Someone tried (and failed) to sign in with these numbers. If this was not you, your number may be under attack.`,
    ``,
    details,
    ``,
    `If this was not you, secure your number and contact support immediately. â€” Kingdom Sponsor`,
  ].join("\n");
}

/** Best-effort email to the configured admin (MailChannels API; requires the
 *  Domain Lockdown DNS record on the from-domain to actually deliver). */
async function sendAdminEmail(env: Bindings, subject: string, text: string): Promise<boolean> {
  const toRow = await env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'admin_email'"
  ).first<Record<string, any>>();
  const to = toRow?.value as string | undefined;
  if (!to) return false;
  try {
    const fromEmail = env.ALERT_FROM_EMAIL ?? to;
    const res = await fetch("https://send.mailchannels.net/api/v1/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, name: "Kingdom Sponsor" },
        subject,
        content: [{ type: "text/plain", value: text }],
      }),
    });
    if (!res.ok) console.error(`intruder-alert email failed (${res.status}):`, await res.text().catch(() => ""));
    return res.ok;
  } catch (e) {
    console.error("intruder-alert email failed:", e);
    return false;
  }
}

/** Sends the drafted warning through every configured channel. */
async function notifyIntruderAlert(
  env: Bindings,
  rows: FailedLoginRow[],
): Promise<{ telegramSent: boolean; smsSent: boolean; emailSent: boolean }> {
  const text = buildIntruderAlertText(rows);
  let telegramSent = false;

  const tokenRow = await env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'telegram_bot_token'"
  ).first<Record<string, any>>();
  const chatIdRow = await env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'telegram_chat_id'"
  ).first<Record<string, any>>();
  const token = tokenRow?.value as string | undefined;
  const chatId = chatIdRow?.value as string | undefined;

  if (token && chatId) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      telegramSent = res.ok;
      if (!res.ok) console.error(`intruder-alert telegram failed (${res.status}):`, await res.text().catch(() => ""));
    } catch (e) {
      console.error("intruder-alert telegram failed:", e);
    }
  }

  // Short SMS + in-app push to superadmins (SMS must stay brief for one part).
  const short = `KSPONSOR ALERT: ${rows.length} failed login attempt${rows.length === 1 ? "" : "s"} (${rows
    .map((r) => r.phone)
    .join(", ")}). Check the admin panel.`;
  await pushAndSmsAdmins(env, short, "Intruder alert", text);

  const emailSent = await sendAdminEmail(env, `Kingdom Sponsor security alert (${rows.length})`, text);

  return { telegramSent, smsSent: true, emailSent };
}

/** Scheduled scan: alert once about every failed login that hasn't been
 *  reported yet (only runs when the intruder-alert toggle is on). */
async function runIntruderAlerts(env: Bindings): Promise<void> {
  const flag = await env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'intruder_alert_telegram'"
  ).first<Record<string, any>>();
  if (flag?.value !== "1") return;

  const rows = await env.DB.prepare(
    "SELECT id, phone, ip, user_agent, reason, created_at FROM failed_logins WHERE notified = 0 ORDER BY id ASC LIMIT 20"
  ).all<FailedLoginRow>();
  if (!rows.results.length) return;

  await notifyIntruderAlert(env, rows.results);
  const ids = rows.results.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  await env.DB.prepare(
    `UPDATE failed_logins SET notified = 1 WHERE id IN (${placeholders})`
  ).bind(...ids).run();
  console.log(`intruder-alert: reported ${ids.length} failed login(s)`);
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

  // Sliding session: when the token has less than 60 days left, re-issue a
  // fresh 90-day token so active users almost never need a new SMS code.
  const remaining = payload.exp - Math.floor(Date.now() / 1000);
  if (remaining < 60 * 86400) {
    const fresh = await signToken(
      { sub: payload.sub, phone: payload.phone, isHost: payload.isHost, username: payload.username },
      c.env.JWT_SECRET as string
    );
    c.header("x-refresh-token", fresh);
  }
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

/** Attach a user to their referrer (only when the referrer is a different real user).
 *  Works for both new signups and pre-existing accounts that never linked before;
 *  a user can only ever be linked to one referrer (unique index on referred_user_id). */
async function attachReferral(env: Bindings, userId: number, rawCode?: string): Promise<void> {
  const code = String(rawCode ?? "").trim().toUpperCase();
  if (code.length < 4) return;
  const referrer = await env.DB.prepare("SELECT id FROM users WHERE referral_code = ?")
    .bind(code).first<{ id: number }>();
  if (!referrer || referrer.id === userId) return;
  const already = await env.DB.prepare("SELECT 1 FROM referrals WHERE referred_user_id = ?")
    .bind(userId).first();
  if (already) return;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO referrals (referrer_user_id, referred_user_id) VALUES (?, ?)"
  ).bind(referrer.id, userId).run();
}

/** Referral reward threshold (admin_settings, default 5 signups). */
async function referralRewardThreshold(env: Bindings): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM admin_settings WHERE key = 'referral_reward_threshold'")
    .first<{ value: string }>();
  const n = Math.round(Number(row?.value ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/** Confirm a contribution (webhook or polling) and credit the campaign. */
async function confirmContribution(env: Bindings, referenceId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM contributions WHERE lipila_reference = ?"
  ).bind(referenceId).first<Record<string, any>>();
  if (!row || row.status === "confirmed") return;

  // Idempotency: only the call that flips pending -> confirmed proceeds, so a
  // webhook replay or a concurrent status poll can't double-notify or double-
  // trigger the auto-disburse path.
  const confirmRes = await env.DB.prepare(
    "UPDATE contributions SET status = 'confirmed', confirmed_at = datetime('now', '+2 hours') WHERE id = ? AND status = 'pending'"
  ).bind(row.id).run();
  if ((confirmRes.meta?.changes ?? 0) === 0) return;

  const raisedBefore = (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
  ).bind(row.campaign_id).first<{ s: number }>())?.s ?? 0;

  const campaign = await env.DB.prepare(
    "SELECT c.*, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(row.campaign_id).first<Record<string, any>>();
  const available = await availableBalance(env, row.campaign_id);
  const shareLink = campaign ? await createShortLink(env, `${env.APP_URL}/share/${campaign.id}`) : undefined;
  if (campaign?.host_phone) {
    await smsIfNoPush(env, campaign.host_user_id, campaign.host_phone, donationReceivedSms(campaign.title, row.amount_cents, available, shareLink));
    await pushToUser(env, campaign.host_user_id, "New gift received",
      `Someone gave ${(row.amount_cents / 100).toLocaleString()} ZMW to "${campaign.title}".`,
      { type: "donation_received", campaignId: String(campaign.id) })
      .catch((e) => console.error("host push failed:", e));
  }
  if (row.phone) {
    await smsIfNoPush(env, row.donor_user_id, row.phone, donationConfirmedSms(campaign?.title ?? "campaign", row.amount_cents, referenceId, shareLink));
    await pushToUser(env, row.donor_user_id, "Gift confirmed",
      `Thank you! Your gift of ${(row.amount_cents / 100).toLocaleString()} ZMW to "${campaign?.title ?? "campaign"}" is confirmed.`,
      { type: "donation_confirmed", campaignId: String(campaign?.id ?? ""), contributionId: String(row.id) })
      .catch((e) => console.error("donor push failed:", e));

    // Donor joined notification: if this is the donor's first confirmed contribution.
    if (row.donor_user_id) {
      const firstCount = Number(
        (await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM contributions WHERE donor_user_id = ? AND status = 'confirmed'"
        ).bind(row.donor_user_id).first<{ c: number }>())?.c ?? 0
      ) === 1;
      if (firstCount) {
        await pushToUser(env, campaign?.host_user_id, "New donor joined",
          `${campaign?.title ?? "Your campaign"} just received its first gift from a new supporter.`,
          { type: "new_donor", campaignId: String(campaign?.id ?? "") })
          .catch((e) => console.error("new donor push failed:", e));
      }
    }
  }

  // Alert the superadmin(s) about every confirmed donation.
  await pushAdmins(env, "New donation",
    `${(row.amount_cents / 100).toLocaleString()} ZMW given to "${campaign?.title ?? "campaign"}".`,
    { type: "donation", campaignId: String(campaign?.id ?? "") }).catch(() => {});

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
    await smsIfNoPush(env, campaign.host_user_id, campaign.host_phone, `ðŸŽ‰ ${campaign.title} has reached its goal of ${(campaign.goal_cents / 100).toLocaleString()} ZMW!`);
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

/** Campaign's withdrawable balance = gross confirmed donations minus
 * already-withdrawn amounts, withdrawal disbursement fees, and the
 * platform's payout cut taken at withdrawal time.
 * NOTE: per-donation platform fees (platformFeeCents) and Lipila
 * collection fees (lipilaFeeCents) are NOT subtracted here â€” they are
 * already paid by the donor on top of their gift amount.
 */
async function availableBalance(env: Bindings, campaignId: number): Promise<number> {
const [raised, withdrawn, disbursementFees, payoutPlatformFees] = await env.DB.batch([
    env.DB.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM contributions WHERE campaign_id = ? AND status = 'confirmed'").bind(campaignId),
    env.DB.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','success')").bind(campaignId),
    env.DB.prepare("SELECT COALESCE(SUM(disbursement_fee_cents),0) AS s FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','success')").bind(campaignId),
    env.DB.prepare("SELECT COALESCE(SUM(platform_fee_cents),0) AS s FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','success')").bind(campaignId),
  ]);
  const g = (r: any) => (r?.results?.[0]?.s ?? r?.[0]?.s ?? 0);
  const balance = g(raised) - g(withdrawn) - g(disbursementFees) - g(payoutPlatformFees);
  return Math.max(0, balance); // never show a negative withdrawable balance
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

  // Idempotency: never start a second payout while one is still in flight
  // (guards host double-taps, cron overlap, and network retries).
  const inFlight = (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','processing')"
  ).bind(campaignId).first<{ n: number }>())?.n ?? 0;
  if (inFlight > 0) return 0;

  // Back-off: don't retry within 30 minutes of the last failed attempt.
  // Changed from 24h to allow faster retries when API issues are resolved.
  const lastFailed = (await env.DB.prepare(
    "SELECT created_at FROM withdrawals WHERE campaign_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1"
  ).bind(campaignId).first<{ created_at: string }>())?.created_at;
  if (lastFailed) {
    const elapsed = Date.now() - new Date(lastFailed + "Z").getTime();
    if (elapsed < 30 * 60 * 1000) return 0; // skip if last failure < 30 minutes ago
  }

  const payoutCents = payoutAmountCents(available, cfg);
  const lipilaFee = disbursementFeeCents(available, cfg);
  const platformFee = platformDisbursementFeeCents(available, cfg);
  if (payoutCents <= 0) return 0;

  const referenceId = `PAY-${campaignId}-${Date.now()}`;
  try {
    // Atomic idempotency: insert only when no pending/processing payout exists
    // for this campaign, so concurrent triggers (cron + webhook + admin + the
    // per-donation maybeAutoDisburse) can never start a second payout.
    const inserted = await env.DB.prepare(
      "INSERT INTO withdrawals (campaign_id, amount_cents, disbursement_fee_cents, platform_fee_cents, lipila_reference, status) " +
      "SELECT ?, ?, ?, ?, ?, 'pending' " +
      "WHERE NOT EXISTS (SELECT 1 FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','processing'))"
    ).bind(campaignId, payoutCents, lipilaFee, platformFee, referenceId, campaignId).run();
    if ((inserted.meta?.changes ?? 0) === 0) return 0; // another payout already in flight

    const result = await createDisbursement(env, {
      referenceId,
      amountCents: payoutCents,
      accountNumber: campaign.host_phone.replace("+", ""),
      narration: `Kingdom Sponsor payout: ${campaign.title}`,
      callbackUrl: `${env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(env.LIPILA_WEBHOOK_SECRET)}`,
    }, env.DB);

    await env.DB.prepare(
      "UPDATE withdrawals SET lipila_identifier = ? WHERE lipila_reference = ?"
    ).bind(result.identifier, referenceId).run();
    return payoutCents;
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await env.DB.prepare(
      "UPDATE withdrawals SET status = 'failed', error = ? WHERE lipila_reference = ?"
    ).bind(reason, referenceId).run();
    // Log failed attempt to lipila_logs for admin visibility
    await logLipilaEvent(env.DB, "disbursement", referenceId, campaign.host_phone, payoutCents, {
      status: "failed",
      message: reason,
    });
    console.error("disbursement failed:", e);
    if (campaign.host_phone) {
      const failedShareLink = await createShortLink(env, `${env.APP_URL}/share/${campaign.id}`);
      await smsIfNoPush(env, campaign.host_user_id, campaign.host_phone, payoutFailedSms(campaign.title, payoutCents, failedShareLink));
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
    }, env.DB);
  } catch (e) {
    await env.DB.prepare(
      "UPDATE fee_sweeps SET status = 'failed' WHERE lipila_reference = ?"
    ).bind(ref).run();
    const msg = e instanceof Error ? e.message : String(e);
    await logLipilaEvent(env.DB, "disbursement", ref, phone, amountCents, msg);
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
    // Count both confirmed and committed-in-flight sweeps so a missed webhook
    // (row stuck 'pending') can never cause the same fees to be swept twice.
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM fee_sweeps WHERE status IN ('success','pending')"
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

/** Display name of the support assistant used as signature/greeting in replies. */
async function supportAssistantName(env: Bindings): Promise<string> {
  return (await getSetting(env, "support_assistant_name")) ?? "Kingdom Sponsor Care Team";
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
      `Kingdom Sponsor â€” Promotion Payment Received\n\nYour payment of K${(promo.amount_cents / 100).toLocaleString()} for "${campaign.title}" has been received and is pending admin approval. You will be notified once the promotion goes live.`
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
    const promoShareLink = await createShortLink(env, `${env.APP_URL}/share/${campaign.id}`);
    await smsIfNoPush(env, campaign.host_user_id, campaign.host_phone, promotionActiveSms(campaign.title, days, until.slice(0, 10), promoShareLink));
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
    await smsIfNoPush(env, campaign.host_user_id, campaign.host_phone, promotionRejectedSms(campaign.title));
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
  }, env.DB);
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
  await smsIfNoPush(env, campaign.host_user_id, campaign.host_phone, promotionRefundedSms(campaign.title, refund.amount_cents));
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
      await smsIfNoPush(env, row.host_user_id, row.host_phone, promotionExpiredSms(row.title));
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
      await smsIfNoPush(env, row.user_id, row.phone, `Kingdom Sponsor\n\nYour support request #${row.id} ("${row.subject}") was closed after 7 days without a reply. You can reopen it anytime in the app if you still need assistance.`);
      await pushToUser(env, row.user_id, "Support request closed",
        `Your request "${row.subject}" was closed after 7 days without a reply. Open it again if you still need help.`,
        { type: "ticket_closed", ticketId: String(row.id) })
        .catch((e) => console.error("ticket close push failed:", e));
    }
  }
}

// ---------- recurring pledges (monthly reminders) ----------

/** Daily: alert donors when a campaign they supported ends within 48h. */
async function runCampaignEndingAlerts(env: Bindings): Promise<void> {
  if (!envPushConfigured(env)) return;
  const in48h = new Date(Date.now() + 48 * 3600000).toISOString().slice(0, 10);
  const campaigns = await env.DB.prepare(
    `SELECT c.id, c.title, c.ends_at FROM campaigns c
     WHERE c.status = 'active' AND c.visibility = 'public'
       AND c.ends_at IS NOT NULL AND c.ends_at <= ? AND c.ends_at >= date('now')`
  ).bind(in48h).all<{ id: number; title: string; ends_at: string }>();
  for (const c of campaigns.results) {
    const donors = await env.DB.prepare(
      `SELECT DISTINCT dt.token FROM device_tokens dt
       JOIN contributions co ON co.donor_user_id = dt.user_id
       WHERE co.campaign_id = ? AND co.status = 'confirmed'`
    ).bind(c.id).all<{ token: string }>();
    if (!donors.results.length) continue;
    await sendMulticastPush(fbEnv(env), donors.results.map((d) => d.token),
      `"${c.title}" ends soon`,
      `This campaign closes ${new Date(c.ends_at + "T23:59:59Z").toLocaleDateString()}. Give now to make a difference.`,
      { type: "campaign_ending", campaignId: String(c.id) })
      .catch((e) => console.error("campaign-ending push failed:", e));
  }
}

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
    // Deep link opens the app straight to the campaign; SMS shows the link
    // text so people without the app can still tap through to the web page.
    const deepLink = `kingdomsponsor://campaign/${row.campaign_id}`;
    const shareLink = await createShortLink(env, `${env.APP_URL}/share/${row.campaign_id}`);
    const message = pledgeReminderSms(row.campaign_title, row.amount_cents, deepLink, shareLink);
    // Pledge reminders are SMS-first: always send, even to app users (a push
    // may go unnoticed; the pledge reminder SMS is the point of the feature).
    await sendSms(env, row.phone, message).catch((e) => console.error("pledge reminder sms failed:", e));

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
  // Idempotency: only the call that flips pending -> success proceeds. A webhook
  // replay or the cron (runWithdrawalStatusChecks) racing the webhook must not
  // settle the platform fee a second time.
  const res = await env.DB.prepare(
    "UPDATE withdrawals SET status = 'success' WHERE id = ? AND status = 'pending'"
  ).bind(row.id).run();
  if ((res.meta?.changes ?? 0) === 0) return;
  if ((row.platform_fee_cents ?? 0) > 0) {
    await settlePlatformFees(env, referenceId, row.platform_fee_cents);
  }
  const campaign = await env.DB.prepare(
    "SELECT c.*, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(row.campaign_id).first<Record<string, any>>();
   if (campaign?.host_phone) {
    const shareLink = await createShortLink(env, `${env.APP_URL}/share/${campaign.id}`);
    await smsIfNoPush(env, campaign.host_user_id, campaign.host_phone, payoutSentSms(campaign.title, row.amount_cents, shareLink));
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
        const reason = (status.message ?? `Lipila reported status: ${status.status}`).slice(0, 500);
        await env.DB.prepare("UPDATE withdrawals SET status = 'failed', error = ? WHERE id = ? AND status = 'pending'")
          .bind(reason, row.id).run();
      }
    } catch (e) {
      // Check itself failed (network/API) â€” leave pending for retry, but record the last error.
      const reason = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await env.DB.prepare("UPDATE withdrawals SET error = ? WHERE id = ? AND status = 'pending'")
        .bind(reason, row.id).run();
      console.error("withdrawal status check failed:", row.lipila_reference, e);
    }
  }
}

async function failContribution(env: Bindings, referenceId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE contributions SET status = 'failed' WHERE lipila_reference = ? AND status = 'pending'"
  ).bind(referenceId).run();
}

/** Scheduled: re-check pending fee sweeps (platform-fee settlements and manual
 *  admin withdrawals) with Lipila in case a webhook was missed. Without this a
 *  stuck 'pending' sweep would linger and inflate the "settled" ledger. */
async function runFeeSweepStatusChecks(env: Bindings): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id, lipila_reference FROM fee_sweeps WHERE status = 'pending' AND lipila_reference IS NOT NULL ORDER BY created_at ASC LIMIT 50"
  ).all<{ id: number; lipila_reference: string }>();
  for (const row of rows.results) {
    try {
      const status = await checkDisbursementStatus(env, row.lipila_reference);
      const s = String(status.status ?? "").toLowerCase();
      if (s.includes("success") || s.includes("complete")) {
        await env.DB.prepare("UPDATE fee_sweeps SET status = 'success' WHERE id = ? AND status = 'pending'").bind(row.id).run();
      } else if (s.includes("fail") || s.includes("cancel") || s.includes("reject")) {
        await env.DB.prepare("UPDATE fee_sweeps SET status = 'failed' WHERE id = ? AND status = 'pending'").bind(row.id).run();
      }
    } catch (e) {
      // Check failed (network/API) â€” leave pending for the next run.
      console.error("fee sweep status check failed:", row.lipila_reference, e);
    }
  }
}

// ---------- auth ----------

app.post("/api/auth/request-otp", async (c) => {
  const { phone: rawPhone } = await c.req.json();
  const phone = normalizePhone(rawPhone);
  if (!/^\+260\d{9}$/.test(phone)) {
    return c.json({ error: "Enter a valid Zambian phone number (e.g. 0977123456)" }, 400);
  }

  // Don't pay for SMS that cannot be delivered: if the user's own network is
  // marked down by the admin, tell them instead of sending the code.
  if (c.env.ENV === "production") {
    const net = networkOf(phone);
    if (net && (await networkStatus(c.env, net)) === "down") {
      const label = net === "zedmobile" ? "ZedMobile" : `${net[0].toUpperCase()}${net.slice(1)}`;
      return c.json({ error: `${label} SMS service is temporarily unavailable. Please try again shortly.` }, 503);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const ip = clientIp(c);

  // Per-IP throttle (SMS-bomb protection): max 10 OTPs per IP per 10 minutes.
  if (!(await ipOtpAllowed(c.env, ip, 10, 600))) {
    await recordOtpAttempt(c.env, ip, phone);
    return c.json({ error: "Too many requests from this device. Try again later." }, 429);
  }

  const recent = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM otps WHERE phone = ? AND sent_at > ?"
  ).bind(phone, nowSec - 3600).first<{ n: number }>()) ?? { n: 0 };
  if (recent.n >= 5) {
    return c.json({ error: "Too many codes. Try again in an hour." }, 429);
  }
  await recordOtpAttempt(c.env, ip, phone);

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
  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "";
  const ua = c.req.header("User-Agent") ?? "";

  const otp = await c.env.DB.prepare(
    "SELECT * FROM otps WHERE phone = ? ORDER BY id DESC LIMIT 1"
  ).bind(phone).first<Record<string, any>>();
  if (!otp || otp.expires_at < nowSec) {
    await c.env.DB.prepare(
      "INSERT INTO failed_logins (phone, ip, user_agent, reason) VALUES (?, ?, ?, ?)"
    ).bind(phone, ip, ua, "otp_expired").run();
    return c.json({ error: "Code expired. Request a new one." }, 400);
  }
  if (otp.attempts >= 5) {
    await c.env.DB.prepare(
      "INSERT INTO failed_logins (phone, ip, user_agent, reason) VALUES (?, ?, ?, ?)"
    ).bind(phone, ip, ua, "too_many_attempts").run();
    return c.json({ error: "Too many attempts. Request a new code." }, 429);
  }
  const codeHash = await sha256Hex(String(code));
  if (codeHash !== otp.code_hash) {
    await c.env.DB.prepare("UPDATE otps SET attempts = attempts + 1 WHERE id = ?").bind(otp.id).run();
    await c.env.DB.prepare(
      "INSERT INTO failed_logins (phone, ip, user_agent, reason) VALUES (?, ?, ?, ?)"
    ).bind(phone, ip, ua, "wrong_code").run();
    return c.json({ error: "Wrong code." }, 400);
  }

  await c.env.DB.prepare("DELETE FROM otps WHERE phone = ?").bind(phone).run();
  // Clear any failed login records for this phone on successful login.
  await c.env.DB.prepare("DELETE FROM failed_logins WHERE phone = ?").bind(phone).run();

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
  if (referralCode) {
    await attachReferral(c.env, user.id, referralCode);
  }

  if (user.banned) {
    return c.json({
      error: "Your account has been suspended.",
      banReason: user.ban_reason || "Banned by administrator",
    }, 403);
  }

  const token = await signToken({ sub: user.id, phone: user.phone, isHost: !!user.is_host, username: user.username, notifications_enabled: user.notifications_enabled }, c.env.JWT_SECRET);
  return c.json({
    token,
    isNewUser,
    user: {
      id: user.id,
      phone: user.phone,
      username: user.username,
      name: user.name,
      avatarUrl: user.avatar_url ?? null,
      isHost: !!user.is_host,
      isAdmin: isAdminPhone(c.env, user.phone),
      hostStatus: user.host_status ?? "none",
      isBanned: !!user.banned,
      banReason: user.ban_reason ?? null,
      referralCode: user.referral_code ?? await ensureReferralCode(c.env, user.id),
    },
  });
});

// ---------- Admin: SMS network status text ----------

app.get("/api/admin/sms-status", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const row = await c.env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'sms_status'"
  ).first<Record<string, any>>();
  return c.json({ text: row?.value ?? '' });
});

app.put("/api/admin/sms-status", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const text = String(body.text ?? "").trim();
  if (text.length > 500) return c.json({ error: "Text too long (max 500 chars)" }, 400);

  await c.env.DB.prepare(
    "INSERT INTO admin_settings (key, value) VALUES ('sms_status', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(text).run();

  return c.json({ ok: true });
});

// ---------- Admin: per-network SMS status (MTN/Airtel/Zamtel/ZedMobile) ----------

app.get("/api/networks/status", async (c) => {
  const statuses: Record<string, string> = {};
  for (const net of ZM_NETWORKS) {
    statuses[net.id] = await networkStatus(c.env, net.id);
  }
  return c.json({ networks: statuses });
});

app.put("/api/admin/network-status", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const statuses = (body.statuses ?? {}) as Record<string, string>;
  for (const net of ZM_NETWORKS) {
    const v = String(statuses[net.id] ?? "").toLowerCase();
    if (v === "ok" || v === "down") {
      await setSetting(c.env, `net_status_${net.id}`, v);
    }
  }
  return c.json({ ok: true });
});

app.get("/api/admin/pledges", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.campaign_id, p.user_id, u.username, u.phone,
           c.title AS campaign_title, p.amount_cents, p.day_of_month,
           p.active, p.last_reminded_at, p.created_at
     FROM recurring_pledges p
     JOIN users u ON u.id = p.user_id
     JOIN campaigns c ON c.id = p.campaign_id
     WHERE p.active = 1
     ORDER BY p.created_at DESC
     LIMIT 100`
  ).all<Record<string, any>>();

  return c.json({
    pledges: rows.results.map((p) => ({
      id: p.id,
      campaignId: p.campaign_id,
      campaignTitle: p.campaign_title,
      userId: p.user_id,
      username: p.username,
      phone: p.phone,
      amountCents: p.amount_cents,
      dayOfMonth: p.day_of_month,
      active: p.active,
      lastRemindedAt: p.last_reminded_at,
      createdAt: p.created_at,
    })),
  });
});

app.post("/api/admin/pledges/:id/cancel", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid pledge id" }, 400);

  const res = await c.env.DB.prepare(
    "UPDATE recurring_pledges SET active = 0 WHERE id = ?"
  ).bind(id).run();

  if ((res.meta?.changes ?? 0) === 0) {
    return c.json({ error: "Pledge not found or already inactive" }, 404);
  }

  return c.json({ ok: true });
});



app.get("/api/admin/intruder-alert", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const row = await c.env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'intruder_alert_telegram'"
  ).first<Record<string, any>>();
  return c.json({ enabled: row?.value === '1' });
});

app.put("/api/admin/intruder-alert", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const enabled = body.enabled === true;
  await c.env.DB.prepare(
    "INSERT INTO admin_settings (key, value) VALUES ('intruder_alert_telegram', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(enabled ? '1' : '0').run();

  return c.json({ ok: true, enabled });
});

// Admin: list recent failed login attempts (intruder detection).
app.get("/api/admin/failed-logins", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const rows = await c.env.DB.prepare(
    "SELECT id, phone, ip, user_agent, reason, created_at FROM failed_logins ORDER BY id DESC LIMIT 100"
  ).all<Record<string, any>>();

  return c.json({ failedLogins: rows.results });
});

// Admin: configure Telegram bot for intruder alerts.
app.get("/api/admin/telegram-config", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const token = await c.env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'telegram_bot_token'"
  ).first<Record<string, any>>();
  const chatId = await c.env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'telegram_chat_id'"
  ).first<Record<string, any>>();

  return c.json({
    configured: token?.value && chatId?.value,
    hasToken: !!token?.value,
    hasChatId: !!chatId?.value,
  });
});

app.put("/api/admin/telegram-config", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const token = body.token != null ? String(body.token) : null;
  const chatId = body.chatId != null ? String(body.chatId) : null;

  if (token != null) {
    await c.env.DB.prepare(
      "INSERT INTO admin_settings (key, value) VALUES ('telegram_bot_token', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(token).run();
  }
  if (chatId != null) {
    await c.env.DB.prepare(
      "INSERT INTO admin_settings (key, value) VALUES ('telegram_chat_id', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(chatId).run();
  }

  return c.json({ ok: true });
});

// Admin: trigger a test intruder alert (Telegram + SMS + email).
app.post("/api/admin/intruder-alert/test", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const result = await notifyIntruderAlert(c.env, [{
    id: 0,
    phone: "test",
    ip: "0.0.0.0",
    user_agent: "manual test from the admin panel",
    reason: "wrong_code",
    created_at: new Date().toISOString(),
  }]);

  return c.json({ ok: true, ...result });
});

// Admin: configure the email address for alert emails.
app.get("/api/admin/email-config", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const row = await c.env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'admin_email'"
  ).first<Record<string, any>>();

  return c.json({ configured: !!row?.value, email: row?.value ?? "" });
});

app.put("/api/admin/email-config", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const email = body.email != null ? String(body.email).trim() : null;
  if (email == null) return c.json({ error: "email required" }, 400);

  await c.env.DB.prepare(
    "INSERT INTO admin_settings (key, value) VALUES ('admin_email', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(email).run();

  return c.json({ ok: true, email });
});

// ---------- admin backup / restore ----------

const BACKUP_TABLES = [
  "app_settings", "users", "campaigns", "contributions", "withdrawals", "otps",
  "campaign_sponsors", "user_links", "device_tokens", "referrals", "refunds",
  "admin_settings", "failed_logins", "support_tickets", "campaign_delete_requests",
  "receipt_downloads", "announcements", "short_links", "sms_events", "fee_sweeps",
  "recurring_pledges", "promotions", "lipila_logs", "airtime_orders", "host_badges",
];

// Child-first so FK-friendly deletes succeed; inserts then run parent-first.
const BACKUP_DELETE_ORDER = [
  "device_tokens", "receipt_downloads", "user_links", "referrals", "sms_events",
  "campaign_delete_requests", "announcements", "promotions", "recurring_pledges",
  "short_links", "support_tickets", "refunds", "fee_sweeps", "failed_logins",
  "admin_settings", "otps", "campaign_sponsors", "contributions", "withdrawals",
  "lipila_logs", "airtime_orders", "host_badges", "campaigns", "users", "app_settings",
];

app.get("/api/admin/backup/export", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const tables: Record<string, any[]> = {};
  for (const name of BACKUP_TABLES) {
    const exists = await c.env.DB.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).bind(name).first();
    if (!exists) continue;
    const { results } = await c.env.DB.prepare(`SELECT * FROM "${name}"`).all();
    tables[name] = results as any[];
  }

  return c.json({ exportedAt: new Date().toISOString(), app: "kingdom-sponsor", tables });
});

app.post("/api/admin/backup/restore", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  if (body.confirm !== true) return c.json({ error: "confirm: true required" }, 400);
  const incoming = (body.tables ?? {}) as Record<string, any[]>;
  const names = Object.keys(incoming);
  if (names.length === 0) return c.json({ error: "tables required" }, 400);

  for (const name of names) {
    if (!BACKUP_TABLES.includes(name)) {
      return c.json({ error: `table not allowed: ${name}` }, 400);
    }
  }

  const stmts: any[] = [];
  for (const name of BACKUP_DELETE_ORDER) {
    if (incoming[name]) stmts.push(c.env.DB.prepare(`DELETE FROM "${name}"`));
  }
  for (const name of names) {
    const rows = incoming[name];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const cols = Object.keys(rows[0]);
    if (cols.length === 0) continue;
    for (const row of rows) {
      const placeholders = cols.map(() => "?").join(", ");
      const values = cols.map((col) => (row[col] === undefined ? null : row[col]));
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO "${name}" (${cols.map((col) => `"${col}"`).join(", ")}) VALUES (${placeholders})`
        ).bind(...values)
      );
    }
  }

  for (let i = 0; i < stmts.length; i += 50) {
    await c.env.DB.batch(stmts.slice(i, i + 50));
  }

  return c.json({ ok: true, restoredTables: names });
});

// ---------- public campaign views ----------

async function campaignPublic(env: Bindings, row: Record<string, any>): Promise<Record<string, any>> {
  // Host display name (from row.host_name when the caller joined users, else looked up).
  let hostName: string | null = row.host_name ?? null;
  let hostVerified = !!row.host_verified;
  let hostOrg: string | null = row.host_org ?? null;
  if (!hostName && row.host_user_id != null) {
    const host = await env.DB.prepare("SELECT username, host_verified, host_org FROM users WHERE id = ?")
      .bind(row.host_user_id).first<{ username: string | null; host_verified: number | null; host_org: string | null }>();
    hostName = host?.username ?? null;
    hostVerified = !!host?.host_verified;
    hostOrg = host?.host_org ?? null;
  }
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
    hostName,
    hostVerified,
    hostOrg,
    campaignType: row.campaign_type ?? "community",
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
    category: row.category ?? "Other",
    visibility: row.visibility ?? "public",
    createdAt: row.created_at,
    shareUrl: `${env.APP_URL}/share/${row.id}`,
  };
}

// ---------- campaign categories ----------

app.get("/api/campaign-categories", async (c) => {
  return c.json({ categories: CAMPAIGN_CATEGORIES });
});

app.get("/api/campaigns", async (c) => {
  const category = c.req.query("category");
  const rows = await c.env.DB.prepare(
    category && isValidCategory(category)
      ? "SELECT c.*, u.username AS host_name, u.host_verified, u.host_org AS host_org FROM campaigns c LEFT JOIN users u ON u.id = c.host_user_id WHERE c.status = 'active' AND c.visibility = 'public' AND c.category = ? ORDER BY c.promoted DESC, c.created_at DESC LIMIT 100"
      : "SELECT c.*, u.username AS host_name, u.host_verified, u.host_org AS host_org FROM campaigns c LEFT JOIN users u ON u.id = c.host_user_id WHERE c.status = 'active' AND c.visibility = 'public' ORDER BY c.promoted DESC, c.created_at DESC LIMIT 100"
  ).bind(...(category && isValidCategory(category) ? [category] : [])).all<Record<string, any>>();
  const out = [];
  for (const row of rows.results) {
    try {
      out.push(await campaignPublic(c.env, row));
    } catch (e) {
      console.error(`campaignPublic failed for campaign ${row.id}:`, e);
      // Include minimal campaign data so the list still shows
      out.push({
        id: row.id, slug: row.slug, title: row.title, description: row.description,
        blurb: String(row.description ?? "").slice(0, 140), imageUrl: row.image_url,
        logoUrl: row.logo_url ?? null, goalCents: Number(row.goal_cents),
        hasGoal: Number(row.goal_cents) > 0, raisedCents: 0, withdrawnCents: 0,
        donorCount: 0, donationCount: 0, avgDonationCents: 0, donorsNeededAtAvg: null,
        dailyRateCents: 0, estimatedEndDate: null, endsAt: row.ends_at ?? null,
        promoted: !!row.promoted, promotedUntil: row.promoted_until ?? null,
        status: row.status, category: row.category ?? "Other",
        createdAt: row.created_at, shareUrl: null,
      });
    }
  }

  // Batch-shorten share URLs (1 SELECT for existing + INSERTs only for new
  // campaigns) so the hot list path stays cheap and users never see the raw
  // workers.dev link.
  const longs = out.map((o) => o.shareUrl).filter((u): u is string => u != null);
  if (longs.length > 0) {
    const placeholders = longs.map(() => "?").join(",");
    const existingRows = await c.env.DB.prepare(
      `SELECT long_url, short_url FROM short_links WHERE long_url IN (${placeholders})`
    ).bind(...longs).all<{ long_url: string; short_url: string }>();
    const existing = new Map(existingRows.results.map((r) => [r.long_url, r.short_url]));
    const base = shortBaseUrl(c.env);
    for (const u of longs) {
      if (existing.has(u)) continue;
      const shortUrl = `${base}/go/${shortCodeFor(u)}`;
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO short_links (long_url, short_url, clicks) VALUES (?, ?, 0)"
      ).bind(u, shortUrl).run();
      existing.set(u, shortUrl);
    }
    for (const o of out) {
      if (o.shareUrl) o.shareUrl = existing.get(o.shareUrl) ?? o.shareUrl;
    }
  }

  c.header("Cache-Control", "public, max-age=30");
  return c.json({ campaigns: out });
});

// Smart campaign search: matches title, description, host name, organisation
// and category. Falls back gracefully to an empty result set.
app.get("/api/campaigns/search", async (c) => {
  const q = String(c.req.query("q") ?? "").trim().slice(0, 80);
  if (!q) return c.json({ campaigns: [] });
  const like = `%${q}%`;
  const rows = await c.env.DB.prepare(
    `SELECT c.*, u.username AS host_name, u.host_verified, u.host_org AS host_org
     FROM campaigns c LEFT JOIN users u ON u.id = c.host_user_id
     WHERE c.status = 'active' AND c.visibility = 'public'
       AND (c.title LIKE ? OR c.description LIKE ? OR c.category LIKE ?
            OR u.username LIKE ? OR COALESCE(u.host_org,'') LIKE ?)
     ORDER BY c.promoted DESC, c.created_at DESC LIMIT 50`
  ).bind(like, like, like, like, like).all<Record<string, any>>();
  const out = [];
  for (const row of rows.results) {
    try {
      out.push(await campaignPublic(c.env, row));
    } catch (e) {
      console.error(`campaignPublic failed for ${row.id} during search:`, e);
    }
  }
  return c.json({ campaigns: out });
});

app.get("/api/campaigns/:id", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT c.*, u.username AS host_name, u.host_verified, u.host_org AS host_org FROM campaigns c LEFT JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "Campaign not found" }, 404);
  const pub = await campaignPublic(c.env, row);
  pub.shareUrl = await createShortLink(c.env, `${c.env.APP_URL}/share/${row.id}`);

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
    `SELECT co.donor_user_id, u.username, co.phone, SUM(co.amount_cents) AS total
     FROM contributions co LEFT JOIN users u ON u.id = co.donor_user_id
     WHERE co.campaign_id = ? AND co.status = 'confirmed' AND co.hide_amount = 0
     GROUP BY (CASE WHEN co.donor_user_id IS NULL THEN 'a' || co.phone ELSE 'u' || co.donor_user_id END)
     ORDER BY total DESC`
  ).bind(row.id).all<Record<string, any>>();

  return c.json({
    campaign: pub,
    donors: donorList,
    leaderboard: leaderboard.results.map((l) => ({
      username: l.username ?? (l.phone ? `Giver${String(l.phone).slice(-4)}` : "Giver"),
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
  const kycType = body.kycType != null ? String(body.kycType).trim() : null;
  const kycDocUrl = body.kycDocUrl != null ? String(body.kycDocUrl).trim() : null;
  const kycNotes = body.kycNotes != null ? String(body.kycNotes).trim().slice(0, 500) : null;
  if (!org) return c.json({ error: "Organization name is required" }, 400);
  if (kycType !== null && !(HOST_KYC_TYPES as readonly string[]).includes(kycType)) {
    return c.json({ error: "Invalid KYC document type" }, 400);
  }

  const current = await hostStatusOf(c.env, user.sub);
  if (current.host_status === "approved") {
    return c.json({ message: "You are already an approved host", hostStatus: "approved" });
  }

  await c.env.DB.prepare(
    `UPDATE users SET host_status = 'pending', host_org = ?, host_role = ?, host_reason = ?, host_rejection = NULL,
            host_kyc_status = ?, host_kyc_type = ?, host_kyc_doc_url = ?, host_kyc_notes = ? WHERE id = ?`
  ).bind(org, role || null, reason || null,
         kycType ? "submitted" : "none", kycType, kycDocUrl || null, kycNotes, user.sub).run();

  // Alert the superadmin(s) so applications are reviewed fast.
  await pushAdmins(c.env,
    "New host application",
    `${user.username ?? user.phone} applied to become a host (${org}).`,
    { type: "host_application" }).catch(() => {});

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
  const category = body.category != null ? String(body.category).trim() : "Other";
  const visibility = body.visibility === "private" ? "private" : "public";
  const campaignType = body.campaignType != null ? String(body.campaignType).trim() : "community";
  const goalCents = Math.round(Number(body.goalCents) || 0);
  const minWithdrawCents = Math.round(Number(body.minWithdrawCents) || 1000);
  const minSponsors = Math.max(1, Math.round(Number(body.minSponsors) || 1));
  if (!title || !description) return c.json({ error: "Title and description are required" }, 400);
  if (!isValidCategory(category)) return c.json({ error: "Invalid campaign category" }, 400);
  if (!(CAMPAIGN_TYPES as readonly string[]).includes(campaignType)) return c.json({ error: "Invalid campaign type" }, 400);

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
    "INSERT INTO campaigns (slug, title, description, goal_cents, min_withdraw_cents, host_user_id, ends_at, min_sponsors, category, visibility, campaign_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(slug, title, description, goalCents, minWithdrawCents, user.sub, endsAt, minSponsors, category, visibility, campaignType).run();

  const campaignId = Number(r.meta?.last_row_id ?? 0);

  // Notify past donors of this host's campaigns about the new campaign
  // (only public ones â€” a private campaign is shared by the host directly).
  if (visibility === "public") {
  const pastDonors = await c.env.DB.prepare(
    "SELECT DISTINCT u.id, u.fcm_token FROM contributions co JOIN campaigns c ON c.id = co.campaign_id JOIN users u ON u.id = co.donor_user_id WHERE c.host_user_id = ? AND u.fcm_token IS NOT NULL LIMIT 50"
  ).bind(user.sub).all<{ id: number; fcm_token: string }>();
  if (pastDonors.results.length && envPushConfigured(c.env)) {
    const tokens = pastDonors.results.map((u) => u.fcm_token);
    const donorIds = pastDonors.results.map((u) => u.id);
    await sendMulticastPush(fbEnv(c.env), tokens, "New campaign posted",
      `${user.username ?? "Someone you support"} just started "${title}". Give now on Kingdom Sponsor.`,
      { type: "new_campaign", campaignId: String(campaignId) }
    ).catch((e) => console.error("new campaign push failed:", e));
  }
  }

  return c.json({ id: campaignId, slug }, 201);
});

// ---------- Admin: Update campaign (title, description, goal, etc.) ----------

app.put("/api/admin/campaigns/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const body = await c.req.json();
  const title = body.title != null ? String(body.title).trim() : null;
  const description = body.description != null ? String(body.description).trim() : null;
  const goalCents = body.goalCents != null ? Math.round(Number(body.goalCents)) : null;
  const minWithdrawCents = body.minWithdrawCents != null ? Math.round(Number(body.minWithdrawCents)) : null;
  const minSponsors = body.minSponsors != null ? Math.max(1, Math.round(Number(body.minSponsors))) : null;
  const status = body.status != null ? String(body.status) : null;
  const category = body.category != null ? String(body.category).trim() : null;
  const visibility = body.visibility != null ? String(body.visibility) : null;
  const campaignType = body.campaignType != null ? String(body.campaignType).trim() : null;
  if (category !== null && !isValidCategory(category)) {
    return c.json({ error: "Invalid campaign category" }, 400);
  }
  if (visibility !== null && !["public", "private"].includes(visibility)) {
    return c.json({ error: "Invalid visibility" }, 400);
  }
  if (campaignType !== null && !(CAMPAIGN_TYPES as readonly string[]).includes(campaignType)) {
    return c.json({ error: "Invalid campaign type" }, 400);
  }

  let endsAt: string | null = null;
  if (body.endsAt != null) {
    if (body.endsAt === null) {
      endsAt = null;
    } else {
      const parsed = new Date(String(body.endsAt));
      if (isNaN(parsed.getTime())) return c.json({ error: "endsAt must be a valid date" }, 400);
      endsAt = parsed.toISOString().slice(0, 10);
    }
  }

  if (title !== null && !title) return c.json({ error: "Title cannot be empty" }, 400);
  if (status !== null && !["active", "draft", "ended", "deleted"].includes(status)) {
    return c.json({ error: "Invalid status" }, 400);
  }

  const sets: string[] = [];
  const vals: any[] = [];
  if (title !== null) { sets.push("title = ?"); vals.push(title); }
  if (description !== null) { sets.push("description = ?"); vals.push(description); }
  if (goalCents !== null) { sets.push("goal_cents = ?"); vals.push(goalCents); }
  if (minWithdrawCents !== null) { sets.push("min_withdraw_cents = ?"); vals.push(minWithdrawCents); }
  if (minSponsors !== null) { sets.push("min_sponsors = ?"); vals.push(minSponsors); }
  if (status !== null) { sets.push("status = ?"); vals.push(status); }
  if (category !== null) { sets.push("category = ?"); vals.push(category); }
  if (visibility !== null) { sets.push("visibility = ?"); vals.push(visibility); }
  if (campaignType !== null) { sets.push("campaign_type = ?"); vals.push(campaignType); }
  if (endsAt !== null) { sets.push("ends_at = ?"); vals.push(endsAt); }

  if (sets.length === 0) return c.json({ error: "No fields to update" }, 400);

  vals.push(campaign.id);
  await c.env.DB.prepare(
    `UPDATE campaigns SET ${sets.join(", ")} WHERE id = ?`
  ).bind(...vals).run();

  const updated = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(campaign.id).first<Record<string, any>>();

  // Notify past donors of significant campaign updates (transparency).
  if (title !== null || description !== null || goalCents !== null || status !== null) {
    const donors = await c.env.DB.prepare(
      "SELECT DISTINCT u.id, u.fcm_token FROM contributions co JOIN users u ON u.id = co.donor_user_id WHERE co.campaign_id = ? AND u.fcm_token IS NOT NULL LIMIT 50"
    ).bind(campaign.id).all<{ id: number; fcm_token: string }>();
    if (donors.results.length && envPushConfigured(c.env)) {
      const tokens = donors.results.map((u) => u.fcm_token);
      await sendMulticastPush(fbEnv(c.env), tokens, "Campaign updated",
        `"${title ?? campaign.title}" has been updated by the host.`,
        { type: "campaign_updated", campaignId: String(campaign.id) }
      ).catch((e) => console.error("campaign-updated push failed:", e));
    }
  }

  return c.json({ ok: true, campaign: updated });
});

// ---------- Host: edit their own campaign ----------

app.put("/api/campaigns/:id", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.host_user_id !== user.sub) {
    return c.json({ error: "You can only request changes to your own campaigns" }, 403);
  }
  if (campaign.status === "deleted") {
    return c.json({ error: "This campaign is deleted and can no longer be edited." }, 400);
  }

  const body = await c.req.json();

  // Hosts cannot edit campaigns directly (fraud protection). Validate the
  // proposed fields, then store them for a superadmin to review and apply.
  const proposed: Record<string, any> = {};
  const allowed: Array<[string, (v: any) => any | null]> = [
    ["title", (v) => (v != null ? String(v).trim() : null)],
    ["description", (v) => (v != null ? String(v).trim() : null)],
    ["goalCents", (v) => (v != null ? Math.round(Number(v)) : null)],
    ["minWithdrawCents", (v) => (v != null ? Math.round(Number(v)) : null)],
    ["category", (v) => (v != null ? String(v).trim() : null)],
    ["visibility", (v) => (v != null ? String(v) : null)],
    ["campaignType", (v) => (v != null ? String(v).trim() : null)],
  ];
  for (const [key, clean] of allowed) {
    if (key in body) proposed[key] = clean(body[key]);
  }

  // Ends-at handling (null clears it).
  if ("endsAt" in body) {
    if (body.endsAt === null) proposed.endsAt = null;
    else {
      const parsed = new Date(String(body.endsAt));
      if (isNaN(parsed.getTime())) return c.json({ error: "endsAt must be a valid date" }, 400);
      proposed.endsAt = parsed.toISOString().slice(0, 10);
    }
  }

  if (Object.keys(proposed).length === 0) {
    return c.json({ error: "No changes to request" }, 400);
  }
  if (proposed.category != null && !isValidCategory(proposed.category)) {
    return c.json({ error: "Invalid campaign category" }, 400);
  }
  if (proposed.visibility != null && !["public", "private"].includes(proposed.visibility)) {
    return c.json({ error: "Invalid visibility" }, 400);
  }
  if (proposed.campaignType != null && !(CAMPAIGN_TYPES as readonly string[]).includes(proposed.campaignType)) {
    return c.json({ error: "Invalid campaign type" }, 400);
  }
  if (proposed.title === "") return c.json({ error: "Title cannot be empty" }, 400);

  // Prevent duplicate pending requests for the same campaign.
  const dup = await c.env.DB.prepare(
    "SELECT id FROM campaign_edit_requests WHERE campaign_id = ? AND status = 'pending' LIMIT 1"
  ).bind(campaign.id).first<{ id: number }>();
  if (dup) {
    return c.json({ error: "You already have a pending edit request for this campaign. Wait for the admin to review it." }, 409);
  }

  await c.env.DB.prepare(
    "INSERT INTO campaign_edit_requests (campaign_id, host_user_id, proposed_json) VALUES (?, ?, ?)"
  ).bind(campaign.id, user.sub, JSON.stringify(proposed)).run();

  // Notify superadmins so the request is reviewed promptly.
  await pushAdmins(c.env, "Campaign edit request",
    `${user.username ?? user.phone} requested changes to "${campaign.title}".`,
    { type: "campaign_edit_request", campaignId: String(campaign.id) }).catch(() => {});

  return c.json({
    ok: true,
    message: "Your edit request has been submitted for review. You'll be notified once approved.",
  });
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
  const totalCents = amountCents + fees.platformFeeCents + fees.lipilaFeeCents;
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
      amountCents: totalCents,
      accountNumber: phone.replace("+", ""),
      narration: `Kingdom Sponsor donation to ${campaign.title}`,
      callbackUrl: `${c.env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(c.env.LIPILA_WEBHOOK_SECRET)}`,
    }, c.env.DB);
    await c.env.DB.prepare(
      "UPDATE contributions SET lipila_identifier = ? WHERE id = ?"
    ).bind(result.identifier, r.meta.last_row_id).run();
    return c.json({
      referenceId,
      message: "Check your phone and enter your PIN to complete the donation.",
      platformFeeCents: fees.platformFeeCents,
      lipilaFeeCents: fees.lipilaFeeCents,
      totalCents,
    });
  } catch (e) {
    await c.env.DB.prepare(
      "UPDATE contributions SET status = 'failed' WHERE id = ?"
    ).bind(r.meta.last_row_id).run();
    const msg = e instanceof Error ? e.message : String(e);
    await logLipilaEvent(c.env.DB, "collection", referenceId, phone, totalCents, msg);
    console.error("collection failed:", e);
    return c.json({ error: "Payment could not be started. Try again." }, 502);
  }
});

// Card donations â€” same flow as mobile money, but the payer completes the
// payment on Lipila's hosted checkout (cardRedirectionUrl) instead of a
// USSD prompt. Disbursements stay mobile-money only.
app.post("/api/campaigns/:id/contribute-card", async (c) => {
  const user = await authUser(c);
  const body = await c.req.json().catch(() => ({}));
  const amountCents = Math.round(Number(body.amountCents) || 0);
  if (amountCents < 100) return c.json({ error: "Minimum donation is K1.00" }, 400);

  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(c.req.param("id")).first();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.status !== "active") return c.json({ error: "Campaign is closed" }, 400);

  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "Enter a valid email address for the card receipt" }, 400);
  }
  const phone = normalizePhone(body.phone ?? user?.phone ?? "");
  if (!/^\+260\d{9}$/.test(phone)) {
    return c.json({ error: "Enter a valid Zambian phone number" }, 400);
  }
  const fullName = String(body.donorName ?? "").trim();
  const nameParts = fullName.split(/\s+/);
  const firstName = nameParts[0] || "Kingdom";
  const lastName = nameParts.slice(1).join(" ") || "Sponsor";

  const donor = await ensureUser(c.env.DB, phone);
  const recent = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM contributions WHERE phone = ? AND created_at > datetime('now', '-1 minute')"
  ).bind(phone).first<{ n: number }>())?.n ?? 0;
  if (recent >= 3) return c.json({ error: "Too many attempts. Wait a moment and try again." }, 429);

  const cfg = loadFeeConfig(c.env);
  const fees = donationFees(amountCents, cfg, "card");
  const totalCents = amountCents + fees.platformFeeCents + fees.lipilaFeeCents;
  const referenceId = `CON-${campaign.id}-${Date.now()}`;

  const r = await c.env.DB.prepare(
    `INSERT INTO contributions (campaign_id, donor_user_id, donor_name, is_anonymous, hide_amount, phone, amount_cents, platform_fee_cents, lipila_fee_cents, lipila_reference, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(
    campaign.id,
    donor.id,
    fullName || null,
    body.isAnonymous ? 1 : 0,
    body.hideAmount ? 1 : 0,
    phone,
    amountCents,
    fees.platformFeeCents,
    fees.lipilaFeeCents,
    referenceId
  ).run();

  try {
    const result = await createCardCollection(c.env, {
      referenceId,
      amountCents: totalCents,
      narration: `Kingdom Sponsor donation to ${campaign.title}`,
      callbackUrl: `${c.env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(c.env.LIPILA_WEBHOOK_SECRET)}`,
      customerInfo: { firstName, lastName, phoneNumber: phone, email },
      backUrl: `${c.env.APP_URL}/share/${campaign.id}`,
      referenceData: `Kingdom Sponsor donation ${campaign.id}`,
    }, c.env.DB);
    await c.env.DB.prepare(
      "UPDATE contributions SET lipila_identifier = ? WHERE id = ?"
    ).bind(result.identifier, r.meta.last_row_id).run();
    return c.json({
      referenceId,
      cardRedirectionUrl: result.cardRedirectionUrl,
      message: "Complete your payment in the secure checkout window.",
      platformFeeCents: fees.platformFeeCents,
      lipilaFeeCents: fees.lipilaFeeCents,
      totalCents,
    });
  } catch (e) {
    await c.env.DB.prepare(
      "UPDATE contributions SET status = 'failed' WHERE id = ?"
    ).bind(r.meta.last_row_id).run();
    const msg = e instanceof Error ? e.message : String(e);
    await logLipilaEvent(c.env.DB, "collection", referenceId, phone, totalCents, msg);
    console.error("card collection failed:", e);
    return c.json({ error: "Payment could not be started. Try again." }, 502);
  }
});

app.get("/api/contributions/status/:referenceId", async (c) => {
  const referenceId = c.req.param("referenceId");
  const row = await c.env.DB.prepare(
    "SELECT * FROM contributions WHERE lipila_reference = ? OR lipila_identifier = ?"
  ).bind(referenceId, referenceId).first<Record<string, any>>();
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status === "pending") {
    try {
      const effectiveRef = row.lipila_reference;
      const st = await checkCollectionStatus(c.env, effectiveRef);
      const s = String(st.status).toLowerCase();
      if (s.includes("success")) {
        await confirmContribution(c.env, effectiveRef);
        row.status = "confirmed";
      } else if (s.includes("fail") || s.includes("cancelled") || s.includes("canceled")) {
        await failContribution(c.env, effectiveRef);
        row.status = "failed";
      }
    } catch (e) {
      console.error("status check failed:", e);
    }
  }
  return c.json({
    referenceId: row.lipila_reference,
    id: row.id,
    status: row.status,
    amountCents: row.amount_cents,
  });
});

/** Resend a Lipila collection prompt for a pending contribution.
 *  Generates a fresh referenceId so Lipila creates a new prompt,
 *  and updates the row so the app's poll still finds it.
 */
app.post("/api/contributions/:referenceId/resend-prompt", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const oldRef = c.req.param("referenceId");
  const row = await c.env.DB.prepare(
    "SELECT * FROM contributions WHERE lipila_reference = ?"
  ).bind(oldRef).first<Record<string, any>>();
  if (!row) return c.json({ error: "Not found" }, 404);

  // IDOR guard: only the donor, the campaign host, or an admin may resend.
  const campaignCheck = await c.env.DB.prepare(
    "SELECT host_user_id FROM campaigns WHERE id = ?"
  ).bind(row.campaign_id).first<{ host_user_id: number }>();
  const isOwner = row.donor_user_id === user.sub || row.phone === user.phone;
  const isHost = campaignCheck?.host_user_id === user.sub;
  const isAdmin = isAdminPhone(c.env, user.phone);
  if (!isOwner && !isHost && !isAdmin) {
    return c.json({ error: "Not authorized to resend this prompt" }, 403);
  }
  if (row.status !== "pending") {
    return c.json({ error: "This payment is no longer waiting for your PIN." }, 400);
  }

  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(row.campaign_id).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const cfg = loadFeeConfig(c.env);
  const fees = donationFees(row.amount_cents, cfg);
  const newRef = `${oldRef}-R${Date.now()}`;
  const totalCents = row.amount_cents + fees.platformFeeCents + fees.lipilaFeeCents;

  await c.env.DB.prepare(
    "UPDATE contributions SET lipila_reference = ?, lipila_identifier = NULL, platform_fee_cents = ?, lipila_fee_cents = ? WHERE id = ?"
  ).bind(newRef, fees.platformFeeCents, fees.lipilaFeeCents, row.id).run();

  try {
    const result = await createCollection(c.env, {
      referenceId: newRef,
      amountCents: totalCents,
      accountNumber: row.phone.replace("+", ""),
      narration: `Kingdom Sponsor donation to ${campaign.title}`,
      callbackUrl: `${c.env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(c.env.LIPILA_WEBHOOK_SECRET)}`,
    }, c.env.DB);
    await c.env.DB.prepare(
      "UPDATE contributions SET lipila_identifier = ? WHERE id = ?"
    ).bind(result.identifier, row.id).run();
    return c.json({
      referenceId: newRef,
      message: "A new payment prompt has been sent to your phone.",
      platformFeeCents: fees.platformFeeCents,
      lipilaFeeCents: fees.lipilaFeeCents,
      totalCents,
    });
  } catch (e) {
    await c.env.DB.prepare(
      "UPDATE contributions SET lipila_reference = ?, lipila_identifier = NULL WHERE id = ?"
    ).bind(oldRef, row.id).run();
    console.error("resend collection failed:", e);
    return c.json({ error: "Could not resend the prompt. Try again." }, 502);
  }
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

// ---------- push notification preferences ----------

app.get("/api/user/notifications", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  return c.json({ enabled: user.notifications_enabled === 1 });
});

app.put("/api/user/notifications", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const body = await c.req.json();
  const enabled = body.enabled === true || body.enabled === "true";
  await c.env.DB.prepare(
    "UPDATE users SET notifications_enabled = ? WHERE id = ?"
  ).bind(enabled ? 1 : 0, user.sub).run();
  return c.json({ ok: true, enabled });
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
  const totalCents = amountCents + fees.platformFeeCents + fees.lipilaFeeCents;
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
      amountCents: totalCents,
      accountNumber: phone.replace("+", ""),
      narration: `Kingdom Sponsor gift to ${campaign.title}`,
      callbackUrl: `${c.env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(c.env.LIPILA_WEBHOOK_SECRET)}`,
    }, c.env.DB);
    await c.env.DB.prepare("UPDATE contributions SET lipila_identifier = ? WHERE id = ?")
      .bind(result.identifier, r.meta.last_row_id).run();
    return c.json({
      referenceId,
      message: "Check your phone and enter PIN to complete the gift.",
      platformFeeCents: fees.platformFeeCents,
      lipilaFeeCents: fees.lipilaFeeCents,
      totalCents,
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
      // Phones are private (schema rule); expose only a masked hint so the
      // collaboration view shows who is in the group without leaking PII.
      phoneMasked: s.phone ? maskPhone(s.phone) : null,
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

  if (!isAdminPhone(c.env, user.phone)) {
    return c.json({ error: "Admin only" }, 403);
  }

  const body = await c.req.json();
  const text = String(body.body ?? "").trim();
  if (!text || text.length > 500) {
    return c.json({ error: "Announcement must be 1-500 characters" }, 400);
  }

  let lastId = 0;
  try {
    const r = await c.env.DB.prepare(
      "INSERT INTO announcements (campaign_id, user_id, body) VALUES (?, ?, ?)"
    ).bind(campaign.id, user.sub, text).run();
    lastId = r.meta.last_row_id ?? 0;
  } catch (e) {
    console.error("announcement insert failed:", e);
    return c.json({ error: `Could not save announcement: ${(e as Error).message}` }, 500);
  }

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

  return c.json({ ok: true, id: lastId, createdAt: new Date().toISOString() });
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

  const linkRes = await c.env.DB.prepare(
    "INSERT INTO user_links (user_id, linked_user_id, link_type, status) VALUES (?, ?, ?, 'pending')"
  ).bind(user.sub, target.id, linkType).run();

  // Send SMS to target user with deep link to accept/reject
  const linkId = Number(linkRes.meta?.last_row_id ?? 0);
  const me = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?").bind(user.sub).first<{ username: string }>();
  const acceptLink = `${c.env.APP_URL}/links/${linkId}/accept`;
  const rejectLink = `${c.env.APP_URL}/links/${linkId}/reject`;
  await sendSms(c.env, target.phone,
    `KSPONSOR: ${me?.username ?? "A Kingdom Sponsor user"} wants to link accounts with you as ${linkType}.\nAccept: ${acceptLink}\nDecline: ${rejectLink}`
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

// ---------- account link detail + combined donations ----------

app.get("/api/user/links/:id/donations", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const linkId = Number(c.req.param("id"));
  if (!linkId) return c.json({ error: "Invalid link id" }, 400);

  const link = await c.env.DB.prepare(
    "SELECT * FROM user_links WHERE id = ? AND (user_id = ? OR linked_user_id = ?) AND status = 'accepted'"
  ).bind(linkId, user.sub, user.sub).first<Record<string, any>>();
  if (!link) return c.json({ error: "Link not found" }, 404);

  const otherUserId = link.user_id === user.sub ? link.linked_user_id : link.user_id;

  const rows = await c.env.DB.prepare(
    `SELECT co.*, cam.title AS campaign_title, u.username, u.avatar_url,
            CASE WHEN co.donor_user_id = ? THEN 1 ELSE 0 END AS is_mine
     FROM contributions co
     JOIN campaigns cam ON cam.id = co.campaign_id
     LEFT JOIN users u ON u.id = co.donor_user_id
     WHERE co.donor_user_id IN (?, ?) AND co.status = 'confirmed'
     ORDER BY co.created_at DESC LIMIT 100`
  ).bind(user.sub, user.sub, otherUserId).all<Record<string, any>>();

  return c.json({
    donations: rows.results.map((d) => ({
      id: d.id,
      amountCents: d.amount_cents,
      campaignId: d.campaign_id,
      campaignTitle: d.campaign_title,
      displayName: d.is_anonymous ? 'Anonymous' : (d.donor_name || d.username || 'Giver'),
      username: d.username,
      avatarUrl: d.avatar_url,
      isAnonymous: d.is_anonymous == 1,
      isMine: d.is_mine == 1,
      createdAt: d.created_at,
    })),
  });
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

  // Idempotency: reject while a payment or approval is already in flight.
  const inFlight = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM promotions WHERE campaign_id = ? AND status IN ('pending','pending_approval')"
  ).bind(campaign.id).first<{ n: number }>())?.n ?? 0;
  if (inFlight > 0) {
    return c.json({ error: "A promotion request for this campaign is already being processed." }, 409);
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
    }, c.env.DB);
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
  const shareUrl = await createShortLink(c.env, `${c.env.APP_URL}/share?ref=${code}`);
  const total = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM referrals WHERE referrer_user_id = ?"
  ).bind(user.sub).first<{ n: number }>())?.n ?? 0;
  const rewardedAt = await c.env.DB.prepare(
    "SELECT referral_rewarded_at FROM users WHERE id = ?"
  ).bind(user.sub).first<{ referral_rewarded_at: string | null }>();
  const threshold = await referralRewardThreshold(c.env);
  return c.json({
    code,
    shareUrl,
    total,
    threshold,
    eligible: total >= threshold && !rewardedAt?.referral_rewarded_at,
    rewardedAt: rewardedAt?.referral_rewarded_at ?? null,
  });
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
    threshold: await referralRewardThreshold(c.env),
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

/** Capitalizes the first letter of every word (used on PDF receipts for names). */
function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

async function buildReceiptPdf(env: Bindings, i: ReceiptInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([540, 720]);
  const { width } = page.getSize();

  // App colors: primary = #E65100 (deep orange), gold = #D4A017
  const primaryColor = rgb(0.902, 0.318, 0.0);   // #E65100 deep orange
  const goldColor = rgb(0.827, 0.627, 0.090);    // #D4A017 gold
  const textMuted = rgb(0.47, 0.41, 0.36);
  const textDark = rgb(0.17, 0.125, 0.07);

  // Header band
  page.drawRectangle({
    x: 0, y: page.getSize().height - 70, width: width, height: 70,
    color: primaryColor,
  });

  // App logo from R2 (falls back to gold circle if unavailable)
  try {
    const logoObj = await env.MEDIA.get("app-logo.jpg");
    if (logoObj?.body) {
      const logoBytes = await logoObj.body.getReader().read().then(({ value }) => value ?? new Uint8Array(0));
      const logoImg = await doc.embedJpg(logoBytes);
      const logoW = 48;
      const logoH = 48;
      page.drawImage(logoImg, {
        x: width - 60 - logoW / 2,
        y: page.getSize().height - 45 - logoH / 2,
        width: logoW,
        height: logoH,
      });
    } else {
      // Logo placeholder (gold circle)
      page.drawCircle({
        x: width - 60, y: page.getSize().height - 40,
        size: 36, color: goldColor,
      });
    }
  } catch {
    page.drawCircle({
      x: width - 60, y: page.getSize().height - 40,
      size: 36, color: goldColor,
    });
  }

  page.drawText("Kingdom Sponsor", { x: 50, y: page.getSize().height - 32, size: 16, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Official Donation Receipt", { x: 50, y: page.getSize().height - 48, size: 10, font, color: rgb(0.95, 0.95, 0.97) });

  let y = page.getSize().height - 90;
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

  const totalPaid = i.amountCents + i.platformFeeCents + i.lipilaFeeCents;
  page.drawText("Amount donated:", { x: 50, y, size: 12, font: bold, color: textDark });
  page.drawText(`K${(i.amountCents / 100).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, { x: 280, y, size: 12, font: bold });

  y -= 18;
  page.drawText("Platform fees:", { x: 50, y, size: 10, font, color: textMuted });
  const platformFees = i.platformFeeCents + i.lipilaFeeCents;
  page.drawText(`K${(platformFees / 100).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, { x: 280, y, size: 10, font: bold, color: textMuted });

  y -= 18;
  page.drawText("Total paid by donor:", { x: 50, y, size: 10, font: bold, color: textMuted });
  page.drawText(`K${(totalPaid / 100).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, { x: 280, y, size: 10, font: bold, color: textMuted });

  y -= 12;
  page.drawRectangle({
    x: 50, y: y - 4, width: width - 100, height: 1,
    color: rgb(0.9, 0.9, 0.95),
  });
  y -= 24;
  page.drawText("Campaign receives:", { x: 50, y, size: 11, font: bold, color: goldColor });
  page.drawText(`K${(i.amountCents / 100).toLocaleString("en-ZM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, { x: 240, y, size: 11, font: bold, color: textDark });

  y -= 50;
  page.drawText(`Thank you for giving to ${i.campaignTitle}.`, { x: 50, y, size: 10, font, color: textDark });
  y -= 14;
  page.drawText("This receipt was issued automatically and records your gift for your records.", { x: 50, y, size: 9, font, color: textMuted });
  y -= 12;
  page.drawText("Kingdom Sponsor  â€¢  Built with Purpose", { x: 50, y, size: 8, font, color: rgb(0.55, 0.55, 0.55) });

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
  const pdf = await buildReceiptPdf(c.env, {
    receiptNumber: `KS-${String(row.id).padStart(6, "0")}`,
    donorName: toTitleCase(donorName),
    donorPhone: row.phone,
    campaignTitle: toTitleCase(row.campaign_title),
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
  await pushAdmins(c.env,
    "New support request", `#${ticketId}: ${subject}`,
    { type: "ticket_created", ticketId: String(ticketId) }).catch(() => {});

  // Friendly auto-acknowledgement for greeting-style messages: the user gets
  // an instant "we've got you" confirmation while an admin drafts a real reply.
  // Kept short and honest so it never looks like a human answered.
  if (/(\bhi\b|\bhello\b|\bhey\b|greetings|good (morning|afternoon|evening)|good day|how are you|thank(s| you)|please help|help me|can you help|i need help|i have a (question|problem|complaint))/i.test(message)) {
    const assistantName = await supportAssistantName(c.env);
    const ack = `Thanks for reaching out${user.username ? `, ${user.username}` : ""}! This is an automatic confirmation â€” your request #${ticketId} ("${subject}") has been received and an admin will reply here shortly.\nâ€” ${assistantName}`;
    await c.env.DB.prepare(
      "UPDATE support_tickets SET admin_reply = ?, status = 'answered', updated_at = datetime('now', '+2 hours') WHERE id = ?"
    ).bind(ack, ticketId).run();
    await pushToUser(c.env, Number(user.sub), "We got your request",
      `Thanks for contacting us${user.username ? `, ${user.username}` : ""}! An admin will reply to "${subject}" shortly.\nâ€” ${assistantName}`,
      { type: "ticket_ack", ticketId: String(ticketId) })
      .catch((e) => console.error("ticket ack push failed:", e));
  }

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

  const isAdmin = isAdminPhone(c.env, user.phone);

  if (isAdmin) {
    // Admin answers: mark answered and notify the user.
    await c.env.DB.prepare(
      "UPDATE support_tickets SET admin_reply = ?, status = 'answered', updated_at = datetime('now', '+2 hours') WHERE id = ?"
    ).bind(text, ticket.id).run();
    await smsIfNoPush(c.env, ticket.user_id, ticket.phone, supportReplySms(ticket.subject, await supportAssistantName(c.env)));
    await pushToUser(c.env, ticket.user_id, "Support replied",
      `Your request "${ticket.subject}" has a new reply.`, { type: "ticket_reply", ticketId: String(ticket.id) })
      .catch((e) => console.error("ticket reply push failed:", e));
  } else {
    // User replies: reopen the ticket.
    if (Number(ticket.user_id) !== Number(user.sub)) return c.json({ error: "Not your ticket" }, 403);
    await c.env.DB.prepare(
      "UPDATE support_tickets SET message = ?, status = 'open', updated_at = datetime('now', '+2 hours') WHERE id = ?"
    ).bind(text, ticket.id).run();
    await pushAdmins(c.env,
      "Ticket reopened", `#${ticket.id}: ${ticket.subject}`,
      { type: "ticket_created", ticketId: String(ticket.id) }).catch(() => {});
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
    assistantName: await supportAssistantName(c.env),
  });
});

// ---------- admin: support assistant name (signature on reply SMS) ----------

app.put("/api/admin/support-config", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const name = String(body.assistantName ?? "").trim();
  if (!name || name.length > 60) return c.json({ error: "Assistant name is required (max 60 characters)." }, 400);

  await setSetting(c.env, "support_assistant_name", name);
  return c.json({ ok: true, assistantName: name });
});

// ---------- admin: resolve a support ticket ----------

app.put("/api/admin/tickets/:id/resolve", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ticket id" }, 400);

  const row = await c.env.DB.prepare(
    "SELECT t.*, u.id AS user_id, u.fcm_token FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?"
  ).bind(id).first<Record<string, any>>();
  if (!row) return c.json({ error: "Ticket not found" }, 404);

  await c.env.DB.prepare(
    "UPDATE support_tickets SET status = 'resolved', updated_at = datetime('now') WHERE id = ?"
  ).bind(id).run();

  // Notify the user that their ticket was resolved.
  await pushToUser(c.env, row.user_id, "Support request resolved",
    `Your support ticket #${id}${row.subject ? ` "${row.subject}"` : ""} has been resolved. Thank you for your patience.`,
    { type: "ticket_resolved", ticketId: String(id) })
    .catch((e) => console.error("ticket-resolved push failed:", e));

  return c.json({ ok: true, message: "Ticket resolved" });
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
async function deleteCampaign(env: Bindings, campaignId: number, reason?: string | null): Promise<void> {
  const campaign = await env.DB.prepare(
    "SELECT c.*, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(campaignId).first<Record<string, any>>();
  if (!campaign) return;

  await env.DB.batch([
    env.DB.prepare("UPDATE campaigns SET status = 'deleted', promoted = 0 WHERE id = ?").bind(campaignId),
    env.DB.prepare("UPDATE promotions SET status = 'cancelled' WHERE campaign_id = ? AND status IN ('pending','pending_approval','active')").bind(campaignId),
  ]);

  const note = reason ? ` Reason: ${reason}` : "";
  const hostBody = `"${campaign.title}" has been removed from Kingdom Sponsor.${note}`;
  const donorTitle = `"${campaign.title}" removed`;
  const donorBody = `This campaign was removed by the administrator.${note}`;

  if (campaign.host_phone) {
    await sendSms(env, campaign.host_phone, `KSPONSOR: Your campaign "${campaign.title}" has been removed from the platform.${note}`)
      .catch((e) => console.error("campaign-deleted sms failed:", e));
    await pushToUser(env, campaign.host_user_id, "Campaign removed", hostBody, { type: "campaign_deleted", campaignId: String(campaignId) })
      .catch((e) => console.error("campaign-deleted push failed:", e));
  }

  // Alert the campaign's donors (push to app users, SMS to those without the app).
  if (envPushConfigured(env)) {
    const donorTokens = await env.DB.prepare(
      `SELECT DISTINCT dt.token FROM device_tokens dt
       JOIN contributions co ON co.donor_user_id = dt.user_id
       WHERE co.campaign_id = ? AND co.status = 'confirmed'`
    ).bind(campaignId).all<{ token: string }>();
    const tokens = donorTokens.results.map((d) => d.token);
    if (tokens.length) {
      await sendMulticastPush(fbEnv(env), tokens, donorTitle, donorBody,
        { type: "campaign_deleted", campaignId: String(campaignId) })
        .catch((e) => console.error("campaign-deleted donor push failed:", e));
    }
  }
  const smsPhones = await env.DB.prepare(
    `SELECT DISTINCT co.phone FROM contributions co
     WHERE co.campaign_id = ? AND co.status = 'confirmed' AND co.phone IS NOT NULL
       AND (co.donor_user_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM device_tokens dt WHERE dt.user_id = co.donor_user_id))`
  ).bind(campaignId).all<{ phone: string }>();
  for (const row of smsPhones.results) {
    await sendSms(env, row.phone, `KSPONSOR: The campaign "${campaign.title}" you supported has been removed by the administrator.${note}`)
      .catch((e) => console.error("campaign-deleted donor sms failed:", e));
  }
}

/** Append an entry to the admin audit log (destructive/sensitive actions only). */
async function logAdminAction(  env: Bindings,
  actorUserId: number | null | undefined,
  action: string,
  targetType: string,
  targetId: string | number | null,
  details?: string
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO admin_actions (actor_user_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)"
    ).bind(actorUserId ?? null, action, targetType, targetId != null ? String(targetId) : null, details?.slice(0, 500) ?? null).run();
  } catch (e) {
    console.error("admin action log failed:", e);
  }
}

/** Restores a soft-deleted campaign to 'active' (undo of an admin delete). */
async function restoreCampaign(env: Bindings, campaignId: number): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE campaigns SET status = 'active' WHERE id = ? AND status = 'deleted'"
  ).bind(campaignId).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Restore a soft-deleted campaign (superadmin or 'restore'-scoped staff). */
app.post("/api/admin/campaigns/:id/restore", async (c) => {
  const staff = await requireStaff(c, "restore");
  if (!staff) return c.json({ error: "Admin only" }, 403);
  const campaignId = Number(c.req.param("id"));
  const campaign = await c.env.DB.prepare("SELECT id, title, status FROM campaigns WHERE id = ?")
    .bind(campaignId).first<{ id: number; title: string; status: string }>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.status !== "deleted") return c.json({ error: "Campaign is not deleted." }, 400);

  await restoreCampaign(c.env, campaignId);
  await logAdminAction(c.env, staff.sub, "campaign_restore", "campaign", campaignId, `Restored "${campaign.title}"`);

  const host = await c.env.DB.prepare(
    "SELECT u.phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(campaignId).first<{ phone: string; host_user_id: number }>();
  if (host?.phone) {
    await sendSms(c.env, host.phone, `KSPONSOR: Good news — your campaign "${campaign.title}" has been restored and is live again.`)
      .catch((e) => console.error("campaign-restore sms failed:", e));
    await pushToUser(c.env, host.host_user_id, "Campaign restored",
      `"${campaign.title}" is live again after being restored by the administrator.`,
      { type: "campaign_restored", campaignId: String(campaignId) })
      .catch((e) => console.error("campaign-restore push failed:", e));
  }

  return c.json({ ok: true, message: `"${campaign.title}" restored.` });
});

/** List recent sensitive admin actions (superadmin only). */
app.get("/api/admin/actions", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.actor_user_id, a.action, a.target_type, a.target_id, a.details, a.created_at, u.username AS actor_name
     FROM admin_actions a LEFT JOIN users u ON u.id = a.actor_user_id
     ORDER BY a.id DESC LIMIT 100`
  ).all<Record<string, any>>();
  return c.json({
    actions: rows.results.map((r) => ({
      id: r.id,
      actorUserId: r.actor_user_id,
      actorName: r.actor_name ?? "Admin",
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      details: r.details,
      createdAt: r.created_at,
    })),
  });
});

/** List soft-deleted campaigns (restorable) — superadmin or 'restore'-scoped staff. */
app.get("/api/admin/campaigns/deleted", async (c) => {
  const staff = await requireStaff(c, "restore");
  if (!staff) return c.json({ error: "Admin only" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.status, c.created_at, u.username AS host_name, u.host_verified, u.host_org AS host_org
     FROM campaigns c LEFT JOIN users u ON u.id = c.host_user_id
     WHERE c.status = 'deleted' ORDER BY c.updated_at DESC LIMIT 100`
  ).all<Record<string, any>>();
  return c.json({
    campaigns: rows.results.map((r) => ({
      id: r.id,
      title: r.title,
      hostName: r.host_name ?? null,
      createdAt: r.created_at,
    })),
  });
});

app.post("/api/admin/campaigns/:id/delete", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?")
    .bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.status === "deleted") return c.json({ error: "Campaign already deleted." }, 400);

  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason ?? "").trim().slice(0, 500) || null;

  await deleteCampaign(c.env, campaign.id, reason);
  await logAdminAction(c.env, admin.sub, "campaign_delete", "campaign", campaign.id, reason ? `"${campaign.title}" — ${reason}` : `"${campaign.title}"`);
  await c.env.DB.prepare(
    "UPDATE campaign_delete_requests SET status = 'approved', resolved_at = datetime('now', '+2 hours') WHERE campaign_id = ? AND status = 'pending'"
  ).bind(campaign.id).run();

  return c.json({ ok: true, message: reason ? `Campaign deleted. Host and donors were alerted with your note.` : "Campaign deleted. Host and donors were alerted." });
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

// ---------- Admin: review host campaign-edit requests ----------

app.get("/api/admin/edit-requests", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.campaign_id, r.host_user_id, r.proposed_json, r.status, r.admin_notes, r.created_at,
            c.title AS campaign_title, u.username AS host_name, u.host_verified, u.host_org AS host_org
     FROM campaign_edit_requests r
     JOIN campaigns c ON c.id = r.campaign_id
     JOIN users u ON u.id = r.host_user_id
     ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 100`
  ).all<Record<string, any>>();
  return c.json({
    requests: rows.results.map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      campaignTitle: r.campaign_title,
      hostUserId: r.host_user_id,
      hostName: r.host_name ?? "Giver",
      proposed: JSON.parse(r.proposed_json || "{}"),
      status: r.status,
      adminNotes: r.admin_notes ?? null,
      createdAt: r.created_at,
    })),
  });
});

app.post("/api/admin/edit-requests/:id/approve", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const req = await c.env.DB.prepare("SELECT * FROM campaign_edit_requests WHERE id = ? AND status = 'pending'")
    .bind(c.req.param("id")).first<Record<string, any>>();
  if (!req) return c.json({ error: "Request not found or already resolved" }, 404);

  const proposed = JSON.parse(req.proposed_json || "{}");
  const sets: string[] = [];
  const vals: any[] = [];
  if (proposed.title !== undefined) { sets.push("title = ?"); vals.push(proposed.title); }
  if (proposed.description !== undefined) { sets.push("description = ?"); vals.push(proposed.description); }
  if (proposed.goalCents !== undefined) { sets.push("goal_cents = ?"); vals.push(proposed.goalCents); }
  if (proposed.minWithdrawCents !== undefined) { sets.push("min_withdraw_cents = ?"); vals.push(proposed.minWithdrawCents); }
  if (proposed.category !== undefined) { sets.push("category = ?"); vals.push(proposed.category); }
  if (proposed.visibility !== undefined) { sets.push("visibility = ?"); vals.push(proposed.visibility); }
  if (proposed.campaignType !== undefined) { sets.push("campaign_type = ?"); vals.push(proposed.campaignType); }
  if ("endsAt" in proposed) { sets.push("ends_at = ?"); vals.push(proposed.endsAt); }

  if (sets.length > 0) {
    vals.push(req.campaign_id);
    await c.env.DB.prepare(
      `UPDATE campaigns SET ${sets.join(", ")} WHERE id = ?`
    ).bind(...vals).run();
  }

  await c.env.DB.prepare(
    "UPDATE campaign_edit_requests SET status = 'approved', resolved_at = datetime('now', '+2 hours') WHERE id = ?"
  ).bind(req.id).run();
  await logAdminAction(c.env, admin.sub, "campaign_edit_approve", "campaign", req.campaign_id,
    `Approved edit request #${req.id} on "${req.campaign_id}"`);

  const campaign = await c.env.DB.prepare(
    "SELECT c.title, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(req.campaign_id).first<Record<string, any>>();
  if (campaign?.host_phone) {
    await sendSms(c.env, campaign.host_phone, editRequestApprovedSms(campaign.title))
      .catch((e) => console.error("edit-approve sms failed:", e));
    await pushToUser(c.env, campaign.host_user_id, "Campaign update approved",
      `Your requested changes to "${campaign.title}" have been approved and applied.`,
      { type: "campaign_edit_approved", campaignId: String(req.campaign_id) })
      .catch((e) => console.error("edit-approve push failed:", e));
  }
  return c.json({ ok: true, message: "Edit request approved and applied." });
});

app.post("/api/admin/edit-requests/:id/reject", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const req = await c.env.DB.prepare("SELECT * FROM campaign_edit_requests WHERE id = ? AND status = 'pending'")
    .bind(c.req.param("id")).first<Record<string, any>>();
  if (!req) return c.json({ error: "Request not found or already resolved" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const notes = String(body.notes ?? "").trim().slice(0, 500) || null;

  await c.env.DB.prepare(
    "UPDATE campaign_edit_requests SET status = 'rejected', admin_notes = ?, resolved_at = datetime('now', '+2 hours') WHERE id = ?"
  ).bind(notes, req.id).run();
  await logAdminAction(c.env, admin.sub, "campaign_edit_reject", "campaign", req.campaign_id,
    `Rejected edit request #${req.id}${notes ? ` — ${notes}` : ""}`);

  const campaign = await c.env.DB.prepare(
    "SELECT c.title, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(req.campaign_id).first<Record<string, any>>();
  if (campaign?.host_phone) {
    await pushToUser(c.env, campaign.host_user_id, "Campaign update declined",
      `Your requested changes to "${campaign.title}" were declined.${notes ? ` Reason: ${notes}` : ""}`,
      { type: "campaign_edit_rejected", campaignId: String(req.campaign_id) })
      .catch((e) => console.error("edit-reject push failed:", e));
  }
  return c.json({ ok: true });
});

// ---------- Admin: Ban/unban users, hosts, or phone numbers ----------

app.post("/api/admin/ban", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const target = String(body.target ?? "").trim();
  const reason = String(body.reason ?? "").trim() || "Banned by admin";
  const kind = body.kind ?? "phone"; // phone | user_id | host

  if (!target && kind !== "host") return c.json({ error: "Target is required" }, 400);

  if (kind === "phone") {
    const user = await c.env.DB.prepare(
      "SELECT id FROM users WHERE phone = ?"
    ).bind(target).first<Record<string, any>>();
    if (!user) return c.json({ error: "User not found" }, 404);
    await c.env.DB.prepare(
      "UPDATE users SET banned = 1, ban_reason = ?, banned_at = datetime('now') WHERE id = ?"
    ).bind(reason, user.id).run();
    return c.json({ ok: true, banned: user.id });
  }

  if (kind === "user_id") {
    const id = parseInt(target);
    if (isNaN(id)) return c.json({ error: "Invalid user ID" }, 400);
    const user = await c.env.DB.prepare(
      "SELECT id FROM users WHERE id = ?"
    ).bind(id).first<Record<string, any>>();
    if (!user) return c.json({ error: "User not found" }, 404);
    await c.env.DB.prepare(
      "UPDATE users SET banned = 1, ban_reason = ?, banned_at = datetime('now') WHERE id = ?"
    ).bind(reason, id).run();
    return c.json({ ok: true, banned: id });
  }

  if (kind === "host") {
    const rows = await c.env.DB.prepare(
      "SELECT id FROM users WHERE is_host = 1 AND host_status = 'approved'"
    ).all<Record<string, any>>();
    for (const row of rows.results) {
      await c.env.DB.prepare(
        "UPDATE users SET banned = 1, ban_reason = ?, banned_at = datetime('now') WHERE id = ?"
      ).bind(reason, row.id).run();
    }
    return c.json({ ok: true, banned: rows.results.length });
  }

  return c.json({ error: "Invalid kind. Use phone, user_id, or host" }, 400);
});

app.post("/api/admin/unban", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const target = String(body.target ?? "").trim();
  const kind = body.kind ?? "phone";

  if (!target) return c.json({ error: "Target is required" }, 400);

  if (kind === "phone") {
    await c.env.DB.prepare(
      "UPDATE users SET banned = 0, ban_reason = NULL, banned_at = NULL WHERE phone = ?"
    ).bind(target).run();
    return c.json({ ok: true });
  }

  if (kind === "user_id") {
    const id = parseInt(target);
    if (isNaN(id)) return c.json({ error: "Invalid user ID" }, 400);
    await c.env.DB.prepare(
      "UPDATE users SET banned = 0, ban_reason = NULL, banned_at = NULL WHERE id = ?"
    ).bind(id).run();
    return c.json({ ok: true });
  }

  return c.json({ error: "Invalid kind. Use phone or user_id" }, 400);
});

app.get("/api/admin/banned", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const rows = await c.env.DB.prepare(
    "SELECT id, phone, username, is_host, host_status, banned, ban_reason, banned_at FROM users WHERE banned = 1 ORDER BY banned_at DESC LIMIT 100"
  ).all<Record<string, any>>();

  return c.json({ banned: rows.results });
});

// ---------- admin referrals (reward qualified referrers) ----------

/** List all referrers with their invite counts and reward status, plus the
 *  configurable threshold. Qualifying users can be rewarded by an admin. */
app.get("/api/admin/referrals", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const threshold = await referralRewardThreshold(c.env);
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.phone, u.referral_rewarded_at,
            COUNT(r.id) AS invites
     FROM users u
     JOIN referrals r ON r.referrer_user_id = u.id
     GROUP BY u.id
     HAVING invites >= ?
     ORDER BY invites DESC, u.id LIMIT 200`
  ).bind(threshold).all<Record<string, any>>();

  return c.json({
    threshold,
    referrers: rows.results.map((r) => ({
      userId: r.id,
      username: r.username ?? "Giver",
      phone: r.phone,
      invites: r.invites,
      rewardedAt: r.referral_rewarded_at ?? null,
      qualified: !r.referral_rewarded_at,
    })),
  });
});

/** Get or change the referral reward threshold. */
app.get("/api/admin/referral-threshold", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  return c.json({ threshold: await referralRewardThreshold(c.env) });
});

app.put("/api/admin/referral-threshold", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const { threshold } = await c.req.json();
  const n = Math.round(Number(threshold ?? 0));
  if (!Number.isFinite(n) || n < 1 || n > 1000) {
    return c.json({ error: "Threshold must be between 1 and 1000" }, 400);
  }
  await c.env.DB.prepare(
    `INSERT INTO admin_settings (key, value) VALUES ('referral_reward_threshold', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(String(n)).run();
  return c.json({ threshold: n });
});

/** Reward a qualified referrer (marks them rewarded and notifies them). */
app.post("/api/admin/referrals/:id/reward", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const user = await c.env.DB.prepare(
    "SELECT * FROM users WHERE id = ?"
  ).bind(c.req.param("id")).first<Record<string, any>>();
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.referral_rewarded_at) {
    return c.json({ error: "This referrer was already rewarded" }, 400);
  }

  const count = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM referrals WHERE referrer_user_id = ?"
  ).bind(user.id).first<{ n: number }>())?.n ?? 0;
  const threshold = await referralRewardThreshold(c.env);
  if (count < threshold) {
    return c.json({ error: `Referrer needs ${threshold} referrals, has ${count}` }, 400);
  }

  await c.env.DB.prepare(
    "UPDATE users SET referral_rewarded_at = datetime('now', '+2 hours') WHERE id = ?"
  ).bind(user.id).run();

  const msg = `Congratulations! You reached ${count} referrals and qualified for your Kingdom Sponsor reward. Check your notifications for details.`;
  await pushToUser(c.env, user.id, "Referral reward earned", msg, { type: "referral_rewarded" })
    .catch((e) => console.error("referral reward push failed:", e));
  if (user.phone) {
    await smsIfNoPush(c.env, user.id, user.phone, msg);
  }

  return c.json({ rewarded: true, userId: user.id, total: count });
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
  } else if (referenceId.startsWith("AIR-") && (status.includes("success") || status.includes("complete"))) {
    await confirmAirtimePayment(c.env, referenceId);
  } else if (referenceId.startsWith("AIR-") && (status.includes("fail") || status.includes("cancel"))) {
    await failAirtimePayment(c.env, referenceId);
  } else if (isDisbursement && (status.includes("success") || status.includes("complete"))) {
    if (referenceId.startsWith("SET-") || referenceId.startsWith("SWEEP-")) {
      await confirmFeeSweep(c.env, referenceId);
    } else {
      await confirmWithdrawal(c.env, referenceId);
    }
  } else if (isDisbursement && (status.includes("fail") || status.includes("cancel") || status.includes("reject"))) {
    const reason = String(body.message ?? body.error ?? `Lipila reported status: ${body.status}`).slice(0, 500);
    await c.env.DB.prepare("UPDATE withdrawals SET status = 'failed', error = ? WHERE lipila_reference = ? AND status = 'pending'")
      .bind(reason, referenceId).run();
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
// form-encoded or JSON payloads. Every payload is stored in the sms_events
// table (per AT's recommendation to keep a copy) and we always answer 200 so
// AT never retries. (We don't act on inbound messages/opt-outs yet.)
app.post("/api/webhooks/at-sms", async (c) => {
  const body = await c.req.text().catch(() => "");
  const form = new URLSearchParams(body);
  let rec: Record<string, string | null> = {
    id: form.get("id"),
    status: form.get("status"),
    phoneNumber: form.get("phoneNumber") ?? form.get("from"),
  };
  if (!rec.id && !rec.status) {
    try {
      const json = JSON.parse(body);
      if (json && typeof json === "object") {
        rec = {
          id: json.id ?? null,
          status: json.status ?? null,
          phoneNumber: json.phoneNumber ?? json.from ?? null,
        };
      }
    } catch {
      // not JSON; keep the empty form parse above
    }
  }

  const lower = body.toLowerCase();
  const kind = rec.status
    ? "delivery"
    : lower.includes("optout") || lower.includes("opt_out") || lower.includes("opt-out")
      ? "optout"
      : lower.includes("subscription") || lower.includes("unsubscription")
        ? "subscription"
        : (rec.phoneNumber && lower.includes("text")) || lower.includes('"text"') || lower.includes("&text=")
          ? "inbound"
          : "other";

  await c.env.DB.prepare(
    "INSERT INTO sms_events (kind, ref_id, status, phone, payload) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(kind, rec.id, rec.status, rec.phoneNumber, body)
    .run()
    .catch((e: any) => console.error("[AT SMS] event insert failed:", e));

  if (rec.status && rec.status !== "Success") {
    console.error(`[AT SMS] delivery ${rec.status} for ${rec.id} -> ${rec.phoneNumber}`);
  }
  console.log("[AT SMS webhook]", JSON.stringify({ ...rec, kind }));
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
            w.platform_fee_cents, w.status, w.lipila_reference, w.error, w.created_at
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
      error: w.error ?? null,
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

  // Idempotency: never start a second payout while one is still in flight.
  const inFlight = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','processing')"
  ).bind(campaign.id).first<{ n: number }>())?.n ?? 0;
  if (inFlight > 0) {
    return c.json({ error: "A payout for this campaign is already being processed." }, 409);
  }

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

  // SMS to donors without the app (app users already got the push above).
  const smsPhones = await c.env.DB.prepare(
    `SELECT DISTINCT co.phone FROM contributions co
     WHERE co.campaign_id = ? AND co.status = 'confirmed' AND co.phone IS NOT NULL
       AND (co.donor_user_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM device_tokens dt WHERE dt.user_id = co.donor_user_id))`
  ).bind(campaign.id).all<{ phone: string }>();
  const endedShareLink = await createShortLink(c.env, `${c.env.APP_URL}/share/${campaign.id}`);
  for (const row of smsPhones.results) {
    await sendSms(c.env, row.phone, campaignEndedSms(campaign.title, raised, supporters, endedShareLink))
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

const ASSISTANT_SCOPES = [
  "campaigns", "donations", "tickets", "users", "settings", "finance", "restore",
] as const;

/** Loads an assistant's permission scopes (comma-separated) as a Set. */
async function assistantScopes(env: Bindings, userId: number): Promise<Set<string>> {
  const row = await env.DB.prepare(
    "SELECT permissions FROM admin_assistants WHERE user_id = ?"
  ).bind(userId).first<{ permissions: string }>();
  if (!row) return new Set();
  return new Set(row.permissions.split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * Auth for admin-staff operations. Superadmins always pass. Assistants pass
 * only when they hold every requested scope. Returns the user or null.
 */
async function requireStaff(c: any, ...scopes: string[]): Promise<TokenPayload | null> {
  const user = await authUser(c);
  if (!user) return null;
  if (isAdminPhone(c.env, user.phone)) return user;
  const allowed = await assistantScopes(c.env, user.sub);
  if (scopes.every((s) => allowed.has(s))) return user;
  return null;
}

app.get("/api/admin/applications", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const rows = await c.env.DB.prepare(
    `SELECT id, phone, username, host_status, host_org, host_role, host_reason, host_rejection,
            host_verified, host_verification_notes, host_kyc_status, host_kyc_type,
            host_kyc_doc_url, host_kyc_notes, created_at
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
      hostVerified: !!u.host_verified,
      hostVerificationNotes: u.host_verification_notes ?? null,
      kycStatus: u.host_kyc_status ?? "none",
      kycType: u.host_kyc_type ?? null,
      kycDocUrl: u.host_kyc_doc_url ?? null,
      kycNotes: u.host_kyc_notes ?? null,
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

// Admin: mark a host as independently verified + attach private notes.
app.post("/api/admin/hosts/:id/verify", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const verified = body.verified !== false;
  const notes = String(body.notes ?? "").trim().slice(0, 1000) || null;
  const res = await c.env.DB.prepare(
    "UPDATE users SET host_verified = ?, host_verification_notes = ? WHERE id = ? AND host_status = 'approved'"
  ).bind(verified ? 1 : 0, notes, c.req.param("id")).run();
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: "Approved host not found" }, 404);
  await logAdminAction(c.env, admin.sub, "host_verify", "user", c.req.param("id"),
    `${verified ? "Verified" : "Un-verified"} host: ${notes ?? "no notes"}`);
  const user = await c.env.DB.prepare("SELECT phone, username FROM users WHERE id = ?")
    .bind(c.req.param("id")).first<{ phone: string; username: string }>();
  if (user?.phone) {
    await pushToUser(c.env, Number(c.req.param("id")),
      verified ? "You're a verified host" : "Host verification updated",
      verified
        ? "Great news! The administrator has independently verified your host account."
        : "Your host verification was updated by the administrator.",
      { type: "host_verified" }).catch((e) => console.error("host verify push failed:", e));
  }
  return c.json({ ok: true, verified, notes });
});

// Admin: approve or reject a host's KYC submission. Approving also flips the
// public verified badge on; rejecting keeps it off until resubmitted.
app.post("/api/admin/hosts/:id/kyc", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const approve = body.approve === true;
  const notes = String(body.notes ?? "").trim().slice(0, 500) || null;

  const res = await c.env.DB.prepare(
    "UPDATE users SET host_kyc_status = ?, host_kyc_notes = ?, host_verified = ? WHERE id = ?"
  ).bind(approve ? "approved" : "rejected", notes, approve ? 1 : 0, c.req.param("id")).run();
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: "User not found" }, 404);
  await logAdminAction(c.env, admin.sub, "host_kyc", "user", c.req.param("id"),
    `${approve ? "Approved" : "Rejected"} KYC${notes ? ` — ${notes}` : ""}`);

  const user = await c.env.DB.prepare("SELECT phone, username FROM users WHERE id = ?")
    .bind(c.req.param("id")).first<{ phone: string; username: string }>();
  if (user?.phone) {
    await pushToUser(c.env, Number(c.req.param("id")),
      approve ? "You're a verified host" : "Host verification updated",
      approve
        ? "Great news! Your identity document was approved — your campaigns now show the verified badge."
        : `Your host verification was not approved.${notes ? ` Reason: ${notes}` : ""}`,
      { type: "host_verified" }).catch((e) => console.error("kyc push failed:", e));
  }
  return c.json({ ok: true, kycStatus: approve ? "approved" : "rejected" });
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

// ---------- admin: promote a campaign directly (free, no approval needed) ----------

app.post("/api/admin/campaigns/:id/promote", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ? AND status != 'deleted'"
  ).bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.promoted) return c.json({ error: "This campaign is already promoted." }, 400);
  if (await activePromotionCount(c.env) >= PROMO_SLOTS) {
    return c.json({ error: "All promotion slots are taken. End or un-promote one first." }, 409);
  }

  const body = await c.req.json().catch(() => ({}));
  let days = Math.round(Number(body.days));
  if (!Number.isFinite(days) || days < 1 || days > 30) days = await promoDays(c.env);
  const until = new Date(Date.now() + days * 86400000).toISOString();

  const referenceId = `ADMIN-${campaign.id}-${Date.now()}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO promotions (campaign_id, amount_cents, days, lipila_reference, status, expires_at) VALUES (?, 0, ?, ?, 'active', ?)"
    ).bind(campaign.id, days, referenceId, until),
    c.env.DB.prepare(
      "UPDATE campaigns SET promoted = 1, promoted_until = ? WHERE id = ?"
    ).bind(until, campaign.id),
  ]);

  const host = await c.env.DB.prepare(
    "SELECT u.phone, u.id AS user_id FROM users u WHERE u.id = ?"
  ).bind(campaign.host_user_id).first<{ phone: string; user_id: number }>();
  if (host) {
    const adminPromoShareLink = await createShortLink(c.env, `${c.env.APP_URL}/share/${campaign.id}`);
    await smsIfNoPush(c.env, host.user_id, host.phone, promotionActiveSms(campaign.title, days, until.slice(0, 10), adminPromoShareLink));
    await pushToUser(c.env, host.user_id, "Your campaign is promoted",
      `"${campaign.title}" is now at the top of Kingdom Sponsor for ${days} days.`,
      { type: "promotion_active", campaignId: String(campaign.id) })
      .catch((e) => console.error("admin promo push failed:", e));
  }

  return c.json({ ok: true, days, until, message: `"${campaign.title}" is promoted to the top for ${days} days.` });
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
      error: w.error ?? null,
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
  const activeRaised = (await c.env.DB.prepare(
    `SELECT COALESCE(SUM(co.amount_cents),0) AS s
     FROM contributions co JOIN campaigns cam ON cam.id = co.campaign_id
     WHERE co.status = 'confirmed' AND cam.status = 'active'`
  ).first<{ s: number }>()) ?? { s: 0 };
  const pending = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE host_status = 'pending'"
  ).first<{ n: number }>()) ?? { n: 0 };

  // Growth + activity counters (7d/30d windows). Indexed via created_at columns.
  const [users, campaigns, donations, receipts, pledges, tickets, deleteReqs] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM users) AS total, (SELECT COUNT(*) FROM users WHERE is_host = 1) AS hosts, (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-7 days')) AS d7, (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-30 days')) AS d30"
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

  const refThreshold = await referralRewardThreshold(c.env);
  const qualifiedReferrers = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT u.id FROM users u
       JOIN referrals r ON r.referrer_user_id = u.id
       WHERE u.referral_rewarded_at IS NULL
       GROUP BY u.id HAVING COUNT(r.id) >= ?
     )`
  ).bind(refThreshold).first<{ n: number }>())?.n ?? 0;

  // Total money processed through the platform: confirmed donations + paid-out
  // withdrawals + settled fee sweeps (gross flow, before fees).
  const payoutsTotal = (await c.env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM withdrawals WHERE status = 'success'"
  ).first<{ s: number }>())?.s ?? 0;
  const totalProcessedCents = total.s + payoutsTotal + feeSettled;

  const assistantsCount = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM admin_assistants"
  ).first<{ n: number }>())?.n ?? 0;

  const pendingEditRequests = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM campaign_edit_requests WHERE status = 'pending'"
  ).first<{ n: number }>())?.n ?? 0;

  return c.json({
    stats: {
      totalRaisedCents: total.s,
      totalActiveRaisedCents: activeRaised.s,
      confirmedDonations: total.n,
      donors: total.d,
      platformFeesCents: platformFees.s + payoutPlatformFees.s,
      platformFeesSettledCents: feeSettled,
      platformFeesPendingCents: (platformFees.s + payoutPlatformFees.s) - feeSettled,
      activeCampaigns: activeCampaigns.n,
      pendingApplications: pending.n,
      dailyRateCents: Math.round(total.s / days),
      usersTotal: usersRow.total ?? 0,
      hostsTotal: usersRow.hosts ?? 0,
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
      qualifiedReferrers,
      totalProcessedCents,
      assistants: assistantsCount,
      pendingEditRequests,
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

// ---------- admin exports (CSV + PDF) ----------

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/** Admin: export the stats snapshot + full transaction ledger as CSV. */
app.get("/api/admin/stats/export.csv", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const stats = (await c.env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(amount_cents),0) FROM contributions WHERE status = 'confirmed') AS donations_cents,
       (SELECT COALESCE(SUM(amount_cents),0) FROM contributions WHERE status = 'confirmed' AND campaign_id IN (SELECT id FROM campaigns WHERE status = 'active')) AS active_cents,
       (SELECT COUNT(*) FROM contributions WHERE status = 'confirmed') AS donations,
       (SELECT COUNT(DISTINCT donor_user_id) FROM contributions WHERE status = 'confirmed') AS donors,
       (SELECT COALESCE(SUM(platform_fee_cents),0) FROM contributions WHERE status = 'confirmed') AS fees_cents,
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM campaigns WHERE status != 'deleted') AS campaigns,
       (SELECT COALESCE(SUM(amount_cents),0) FROM withdrawals WHERE status = 'success') AS payouts_cents,
       (SELECT COALESCE(SUM(amount_cents),0) FROM fee_sweeps WHERE status = 'success') AS sweeps_cents`
  ).first<Record<string, number>>()) ?? {};

  const lines: string[] = [];
  lines.push(csvRow(["Kingdom Sponsor stats export", new Date().toISOString()]));
  lines.push(csvRow([]));
  lines.push(csvRow(["Metric", "Value"]));
  lines.push(csvRow(["Total raised (all time, ZMW)", ((stats.donations_cents ?? 0) / 100).toFixed(2)]));
  lines.push(csvRow(["Total raised (active campaigns, ZMW)", ((stats.active_cents ?? 0) / 100).toFixed(2)]));
  lines.push(csvRow(["Confirmed donations", stats.donations ?? 0]));
  lines.push(csvRow(["Distinct donors", stats.donors ?? 0]));
  lines.push(csvRow(["Platform fees earned (ZMW)", ((stats.fees_cents ?? 0) / 100).toFixed(2)]));
  lines.push(csvRow(["Payouts sent (ZMW)", ((stats.payouts_cents ?? 0) / 100).toFixed(2)]));
  lines.push(csvRow(["Fee sweeps settled (ZMW)", ((stats.sweeps_cents ?? 0) / 100).toFixed(2)]));
  lines.push(csvRow(["Total processed (ZMW)", (((stats.donations_cents ?? 0) + (stats.payouts_cents ?? 0) + (stats.sweeps_cents ?? 0)) / 100).toFixed(2)]));
  lines.push(csvRow(["Users", stats.users ?? 0]));
  lines.push(csvRow(["Campaigns", stats.campaigns ?? 0]));
  lines.push(csvRow([]));
  lines.push(csvRow(["Transaction ledger"]));
  lines.push(csvRow(["id", "campaignId", "campaignTitle", "donor", "phone", "amountCents", "platformFeeCents", "lipilaFeeCents", "status", "confirmedAt", "createdAt"]));

  const tx = await c.env.DB.prepare(
    `SELECT co.id, co.campaign_id, cam.title AS campaign_title, co.donor_name, co.is_anonymous,
            co.phone, co.amount_cents, co.platform_fee_cents, co.lipila_fee_cents,
            co.status, co.confirmed_at, co.created_at
     FROM contributions co JOIN campaigns cam ON cam.id = co.campaign_id
     ORDER BY co.id DESC LIMIT 5000`
  ).all<Record<string, any>>();
  for (const t of tx.results) {
    lines.push(csvRow([
      t.id, t.campaign_id, t.campaign_title,
      t.is_anonymous ? "Anonymous" : (t.donor_name ?? ""),
      t.phone, t.amount_cents, t.platform_fee_cents, t.lipila_fee_cents,
      t.status, t.confirmed_at, t.created_at,
    ]));
  }

  return new Response(lines.join("\r\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="kingdom-sponsor-stats-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});

/** Admin: downloadable PDF stats report (uses the same pdf-lib we use for receipts). */
app.get("/api/admin/stats/export.pdf", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const stats = (await c.env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(amount_cents),0) FROM contributions WHERE status = 'confirmed') AS donations_cents,
       (SELECT COUNT(*) FROM contributions WHERE status = 'confirmed') AS donations,
       (SELECT COUNT(DISTINCT donor_user_id) FROM contributions WHERE status = 'confirmed') AS donors,
       (SELECT COALESCE(SUM(platform_fee_cents),0) FROM contributions WHERE status = 'confirmed') AS fees_cents,
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM campaigns WHERE status != 'deleted') AS campaigns,
       (SELECT COALESCE(SUM(amount_cents),0) FROM withdrawals WHERE status = 'success') AS payouts_cents,
       (SELECT COALESCE(SUM(amount_cents),0) FROM fee_sweeps WHERE status = 'success') AS sweeps_cents`
  ).first<Record<string, number>>()) ?? {};
  const topCamps = await c.env.DB.prepare(
    `SELECT c.title, COALESCE(SUM(co.amount_cents),0) AS raised, COUNT(co.id) AS n
     FROM campaigns c LEFT JOIN contributions co ON co.campaign_id = c.id AND co.status = 'confirmed'
     WHERE c.status != 'deleted' GROUP BY c.id ORDER BY raised DESC LIMIT 10`
  ).all<Record<string, any>>();

  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const { width, height } = page.getSize();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const gold = rgb(0.78, 0.59, 0.12);
  const dark = rgb(0.1, 0.12, 0.16);
  const muted = rgb(0.45, 0.48, 0.52);

  let y = height - 60;
  page.drawText("Kingdom Sponsor", { x: 50, y, size: 20, font: bold, color: gold });
  y -= 22;
  page.drawText("Platform stats report", { x: 50, y, size: 12, font, color: muted });
  y -= 14;
  page.drawText(`Generated ${new Date().toLocaleDateString("en-ZM", { year: "numeric", month: "long", day: "numeric" })}`, { x: 50, y, size: 10, font, color: muted });
  y -= 30;
  page.drawRectangle({ x: 50, y: y - 4, width: width - 100, height: 1, color: gold });

  const rows: [string, string][] = [
    ["Total raised (all time)", `ZMW ${((stats.donations_cents ?? 0) / 100).toLocaleString("en-ZM", { minimumFractionDigits: 2 })}`],
    ["Confirmed donations", String(stats.donations ?? 0)],
    ["Distinct donors", String(stats.donors ?? 0)],
    ["Platform fees earned", `ZMW ${((stats.fees_cents ?? 0) / 100).toLocaleString("en-ZM", { minimumFractionDigits: 2 })}`],
    ["Payouts sent", `ZMW ${((stats.payouts_cents ?? 0) / 100).toLocaleString("en-ZM", { minimumFractionDigits: 2 })}`],
    ["Fee sweeps settled", `ZMW ${((stats.sweeps_cents ?? 0) / 100).toLocaleString("en-ZM", { minimumFractionDigits: 2 })}`],
    ["Total processed", `ZMW ${(((stats.donations_cents ?? 0) + (stats.payouts_cents ?? 0) + (stats.sweeps_cents ?? 0)) / 100).toLocaleString("en-ZM", { minimumFractionDigits: 2 })}`],
    ["Users", String(stats.users ?? 0)],
    ["Campaigns", String(stats.campaigns ?? 0)],
  ];
  for (const [label, value] of rows) {
    page.drawText(label, { x: 50, y, size: 11, font, color: dark });
    page.drawText(value, { x: 300, y, size: 11, font: bold, color: dark });
    y -= 22;
  }

  y -= 10;
  page.drawText("Top campaigns", { x: 50, y, size: 13, font: bold, color: gold });
  y -= 18;
  for (const c of topCamps.results) {
    if (y < 70) break;
    page.drawText(String(c.title ?? "").slice(0, 40), { x: 50, y, size: 10, font, color: dark });
    page.drawText(`ZMW ${(c.raised / 100).toLocaleString("en-ZM", { minimumFractionDigits: 2 })} (${c.n} gifts)`, { x: 300, y, size: 10, font: bold, color: dark });
    y -= 16;
  }

  y -= 20;
  page.drawText("This report is generated automatically for the Kingdom Sponsor admin.", { x: 50, y, size: 8, font, color: muted });

  return new Response(await doc.save(), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="kingdom-sponsor-stats-${new Date().toISOString().slice(0, 10)}.pdf"`,
      "Cache-Control": "no-store",
    },
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
      campaignTitle: w.campaign_title ?? "â€”",
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

// ---------- Lipila diagnostic endpoint ----------
app.get("/api/admin/lipila-diagnostic", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const env = c.env;
  const results: Record<string, any> = {
    lipilaEnv: env.LIPILA_ENV,
    baseUrl: lipilaBase(env),
    apiKeyPrefix: env.LIPILA_API_KEY ? env.LIPILA_API_KEY.slice(0, 4) + "..." : "NOT SET",
  };

  // Get our outbound IP (for whitelisting in Lipila dashboard)
  try {
    const ipRes = await fetch("https://ifconfig.me/ip");
    results.outboundIp = (await ipRes.text()).trim();
  } catch {
    results.outboundIpError = "Could not determine outbound IP";
  }

  // Test 1: Wallet balance (tests API key + base URL)
  try {
    const bal = await getWalletBalance(env);
    results.walletBalance = bal;
    results.walletBalanceOk = true;
  } catch (e) {
    results.walletBalanceError = e instanceof Error ? e.message : String(e);
    results.walletBalanceOk = false;
  }

  // Test 2: Disbursement status check (tests auth against disbursement endpoint)
  try {
    const testRef = `DIAG-${Date.now()}`;
    const url = `${lipilaBase(env)}/disbursements/check-status?referenceId=${testRef}`;
    const res = await fetch(url, {
      headers: { accept: "application/json", "x-api-key": env.LIPILA_API_KEY },
    });
    const rawText = await res.text().catch(() => "");
    results.disbursementStatusCheck = {
      status: res.status,
      body: rawText.slice(0, 300),
      ok: res.ok,
    };
  } catch (e) {
    results.disbursementStatusCheckError = e instanceof Error ? e.message : String(e);
  }

  // Test 3: Check recent withdrawals
  const recent = await env.DB.prepare(
    "SELECT status, COUNT(*) as cnt FROM withdrawals GROUP BY status"
  ).all<{ status: string; cnt: number }>();
  results.withdrawalStats = recent.results;

  return c.json(results);
});

app.get("/api/admin/lipila-logs", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const kind = c.req.query("kind");     // collection | disbursement | all (default all)
  const status = c.req.query("status"); // pending | success | failed | error
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "200", 10) || 200, 1), 1000);

  const params: string[] = [];
  const binds: any[] = [];
  let where = "WHERE 1=1";
  if (kind && ["collection", "disbursement"].includes(kind)) {
    where += ` AND kind = ?`;
    binds.push(kind);
  }
  if (status) {
    where += ` AND status = ?`;
    binds.push(status);
  }
  const sql = `SELECT kind, reference_id AS referenceId, phone, amount_cents AS amountCents,
                      status, lipila_status AS lipilaStatus, message, created_at AS createdAt, updated_at AS updatedAt
               FROM lipila_logs ${where} ORDER BY created_at DESC LIMIT ?`;
  const out = await c.env.DB.prepare(sql).bind(...binds, limit).all<Record<string, any>>();
  return c.json({ logs: out.results.map((r) => ({
    kind: r.kind, referenceId: r.reference_id, phone: r.phone,
    amountCents: r.amount_cents, status: r.status, lipilaStatus: r.lipila_status,
    message: r.message, createdAt: r.created_at, updatedAt: r.updated_at,
  })) });
});

// ---------- Superadmin manual disbursement trigger ----------

// ---------- Admin: campaigns eligible for payout ----------

app.get("/api/admin/eligible-payouts", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const DEFAULT_MIN_WITHDRAW = 20000;
  const cfg = loadFeeConfig(c.env);
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.host_user_id, u.phone AS hostPhone,
            c.min_withdraw_cents AS minWithdrawCents
     FROM campaigns c JOIN users u ON u.id = c.host_user_id
     WHERE c.status = 'active'`
  ).all<Record<string, any>>();

  const eligible: Record<string, any>[] = [];
  for (const row of rows.results) {
    const available = await availableBalance(c.env, row.id);
    const minW = row.minWithdrawCents ?? DEFAULT_MIN_WITHDRAW;
    if (available < minW) continue;
    const payoutCents = payoutAmountCents(available, cfg);
    const lipilaFee = disbursementFeeCents(available, cfg);
    const platformFee = platformDisbursementFeeCents(available, cfg);
    if (payoutCents <= 0) continue;
    eligible.push({
      id: row.id,
      title: row.title,
      hostPhone: row.hostPhone,
      availableCents: available,
      minWithdrawCents: minW,
      payoutCents,
      lipilaFeeCents: lipilaFee,
      platformFeeCents: platformFee,
    });
  }
  return c.json({ campaigns: eligible });
});

// ---------- Admin: disburse a specific campaign ----------

app.post("/api/admin/disburse", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json().catch(() => ({}));
  const campaignId = Number(body.campaignId) || 0;

  if (campaignId) {
    const result = await createWithdrawal(c.env, campaignId);
    return c.json({ ok: true, campaignId, payoutCents: result, message: result > 0 ? `Payout of K${(result / 100).toLocaleString()} initiated` : 'No payout: balance below minimum or zero' });
  }

  // Trigger all
  await runAutoDisburse(c.env);
  return c.json({ ok: true, message: 'Auto-disburse triggered for all active campaigns'   });
});

// ---------- Admin: send test push notification ----------

app.post("/api/admin/test-push", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json().catch(() => ({}));
  const userId = Number(body.userId) || admin.sub;

  const sent = await pushToUser(c.env, userId, "Kingdom Sponsor Test", "This is a test push notification from the admin dashboard.", { type: "test" });
  return c.json({ ok: true, message: `Test push sent (delivered to ${sent} device${sent === 1 ? "" : "s"})`, sent });
});

// ---------- Lipila wallet balance (superadmin) ----------

app.get("/api/admin/wallet-balance", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  try {
    const balanceKwacha = await getWalletBalance(c.env as LipilaEnv);
    const balanceCents = Math.round(balanceKwacha * 100);
    return c.json({ ok: true, balanceCents, balanceKwacha });
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    console.error("wallet-balance failed:", e);
    return c.json({ ok: false, balanceCents: 0, balanceKwacha: 0, error: reason });
  }
});

// ---------- Superadmin manual withdraw ----------

app.post("/api/admin/withdraw", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  const amountCents = Math.round(Number(body.amountCents) || 0);
  const phone = String(body.phone ?? "").trim();
  if (amountCents < 100) return c.json({ error: "Minimum withdraw is K1" }, 400);
  if (!phone || phone.length < 10) return c.json({ error: "Valid phone number required" }, 400);
  const referenceId = `ADMIN-WITHDRAW-${Date.now()}`;
  const cleanPhone = phone.replace("+", "").replace(/\s/g, "");
  try {
     const result = await createDisbursement(c.env, {
       referenceId, amountCents, accountNumber: cleanPhone,
       narration: "Kingdom Sponsor admin withdrawal",
       callbackUrl: `${c.env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(c.env.LIPILA_WEBHOOK_SECRET)}`,
     }, c.env.DB);
     await c.env.DB.prepare(
       "INSERT INTO fee_sweeps (kind, amount_cents, lipila_reference, status) VALUES (?, ?, ?, 'pending')"
     ).bind("admin_withdraw", amountCents, referenceId).run();
     // Immediately check Lipila status so pending doesn't get stuck
     try {
       const statusRes = await checkDisbursementStatus(c.env, referenceId);
       const lipilaStatus = (statusRes.status ?? "").toLowerCase();
       if (["successful", "success", "complete"].includes(lipilaStatus)) {
         await c.env.DB.prepare("UPDATE fee_sweeps SET status = 'success' WHERE lipila_reference = ?").bind(referenceId).run();
       } else if (["failed", "error"].includes(lipilaStatus)) {
         await c.env.DB.prepare("UPDATE fee_sweeps SET status = 'failed' WHERE lipila_reference = ?").bind(referenceId).run();
       }
     } catch (_) { /* status check is best-effort */ }
     return c.json({ ok: true, referenceId, identifier: result.identifier, message: `Withdrawal of K${(amountCents / 100).toLocaleString()} initiated to ${phone}` });
   } catch (e) {
     const msg = e instanceof Error ? e.message : String(e);
     await logLipilaEvent(c.env.DB, "disbursement", referenceId, phone, amountCents, msg);
     return c.json({ error: `Withdrawal failed: ${e}` }, 500);
   }
});

// ---------- admin assistants (limited admin roles) ----------

app.get("/api/admin/assistants", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT a.user_id, a.permissions, a.added_by, a.created_at, u.phone, u.username, u.host_status
     FROM admin_assistants a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC`
  ).all<Record<string, any>>();
  return c.json({
    assistants: rows.results.map((r) => ({
      userId: r.user_id,
      phone: r.phone,
      username: r.username ?? "Giver",
      hostStatus: r.host_status,
      permissions: (String(r.permissions ?? "")).split(",").map((s: string) => s.trim()).filter(Boolean),
      addedBy: r.added_by,
      createdAt: r.created_at,
    })),
  });
});

/** Search users by phone or username for adding assistants (superadmin only). */
app.get("/api/admin/users/search", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const q = String(c.req.query("q") ?? "").trim().slice(0, 50);
  if (!q) return c.json({ users: [] });
  const like = `%${q}%`;
  const rows = await c.env.DB.prepare(
    `SELECT id, phone, username, host_status FROM users
     WHERE phone LIKE ? OR username LIKE ? ORDER BY created_at DESC LIMIT 20`
  ).bind(like, like).all<Record<string, any>>();
  return c.json({
    users: rows.results.map((u) => ({
      id: u.id,
      phone: u.phone,
      username: u.username ?? "Giver",
      hostStatus: u.host_status,
    })),
  });
});

app.post("/api/admin/assistants", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  const userId = Math.round(Number(body.userId) || 0);
  if (!userId) return c.json({ error: "A user is required" }, 400);
  const permissions = Array.isArray(body.permissions)
    ? body.permissions.map((p: string) => String(p).trim()).filter((p: string) => (ASSISTANT_SCOPES as readonly string[]).includes(p))
    : [];
  if (permissions.length === 0) return c.json({ error: "Pick at least one permission" }, 400);
  if (isAdminPhone(c.env, String(body.phone ?? ""))) {
    return c.json({ error: "That phone belongs to a superadmin — already has full access." }, 400);
  }
  await c.env.DB.prepare(
    "INSERT INTO admin_assistants (user_id, permissions, added_by) VALUES (?, ?, ?) " +
    "ON CONFLICT(user_id) DO UPDATE SET permissions = excluded.permissions, added_by = excluded.added_by"
  ).bind(userId, permissions.join(","), admin.sub).run();
  return c.json({ ok: true });
});

app.put("/api/admin/assistants/:userId", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const userId = Number(c.req.param("userId"));
  const body = await c.req.json();
  const permissions = Array.isArray(body.permissions)
    ? body.permissions.map((p: string) => String(p).trim()).filter((p: string) => (ASSISTANT_SCOPES as readonly string[]).includes(p))
    : [];
  if (permissions.length === 0) return c.json({ error: "Pick at least one permission" }, 400);
  const res = await c.env.DB.prepare(
    "UPDATE admin_assistants SET permissions = ? WHERE user_id = ?"
  ).bind(permissions.join(","), userId).run();
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: "Assistant not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/api/admin/assistants/:userId", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  await c.env.DB.prepare("DELETE FROM admin_assistants WHERE user_id = ?")
    .bind(c.req.param("userId")).run();
  return c.json({ ok: true });
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
  // KYC documents are private — only admins can view them.
  if (key.startsWith("kyc/")) {
    const admin = await requireAdmin(c);
    if (!admin) return c.json({ error: "Not found" }, 404);
  }
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  const ext = key.split(".").pop()?.toLowerCase();
  const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const cache = key.startsWith("kyc/") ? "private, no-store" : "public, max-age=86400, immutable";
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": cache,
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

/** Host KYC document upload (NRC / NGO cert / endorsement). Stored privately in
 *  R2 under `kyc/` so only admins can view it; URL is saved on the user. */
app.post("/api/host/kyc-upload", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "Upload a document image" }, 400);

  const type = file.type.toLowerCase();
  const ext = LOGO_TYPES[type];
  if (!ext) return c.json({ error: "Document must be PNG, JPG or WebP" }, 400);
  if (file.size > 5_000_000) return c.json({ error: "Document must be under 5 MB" }, 400);

  const key = `kyc/${user.sub}-${Date.now()}.${ext}`;
  await c.env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: type } });
  const docUrl = `${c.env.APP_URL}/media/${key}`;
  await c.env.DB.prepare("UPDATE users SET host_kyc_doc_url = ? WHERE id = ?")
    .bind(docUrl, user.sub).run();

  return c.json({ ok: true, docUrl });
});

/** Admin: view a host's KYC document. Only reachable through the /media/ route
 *  which requires admin auth for the `kyc/` prefix (see media handler). */

app.post("/api/campaigns/:id/logo", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

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

  const longUrl = c.env.APP_URL + "/share/" + id;
  await createShortLink(c.env, longUrl);

  const pub = await campaignPublic(c.env, campaign);
  const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const pageUrl = c.env.APP_URL + "/share/" + id + refQuery;
  const waMessage = pub.title + "\n" + pub.blurb +
    "\n" + formatKwacha(pub.raisedCents) + " raised" +
    (pub.hostName ? " \u00b7 " + pub.hostName : "") +
    "\n\nGive here: " + pageUrl;
  const wa = "https://wa.me/?text=" + encodeURIComponent(waMessage);
  const goalLine = pub.hasGoal
    ? "<div class=\"amt\">" + formatKwacha(pub.raisedCents) + " raised of " + formatKwacha(pub.goalCents) + "</div>"
    : "<div class=\"amt\">" + formatKwacha(pub.raisedCents) + " raised</div>";
  const endsLine = pub.endsAt ? "ends " + new Date(pub.endsAt).toLocaleDateString() : "";
  const ogImage = pub.imageUrl ? "<meta property=\"og:image\" content=\"" + pub.imageUrl + "\">" : "";
  const verifiedBadge = pub.hostVerified
    ? "<span style=\"display:inline-block;background:#1d4ed8;color:#fff;font-size:11px;font-weight:700;border-radius:12px;padding:3px 10px;margin-bottom:8px\">\u2713 Verified host</span>"
    : "";
  const hostLine = pub.hostName
    ? "<div style=\"color:#94a3b8;font-size:12px;margin-bottom:8px\">Hosted by " + pub.hostName + (pub.hostVerified ? " \u00b7 verified" : "") + "</div>"
    : "";
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta property=\"og:title\" content=\"" + pub.title + "\"><meta property=\"og:description\" content=\"" + pub.blurb + "\"><meta property=\"og:type\" content=\"website\"><meta property=\"og:url\" content=\"" + pageUrl + "\">" + ogImage + "<meta name=\"theme-color\" content=\"#1d4ed8\"><title>" + pub.title + " - Kingdom Sponsor</title><style>" + SHARE_STYLE + "</style></head><body><div class=\"card\">" + (pub.imageUrl ? "<img src=\"" + pub.imageUrl + "\" alt=\"\" style=\"width:96px;height:96px;border-radius:16px;margin-bottom:12px;object-fit:cover\">" : "") + "<h1>" + pub.title + "</h1>" + verifiedBadge + hostLine + "<p>" + pub.blurb + "</p>" + goalLine + "<a class=\"btn\" href=\"" + wa + "\" target=\"_blank\">Share on WhatsApp</a><a class=\"btn2\" href=\"kingdomsponsor://campaign/" + id + (ref ? "?ref=" + encodeURIComponent(ref) : "") + "\">Open in app</a><a class=\"btn3\" href=\"https://play.google.com/store/apps/details?id=com.kingdomsponsor.app\" target=\"_blank\">Don't have the app? Get it on Play Store</a><div class=\"foot\">" + (pub.donorCount ?? 0) + " givers - " + endsLine + "</div></div></body></html>";
  return c.html(html);
});

// Short-link redirect: increments click count and 302-redirects to the long URL.
app.get("/go/:code", async (c) => {
  const longUrl = await resolveShortLink(c.env, c.req.param("code"));
  if (!longUrl) return c.json({ error: "Link not found" }, 404);
  return c.redirect(longUrl, 302);
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
    "SELECT id, title FROM campaigns WHERE status = 'active' AND visibility = 'public' ORDER BY created_at DESC LIMIT 5"
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
      "SELECT id, title FROM campaigns WHERE status = 'active' AND visibility = 'public' ORDER BY created_at DESC LIMIT 10"
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
        amountCents: row.amount_cents + row.platform_fee_cents + row.lipila_fee_cents,
        accountNumber: phone.replace("+", ""),
        narration: `Kingdom Sponsor donation to ${campaign.title}`,
        callbackUrl: `${c.env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(c.env.LIPILA_WEBHOOK_SECRET)}`,
      }, c.env.DB);
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
    const appShareLink = await createShortLink(c.env, c.env.APP_URL);
    return c.text(`END Share the Kingdom Sponsor app: ${appShareLink}. Copy the link and send it to your family and friends via WhatsApp.`);
  }

  if (level === 1 && choice === "4") {
    const appShareLink = await createShortLink(c.env, c.env.APP_URL);
    return c.text(`END Download Kingdom Sponsor from Google Play Store. Search for 'Kingdom Sponsor' or visit ${appShareLink} to get the download link.`);
  }

  const mainMenuText = "CON Kingdom Sponsor\n1. View campaigns\n2. Scan QR code\n3. Share event\n4. Download app\n0. Exit";

  async function campaignListText() {
    const campaigns = await topCampaigns();
    const menu = campaigns.map((camp, i) => `${i + 1}. ${camp.title}`).join("\n");
    return `CON Select a campaign\n${menu}\n0. Back`;
  }

  const scanText = "END Open your phone camera or WhatsApp and scan the QR code on the Kingdom Sponsor poster or flyer to access the fundraiser.";

  async function makeContribution(campaignId: number, amountCents: number): Promise<boolean> {
    const fees = donationFees(amountCents, loadFeeConfig(c.env));
    const referenceId = `USSD-${sessionId}`;
    await c.env.DB.prepare(
      "DELETE FROM contributions WHERE lipila_reference = ?"
    ).bind(referenceId).run();
    await c.env.DB.prepare(
      "INSERT INTO contributions (campaign_id, donor_user_id, giver_user_id, is_anonymous, phone, amount_cents, platform_fee_cents, lipila_fee_cents, lipila_reference, status) VALUES (?, NULL, NULL, 1, ?, ?, ?, ?, ?, 'pending')"
    ).bind(campaignId, phone, amountCents, fees.platformFeeCents, fees.lipilaFeeCents, referenceId).run();
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
    if (choice === "3") {
      const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ? AND status = 'active'").bind(parts[0]).first<Record<string, any>>();
      if (!campaign) return c.text("END Invalid selection.");
      const campaignShareLink = await createShortLink(c.env, `${c.env.APP_URL}/share/${campaign.id}`);
      return c.text(`END Share this fundraiser: ${campaignShareLink}. Copy the link and send it to your family and friends via WhatsApp.`);
    }
    if (choice === "4") {
      const appShareLink = await createShortLink(c.env, c.env.APP_URL);
      return c.text(`END Download Kingdom Sponsor from Google Play Store. Search for 'Kingdom Sponsor' or visit ${appShareLink} to get the download link.`);
    }
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
    const ussdRow = await pendingUssdContribution();
    const ussdTotal = ussdRow ? ussdRow.amount_cents + ussdRow.platform_fee_cents + ussdRow.lipila_fee_cents : amountCents;
    return c.text(`CON You are about to donate K${(amountCents / 100).toLocaleString()} (K${(ussdTotal / 100).toLocaleString()} total incl. fees) to "${camp.title}".\nConfirm? 1. Yes 2. No`);
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
      const ussdRow = await pendingUssdContribution();
      const ussdTotal = ussdRow ? ussdRow.amount_cents + ussdRow.platform_fee_cents + ussdRow.lipila_fee_cents : amountCents;
      return c.text(`CON You are about to donate K${(amountCents / 100).toLocaleString()} (K${(ussdTotal / 100).toLocaleString()} total incl. fees) to "${camp.title}".\nConfirm? 1. Yes 2. No`);
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

// ---------- Account link accept/reject (web deep-link landing) ----------

app.get("/links/:id/accept", async (c) => {
  const linkId = Number(c.req.param("id"));
  if (!linkId) return c.json({ error: "Invalid link id" }, 400);

  const row = await c.env.DB.prepare(
    "SELECT ul.*, u.username AS sender_username FROM user_links ul JOIN users u ON u.id = ul.user_id WHERE ul.id = ? AND ul.status = 'pending'"
  ).bind(linkId).first<Record<string, any>>();

  if (!row) return c.text("This link request is no longer pending.", 410);

  const deepLink = `kingdomsponsor://accept-link/${linkId}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Accept link â€” Kingdom Sponsor</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;padding:24px;max-width:420px;margin:0 auto;text-align:center}h1{font-size:22px;margin:0 0 12px;color:#34d399}p{color:#94a3b8;line-height:1.5}a.btn{display:block;background:#25D366;color:#06281b;font-weight:700;text-decoration:none;padding:14px;border-radius:10px;margin:12px 0}a.btn2{display:block;background:#334155;color:#cbd5e1;font-weight:700;text-decoration:none;padding:12px;border-radius:10px;margin:12px 0}</style></head><body><h1>Accept account link?</h1><p>${row.sender_username ?? "Someone"} wants to link their account to yours as ${row.link_type}.</p><a class="btn" href="${deepLink}">Open in app to accept</a><a class="btn2" href="https://play.google.com/store/apps/details?id=com.kingdomsponsor.app">Don't have the app? Get it on Play Store</a></body></html>`;
  return c.html(html);
});

app.get("/links/:id/reject", async (c) => {
  const linkId = Number(c.req.param("id"));
  if (!linkId) return c.json({ error: "Invalid link id" }, 400);

  const row = await c.env.DB.prepare(
    "SELECT ul.*, u.username AS sender_username FROM user_links ul JOIN users u ON u.id = ul.user_id WHERE ul.id = ? AND ul.status = 'pending'"
  ).bind(linkId).first<Record<string, any>>();

  if (!row) return c.text("This link request is no longer pending.", 410);

  const deepLink = `kingdomsponsor://reject-link/${linkId}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Decline link â€” Kingdom Sponsor</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;padding:24px;max-width:420px;margin:0 auto;text-align:center}h1{font-size:22px;margin:0 0 12px;color:#34d399}p{color:#94a3b8;line-height:1.5}a.btn{display:block;background:#ef4444;color:#fff;font-weight:700;text-decoration:none;padding:14px;border-radius:10px;margin:12px 0}a.btn2{display:block;background:#334155;color:#cbd5e1;font-weight:700;text-decoration:none;padding:12px;border-radius:10px;margin:12px 0}</style></head><body><h1>Decline account link?</h1><p>Decline the link request from ${row.sender_username ?? "someone"}.</p><a class="btn" href="${deepLink}">Open in app to decline</a><a class="btn2" href="https://play.google.com/store/apps/details?id=com.kingdomsponsor.app">Don't have the app? Get it on Play Store</a></body></html>`;
  return c.html(html);
});

app.get("/privacy", (c) => {
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Privacy Policy â€” Kingdom Sponsor</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;padding:24px;max-width:800px;margin:0 auto;line-height:1.6}h1{font-size:24px;margin:0 0 16px;color:#34d399}h2{font-size:18px;margin:24px 0 8px;color:#94a3b8}p{margin:0 0 12px}ul{margin:0 0 12px;padding-left:20px}li{margin:4px 0}a{color:#34d399}</style></head><body><h1>Privacy Policy</h1><p><strong>Last updated:</strong> August 2026</p><p>Kingdom Sponsor (\"we,\" \"our,\" or \"us\") operates a fundraising platform that allows users to donate to campaigns and hosts to create and manage fundraising campaigns. This privacy policy describes how we collect, use, and protect your personal data.</p><h2>1. Information We Collect</h2><h3>1.1 Account Data</h3><ul><li><strong>Phone number</strong> â€” required for registration and OTP-based authentication via Africa's Talking SMS</li><li><strong>Username</strong> â€” chosen during registration</li><li><strong>User ID</strong> â€” internally generated identifier</li></ul><h3>1.2 Donation Data</h3><ul><li><strong>Amount donated</strong> (in ngwee/cents)</li><li><strong>Donor name</strong> (optional, can be anonymous)</li><li><strong>Phone number</strong> â€” used for Lipila payment prompts and SMS notifications</li><li><strong>Transaction reference ID</strong> â€” unique identifier for each donation</li><li><strong>Campaign ID</strong> â€” the campaign being supported</li></ul><h3>1.3 Campaign Data</h3><ul><li><strong>Campaign title, description, and goal</strong></li><li><strong>Campaign status</strong> (active, draft, ended)</li><li><strong>Logo URL</strong> (if uploaded by the host)</li><li><strong>Sponsor count and amounts</strong></li></ul><h3>1.4 Payment Data</h3><ul><li><strong>Lipila collection and disbursement references</strong></li><li><strong>Payment status</strong> (pending, success, failed, cancelled)</li><li><strong>Platform fees and Lipila fees</strong> (calculated automatically)</li></ul><h3>1.5 USSD Session Data</h3><ul><li><strong>Session ID</strong> â€” temporary identifier for USSD interactions</li><li><strong>Phone number</strong> â€” the user's phone dialing the USSD code</li><li><strong>Menu selections</strong> â€” choices made during the USSD flow</li><li><strong>Donation amount and reference</strong> â€” recorded when a USSD donation is confirmed</li></ul><h3>1.6 Technical Data</h3><ul><li><strong>IP address</strong> â€” logged automatically by Cloudflare</li><li><strong>User agent and device information</strong> â€” collected by the Flutter app</li><li><strong>FCM tokens</strong> â€” used for push notifications (stored per device)</li></ul><h2>2. How We Use Your Data</h2><ul><li><strong>Authentication</strong> â€” your phone number is used to send and verify OTPs via Africa's Talking SMS</li><li><strong>Payment processing</strong> â€” donation amounts and phone numbers are sent to Lipila for mobile money transactions</li><li><strong>SMS notifications</strong> â€” we send transaction confirmations and pledge reminders via Africa's Talking</li><li><strong>USSD interactions</strong> â€” your USSD session data is processed in real time to provide the interactive menu experience</li><li><strong>Campaign management</strong> â€” campaign data is displayed publicly (except donor phone numbers, which are never exposed)</li><li><strong>Analytics and reporting</strong> â€” aggregated, anonymised data is used for platform statistics and admin dashboards</li><li><strong>Fee calculation</strong> â€” platform fees and Lipila fees are calculated and deducted automatically from each transaction</li></ul><h2>3. Data Storage</h2><ul><li>All data is stored in <strong>Cloudflare D1</strong> (SQLite) databases</li><li>Media files (campaign logos) are stored in <strong>Cloudflare R2</strong></li><li>No data is stored on our own servers â€” all infrastructure is provided by Cloudflare</li></ul><h2>4. Data Retention</h2><ul><li><strong>Contributions and transactions</strong> â€” retained indefinitely for financial records</li><li><strong>USSD session data</strong> â€” not persisted; processed in real time and discarded after the session ends</li><li><strong>User accounts</strong> â€” retained until the account is deleted</li><li><strong>Campaigns</strong> â€” retained until the host ends the campaign</li><li><strong>Payout/withdrawal records</strong> â€” retained indefinitely</li></ul><h2>5. Data Sharing</h2><p>We do not sell your personal data. We share data only with:</p><ul><li><strong>Lipila</strong> â€” for payment processing (phone number, amount, reference ID)</li><li><strong>Africa's Talking</strong> â€” for SMS and USSD services (phone number, session data)</li><li><strong>Cloudflare</strong> â€” as our infrastructure provider (IP address, technical data)</li><li><strong>Firebase</strong> â€” for FCM push notifications (device tokens)</li></ul><h2>6. Your Rights</h2><p>You have the right to:</p><ul><li><strong>Access</strong> â€” request a copy of your personal data</li><li><strong>Rectification</strong> â€” correct inaccurate information</li><li><strong>Erasure</strong> â€” request deletion of your account and associated data</li><li><strong>Portability</strong> â€” receive your data in a machine-readable format</li><li><strong>Object</strong> â€” object to processing of your data for direct marketing</li></ul><p>To exercise any of these rights, contact us through the platform or reach out to the superadmin.</p><h2>7. Security</h2><ul><li>All API endpoints are protected by JWT authentication</li><li>Phone numbers are never exposed publicly</li><li>Payment data is processed by Lipila and never stored in full</li><li>USSD session data is processed in real time and not persisted</li><li>We use HTTPS for all data transmission</li></ul><h2>8. Children's Privacy</h2><p>Kingdom Sponsor is not intended for users under the age of 13. We do not knowingly collect data from children.</p><h2>9. Changes to This Policy</h2><p>We may update this privacy policy from time to time. Changes will be posted on this page with a new \"Last updated\" date.</p><h2>10. Contact</h2><p>For privacy-related inquiries, contact the platform administrator or the superadmin phone number configured in the backend.</p><p><strong>Platform:</strong> Kingdom Sponsor<br><strong>Backend:</strong> https://kingdom-sponsor-api.godfreymoseskalambo.workers.dev<br><strong>GitHub:</strong> https://github.com/Carpso/chisomo</p></body></html>";
  return c.html(html);
});

app.get("/delete-account", (c) => {
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Delete Account â€” Kingdom Sponsor</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;padding:24px;max-width:600px;margin:0 auto;line-height:1.6}h1{font-size:24px;margin:0 0 16px;color:#34d399}h2{font-size:18px;margin:24px 0 8px;color:#94a3b8}p{margin:0 0 12px}ul{margin:0 0 12px;padding-left:20px}li{margin:4px 0}a{color:#34d399}</style></head><body><h1>Delete Account</h1><h2>Kingdom Sponsor</h2><p><strong>In the app:</strong> open the app, tap the settings icon, then \"Delete account\". Your account and personal data are deleted immediately.</p><p><strong>By email:</strong> email <strong>support@kingdom-sponsor.app</strong> with the subject \"Delete Account\" and the phone number associated with your account. Requests are processed within 30 days.</p><h2>Data Deleted</h2><ul><li>Username and profile information</li><li>Pledge records</li><li>User links</li><li>FCM device tokens</li><li>Donor name and identity on contributions</li></ul><h2>Data Retained</h2><ul><li>Transaction records (required for financial compliance) â€” retained for 7 years</li><li>Anonymized analytics â€” retained indefinitely</li><li>Audit logs â€” retained for 1 year</li></ul><p>If you simply want to stop receiving SMS notifications, you can reply STOP to any SMS from us.</p></body></html>";
  return c.html(html);
});

app.get("/", (c) => c.json({ name: "Kingdom Sponsor API", version: "0.3.0", pushConfigured: envPushConfigured(c.env) }));

// ---------- Push notification diagnostic (admin) ----------

app.get("/api/admin/push-status", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const pushConfigured = envPushConfigured(c.env);
  const tokenCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM device_tokens"
  ).first<{ n: number }>();
  const usersWithTokens = await c.env.DB.prepare(
    "SELECT COUNT(DISTINCT user_id) AS n FROM device_tokens"
  ).first<{ n: number }>();
  const pendingWithdrawals = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'"
  ).first<{ n: number }>();

  return c.json({
    pushConfigured,
    firebaseEmailConfigured: !!c.env.FIREBASE_CLIENT_EMAIL,
    firebaseKeyConfigured: !!c.env.FIREBASE_PRIVATE_KEY,
    totalTokens: tokenCount?.n ?? 0,
    usersWithTokens: usersWithTokens?.n ?? 0,
    pendingWithdrawals: pendingWithdrawals?.n ?? 0,
  });
});

// ---------- Admin: send test push notification ----------

/** Scheduled: sweep payout-eligible balances for every active campaign. */
async function runAutoDisburse(env: Bindings): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id FROM campaigns WHERE status = 'active'"
  ).all<{ id: number }>();
  let attempted = 0;
  let succeeded = 0;
  let skipped = 0;
  for (const row of rows.results) {
    try {
      const result = await createWithdrawal(env, row.id);
      attempted++;
      if (result > 0) succeeded++;
      else skipped++;
    } catch (e) {
      console.error(`auto-disburse: campaign ${row.id} failed:`, e);
    }
  }
  console.log(`auto-disburse: checked ${rows.results.length} campaigns, attempted ${attempted}, succeeded ${succeeded}, skipped ${skipped}`);
}

const appObject = Sentry.withSentry(
  (env: Bindings) => ({
    dsn: env.SENTRY_DSN ?? "",
    environment: env.ENV ?? "sandbox",
    tracesSampleRate: 0.05,
  }),
  {
    fetch: app.fetch,
    scheduled: async (controller: ScheduledController, env: Bindings, ctx: ExecutionContext) => {
      // 15-minute cron: intruder alert scan, MNO health check, + auto-disburse.
      if (controller.cron === "*/15 * * * *") {
        ctx.waitUntil(runIntruderAlerts(env));
        ctx.waitUntil(refreshMnoHealth(env));
        ctx.waitUntil(runAutoDisburse(env));
        return;
      }
      // Daily cron: all scheduled jobs.
      ctx.waitUntil(runFeeSweep(env));
      ctx.waitUntil(runFeeSweepStatusChecks(env));
      ctx.waitUntil(runPledgeReminders(env));
      ctx.waitUntil(runPromotionExpiry(env));
      ctx.waitUntil(runAutoDisburse(env));
      ctx.waitUntil(runWithdrawalStatusChecks(env));
      ctx.waitUntil(runTicketAutoClose(env));
      ctx.waitUntil(runAirtimeFulfillment(env));
      ctx.waitUntil(runCampaignEndingAlerts(env));
    },
  }
);

// ===================================================================
// USSD SERVICE (Africa's Talking callback)
// Requires: USSD code provisioned via Africa Talking dashboard + MNO approval
// ===================================================================

const ussdSessions = new Map<string, { step: string; data: Record<string, string> }>();

app.post("/api/ussd/callback", async (c) => {
  const sessionId = c.req.header("sessionId") || c.req.query("sessionId") || "";
  const phone = c.req.header("phoneNumber") || c.req.query("phoneNumber") || "";
  const serviceCode = c.req.header("serviceCode") || c.req.query("serviceCode") || "";
  const text = c.req.header("text") || c.req.query("text") || "";

  if (!sessionId || !phone) return c.text("END Invalid request");

  const session = ussdSessions.get(sessionId) || { step: "main", data: {} };
  let response = "";

  if (text === "") {
    // Main menu
    response = "CON Welcome to Kingdom Sponsor\n1. Donate to a campaign\n2. Check balance\n3. My pledges\n4. Help";
    session.step = "main";
  } else if (session.step === "main") {
    switch (text) {
      case "1":
        response = "CON Choose campaign:\n";
        const rows = await c.env.DB.prepare(
          "SELECT id, title FROM campaigns WHERE status = 'active' AND visibility = 'public' ORDER BY promoted DESC, created_at DESC LIMIT 5"
        ).all<{ id: number; title: string }>();
        for (let i = 0; i < rows.results.length; i++) {
          response += `${i + 1}. ${rows.results[i].title}\n`;
        }
        session.step = "select_campaign";
        break;
      case "2":
        const userRow = await c.env.DB.prepare("SELECT id FROM users WHERE phone = ?").bind(phone).first<{ id: number }>();
        if (userRow) {
          const total = await donorTotalCents(c.env.DB, userRow.id);
          response = `END Your total giving: ${formatKwacha(total)}`;
        } else {
          response = "END You are not registered. Sign up on the app.";
        }
        session.step = "done";
        break;
      case "3":
        response = "END Pledges feature coming soon on USSD.";
        session.step = "done";
        break;
      case "4":
        response = "END Help: Dial this code to donate to fundraisers. Visit kingdom-sponsor.app for more.";
        session.step = "done";
        break;
      default:
        response = "END Invalid option";
        session.step = "done";
    }
  } else if (session.step === "select_campaign") {
    const choice = parseInt(text, 10);
    if (choice >= 1) {
      const rows = await c.env.DB.prepare(
        "SELECT id, title FROM campaigns WHERE status = 'active' AND visibility = 'public' ORDER BY promoted DESC, created_at DESC LIMIT 5"
      ).all<{ id: number; title: string }>();
      if (rows.results[choice - 1]) {
        session.data.campaignId = String(rows.results[choice - 1].id);
        response = "CON Enter amount (K):";
        session.step = "enter_amount";
      } else {
        response = "END Invalid campaign";
        session.step = "done";
      }
    }
  } else if (session.step === "enter_amount") {
    const kwacha = parseFloat(text);
    if (kwacha >= 1) {
      session.data.amountCents = String(Math.round(kwacha * 100));
      response = `CON Donate K${kwacha} to campaign?\n1. Yes\n2. No`;
      session.step = "confirm_donation";
    } else {
      response = "END Invalid amount. Minimum is K1.";
      session.step = "done";
    }
  } else if (session.step === "confirm_donation") {
    if (text === "1") {
      response = "END Donation initiated. You will receive a payment prompt on your phone.";
      session.step = "done";
    } else {
      response = "END Donation cancelled.";
      session.step = "done";
    }
  } else {
    response = "END Session expired. Please dial again.";
    session.step = "done";
  }

  if (session.step === "done") {
    ussdSessions.delete(sessionId);
  } else {
    ussdSessions.set(sessionId, session);
  }

  c.header("Content-Type", "text/plain");
  return c.text(response);
});

// ===================================================================
// APPROVED HOST BADGE SYSTEM
// Admin-controlled subscription for verified hosts
// ===================================================================

// Get badge pricing (admin configurable)
app.get("/api/host/badge-config", async (c) => {
  const basePrice = await getSetting(c.env, "host_badge_base_price_cents");
  const proPrice = await getSetting(c.env, "host_badge_pro_price_cents");
  const annualPrice = await getSetting(c.env, "host_badge_annual_price_cents");
  const enabled = await getSetting(c.env, "host_badge_enabled");
  return c.json({
    enabled: enabled === "true",
    tiers: {
      basic: { priceCents: Number(basePrice) || 5000, days: 30, label: "Basic Host" },
      pro: { priceCents: Number(proPrice) || 15000, days: 30, label: "Pro Host" },
      annual: { priceCents: Number(annualPrice) || 120000, days: 365, label: "Annual Pro" },
    },
  });
});

// Admin: update badge pricing
app.put("/api/admin/host/badge-config", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  if (body.basicPriceCents) await setSetting(c.env, "host_badge_base_price_cents", String(body.basicPriceCents));
  if (body.proPriceCents) await setSetting(c.env, "host_badge_pro_price_cents", String(body.proPriceCents));
  if (body.annualPriceCents) await setSetting(c.env, "host_badge_annual_price_cents", String(body.annualPriceCents));
  if (body.enabled !== undefined) await setSetting(c.env, "host_badge_enabled", body.enabled ? "true" : "false");
  return c.json({ ok: true });
});

// Get user's badge status
app.get("/api/host/badge-status", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const badge = await c.env.DB.prepare(
    "SELECT * FROM host_badges WHERE user_id = ? AND expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1"
  ).bind(user.sub).first<Record<string, any>>();
  return c.json({
    hasActiveBadge: !!badge,
    tier: badge?.tier || null,
    expiresAt: badge?.expires_at || null,
  });
});

// Subscribe to a badge tier
app.post("/api/host/badge/subscribe", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const enabled = await getSetting(c.env, "host_badge_enabled");
  if (enabled !== "true") return c.json({ error: "Badge program not yet active" }, 503);

  const body = await c.req.json();
  const tier = String(body.tier ?? "basic");

  let priceCents: number;
  let days: number;
  switch (tier) {
    case "pro":
      priceCents = Number(await getSetting(c.env, "host_badge_pro_price_cents")) || 15000;
      days = 30;
      break;
    case "annual":
      priceCents = Number(await getSetting(c.env, "host_badge_annual_price_cents")) || 120000;
      days = 365;
      break;
    default:
      priceCents = Number(await getSetting(c.env, "host_badge_base_price_cents")) || 5000;
      days = 30;
  }

  // Check if user already has active badge
  const existing = await c.env.DB.prepare(
    "SELECT id FROM host_badges WHERE user_id = ? AND expires_at > datetime('now') AND status = 'active'"
  ).bind(user.sub).first();

  if (existing) {
    return c.json({ error: "You already have an active badge. Wait for it to expire before renewing." }, 400);
  }

  // In production, this would trigger a Lipila payment prompt.
  // For now, we directly activate (admin can require manual payment verification).
  await c.env.DB.prepare(
    "INSERT INTO host_badges (user_id, tier, expires_at, amount_cents, status) VALUES (?, ?, datetime('now', '+' || ? || ' days'), ?, 'active')"
  ).bind(user.sub, tier, String(days), priceCents).run();

  // Notify user
  await pushToUser(c.env, user.sub, "Badge Activated",
    "Your Verified Host badge is now active! It will expire in $days days.",
    { type: "badge_activated", tier })
    .catch((e) => console.error("badge push failed:", e));

  return c.json({ ok: true, message: "Badge activated!", tier, expiresInDays: days });
});

// ===================================================================
// AIRTIME SYSTEM (Admin controlled - "Coming Soon" until enabled)
// ===================================================================

// Get airtime config (public - shows if enabled)
app.get("/api/airtime/config", async (c) => {
  const enabled = await getSetting(c.env, "airtime_enabled");
  const markup = await getSetting(c.env, "airtime_markup_pct");
  const minAmount = await getSetting(c.env, "airtime_min_amount_cents");
  const maxAmount = await getSetting(c.env, "airtime_max_amount_cents");
  const bonusPct = Number(await getSetting(c.env, "airtime_bonus_pct")) || 5;
  const user = await authUser(c);
  let creditsCents = 0;
  if (user) {
    const row = await c.env.DB.prepare("SELECT airtime_credits_cents FROM users WHERE id = ?")
      .bind(user.sub).first<{ airtime_credits_cents: number }>();
    creditsCents = Number(row?.airtime_credits_cents) || 0;
  }
  return c.json({
    enabled: enabled === "true",
    markupPct: Number(markup) || 5,
    minAmountCents: Number(minAmount) || 500,
    maxAmountCents: Number(maxAmount) || 50000,
    bonusPct,
    creditsCents,
  });
});

// Create airtime order (payment collected via Lipila MoMo prompt, then
// fulfilled through Africa's Talking airtime API by the webhook/cron).
app.post("/api/airtime/order", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const enabled = await getSetting(c.env, "airtime_enabled");
  if (enabled !== "true") return c.json({ error: "Airtime service coming soon" }, 503);

  const body = await c.req.json();
  const phone = String(body.phone ?? "").trim();
  const network = String(body.network ?? "").toLowerCase();
  const amountCents = Math.round(Number(body.amountCents) || 0);

  if (!phone || phone.length < 10) return c.json({ error: "Valid phone required" }, 400);
  if (!["airtel", "mtn", "zamtel", "zedmobile"].includes(network)) return c.json({ error: "Invalid network" }, 400);

  const minAmount = Number(await getSetting(c.env, "airtime_min_amount_cents")) || 500;
  const maxAmount = Number(await getSetting(c.env, "airtime_max_amount_cents")) || 50000;
  if (amountCents < minAmount || amountCents > maxAmount) {
    return c.json({ error: `Amount must be between K${minAmount / 100} and K${maxAmount / 100}` }, 400);
  }

  const markupPct = Number(await getSetting(c.env, "airtime_markup_pct")) || 5;
  let costCents = Math.round(amountCents * (1 + markupPct / 100));

  // Optional: apply accumulated airtime bonus credits towards this order.
  const balanceRow = await c.env.DB.prepare(
    "SELECT airtime_credits_cents FROM users WHERE id = ?"
  ).bind(user.sub).first<{ airtime_credits_cents: number }>();
  const balanceCents = Number(balanceRow?.airtime_credits_cents) || 0;
  const useCreditsCents = Math.max(0, Math.round(Number(body.useCreditsCents) || 0));
  const creditsUsed = Math.min(useCreditsCents, balanceCents, costCents);
  costCents -= creditsUsed;
  if (costCents <= 0) return c.json({ error: "Amount is fully covered by credits â€” enter an amount above your credits." }, 400);

  const referenceId = `AIR-${user.sub}-${Date.now()}`;
  const r = await c.env.DB.prepare(
    `INSERT INTO airtime_orders (user_id, phone, network, amount_cents, cost_cents, lipila_reference, credits_used_cents, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(user.sub, phone, network, amountCents, costCents, referenceId, creditsUsed).run();
  const orderId = r.meta?.last_row_id;

  if (creditsUsed > 0) {
    // Atomic decrement: never spend more than the user holds, even if two
    // orders race in (prevents negative credit balances).
    await c.env.DB.prepare(
      "UPDATE users SET airtime_credits_cents = airtime_credits_cents - ? WHERE id = ? AND airtime_credits_cents >= ?"
    ).bind(creditsUsed, user.sub, creditsUsed).run();
  }

  // Collect the order cost via a mobile-money prompt (same flow as donations).
  try {
    await createCollection(c.env, {
      referenceId,
      amountCents: costCents,
      accountNumber: user.phone.replace("+", ""),
      narration: `Kingdom Sponsor airtime order ${orderId}`,
      callbackUrl: `${c.env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(c.env.LIPILA_WEBHOOK_SECRET)}`,
    }, c.env.DB);
  } catch (e) {
    // Payment could not start: refund any credits used and void the order.
    if (creditsUsed > 0) {
      await c.env.DB.prepare(
        "UPDATE users SET airtime_credits_cents = airtime_credits_cents + ? WHERE id = ?"
      ).bind(creditsUsed, user.sub).run();
    }
    await c.env.DB.prepare(
      "UPDATE airtime_orders SET status = 'failed', error = ? WHERE id = ?"
    ).bind(String(e instanceof Error ? e.message : e).slice(0, 500), orderId).run();
    await logLipilaEvent(c.env.DB, "collection", referenceId, user.phone, costCents, `airtime collection failed: ${e}`);
    console.error("airtime collection failed:", e);
    return c.json({ error: "Airtime payment could not be started. Try again." }, 502);
  }

  return c.json({
    ok: true,
    orderId,
    phone,
    network,
    amountCents,
    costCents,
    creditsUsed,
    message: `Check your phone and enter PIN to pay ${formatKwacha(costCents)}. Airtime is delivered right after payment.`,
  });
});

// ---------- airtime fulfillment ----------

/** Deliver airtime for a paid order via Africa's Talking (real in production).
 *  Moves the order to `sent` and stores the AT requestId so the AT status
 *  callback can confirm real MNO delivery the instant it arrives. */
async function fulfillAirtimeOrder(env: Bindings, orderId: number): Promise<void> {
  const order = await env.DB.prepare("SELECT * FROM airtime_orders WHERE id = ?")
    .bind(orderId).first<Record<string, any>>();
  if (!order || order.status !== "paid") return;
  try {
    const res = await sendAirtime(env, order.phone, order.amount_cents / 100);
    const requestId = String(res?.responses?.[0]?.requestId ?? "").trim();
    await env.DB.prepare(
      "UPDATE airtime_orders SET status = 'sent', at_request_id = ?, sent_at = datetime('now', '+2 hours'), completed_at = NULL, error = NULL WHERE id = ?"
    ).bind(requestId || null, orderId).run();
    const msg = airtimeSentSms(order.phone, order.amount_cents);
    await pushToUser(env, order.user_id, "Airtime sent", msg, { type: "airtime_sent" })
      .catch((e) => console.error("airtime push failed:", e));
    const user = await env.DB.prepare("SELECT phone FROM users WHERE id = ?")
      .bind(order.user_id).first<{ phone: string }>();
    if (user?.phone) await smsIfNoPush(env, order.user_id, user.phone, msg);
    console.log("[AIRTIME] order", orderId, "sent; requestId =", requestId, JSON.stringify(res).slice(0, 200));
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 500);
    await env.DB.prepare(
      "UPDATE airtime_orders SET attempts = attempts + 1, error = ? WHERE id = ?"
    ).bind(msg, orderId).run();
    console.error("[AIRTIME] fulfillment failed for order", orderId, msg);
  }
}

/** Africa's Talking airtime STATUS callback — the one that confirms real MNO
 *  delivery the instant it happens. Matches by the requestId we stored when
 *  sending, then marks the order delivered or failed and notifies the user. */
app.post("/api/webhooks/at-airtime/status", async (c) => {
  // Read the raw body text first (Sentry/buffering-safe) and parse it manually.
  const raw = await c.req.text().catch(() => "");
  let body: Record<string, any> = {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      // Form-encoded fallback: phoneNumber=...&status=...&requestId=...
      for (const pair of raw.split("&")) {
        const [k, v] = pair.split("=");
        if (k) body[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
      }
    }
  }
  const requestId = String(body.requestId ?? "").trim();
  const status = String(body.status ?? "").toLowerCase();
  const phone = String(body.phoneNumber ?? "");
  const description = String(body.description ?? "").slice(0, 500);

  if (!requestId) {
    return c.json({ ok: false, error: "No requestId" }, 400);
  }

  const order = await c.env.DB.prepare(
    "SELECT * FROM airtime_orders WHERE at_request_id = ?"
  ).bind(requestId).first<Record<string, any>>();
  if (!order) {
    console.error("[AIRTIME] status callback for unknown requestId:", requestId, status);
    return c.json({ ok: false, error: "Unknown order" }, 404);
  }

  if (status.includes("success")) {
    const res = await c.env.DB.prepare(
      "UPDATE airtime_orders SET status = 'completed', delivered_at = datetime('now', '+2 hours'), error = NULL WHERE id = ? AND status IN ('sent','paid')"
    ).bind(order.id).run();
    if ((res.meta?.changes ?? 0) === 0) return c.json({ ok: true, ignored: true });
    const msg = airtimeDeliveredSms(order.phone, order.amount_cents);
    await pushToUser(c.env, order.user_id, "Airtime delivered", msg, { type: "airtime_delivered" })
      .catch((e) => console.error("airtime delivered push failed:", e));
    const user = await c.env.DB.prepare("SELECT phone FROM users WHERE id = ?")
      .bind(order.user_id).first<{ phone: string }>();
    if (user?.phone) await smsIfNoPush(c.env, order.user_id, user.phone, msg);
    console.log("[AIRTIME] delivered:", requestId);
  } else if (status.includes("fail")) {
    const res = await c.env.DB.prepare(
      "UPDATE airtime_orders SET status = 'failed', error = ?, completed_at = NULL WHERE id = ? AND status = 'sent'"
    ).bind(description || "Delivery failed", order.id).run();
    if ((res.meta?.changes ?? 0) === 0) return c.json({ ok: true, ignored: true });
    const msg = airtimeFailedSms(order.phone, order.amount_cents);
    await pushToUser(c.env, order.user_id, "Airtime delivery failed", msg, { type: "airtime_failed" })
      .catch((e) => console.error("airtime failed push failed:", e));
    const user = await c.env.DB.prepare("SELECT phone FROM users WHERE id = ?")
      .bind(order.user_id).first<{ phone: string }>();
    if (user?.phone) await smsIfNoPush(c.env, order.user_id, user.phone, msg);
    console.error("[AIRTIME] failed:", requestId, description);
  }

  return c.json({ ok: true });
});

/** Lipila webhook: payment for an airtime order succeeded -> mark paid + fulfill. */
async function confirmAirtimePayment(env: Bindings, referenceId: string): Promise<void> {
  const order = await env.DB.prepare("SELECT * FROM airtime_orders WHERE lipila_reference = ?")
    .bind(referenceId).first<Record<string, any>>();
  if (!order || order.status !== "pending") return;
  // Idempotency: only the call that flips pending -> paid proceeds, so a
  // webhook replay can't double-grant bonus credits or double-deliver airtime.
  const res = await env.DB.prepare("UPDATE airtime_orders SET status = 'paid' WHERE id = ? AND status = 'pending'").bind(order.id).run();
  if ((res.meta?.changes ?? 0) === 0) return;
  // Bonus reward: a percentage of the airtime amount back as credits (granted on payment).
  const bonusPct = Number(await getSetting(env, "airtime_bonus_pct")) || 5;
  const bonusCents = Math.round(order.amount_cents * (bonusPct / 100));
  if (bonusCents > 0) {
    await env.DB.prepare(
      "UPDATE users SET airtime_credits_cents = airtime_credits_cents + ? WHERE id = ?"
    ).bind(bonusCents, order.user_id).run();
  }
  await fulfillAirtimeOrder(env, order.id);
}

/** Lipila webhook: payment failed -> refund credits used, void the order. */
async function failAirtimePayment(env: Bindings, referenceId: string): Promise<void> {
  const order = await env.DB.prepare("SELECT * FROM airtime_orders WHERE lipila_reference = ?")
    .bind(referenceId).first<Record<string, any>>();
  if (!order || order.status !== "pending") return;
  if (order.credits_used_cents > 0) {
    await env.DB.prepare(
      "UPDATE users SET airtime_credits_cents = airtime_credits_cents + ? WHERE id = ?"
    ).bind(order.credits_used_cents, order.user_id).run();
  }
  await env.DB.prepare(
    "UPDATE airtime_orders SET status = 'failed', error = 'Payment not completed' WHERE id = ?"
  ).bind(order.id).run();
}

/** Scheduled: retry paid-but-unsent, stuck-sent, and failed-but-retryable airtime orders. */
async function runAirtimeFulfillment(env: Bindings): Promise<void> {
  const paid = await env.DB.prepare(
    "SELECT id FROM airtime_orders WHERE status = 'paid' AND (error IS NULL OR attempts < 3)"
  ).all<{ id: number }>();
  for (const row of paid.results) {
    await fulfillAirtimeOrder(env, row.id);
  }
  // Orders we sent but never got a status callback for (MNO silence) — resend
  // after 30 minutes; if it keeps failing we surface the failure.
  const stuckSent = await env.DB.prepare(
    "SELECT id FROM airtime_orders WHERE status = 'sent' AND sent_at < datetime('now', '-30 minutes') AND attempts < 2"
  ).all<{ id: number }>();
  for (const row of stuckSent.results) {
    await env.DB.prepare("UPDATE airtime_orders SET status = 'paid' WHERE id = ?").bind(row.id).run();
    await fulfillAirtimeOrder(env, row.id);
  }
  const failed = await env.DB.prepare(
    "SELECT id FROM airtime_orders WHERE status = 'failed' AND attempts < 3 AND created_at >= datetime('now', '-3 days')"
  ).all<{ id: number }>();
  for (const row of failed.results) {
    await env.DB.prepare("UPDATE airtime_orders SET status = 'paid' WHERE id = ?").bind(row.id).run();
    await fulfillAirtimeOrder(env, row.id);
  }
}

// Admin: update airtime config
app.put("/api/admin/airtime/config", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  if (body.enabled !== undefined) await setSetting(c.env, "airtime_enabled", body.enabled ? "true" : "false");
  if (body.markupPct) await setSetting(c.env, "airtime_markup_pct", String(body.markupPct));
  if (body.minAmountCents) await setSetting(c.env, "airtime_min_amount_cents", String(body.minAmountCents));
  if (body.maxAmountCents) await setSetting(c.env, "airtime_max_amount_cents", String(body.maxAmountCents));
  if (body.bonusPct !== undefined) await setSetting(c.env, "airtime_bonus_pct", String(Math.max(0, Math.min(50, Math.round(Number(body.bonusPct))))));
  return c.json({ ok: true });
});

// Admin: verify Africa's Talking airtime credentials by sending a real
// K1 top-up to a provided Zambian number. Also reports AT account status.
app.post("/api/admin/airtime/test", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  const phone = String(body.phone ?? "").trim();
  const digits = phone.replace(/\D/g, "");
  const validPhone =
    (digits.startsWith("260") && digits.length === 12) ||
    (digits.startsWith("0") && digits.length === 10);
  if (!validPhone) {
    return c.json({ error: "Enter a valid Zambian phone number (e.g. +260 977 123 456)." }, 400);
  }
  if (!c.env.AT_API_KEY || !c.env.AT_USERNAME) {
    return c.json({ error: "Africa's Talking credentials not configured on the worker." }, 500);
  }
  const e164 = digits.startsWith("260") ? `+${digits}` : `+260${digits.slice(1)}`;
  try {
    const res = await sendAirtime(c.env, e164, 1);
    await logLipilaEvent(c.env.DB, "airtime_test", `TEST-${Date.now()}`, e164, 100, JSON.stringify(res).slice(0, 500));
    return c.json({
      ok: true,
      message: "K1 airtime sent — check the recipient phone for delivery.",
      response: res,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logLipilaEvent(c.env.DB, "airtime_test", `TEST-${Date.now()}`, e164, 100, msg);
    return c.json({ error: `Airtime test failed: ${msg}` }, 502);
  }
});

// ===================================================================
// CAMPAIGN IMAGE EDIT (Admin - update logo/image on existing campaign)
// ===================================================================

app.put("/api/admin/campaigns/:id/image", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const campaignId = Number(c.req.param("id"));
  if (!campaignId) return c.json({ error: "Invalid campaign id" }, 400);

  const body = await c.req.json();
  const imageUrl = String(body.imageUrl ?? "").trim();
  const logoUrl = body.logoUrl !== undefined ? String(body.logoUrl ?? "").trim() || null : undefined;

  const campaign = await c.env.DB.prepare("SELECT id FROM campaigns WHERE id = ?").bind(campaignId).first();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  if (imageUrl) {
    await c.env.DB.prepare("UPDATE campaigns SET image_url = ? WHERE id = ?").bind(imageUrl, campaignId).run();
  }
  if (logoUrl !== undefined) {
    await c.env.DB.prepare("UPDATE campaigns SET logo_url = ? WHERE id = ?").bind(logoUrl, campaignId).run();
  }

  return c.json({ ok: true, message: "Campaign image updated" });
});

// ===================================================================
// REAL-TIME DISBURSEMENT - trigger via API (in addition to cron)
// ===================================================================

app.post("/api/admin/disburse-now", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const campaignId = Number(body.campaignId) || 0;

  if (campaignId) {
    const result = await createWithdrawal(c.env, campaignId);
    return c.json({ ok: true, campaignId, payoutCents: result });
  }

  await runAutoDisburse(c.env);
  return c.json({ ok: true, message: "Auto-disburse triggered for all campaigns" });
});

// ===================================================================
// MNO HEALTH STATUS - public endpoint + cron check
// ===================================================================

const ZM_MNO_IDS = ["airtel", "mtn", "zamtel"] as const;

async function refreshMnoHealth(env: Bindings): Promise<void> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  // Map prefixes to network IDs
  const PREFIX_MAP: Record<string, string> = {};
  for (const net of ZM_NETWORKS) {
    for (const pfx of net.prefixes) PREFIX_MAP[pfx] = net.id;
  }

  function detectNetwork(phone: string): string | null {
    const digits = phone.replace(/\D/g, "").replace(/^260/, "");
    const local = digits.startsWith("0") ? digits : `0${digits}`;
    return PREFIX_MAP[local.slice(0, 3)] ?? null;
  }

  for (const network of ZM_MNO_IDS) {
    // Count successes where phone matches this network
    const successRow = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM lipila_logs
       WHERE kind = 'disbursement' AND status = 'success' AND created_at > ?`
    ).bind(oneHourAgo).first<{ cnt: number }>();

    const failRow = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM lipila_logs
       WHERE kind = 'disbursement' AND status = 'failed' AND created_at > ?`
    ).bind(oneHourAgo).first<{ cnt: number }>();

    // Get all recent logs and filter by network in JS
    const allRecent = await env.DB.prepare(
      `SELECT phone, status FROM lipila_logs
       WHERE kind = 'disbursement' AND created_at > ?`
    ).bind(oneHourAgo).all<{ phone: string; status: string }>();

    let networkSuccess = 0;
    let networkFail = 0;
    let lastSuccessTime: string | null = null;
    let lastFailTime: string | null = null;

    for (const row of allRecent.results) {
      const net = detectNetwork(row.phone ?? "");
      if (net !== network) continue;
      if (row.status === "success") networkSuccess++;
      else if (row.status === "failed") networkFail++;
    }

    const total = networkSuccess + networkFail;
    const successRate = total > 0 ? networkSuccess / total : 1;

    let status = "operational";
    if (total === 0) status = "unknown";
    else if (successRate < 0.3) status = "down";
    else if (successRate < 0.7) status = "degraded";

    const lastSuccess = await env.DB.prepare(
      `SELECT created_at FROM lipila_logs
       WHERE kind = 'disbursement' AND status = 'success'
       ORDER BY created_at DESC LIMIT 1`
    ).first<{ created_at: string }>();

    const lastFail = await env.DB.prepare(
      `SELECT created_at FROM lipila_logs
       WHERE kind = 'disbursement' AND status = 'failed'
       ORDER BY created_at DESC LIMIT 1`
    ).first<{ created_at: string }>();

    await env.DB.prepare(
      `INSERT INTO mno_health (network, status, success_count, fail_count, success_rate, last_checked_at, last_success_at, last_failure_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(network) DO UPDATE SET
         status = excluded.status,
         success_count = excluded.success_count,
         fail_count = excluded.fail_count,
         success_rate = excluded.success_rate,
         last_checked_at = excluded.last_checked_at,
         last_success_at = excluded.last_success_at,
         last_failure_at = excluded.last_failure_at,
         updated_at = excluded.updated_at`
    ).bind(
      network, status, networkSuccess, networkFail, successRate,
      now.toISOString(), lastSuccess?.created_at ?? null, lastFail?.created_at ?? null
    ).run();
  }
}

app.get("/api/mno-status", async (c) => {
  let rows = await c.env.DB.prepare(
    "SELECT network, status, success_count, fail_count, success_rate, last_checked_at, last_success_at, last_failure_at FROM mno_health"
  ).all<Record<string, any>>();

  // If no data yet, run the health check now
  if (rows.results.length === 0) {
    await refreshMnoHealth(c.env);
    rows = await c.env.DB.prepare(
      "SELECT network, status, success_count, fail_count, success_rate, last_checked_at, last_success_at, last_failure_at FROM mno_health"
    ).all<Record<string, any>>();
  }

  return c.json({
    networks: rows.results,
    checkedAt: new Date().toISOString(),
  });
});

export default appObject;
