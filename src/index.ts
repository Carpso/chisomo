// Kingdom Sponsor API - neutral fundraising platform.
// Stack: Cloudflare Worker + D1 + Lipila (payments) + Africa's Talking (OTP SMS).
// Money is stored in ngwee (integer cents). 100 ngwee = K1.

import { Hono } from "hono";
import { cors } from "hono/cors";
import * as Sentry from "@sentry/cloudflare";
import { signToken, verifyToken, sha256Hex, type TokenPayload } from "./jwt";
import { createCollection, createCardCollection, checkCollectionStatus, checkDisbursementStatus, createDisbursement, getWalletBalance, logLipilaEvent, updateLipilaLogStatus, lipilaBase, type LipilaEnv } from "./lipila";
import { sendOtpSms, sendSms, clampSms } from "./sms";
import { sendAirtime, getAirtimeProvider, airtimeProviders, type AirtimeEnv } from "./airtime";
import { loadFeeConfig, donationFees, payoutAmountCents, disbursementFeeCents, platformDisbursementFeeCents, feeConfigPublic, formatKwacha, moneyRef } from "./fees";
import { generateUsername, ensureUser, donorTotalCents, donorVisibleCents, tierFor } from "./donors";
import { sendPushNotification, sendMulticastPush } from "./firebase";
import {
  donationConfirmedSms, donationReceivedSms, payoutSentSms, payoutFailedSms,
  airtimeSentSms, airtimeDeliveredSms, airtimeFailedSms,
} from "./messages";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createShortLink, resolveShortLink, shortBaseUrl, shortCodeFor } from "./shorten";
import { CAMPAIGN_CATEGORIES, isValidCategory, EVENT_CATEGORIES, isValidEventCategory } from "./categories";

const CAMPAIGN_TYPES = [
  "community", "ngo", "faith", "emergency", "medical", "sponsor", "event",
] as const;

/** Valid KYC document types a host can submit for vetting. */
const HOST_KYC_TYPES = ["nrc", "ngo_cert", "endorsement"] as const;

type Bindings = LipilaEnv & SmsEnv2 & AirtimeEnv & {
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
  if (digits.length < 4) return "••••";
  const last4 = digits.slice(-4);
  const tail = last4.length >= 4 ? ` ${last4.slice(0, 2)} ${last4.slice(2)}` : "";
  return `+260 •• •• ••${tail}`;
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

/** Stores an in-app notification so users keep a history of important events
 *  even when a push is missed or the OS blocks it. Used alongside pushes. */
async function recordNotification(
  env: Bindings,
  userId: number | null,
  type: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  if (userId == null) return;
  await env.DB.prepare(
    "INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, ?, ?, ?, ?)"
  ).bind(userId, type ?? null, title, body, data ? JSON.stringify(data) : null)
    .run().catch((e) => console.error("notification insert failed:", e));
  // Keep each user's history bounded (latest 200).
  await env.DB.prepare(
    `DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
       SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 200
     )`
  ).bind(userId, userId).run().catch(() => {});
}

/** Pushes AND records the in-app notification for a single user. */
async function pushAndRecord(env: Bindings, userId: number | null, type: string, title: string, body: string, data?: Record<string, string>): Promise<number> {
  await recordNotification(env, userId, type, title, body, data);
  return pushToUser(env, userId, title, body, data);
}

/** Delete device tokens FCM no longer accepts so the push path stays clean. */
async function pruneInvalidTokens(env: Bindings, tokens: string[]): Promise<void> {
  for (const token of tokens) {
    await env.DB.prepare("DELETE FROM device_tokens WHERE token = ?").bind(token).run().catch(() => {});
  }
}

/** Transaction + verification events: push + in-app notification (SMS is now
 *  reserved STRICTLY for OTP verification to keep costs at the absolute
 *  minimum). `phone`/`smsText` are kept in the signature so future opt-in
 *  SMS can be re-enabled without touching call sites. */
async function smsAndPush(env: Bindings, userId: number | null, _phone: string | null, _smsText: string, pushTitle: string, pushBody: string, data?: Record<string, string>): Promise<void> {
  if (userId != null) {
    await pushAndRecord(env, userId, data?.type ?? "transaction", pushTitle, pushBody, data);
  }
}

/** Non-transaction events (promotions, edits, support, milestones, �):
 *  push only � SMS is reserved for transactions + verification to keep
 *  volume and cost in check. */
async function pushOnly(env: Bindings, userId: number | null, pushTitle: string, pushBody: string, data?: Record<string, string>): Promise<void> {
  if (userId != null) {
    await pushAndRecord(env, userId, data?.type ?? "info", pushTitle, pushBody, data);
  }
}

/**
 * Push-only alert to the admin team (superadmins + assistants with the app
 * installed; in-app notifications, never SMS). Used for support tickets and
 * other admin alerts. Superadmins come from SUPERADMIN_PHONES; assistants are
 * every user in admin_assistants, so a team member always sees what hosts and
 * donors do.
 */
async function pushAdmins(env: Bindings, title: string, body: string, data?: Record<string, string>): Promise<void> {
  if (!envPushConfigured(env)) return;
  const phones = (env.SUPERADMIN_PHONES ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const userIds = new Set<number>();
  const tokens = new Set<string>();

  if (phones.length) {
    const placeholders = phones.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT DISTINCT dt.token, dt.user_id FROM device_tokens dt
       JOIN users u ON u.id = dt.user_id
       WHERE u.phone IN (${placeholders})`
    ).bind(...phones).all<{ token: string; user_id: number }>();
    for (const r of rows.results) {
      tokens.add(r.token);
      userIds.add(r.user_id);
    }
  }

  // Assistants: every user who has been granted admin-assistant access.
  const assistantRows = await env.DB.prepare(
    `SELECT DISTINCT dt.token, dt.user_id FROM device_tokens dt
     JOIN admin_assistants a ON a.user_id = dt.user_id`
  ).all<{ token: string; user_id: number }>();
  for (const r of assistantRows.results) {
    tokens.add(r.token);
    userIds.add(r.user_id);
  }

  if (!tokens.size) return;
  // Record an in-app notification for each admin/assistant too.
  for (const uid of userIds) {
    await recordNotification(env, uid, data?.type ?? "admin_alert", title, body, data);
  }
  const result = await sendMulticastPush(fbEnv(env), [...tokens], title, body, data)
    .catch((e) => { console.error("admin push failed:", e); return { success: 0, failure: tokens.size, failedTokens: [...tokens] }; });
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
      `SELECT DISTINCT dt.token, dt.user_id FROM device_tokens dt
       JOIN users u ON u.id = dt.user_id
       WHERE u.phone IN (${placeholders})`
    ).bind(...phones).all<{ token: string; user_id: number }>();
    const tokens = rows.results.map((r) => r.token);
    for (const uid of [...new Set(rows.results.map((r) => r.user_id))]) {
      await recordNotification(env, uid, "admin_alert", pushTitle, pushBody, { type: "admin_alert" });
    }
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
      const ua = r.user_agent ? ` · ${r.user_agent.slice(0, 80)}` : "";
      return `• ${r.created_at ?? "?"} — ${r.phone} — ${intruderReasonLabel(r.reason)} — IP ${r.ip ?? "?"}${ua}`;
    })
    .join("\n");
  return [
    `🚨 SECURITY ALERT — ${n} failed login attempt${n === 1 ? "" : "s"} on Kingdom Sponsor${when}`,
    ``,
    `Someone tried (and failed) to sign in with these numbers. If this was not you, your number may be under attack.`,
    ``,
    details,
    ``,
    `If this was not you, secure your number and contact support immediately. — Kingdom Sponsor`,
  ].join("\n");
}

/** Best-effort email to the configured admin (MailChannels API; requires the
 *  Domain Lockdown DNS record on the from-domain to actually deliver). */
async function sendAdminEmail(env: Bindings, subject: string, text: string, attachment?: { filename: string; content: string }): Promise<boolean> {
  const toRow = await env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'admin_email'"
  ).first<Record<string, any>>();
  const to = toRow?.value as string | undefined;
  if (!to) return false;
  try {
    const fromEmail = env.ALERT_FROM_EMAIL ?? to;
    const payload: Record<string, any> = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromEmail, name: "Kingdom Sponsor" },
      subject,
      content: [{ type: "text/plain", value: text }],
    };
    if (attachment) {
      payload.attachments = [{ filename: attachment.filename, content: attachment.content }];
    }
    const res = await fetch("https://send.mailchannels.net/api/v1/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error(`email failed (${res.status}):`, await res.text().catch(() => ""));
    return res.ok;
  } catch (e) {
    console.error("email failed:", e);
    return false;
  }
}

/** Weekly emailed report (Sundays 06:00): a PDF snapshot of key stats. */
async function runWeeklyReport(env: Bindings, force = false): Promise<boolean> {
  // Only run on Sunday (UTC day-of-week 0) unless forced by an admin.
  if (!force && new Date().getUTCDay() !== 0) return false;
  const admin = await env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'admin_email'"
  ).first<{ value: string }>();
  if (!admin?.value) return false;

  const total = (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS n FROM contributions WHERE status = 'confirmed'"
  ).first<{ s: number; n: number }>()) ?? { s: 0, n: 0 };
  const week = (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS n FROM contributions WHERE status = 'confirmed' AND confirmed_at >= datetime('now', '-7 days')"
  ).first<{ s: number; n: number }>()) ?? { s: 0, n: 0 };
  const users = (await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM users) AS u, (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-7 days')) AS nu, (SELECT COUNT(*) FROM campaigns WHERE status != 'deleted') AS c"
  ).first<{ u: number; nu: number; c: number }>()) ?? { u: 0, nu: 0, c: 0 };

  const doc = await PDFDocument.create();
  const page = doc.addPage([540, 720]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Kingdom Sponsor — Weekly Report", { x: 40, y: 680, size: 18, font });
  const lines = [
    `Total raised (all time): ${formatKwacha(total.s)} (${total.n} gifts)`,
    `Raised this week: ${formatKwacha(week.s)} (${week.n} gifts)`,
    `Registered users: ${users.u} (+${users.nu} this week)`,
    `Campaigns: ${users.c}`,
    `Generated ${new Date().toISOString().slice(0, 10)}`,
  ];
  lines.forEach((l, i) => page.drawText(l, { x: 40, y: 640 - i * 24, size: 12, font: body }));

  const pdfBytes = await doc.save();
  const b64 = bytesToBase64(new Uint8Array(pdfBytes));
  await sendAdminEmail(env, "Kingdom Sponsor — Weekly Report", lines.join("\n"), {
    filename: "kingdom_sponsor_weekly_report.pdf",
    content: b64,
  });
  return true;
}

/** Admin: email the weekly report immediately (regardless of the day). */
app.post("/api/admin/report/send", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const sent = await runWeeklyReport(c.env, true);
  if (!sent) return c.json({ error: "No alert email configured (Settings → Security alerts)." }, 400);
  return c.json({ ok: true, message: "Weekly report emailed." });
});

/** List of Telegram bots configured for team alerts (token + chat + label). */
async function telegramBots(env: Bindings): Promise<{ token: string; chatId: string; label?: string }[]> {
  const row = await env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'telegram_bots'"
  ).first<Record<string, any>>();
  if (!row?.value) {
    // Legacy single-bot config (migrated in-place so existing setups keep working).
    const tokenRow = await env.DB.prepare(
      "SELECT value FROM admin_settings WHERE key = 'telegram_bot_token'"
    ).first<Record<string, any>>();
    const chatIdRow = await env.DB.prepare(
      "SELECT value FROM admin_settings WHERE key = 'telegram_chat_id'"
    ).first<Record<string, any>>();
    if (tokenRow?.value && chatIdRow?.value) {
      return [{ token: String(tokenRow.value), chatId: String(chatIdRow.value), label: "Primary" }];
    }
    return [];
  }
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveTelegramBots(env: Bindings, bots: { token: string; chatId: string; label?: string }[]): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO admin_settings (key, value) VALUES ('telegram_bots', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(JSON.stringify(bots)).run();
}

/** Sends the drafted warning through every configured channel. */
async function notifyIntruderAlert(
  env: Bindings,
  rows: FailedLoginRow[],
): Promise<{ telegramSent: boolean; smsSent: boolean; emailSent: boolean }> {
  const text = buildIntruderAlertText(rows);
  let telegramSent = false;

  // Send to EVERY configured team bot so the whole team sees the alert.
  const bots = await telegramBots(env);
  for (const bot of bots) {
    if (!bot.token || !bot.chatId) continue;
    try {
      const res = await fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: bot.chatId, text }),
      });
      if (res.ok) telegramSent = true;
      else console.error(`intruder-alert telegram failed (${res.status}):`, await res.text().catch(() => ""));
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

/** Referral reward threshold (admin_settings, default 10 signups). */
async function referralRewardThreshold(env: Bindings): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM admin_settings WHERE key = 'referral_reward_threshold'")
    .first<{ value: string }>();
  const n = Math.round(Number(row?.value ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 10;
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
  //
  // Ticket oversell guard: the confirm UPDATE also enforces event capacity
  // atomically. Two buyers who both passed the order-time "tickets left" check
  // in the same moment cannot both confirm the last seat — SQLite serializes
  // these writes, so the second UPDATE matches 0 rows and the sale is refused.
  const confirmRes = await env.DB.prepare(
    `UPDATE contributions SET status = 'confirmed', confirmed_at = datetime('now', '+2 hours')
     WHERE id = ? AND status = 'pending'
       AND (
         (SELECT COALESCE(event_capacity, 0) FROM campaigns WHERE id = ?) = 0
         OR (SELECT COALESCE(event_capacity, 0) FROM campaigns WHERE id = ?)
            >= (SELECT COALESCE(SUM(ticket_qty), 0) FROM contributions
                WHERE campaign_id = ? AND status = 'confirmed') + COALESCE(?, 1)
       )`
  ).bind(row.id, row.campaign_id, row.campaign_id, row.campaign_id, row.ticket_qty ?? 1).run();
  if ((confirmRes.meta?.changes ?? 0) === 0) {
    // Either already confirmed (replay) or the event just sold out. If the
    // payment genuinely went through but capacity is full, fail the row so it
    // never lingers as pending and the admin can refund the paid donor.
    const stillPending = (await env.DB.prepare(
      "SELECT status FROM contributions WHERE id = ?"
    ).bind(row.id).first<{ status: string }>())?.status;
    if (stillPending === "pending") {
      await env.DB.prepare(
        "UPDATE contributions SET status = 'failed', error = 'Event capacity reached at confirmation' WHERE id = ?"
      ).bind(row.id).run();
      await updateLipilaLogStatus(env.DB, referenceId, "failed");
      const capCampaign = await env.DB.prepare(
        "SELECT c.title, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
      ).bind(row.campaign_id).first<Record<string, any>>();
      if (capCampaign?.host_user_id) {
        await pushOnly(env, capCampaign.host_user_id, "Ticket oversold",
          `A ticket payment for "${capCampaign.title}" arrived after the event sold out. Refund the donor if the money was taken.`,
          { type: "ticket_oversold", campaignId: String(row.campaign_id) }).catch(() => {});
      }
    }
    return;
  }

  // Keep the admin Lipila logs truthful: this collection actually succeeded.
  await updateLipilaLogStatus(env.DB, referenceId, "success");

  const raisedBefore = (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
  ).bind(row.campaign_id).first<{ s: number }>())?.s ?? 0;

  const campaign = await env.DB.prepare(
    "SELECT c.*, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(row.campaign_id).first<Record<string, any>>();
  const available = await availableBalance(env, row.campaign_id);
  const isTicket = !!row.tier_name;
  const noun = isTicket ? "event" : "campaign";
  const title = campaign?.title ?? (isTicket ? "Your event" : "Your campaign");
  if (campaign?.host_phone) {
    await smsAndPush(env, campaign.host_user_id, campaign.host_phone,
      donationReceivedSms(campaign.title, row.amount_cents, available),
      isTicket ? "New ticket sold" : "New gift received",
      isTicket
        ? `Someone bought ${row.ticket_qty ?? 1} ${(row.ticket_qty ?? 1) === 1 ? "ticket" : "tickets"} (${row.tier_name}) for "${campaign.title}".`
        : `Someone gave ${(row.amount_cents / 100).toLocaleString()} ZMW to "${campaign.title}".`,
      { type: "donation_received", campaignId: String(campaign.id) });
  }
  if (row.phone) {
    await smsAndPush(env, row.donor_user_id, row.phone,
      donationConfirmedSms(campaign?.title ?? "campaign", row.amount_cents, referenceId),
      isTicket ? "Ticket confirmed" : "Gift confirmed",
      isTicket
        ? `Your ${row.ticket_qty ?? 1} ${(row.ticket_qty ?? 1) === 1 ? "ticket" : "tickets"} for "${title}" ${(row.ticket_qty ?? 1) === 1 ? "is" : "are"} confirmed. See you at the event!`
        : `Thank you! Your gift of ${(row.amount_cents / 100).toLocaleString()} ZMW to "${title}" is confirmed.`,
      { type: isTicket ? "ticket_confirmed" : "donation_confirmed", campaignId: String(campaign?.id ?? ""), contributionId: String(row.id) });

    // Donor joined notification: if this is the donor's first confirmed contribution.
    if (row.donor_user_id) {
      const firstCount = Number(
        (await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM contributions WHERE donor_user_id = ? AND status = 'confirmed'"
        ).bind(row.donor_user_id).first<{ c: number }>())?.c ?? 0
      ) === 1;
      if (firstCount) {
        await pushToUser(env, campaign?.host_user_id, "New donor joined",
          `${title} just received its first ${isTicket ? "ticket" : "gift"} from a new supporter.`,
          { type: "new_donor", campaignId: String(campaign?.id ?? "") })
          .catch((e) => console.error("new donor push failed:", e));
      }
    }
  }

  // Alert the admin team about every confirmed donation or ticket sale.
  await pushAdmins(env,
    isTicket ? "Ticket sold" : "New donation",
    isTicket
      ? `${(row.amount_cents / 100).toLocaleString()} ZMW from ${row.ticket_qty ?? 1} ${(row.ticket_qty ?? 1) === 1 ? "ticket" : "tickets"} (${row.tier_name}) for "${title}".`
      : `${(row.amount_cents / 100).toLocaleString()} ZMW given to "${title}".`,
    { type: "donation", campaignId: String(campaign?.id ?? "") }).catch(() => {});

  // Milestone notifications: alert a campaign's donors when it crosses 25/50/75/100% of its goal.
  await maybeNotifyMilestones(env, campaign, raisedBefore, row.amount_cents);

  await maybeAutoDisburse(env, row.campaign_id);
}

const MILESTONES = [25, 50, 75, 100];

/** Milestone thresholds (whole percentages) — editable by admins via app_settings. */
async function milestoneThresholds(env: Bindings): Promise<number[]> {
  const raw = await getSetting(env, "milestone_thresholds");
  if (!raw) return MILESTONES;
  const parsed = raw.split(",").map((s) => Number(s.trim())).filter((n) => n > 0 && n <= 100);
  return parsed.length ? [...new Set(parsed)].sort((a, b) => a - b) : MILESTONES;
}

/** Push + SMS the campaign's donors when a goal milestone is crossed. */
async function maybeNotifyMilestones(env: Bindings, campaign: Record<string, any> | null, raisedBefore: number, addedCents: number): Promise<void> {
  if (!campaign || !campaign.goal_cents || campaign.goal_cents <= 0) return;
  const after = raisedBefore + addedCents;
  const beforePct = (raisedBefore / campaign.goal_cents) * 100;
  const afterPct = (after / campaign.goal_cents) * 100;
  const thresholds = await milestoneThresholds(env);

  const crossed = thresholds.filter((m) => beforePct < m && afterPct >= m);
  if (!crossed.length) return;

  const pct = Math.round(crossed[crossed.length - 1]);
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

  // Milestones push the host (SMS alert optional, toggle off by default).
  await pushToUser(env, campaign.host_user_id, title, body, { type: "milestone", campaignId: String(campaign.id) })
    .catch(() => {});
  await sendAlertSms(env, "sms_alert_milestone", campaign.host_phone ?? null,
    `${title}. ${body}`);
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
 * collection fees (lipilaFeeCents) are NOT subtracted here — they are
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

/**
 * Collection-side overrides for an event ticket sale. Collection stays the
 * default platform fee (1% / K3 min + K0.48); the K10 finder's commission is
 * deducted on DISBURSEMENT (payout). `waivePlatform` zeroes the collection cut
 * when the admin enabled "waive event fees" on the event.
 */
async function eventFeeOverrides(env: Bindings, campaign: Record<string, any>) {
  return { waivePlatform: !!campaign.waive_event_fees };
}

/**
 * Fee config with admin-dashboard overrides merged in (falls back to the
 * wrangler-var defaults when an admin setting hasn't been written). Lets admins
 * adjust platform %, minimums and fixed fees without redeploying.
 */
async function adminFeeConfig(env: Bindings) {
  const base = loadFeeConfig(env);
  const num = (v: string | null, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    ...base,
    platformPct: num(await getSetting(env, "platform_fee_pct"), base.platformPct),
    platformMinFeeCents: Math.round(num(await getSetting(env, "platform_min_fee_cents"), base.platformMinFeeCents)),
    platformFixedFeeCents: Math.round(num(await getSetting(env, "platform_fixed_fee_cents"), 48)),
    cardPlatformPct: num(await getSetting(env, "card_platform_fee_pct"), base.cardPlatformPct),
    cardPlatformMinFeeCents: Math.round(num(await getSetting(env, "card_platform_min_fee_cents"), base.cardPlatformMinFeeCents)),
    cardLipilaCollectionPct: num(await getSetting(env, "card_lipila_collection_fee_pct"), base.cardLipilaCollectionPct),
  };
}

/**
 * Disbursement fees for an event payout: the NORMAL platform cut
 * (max(K3, 1%) + K0.48) PLUS the admin-configured K10 finder's commission,
 * all on top of Lipila's 1.5%. Non-events pay only the normal cut.
 * Returns 0 when the event's payout fees are waived (waive_payout_fees).
 */
async function eventDisbursementFeeCents(env: Bindings, campaign: Record<string, any>, availableCents: number): Promise<number> {
  if (campaign.waive_payout_fees) return 0;
  const normal = platformDisbursementFeeCents(availableCents, await adminFeeConfig(env));
  const isEvent = !!campaign.event_tiers && String(campaign.event_tiers).length > 2;
  if (!isEvent) return normal;
  const finderFee = Number(await getSetting(env, "event_commission_finder_fee_cents")) || 1000; // K10
  return Math.min(normal + finderFee, availableCents);
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

  // Fees can be waived per campaign (admin toggle). When waived, no platform
  // payout cut and no Lipila disbursement fee are deducted from the host's
  // payout — the full available balance is sent.
  const waiveFees = !!campaign.waive_payout_fees;
  const lipilaFee = waiveFees ? 0 : disbursementFeeCents(available, cfg);
  // Event ticket campaigns carry a flat K10 finder's commission deducted from
  // the host's payout, ON TOP of Lipila's 1.5%. Non-events use the default
  // max(K3, 1%) + K0.48 payout cut.
  const platformFee = waiveFees ? 0 : (await eventDisbursementFeeCents(env, campaign, available));
  const payoutCents = waiveFees ? available : available - lipilaFee - platformFee;
  if (payoutCents <= 0) return 0;

  const referenceId = moneyRef("PAY", campaignId);
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
    // Alert the admin team that money is moving out (payout initiated).
    await pushAdmins(env, "Payout started",
      `${(payoutCents / 100).toLocaleString()} ZMW being sent to the host of "${campaign.title}".`,
      { type: "payout_started", campaignId: String(campaign.id) }).catch(() => {});
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
      await smsAndPush(env, campaign.host_user_id, campaign.host_phone,
        payoutFailedSms(campaign.title, payoutCents),
        "Payout delayed",
        `We'll retry your payout of ${(payoutCents / 100).toLocaleString()} ZMW for "${campaign.title}" automatically.`,
        { type: "payout_failed", campaignId: String(campaign.id) });
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

// ---------------------------------------------------------------------------
// Non-transactional SMS alerts (all OFF by default; superadmin/assistants turn
// them on per category from Admin → Tools & settings → SMS alerts). SMS is
// otherwise reserved for OTP + transaction confirmations to keep costs minimal.
// ---------------------------------------------------------------------------

/** Every toggleable non-transactional SMS alert category. */
const SMS_ALERT_KEYS = [
  "sms_alert_milestone",        // campaign milestone celebration
  "sms_alert_promotion",        // promotion active/approved
  "sms_alert_sponsor_desk",     // new Sponsor Desk opportunities
  "sms_alert_event_reminder",   // 48h / 2h event countdown
  "sms_alert_announcement",     // host update published
  "sms_alert_campaign_ending",  // campaign ends soon
] as const;

/** True only when the master SMS-alerts switch AND this category are on. */
async function smsAlertEnabled(env: Bindings, key: string): Promise<boolean> {
  if ((await getSetting(env, "sms_alerts_master")) !== "true") return false;
  return (await getSetting(env, key)) === "true";
}

/** Sends a non-transactional alert SMS only if its toggle + master are ON and
 *  we're in production (never billed in sandbox). Fire-and-forget: a failure
 *  here must never break the caller. Text is clamped to one SMS unit. */
async function sendAlertSms(env: Bindings, key: string, phone: string | null, text: string): Promise<void> {
  if (!phone) return;
  if (env.ENV !== "production") return;
  if (!(await smsAlertEnabled(env, key))) return;
  await sendSms(env, phone, `KSPONSOR: ${text}`)
    .catch((e) => console.error(`[alert-sms ${key}] failed:`, e));
}

/** Full SMS-alerts config (master + every category). */
async function smsAlertConfig(env: Bindings): Promise<Record<string, boolean>> {
  const master = (await getSetting(env, "sms_alerts_master")) === "true";
  const out: Record<string, boolean> = { master };
  for (const key of SMS_ALERT_KEYS) out[key] = (await getSetting(env, key)) === "true";
  return out;
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

/** Number of promoted top-5 slots (admin-configurable, default 5). */
async function promoSlots(env: Bindings): Promise<number> {
  const v = await getSetting(env, "promo_slots");
  if (v) { const n = parseInt(v, 10); if (n >= 1 && n <= 20) return n; }
  return 5;
}

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
    "SELECT c.title, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(promo.campaign_id).first<Record<string, any>>();
  if (campaign?.host_user_id) {
    await pushOnly(env, campaign.host_user_id, "Promotion payment received",
      `Your payment of K${(promo.amount_cents / 100).toLocaleString()} for "${campaign.title}" is pending admin approval.`)
      .catch((e) => console.error("promo payment push failed:", e));
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
  if (campaign?.host_user_id) {
    await pushOnly(env, campaign.host_user_id, "Your campaign is promoted",
      `"${campaign.title}" is now at the top of Kingdom Sponsor for ${days} days.`,
      { type: "promotion_active", campaignId: String(campaign.id) });
    await sendAlertSms(env, "sms_alert_promotion", campaign.host_phone ?? null,
      `Your campaign "${campaign.title}" is promoted at the top for ${days} days.`);
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
  if (campaign?.host_user_id) {
    await pushOnly(env, campaign.host_user_id, "Promotion not approved",
      `Your promotion for "${campaign.title}" was declined. Contact support about a refund.`,
      { type: "promotion_rejected", campaignId: String(campaign.id) });
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

  const referenceId = moneyRef("REF", promo.id);
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
  await updateLipilaLogStatus(env.DB, referenceId, "success");

  const promo = await env.DB.prepare("SELECT * FROM promotions WHERE id = ?")
    .bind(refund.promo_id).first<Record<string, any>>();
  if (!promo) return;
  await env.DB.prepare("UPDATE promotions SET status = 'refunded' WHERE id = ?").bind(promo.id).run();

  const campaign = await env.DB.prepare(
    "SELECT c.title, c.id, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(promo.campaign_id).first<Record<string, any>>();
  if (!campaign?.host_user_id) return;
  await pushOnly(env, campaign.host_user_id, "Promotion refunded",
    `Your promotion payment of ${formatKwacha(refund.amount_cents)} for "${campaign.title}" has been refunded to your mobile money.`,
    { type: "promotion_refunded", campaignId: String(campaign.id) });
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
    await pushOnly(env, row.host_user_id, "Your promotion has ended",
      `"${row.title}" is no longer promoted. You can promote it again anytime in the app.`,
      { type: "promotion_expired", campaignId: String(row.id) });
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
    if (row.user_id) {
      await pushOnly(env, row.user_id, "Support request closed",
        `Your request "${row.subject}" was closed after 7 days without a reply. Open it again if you still need help.`,
        { type: "ticket_closed", ticketId: String(row.id) });
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

/** Hourly cron: push 48h and 2h countdown reminders to an event's ticket
 *  holders (and the host) so they never miss it. Each bucket fires once per
 *  event (tracked by event_remind_48h / event_remind_2h flags). */
async function runEventReminders(env: Bindings): Promise<void> {
  if (!envPushConfigured(env)) return;
  const zambia = (offsetMs: number) => Date.now() + 2 * 3600000 + offsetMs; // CAT (UTC+2)
  const now = Date.now() + 2 * 3600000; // current CAT time
  const in48h = zambia(48 * 3600000);
  const in2h = zambia(2 * 3600000);

  const events = await env.DB.prepare(
    `SELECT c.id, c.title, c.event_date, c.event_time, c.event_capacity,
            c.event_remind_48h, c.event_remind_2h,
            c.host_user_id, u.phone AS host_phone
     FROM campaigns c JOIN users u ON u.id = c.host_user_id
     WHERE c.status = 'active'
       AND (c.campaign_type = 'event' OR (c.event_tiers IS NOT NULL AND c.event_tiers != ''))
       AND c.event_date IS NOT NULL`
  ).all<Record<string, any>>();

  for (const ev of events.results) {
    // Event start = event_date + event_time (default 18:00), CAT.
    const time = (ev.event_time ?? "18:00").split(":").map(Number);
    const start = new Date(Date.parse(`${ev.event_date}T${String(time[0] ?? 18).padStart(2, "0")}:${String(time[1] ?? 0).padStart(2, "0")}:00+02:00`));
    if (isNaN(start.getTime())) continue;

    const at48 = start.getTime() - 48 * 3600000;
    const at2 = start.getTime() - 2 * 3600000;
    const inWindow = (target: number) => now >= target - 60 * 60000 && now <= target + 60 * 60000;

    // Decide which buckets to fire this pass.
    const fire48 = !ev.event_remind_48h && at48 > Date.now() && inWindow(at48);
    const fire2 = !ev.event_remind_2h && at2 > Date.now() && inWindow(at2);

    if (!fire48 && !fire2) continue;

    const startLabel = `${ev.event_date} ${(ev.event_time ?? "18:00")}`;
    const flags: string[] = [];
    if (fire48) flags.push("event_remind_48h = 1");
    if (fire2) flags.push("event_remind_2h = 1");

    // Ticket holders (confirmed contributions with a tier).
    const buyers = await env.DB.prepare(
      `SELECT DISTINCT dt.token, dt.user_id FROM device_tokens dt
       JOIN contributions co ON co.donor_user_id = dt.user_id
       WHERE co.campaign_id = ? AND co.status = 'confirmed' AND co.tier_name IS NOT NULL`
    ).bind(ev.id).all<{ token: string; user_id: number }>();
    const tokens = buyers.results.map((b) => b.token);

    if (fire48 && tokens.length) {
      await sendMulticastPush(fbEnv(env), tokens,
        `⏰ "${ev.title}" starts in 2 days`,
        `Don't forget — the event kicks off on ${startLabel}. See you there!`,
        { type: "event_reminder", campaignId: String(ev.id), when: "48h" })
        .catch((e) => console.error("event 48h reminder failed:", e));
      for (const uid of [...new Set(buyers.results.map((b) => b.user_id))]) {
        await recordNotification(env, uid, "event_reminder",
          `"${ev.title}" starts in 2 days`,
          `The event kicks off on ${startLabel}. See you there!`,
          { type: "event_reminder", campaignId: String(ev.id) }).catch(() => {});
      }
    }
    if (fire2 && tokens.length) {
      await sendMulticastPush(fbEnv(env), tokens,
        `🎟️ "${ev.title}" starts in 2 hours`,
        `Almost showtime! The event starts at ${startLabel}. Bring your ticket.`,
        { type: "event_reminder", campaignId: String(ev.id), when: "2h" })
        .catch((e) => console.error("event 2h reminder failed:", e));
      for (const uid of [...new Set(buyers.results.map((b) => b.user_id))]) {
        await recordNotification(env, uid, "event_reminder",
          `"${ev.title}" starts in 2 hours`,
          `Almost showtime! The event starts at ${startLabel}.`,
          { type: "event_reminder", campaignId: String(ev.id) }).catch(() => {});
      }
    }

    // Remind the host too.
    if (ev.host_phone && (fire48 || fire2)) {
      const hostTokens = await env.DB.prepare(
        "SELECT token FROM device_tokens WHERE user_id = ?"
      ).bind(ev.host_user_id).all<{ token: string }>();
      if (hostTokens.results.length) {
        await sendMulticastPush(fbEnv(env), hostTokens.results.map((t) => t.token),
          fire2 ? "🎟️ Your event starts in 2 hours" : "⏰ Your event is in 2 days",
          `"${ev.title}" is on ${startLabel}. Check attendance and be ready!`,
          { type: "event_reminder", campaignId: String(ev.id), when: fire2 ? "2h" : "48h" })
          .catch((e) => console.error("event host reminder failed:", e));
      }
      // Optional host SMS alert (toggle off by default).
      await sendAlertSms(env, "sms_alert_event_reminder", ev.host_phone,
        `${fire2 ? "Your event starts in 2 hours" : "Your event is in 2 days"}: "${ev.title}" on ${startLabel}.`);
    }

    await env.DB.prepare(
      `UPDATE campaigns SET ${flags.join(", ")} WHERE id = ?`
    ).bind(ev.id).run();
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
    // True recurring giving: auto-charge the pledge with a Lipila mobile-money
    // prompt (same flow as a donation). The phone gets a payment prompt and a
    // donation is recorded once paid via the webhook (pending contribution).
    // A failed payment just sends the reminder so the donor can pay in-app.
    try {
      const campaign = await env.DB.prepare(
        "SELECT * FROM campaigns WHERE id = ?"
      ).bind(row.campaign_id).first<Record<string, any>>();
      const cfg = await adminFeeConfig(env);
      const fees = donationFees(Number(row.amount_cents), cfg, "momo");
      const referenceId = moneyRef("PLG", Number(row.campaign_id));
      await createCollection(env, {
        referenceId,
        amountCents: Number(row.amount_cents) + fees.platformFeeCents + fees.lipilaFeeCents,
        accountNumber: String(row.phone).replace("+", ""),
        narration: `Kingdom Sponsor monthly pledge for ${row.campaign_title ?? "campaign"}`,
        callbackUrl: `${env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(env.LIPILA_WEBHOOK_SECRET)}`,
      }, env.DB);
      // Record a pending contribution so the webhook can confirm it.
      await env.DB.prepare(
        `INSERT INTO contributions (campaign_id, donor_user_id, is_anonymous, phone, amount_cents, platform_fee_cents, lipila_fee_cents, lipila_reference, status)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'pending')`
      ).bind(
        row.campaign_id,
        row.user_id,
        String(row.phone),
        Number(row.amount_cents),
        fees.platformFeeCents,
        fees.lipilaFeeCents,
        referenceId,
      ).run();
      await env.DB.prepare(
        "UPDATE recurring_pledges SET last_charged_at = datetime('now', '+2 hours'), last_lipila_reference = ? WHERE id = ?"
      ).bind(referenceId, row.id).run();
      await pushToUser(env, row.user_id, "Monthly pledge charged",
        `Your pledge of ${(row.amount_cents / 100).toLocaleString()} ZMW to "${row.campaign_title}" is on its way. Check your phone to approve the payment.`,
        { type: "pledge_reminder", campaignId: String(row.campaign_id) })
        .catch((e) => console.error("push failed:", e));
    } catch (e) {
      console.error("pledge auto-charge failed:", e);
      // Payment could not start — send the reminder so the donor can pay in-app.
      await pushToUser(env, row.user_id, "Monthly pledge due",
        `Your pledge of ${(row.amount_cents / 100).toLocaleString()} ZMW to "${row.campaign_title}" is due. Pay it in the app.`,
        { type: "pledge_reminder", campaignId: String(row.campaign_id) })
        .catch((e2) => console.error("push failed:", e2));
    }

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
  await updateLipilaLogStatus(env.DB, referenceId, "success");
  if ((row.platform_fee_cents ?? 0) > 0) {
    await settlePlatformFees(env, referenceId, row.platform_fee_cents);
  }
  const campaign = await env.DB.prepare(
    "SELECT c.*, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(row.campaign_id).first<Record<string, any>>();
   if (campaign?.host_phone) {
    await smsAndPush(env, campaign.host_user_id, campaign.host_phone,
      payoutSentSms(campaign.title, row.amount_cents),
      "Payout sent",
      `Your payout of ${(row.amount_cents / 100).toLocaleString()} ZMW for "${campaign.title}" is on its way to your mobile money.`,
      { type: "payout_sent", campaignId: String(campaign.id) });
    await pushAdmins(env, "Payout sent",
      `${(row.amount_cents / 100).toLocaleString()} ZMW delivered to the host of "${campaign.title}".`,
      { type: "payout_sent", campaignId: String(campaign.id) }).catch(() => {});
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
      // Check itself failed (network/API) — leave pending for retry, but record the last error.
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
  await updateLipilaLogStatus(env.DB, referenceId, "failed");
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
      // Check failed (network/API) — leave pending for the next run.
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
    // Alert superadmins the moment a brand-new account is created so nobody
    // registers unnoticed (push to admins with the app installed).
    await pushAdmins(c.env, "New user registered",
      `${user?.username ?? "Someone"} just joined Kingdom Sponsor (${phone}).`,
      { type: "new_user", userId: String(user?.id ?? ""), phone }).catch(() => {});
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

  // Capture every successful login/signup so the admin can see who is active.
  await c.env.DB.prepare("UPDATE users SET last_login_at = datetime('now', '+2 hours') WHERE id = ?")
    .bind(user.id).run();

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
      assistantScopes: [...(await assistantScopes(c.env, user.id))],
      hostStatus: user.host_status ?? "none",
      isBanned: !!user.banned,
      banReason: user.ban_reason ?? null,
      referralCode: user.referral_code ?? await ensureReferralCode(c.env, user.id),
    },
  });
});

// ---------- Admin: SMS network status text ----------

app.get("/api/admin/sms-status", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const row = await c.env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'sms_status'"
  ).first<Record<string, any>>();
  return c.json({ text: row?.value ?? '' });
});

app.put("/api/admin/sms-status", async (c) => {
  const admin = await requireStaff(c, "settings");
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

// ---------- Admin: SMS broadcasts + SMS delivery activity ----------

/** Public network-health + announcement notice shown on the sign-in screen.
 *  Lets admins tell users about outages (e.g. MTN SMS down) without burning
 *  SMS credits trying to message them. */
app.get("/api/sms/notice", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'sms_status'"
  ).first<Record<string, any>>();
  const statuses: Record<string, string> = {};
  for (const net of ZM_NETWORKS) {
    statuses[net.id] = await networkStatus(c.env, net.id);
  }
  return c.json({ text: row?.value ?? '', networks: statuses });
});

/** Admin: send an SMS to any number (in-app or out-of-app). Supports a single
 *  phone or a comma-separated list. The message is clamped to one SMS unit
 *  and always sent from the approved KSPONSOR sender. Delivery is logged so
 *  the AT callback (sms_events) can confirm it. */
app.post("/api/admin/sms/send", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const rawPhones = String(body.phone ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const message = clampSms(String(body.message ?? "").trim());
  if (!rawPhones.length) return c.json({ error: "Enter at least one phone number" }, 400);
  if (!message) return c.json({ error: "Enter a message" }, 400);
  if (rawPhones.length > 50) return c.json({ error: "Max 50 numbers per send" }, 400);

  const sent: { phone: string; ok: boolean; error?: string }[] = [];
  for (const raw of rawPhones) {
    const phone = normalizePhone(raw);
    try {
      await sendSms(c.env, phone, message);
      await c.env.DB.prepare(
        "INSERT INTO sms_events (kind, ref_id, status, phone, payload) VALUES ('admin_broadcast', ?, 'Sent', ?, ?)"
      ).bind(`ADM-${admin.sub}-${Date.now()}`, phone, JSON.stringify({ message })).run().catch(() => {});
      sent.push({ phone, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sent.push({ phone, ok: false, error: msg });
      await c.env.DB.prepare(
        "INSERT INTO sms_events (kind, ref_id, status, phone, payload) VALUES ('admin_broadcast', ?, 'Failed', ?, ?)"
      ).bind(`ADM-${admin.sub}-${Date.now()}`, phone, JSON.stringify({ message, error: msg })).run().catch(() => {});
    }
  }
  const okCount = sent.filter((s) => s.ok).length;
  return c.json({
    ok: okCount > 0,
    sentCount: okCount,
    failedCount: sent.length - okCount,
    results: sent,
    message: `${okCount} sent, ${sent.length - okCount} failed.`,
  });
});

/** Admin: recent SMS delivery activity (from AT callbacks + broadcasts) so
 *  delivery failures (e.g. MTN) are visible and diagnosable. */
app.get("/api/admin/sms/activity", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const rows = await c.env.DB.prepare(
    "SELECT id, kind, ref_id, status, phone, payload, received_at FROM sms_events ORDER BY id DESC LIMIT 100"
  ).all<Record<string, any>>();
  return c.json({
    events: rows.results.map((r) => ({
      id: r.id,
      kind: r.kind,
      refId: r.ref_id,
      status: r.status,
      phone: r.phone,
      payload: r.payload,
      receivedAt: r.received_at,
    })),
  });
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
  const admin = await requireStaff(c, "settings");
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
  const admin = await requireStaff(c, "donations");
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
  const admin = await requireStaff(c, "donations");
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
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const row = await c.env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'intruder_alert_telegram'"
  ).first<Record<string, any>>();
  return c.json({ enabled: row?.value === '1' });
});

app.put("/api/admin/intruder-alert", async (c) => {
  const admin = await requireStaff(c, "settings");
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
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const rows = await c.env.DB.prepare(
    "SELECT id, phone, ip, user_agent, reason, created_at FROM failed_logins ORDER BY id DESC LIMIT 100"
  ).all<Record<string, any>>();

  return c.json({ failedLogins: rows.results });
});

// Admin: configure Telegram bots for team intruder alerts (multiple bots).
app.get("/api/admin/telegram-config", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const bots = await telegramBots(c.env);
  return c.json({
    bots,
    configured: bots.length > 0,
  });
});

app.put("/api/admin/telegram-config", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  // Accept either the new `bots` array or the legacy single token/chatId pair.
  if (Array.isArray(body.bots)) {
    const cleaned = body.bots
      .map((b: any) => ({
        token: String(b?.token ?? "").trim(),
        chatId: String(b?.chatId ?? "").trim(),
        label: String(b?.label ?? "").trim() || undefined,
      }))
      .filter((b: { token: string; chatId: string }) => b.token && b.chatId);
    await saveTelegramBots(c.env, cleaned);
    return c.json({ ok: true, bots: cleaned });
  }

  const token = body.token != null ? String(body.token) : null;
  const chatId = body.chatId != null ? String(body.chatId) : null;
  const bots = await telegramBots(c.env);
  const current = bots[0] ?? { token: "", chatId: "" };
  const next = [{
    token: token ?? current.token,
    chatId: chatId ?? current.chatId,
    label: current.label,
  }].filter((b) => b.token && b.chatId);
  await saveTelegramBots(c.env, next);
  return c.json({ ok: true, bots: next });
});

app.post("/api/admin/telegram-config/test", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const results: { label?: string; chatId: string; ok: boolean; error?: string }[] = [];
  const bots = await telegramBots(c.env);
  for (const bot of bots) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: bot.chatId,
          text: "Kingdom Sponsor test alert \u2014 your team bot is working.",
        }),
      });
      const text = await res.text().catch(() => "");
      results.push({ label: bot.label, chatId: bot.chatId, ok: res.ok, error: res.ok ? undefined : text.slice(0, 200) });
    } catch (e) {
      results.push({ label: bot.label, chatId: bot.chatId, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return c.json({ ok: results.some((r) => r.ok), results });
});

// Admin: trigger a test intruder alert (Telegram + SMS + email).
app.post("/api/admin/intruder-alert/test", async (c) => {
  const admin = await requireStaff(c, "settings");
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
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const row = await c.env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'admin_email'"
  ).first<Record<string, any>>();

  return c.json({ configured: !!row?.value, email: row?.value ?? "" });
});

app.put("/api/admin/email-config", async (c) => {
  const admin = await requireStaff(c, "settings");
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
  "sponsor_desk", "campaign_chat",
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
  const admin = await requireStaff(c, "settings");
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

async function campaignPublic(env: Bindings, row: Record<string, any>, authUserId?: number | null): Promise<Record<string, any>> {
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
            COALESCE(AVG(amount_cents),0) AS avg,
            COALESCE(SUM(CASE WHEN ticket_qty > 1 THEN ticket_qty ELSE 1 END),0) AS t
     FROM contributions WHERE campaign_id = ? AND status = 'confirmed'`
  ).bind(row.id).first<{ s: number; n: number; d: number; avg: number; t: number }>()) ?? { s: 0, n: 0, d: 0, avg: 0, t: 0 };
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

  const isEventLike = !!parseEventTiers(row.event_tiers).length || row.campaign_type === "event";
  const rsvpCount = isEventLike
    ? ((await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM event_rsvps WHERE event_id = ?"
      ).bind(row.id).first<{ n: number }>())?.n ?? 0)
    : 0;

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
    waivePayoutFees: !!row.waive_payout_fees,
    waiveEventFees: !!row.waive_event_fees,
    eventTiers: parseEventTiers(row.event_tiers),
    eventCapacity: Math.max(0, Number(row.event_capacity) || 0),
    eventDate: row.event_date ?? null,
    eventTime: row.event_time ?? null,
    eventVenue: row.event_venue ?? null,
    ticketsSold: Math.max(0, agg.t),
    rsvpCount,
    isMine: authUserId != null && Number(row.host_user_id) === Number(authUserId),
    isLive: (await getSetting(env, `live_${row.id}`)) === "1",
    createdAt: row.created_at,
    shareUrl: `${env.APP_URL}/share/${row.id}`,
  };
}

/** Parses the campaign's event ticket tiers (JSON) into a safe array. */
export function parseEventTiers(raw: unknown): { name: string; amountCents: number }[] {
  if (!raw) return [];
  let parsed: unknown = raw;
  // Accept both a JSON string ("[{"name":"Standard","amountCents":20000}]")
  // and an already-parsed array (what the Flutter app sends in the body).
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((t) => ({
      name: String(t?.name ?? "").trim().slice(0, 60),
      amountCents: Math.max(0, Math.round(Number(t?.amountCents) || 0)),
    }))
    .filter((t) => t.name && t.amountCents > 0)
    .slice(0, 10);
}

// ---------- campaign categories ----------

app.get("/api/campaign-categories", async (c) => {
  return c.json({ categories: CAMPAIGN_CATEGORIES });
});

app.get("/api/event-categories", async (c) => {
  return c.json({ categories: EVENT_CATEGORIES });
});

app.get("/api/campaigns", async (c) => {
  const category = c.req.query("category");
  // Never mix events with fundraisers: `type=events` returns ONLY events,
  // anything else returns ONLY campaigns. The events tab asks for events,
  // the campaigns tab gets campaigns — no cross-pollination.
  const type = String(c.req.query("type") ?? "").trim().toLowerCase();
  const wantEvents = type === "events" || type === "event";
  const categoryOk = wantEvents
    ? category && isValidEventCategory(category)
    : category && isValidCategory(category);
  const whereClause = wantEvents
    ? "WHERE c.status = 'active' AND c.visibility = 'public' AND (c.campaign_type = 'event' OR (c.event_tiers IS NOT NULL AND c.event_tiers != ''))"
    : "WHERE c.status = 'active' AND c.visibility = 'public' AND (c.campaign_type != 'event' OR c.campaign_type IS NULL) AND (c.event_tiers IS NULL OR c.event_tiers = '')";
  const categoryClause = categoryOk ? ` AND c.category = ?` : "";
  const rows = await c.env.DB.prepare(
    `SELECT c.*, u.username AS host_name, u.host_verified, u.host_org AS host_org FROM campaigns c LEFT JOIN users u ON u.id = c.host_user_id ${whereClause}${categoryClause} ORDER BY c.promoted DESC, c.created_at DESC LIMIT 100`
  ).bind(...(categoryOk ? [category] : [])).all<Record<string, any>>();
  const out = await Promise.all(rows.results.map(async (row) => {
    try {
      return await campaignPublic(c.env, row);
    } catch (e) {
      console.error(`campaignPublic failed for campaign ${row.id}:`, e);
      // Include minimal campaign data so the list still shows
      return {
        id: row.id, slug: row.slug, title: row.title, description: row.description,
        blurb: String(row.description ?? "").slice(0, 140), imageUrl: row.image_url,
        logoUrl: row.logo_url ?? null, goalCents: Number(row.goal_cents),
        hasGoal: Number(row.goal_cents) > 0, raisedCents: 0, withdrawnCents: 0,
        donorCount: 0, donationCount: 0, avgDonationCents: 0, donorsNeededAtAvg: null,
        dailyRateCents: 0, estimatedEndDate: null, endsAt: row.ends_at ?? null,
        promoted: !!row.promoted, promotedUntil: row.promoted_until ?? null,
        status: row.status, category: row.category ?? "Other",
        createdAt: row.created_at, shareUrl: null,
      };
    }
  }));

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
       AND (c.campaign_type != 'event' OR c.campaign_type IS NULL)
       AND (c.event_tiers IS NULL OR c.event_tiers = '')
       AND (c.title LIKE ? OR c.description LIKE ? OR c.category LIKE ?
            OR u.username LIKE ? OR COALESCE(u.host_org,'') LIKE ?)
     ORDER BY c.promoted DESC, c.created_at DESC LIMIT 50`
  ).bind(like, like, like, like, like).all<Record<string, any>>();
  const out = (await Promise.allSettled(rows.results.map((row) => campaignPublic(c.env, row))))
    .map((r) => {
      if (r.status === "fulfilled") return r.value;
      console.error("campaignPublic failed during search:", r.reason);
      return null;
    })
    .filter((v): v is Record<string, any> => v != null);
  return c.json({ campaigns: out });
});

app.get("/api/campaigns/:id", async (c) => {
  const auth = await authUser(c);
  const row = await c.env.DB.prepare(
    "SELECT c.*, u.username AS host_name, u.host_verified, u.host_org AS host_org FROM campaigns c LEFT JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "Campaign not found" }, 404);
  const pub = await campaignPublic(c.env, row, auth?.sub ?? null);
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

  // Short cache so donation totals update quickly but list/detail reads don't hammer D1.
  c.header("Cache-Control", "public, max-age=15");
  return c.json({
    campaign: pub,
    donors: donorList,
    leaderboard: leaderboard.results.map((r) => ({
      username: r.username ?? "Giver",
      totalCents: r.total,
      tier: tierFor(r.total),
    })),
    fees: feeConfigPublic(loadFeeConfig(c.env)),
  });
});

// ---------- campaign views (private links stay findable) ----------

/** Records that the signed-in user opened a campaign (public or private), so a
 *  donor who reaches a PRIVATE campaign via a shared invite link can find it
 *  again under "Recently opened" without needing the link a second time. */
app.post("/api/campaigns/:id/view", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const campaignId = Number(c.req.param("id"));
  if (!campaignId) return c.json({ error: "Invalid campaign" }, 400);

  await c.env.DB.prepare(
    "INSERT INTO campaign_views (user_id, campaign_id, viewed_at) VALUES (?, ?, datetime('now', '+2 hours')) " +
    "ON CONFLICT(user_id, campaign_id) DO UPDATE SET viewed_at = excluded.viewed_at"
  ).bind(user.sub, campaignId).run();
  // Keep the list bounded: drop the user's oldest views beyond 30.
  await c.env.DB.prepare(
    `DELETE FROM campaign_views WHERE user_id = ? AND campaign_id NOT IN (
       SELECT campaign_id FROM campaign_views WHERE user_id = ? ORDER BY viewed_at DESC LIMIT 30
     )`
  ).bind(user.sub, user.sub).run();
  return c.json({ ok: true });
});

/** Recently-opened campaigns for the signed-in user — includes PRIVATE campaigns
 *  they reached via a shared link, so those invite links never get lost. */
app.get("/api/me/campaign-views", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const rows = await c.env.DB.prepare(
    `SELECT cv.campaign_id, cv.viewed_at, c.*, u.username AS host_name, u.host_verified, u.host_org AS host_org
     FROM campaign_views cv
     JOIN campaigns c ON c.id = cv.campaign_id
     LEFT JOIN users u ON u.id = c.host_user_id
     WHERE cv.user_id = ? AND c.status = 'active'
     ORDER BY cv.viewed_at DESC LIMIT 30`
  ).bind(user.sub).all<Record<string, any>>();

  const out = [];
  for (const row of rows.results) {
    try {
      const pub = await campaignPublic(c.env, row);
      pub.viewedAt = row.viewed_at;
      pub.isPrivate = (row.visibility ?? "public") === "private";
      out.push(pub);
    } catch (e) {
      console.error(`campaign-view public failed for ${row.id}:`, e);
    }
  }
  return c.json({ campaigns: out });
});

// ---------- host: apply & create campaign ----------

app.post("/api/host/apply", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const body = await c.req.json();
  const org = String(body.org ?? "").trim();
  const role = String(body.role ?? "").trim();
  const reason = String(body.reason ?? "").trim();
  const orgType = body.orgType != null ? String(body.orgType).trim() : null;
  const kycType = body.kycType != null ? String(body.kycType).trim() : null;
  const kycDocUrl = body.kycDocUrl != null ? String(body.kycDocUrl).trim() : null;
  const kycNotes = body.kycNotes != null ? String(body.kycNotes).trim().slice(0, 500) : null;
  if (!org) return c.json({ error: "Organization name is required" }, 400);
  if (orgType !== null && !["individual", "ngo", "agency"].includes(orgType)) {
    return c.json({ error: "Invalid organisation type" }, 400);
  }
  if (kycType !== null && !(HOST_KYC_TYPES as readonly string[]).includes(kycType)) {
    return c.json({ error: "Invalid KYC document type" }, 400);
  }

  const current = await hostStatusOf(c.env, user.sub);
  if (current.host_status === "approved") {
    return c.json({ message: "You are already an approved host", hostStatus: "approved" });
  }

  await c.env.DB.prepare(
    `UPDATE users SET host_status = 'pending', host_org = ?, host_role = ?, host_reason = ?, host_rejection = NULL,
            org_type = COALESCE(?, org_type),
            host_kyc_status = ?, host_kyc_type = ?, host_kyc_doc_url = ?, host_kyc_notes = ? WHERE id = ?`
  ).bind(org, role || null, reason || null,
         orgType || null,
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
  const waivePayoutFees = body.waivePayoutFees === true ? 1 : 0;
  const eventTiers = parseEventTiers(body.eventTiers);
  const eventCapacity = Math.max(0, Math.round(Number(body.eventCapacity) || 0));
  const eventDate = body.eventDate != null ? String(body.eventDate).slice(0, 10) || null : null;
  const eventTime = body.eventTime != null ? String(body.eventTime).trim().slice(0, 5) || null : null;
  const eventVenue = body.eventVenue != null ? String(body.eventVenue).trim().slice(0, 200) || null : null;
  const imageUrl = body.imageUrl != null ? String(body.imageUrl).trim().slice(0, 500) || null : null;
  if (imageUrl !== null && !/^https:\/\/.+/.test(imageUrl)) {
    return c.json({ error: "imageUrl must be an https URL" }, 400);
  }
  if (!title || !description) return c.json({ error: "Title and description are required" }, 400);
  const isEventCreate = campaignType === "event" || eventTiers.length > 0;
  if (isEventCreate) {
    if (!isValidEventCategory(category)) return c.json({ error: "Invalid event category" }, 400);
  } else {
    if (!isValidCategory(category)) return c.json({ error: "Invalid campaign category" }, 400);
  }
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
    "INSERT INTO campaigns (slug, title, description, goal_cents, min_withdraw_cents, host_user_id, ends_at, min_sponsors, category, visibility, campaign_type, waive_payout_fees, event_tiers, event_capacity, event_date, event_time, event_venue, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(slug, title, description, goalCents, minWithdrawCents, user.sub, endsAt, minSponsors, category, visibility, campaignType, waivePayoutFees, eventTiers.length ? JSON.stringify(eventTiers) : null, eventCapacity, eventDate, eventTime, eventVenue, imageUrl).run();

  const campaignId = Number(r.meta?.last_row_id ?? 0);

  // Alert the admin team about every new campaign or event posted.
  await pushAdmins(c.env,
    campaignType === "event" ? "New event posted" : "New campaign posted",
    `${user.username ?? "A host"} ${campaignType === "event" ? "listed the event" : "started the campaign"} "${title}".`,
    { type: campaignType === "event" ? "new_event" : "new_campaign", campaignId: String(campaignId) }).catch(() => {});

  // Notify past donors of this host's campaigns about the new campaign
  // (only public ones — a private campaign is shared by the host directly).
  if (visibility === "public") {
  const pastDonors = await c.env.DB.prepare(
    `SELECT DISTINCT dt.token, dt.user_id
     FROM contributions co
     JOIN campaigns c ON c.id = co.campaign_id
     JOIN users u ON u.id = co.donor_user_id
     JOIN device_tokens dt ON dt.user_id = u.id
     WHERE c.host_user_id = ? AND u.notifications_enabled = 1
     LIMIT 500`
  ).bind(user.sub).all<{ token: string; user_id: number }>();
  if (pastDonors.results.length && envPushConfigured(c.env)) {
    const tokens = pastDonors.results.map((u) => u.token);
    const donorIds = pastDonors.results.map((u) => u.user_id);
    const isEvent = campaignType === "event";
    const pushTitle = isEvent ? "New event posted" : "New campaign posted";
    const pushBody = isEvent
      ? `${user.username ?? "Someone you support"} just listed "${title}". Get tickets on Kingdom Sponsor.`
      : `${user.username ?? "Someone you support"} just started "${title}". Give now on Kingdom Sponsor.`;
    await sendMulticastPush(fbEnv(c.env), tokens, pushTitle, pushBody,
      { type: isEvent ? "new_event" : "new_campaign", campaignId: String(campaignId) }
    ).catch((e) => console.error("new campaign push failed:", e));
    for (const uid of new Set(donorIds)) {
      await recordNotification(c.env, uid, isEvent ? "new_event" : "new_campaign",
        pushTitle, pushBody,
        { type: isEvent ? "new_event" : "new_campaign", campaignId: String(campaignId) }).catch(() => {});
    }
  }
  }

  return c.json({ id: campaignId, slug }, 201);
});

// ---------- Admin: Update campaign (title, description, goal, etc.) ----------

app.put("/api/admin/campaigns/:id", async (c) => {
  const admin = await requireStaff(c, "campaigns");
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
  const waivePayoutFees = body.waivePayoutFees != null ? (body.waivePayoutFees === true ? 1 : 0) : null;
  const eventTiersRaw = body.eventTiers !== undefined ? body.eventTiers : null;
  const hasEventTiers = body.eventTiers !== undefined;
  const eventCapacity = body.eventCapacity != null ? Math.max(0, Math.round(Number(body.eventCapacity))) : null;
  const eventDate = body.eventDate !== undefined ? (body.eventDate == null ? null : String(body.eventDate).slice(0, 10) || null) : undefined;
  const eventTime = body.eventTime !== undefined ? (body.eventTime == null ? null : String(body.eventTime).trim().slice(0, 5) || null) : undefined;
  const eventVenue = body.eventVenue !== undefined ? (body.eventVenue == null ? null : String(body.eventVenue).trim().slice(0, 200) || null) : undefined;
  const isEditEvent = campaignType === "event"
    || parseEventTiers(campaign.event_tiers).length > 0
    || parseEventTiers(eventTiersRaw ?? campaign.event_tiers).length > 0;
  if (category !== null && !(isEditEvent ? isValidEventCategory(category) : isValidCategory(category))) {
    return c.json({ error: isEditEvent ? "Invalid event category" : "Invalid campaign category" }, 400);
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
  if (waivePayoutFees !== null) { sets.push("waive_payout_fees = ?"); vals.push(waivePayoutFees); }
  if (hasEventTiers) {
    sets.push("event_tiers = ?");
    vals.push(eventTiersRaw == null ? null : JSON.stringify(parseEventTiers(eventTiersRaw)));
  }
  if (eventCapacity !== null) { sets.push("event_capacity = ?"); vals.push(eventCapacity); }
  if (eventDate !== undefined) { sets.push("event_date = ?"); vals.push(eventDate); }
  if (eventTime !== undefined) { sets.push("event_time = ?"); vals.push(eventTime); }
  if (eventVenue !== undefined) { sets.push("event_venue = ?"); vals.push(eventVenue); }
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
      `SELECT DISTINCT dt.token, dt.user_id FROM device_tokens dt
       JOIN contributions co ON co.donor_user_id = dt.user_id
       WHERE co.campaign_id = ? AND co.status = 'confirmed' AND dt.user_id IS NOT NULL
       LIMIT 500`
    ).bind(campaign.id).all<{ token: string; user_id: number }>();
    if (donors.results.length && envPushConfigured(c.env)) {
      const tokens = donors.results.map((u) => u.token);
      const isEvent = campaign.campaign_type === "event";
      const pushTitle = isEvent ? "Event updated" : "Campaign updated";
      const pushBody = `"${title ?? campaign.title}" has been updated by the host.`;
      await sendMulticastPush(fbEnv(c.env), tokens, pushTitle, pushBody,
        { type: "campaign_updated", campaignId: String(campaign.id) }
      ).catch((e) => console.error("campaign-updated push failed:", e));
      for (const uid of new Set(donors.results.map((d) => d.user_id))) {
        await recordNotification(c.env, uid, "campaign_updated", pushTitle, pushBody,
          { type: "campaign_updated", campaignId: String(campaign.id) }).catch(() => {});
      }
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
    ["waivePayoutFees", (v) => (v != null ? v === true : null)],
    ["eventCapacity", (v) => (v != null ? Math.max(0, Math.round(Number(v))) : null)],
    ["eventDate", (v) => (v != null ? String(v).slice(0, 10) || null : null)],
    ["eventTime", (v) => (v != null ? String(v).trim().slice(0, 5) || null : null)],
    ["eventVenue", (v) => (v != null ? String(v).trim().slice(0, 200) || null : null)],
  ];
  for (const [key, clean] of allowed) {
    if (key in body) proposed[key] = clean(body[key]);
  }
  // Event ticket tiers are proposed as-is (validated when applied).
  if ("eventTiers" in body) proposed.eventTiers = body.eventTiers ?? null;

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
  const proposedCampaignType = proposed.campaignType ?? campaign.campaign_type ?? "community";
  const isEditEvent = proposedCampaignType === "event"
    || parseEventTiers(campaign.event_tiers).length > 0
    || (proposed.eventTiers != null && parseEventTiers(proposed.eventTiers).length > 0);
  if (proposed.category != null && !(isEditEvent ? isValidEventCategory(proposed.category) : isValidCategory(proposed.category))) {
    return c.json({ error: isEditEvent ? "Invalid event category" : "Invalid campaign category" }, 400);
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
  if (amountCents < 500) return c.json({ error: "Minimum donation is K5.00" }, 400);

  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(c.req.param("id")).first();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.status !== "active") return c.json({ error: "Campaign is closed" }, 400);

  // Event ticket purchase: optional tier + quantity recorded on the
  // contribution so ticket sales & tier mix are real (not just donations).
  const tiers = parseEventTiers(campaign.event_tiers);
  const tierName = String(body.tierName ?? "").trim().slice(0, 60);
  const qty = Math.max(1, Math.min(20, Math.round(Number(body.ticketQty) || 1)));
  if (tiers.length > 0) {
    if (!tierName || !tiers.some((t) => t.name === tierName)) {
      return c.json({ error: "Choose a valid ticket tier" }, 400);
    }
  }

  // Event capacity / sold-out check: when an event has a ticket cap and all
  // tickets are sold, no more purchases are allowed (counted by quantity).
  const capacity = Math.max(0, Number(campaign.event_capacity) || 0);
  if (capacity > 0) {
    const sold = (await c.env.DB.prepare(
      "SELECT COALESCE(SUM(ticket_qty), 0) AS n FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
    ).bind(campaign.id).first<{ n: number }>())?.n ?? 0;
    if (sold + qty > capacity) {
      return c.json({ error: "Not enough tickets left — this event is selling out fast." }, 409);
    }
  }

  const phone = normalizePhone(body.phone ?? user?.phone ?? "");
  if (!/^\+260\d{9}$/.test(phone)) {
    return c.json({ error: "Enter a valid Zambian phone number" }, 400);
  }

  const donor = await ensureUser(c.env.DB, phone);
  const recent = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM contributions WHERE phone = ? AND created_at > datetime('now', '-1 minute')"
  ).bind(phone).first<{ n: number }>())?.n ?? 0;
  if (recent >= 3) return c.json({ error: "Too many attempts. Wait a moment and try again." }, 429);

  const cfg = await adminFeeConfig(c.env);
  const overrides = tiers.length > 0 ? await eventFeeOverrides(c.env, campaign) : undefined;
  const fees = donationFees(amountCents, cfg, "momo", overrides);
  const totalCents = amountCents + fees.platformFeeCents + fees.lipilaFeeCents;
  const referenceId = moneyRef("CON", Number(campaign.id));

  const r = await c.env.DB.prepare(
    `INSERT INTO contributions (campaign_id, donor_user_id, donor_name, is_anonymous, hide_amount, phone, amount_cents, platform_fee_cents, lipila_fee_cents, lipila_reference, status, tier_name, ticket_qty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
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
    referenceId,
    tierName || null,
    tiers.length > 0 ? qty : 1
  ).run();

  try {
    const result = await createCollection(c.env, {
      referenceId,
      amountCents: totalCents,
      accountNumber: phone.replace("+", ""),
      narration: tiers.length > 0
        ? `Kingdom Sponsor event ticket: ${campaign.title}`
        : `Kingdom Sponsor donation to ${campaign.title}`,
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

// Card donations — same flow as mobile money, but the payer completes the
// payment on Lipila's hosted checkout (cardRedirectionUrl) instead of a
// USSD prompt. Disbursements stay mobile-money only.
app.post("/api/campaigns/:id/contribute-card", async (c) => {
  const user = await authUser(c);
  const body = await c.req.json().catch(() => ({}));
  const amountCents = Math.round(Number(body.amountCents) || 0);
  if (amountCents < 500) return c.json({ error: "Minimum donation is K5.00" }, 400);

  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(c.req.param("id")).first();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.status !== "active") return c.json({ error: "Campaign is closed" }, 400);

  // Event ticket purchase via card: same tier/quantity handling as MoMo.
  const tiers = parseEventTiers(campaign.event_tiers);
  const tierName = String(body.tierName ?? "").trim().slice(0, 60);
  const qty = Math.max(1, Math.min(20, Math.round(Number(body.ticketQty) || 1)));
  if (tiers.length > 0 && (!tierName || !tiers.some((t) => t.name === tierName))) {
    return c.json({ error: "Choose a valid ticket tier" }, 400);
  }
  const capacity = Math.max(0, Number(campaign.event_capacity) || 0);
  if (capacity > 0) {
    const sold = (await c.env.DB.prepare(
      "SELECT COALESCE(SUM(ticket_qty), 0) AS n FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
    ).bind(campaign.id).first<{ n: number }>())?.n ?? 0;
    if (sold + qty > capacity) {
      return c.json({ error: "Not enough tickets left — this event is selling out fast." }, 409);
    }
  }

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

  const cfg = await adminFeeConfig(c.env);
  const overrides = tiers.length > 0 ? await eventFeeOverrides(c.env, campaign) : undefined;
  const fees = donationFees(amountCents, cfg, "card", overrides);
  const totalCents = amountCents + fees.platformFeeCents + fees.lipilaFeeCents;
  const referenceId = moneyRef("CON", Number(campaign.id));

  const r = await c.env.DB.prepare(
    `INSERT INTO contributions (campaign_id, donor_user_id, donor_name, is_anonymous, hide_amount, phone, email, amount_cents, platform_fee_cents, lipila_fee_cents, lipila_reference, status, tier_name, ticket_qty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(
    campaign.id,
    donor.id,
    fullName || null,
    body.isAnonymous ? 1 : 0,
    body.hideAmount ? 1 : 0,
    phone,
    email || null,
    amountCents,
    fees.platformFeeCents,
    fees.lipilaFeeCents,
    referenceId,
    tierName || null,
    tiers.length > 0 ? qty : 1
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
        // Grace period: Lipila can briefly report a failure right after the
        // USSD prompt is dispatched, before the donor has entered their PIN.
        // Only treat it as failed once the prompt has had time to settle
        // (webhooks are authoritative; a status-check alone shouldn't fail a
        // payment the user may still be completing).
        const createdAgoSec = (Date.now() - new Date(row.created_at.replace(" ", "T") + "Z").getTime()) / 1000;
        if (createdAgoSec >= 90) {
          await failContribution(c.env, effectiveRef);
          row.status = "failed";
        }
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
  const referenceId = moneyRef("CON-GIFT", campaign.id);

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

// ---------- host announcements (moderated updates) ----------

/** Public: approved host updates shown on a campaign/event page. */
app.get("/api/campaigns/:id/announcements", async (c) => {
  const campaign = await c.env.DB.prepare("SELECT id, status FROM campaigns WHERE id = ?")
    .bind(c.req.param("id")).first<{ id: number; status: string }>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.status === "draft") return c.json({ error: "Campaign not found" }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.body, a.created_at, u.username AS author
     FROM announcements a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.campaign_id = ? AND a.status = 'approved'
     ORDER BY a.created_at DESC LIMIT 50`
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

/**
 * Submit a host update. Hosts' updates go into a moderation queue that the
 * superadmin (and assistants with the campaigns scope) review; admin-submitted
 * updates are approved instantly. On approval, confirmed donors are pushed.
 */
app.post("/api/campaigns/:id/announcements", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const body = await c.req.json();
  const text = String(body.body ?? "").trim();
  if (!text || text.length > 500) {
    return c.json({ error: "Update must be 1-500 characters" }, 400);
  }

  const isAdmin = isAdminPhone(c.env, user.phone);
  const isHost = Number(campaign.host_user_id) === Number(user.sub);
  if (!isAdmin && !isHost) {
    return c.json({ error: "Only the host or an admin can post an update" }, 403);
  }

  // Hosts must wait for moderation; admins publish immediately.
  const status = isAdmin ? "approved" : "pending";

  let lastId = 0;
  try {
    const r = await c.env.DB.prepare(
      "INSERT INTO announcements (campaign_id, user_id, body, status) VALUES (?, ?, ?, ?)"
    ).bind(campaign.id, user.sub, text, status).run();
    lastId = Number(r.meta?.last_row_id ?? 0);
  } catch (e) {
    console.error("announcement insert failed:", e);
    return c.json({ error: `Could not save update: ${(e as Error).message}` }, 500);
  }

  // Host submission -> alert the superadmins + campaign-scope assistants.
  if (status === "pending") {
    await pushAdmins(c.env, "New update to review",
      `Host ${user.username ?? "user"} posted an update on "${campaign.title}". Approve or reject it in the admin dashboard.`,
      { type: "announcement_review", announcementId: String(lastId) }).catch(() => {});
  }

  return c.json({ ok: true, id: lastId, status, createdAt: new Date().toISOString() });
});

/** Admin: list announcements by status (default pending) for moderation. */
app.get("/api/admin/announcements", async (c) => {
  const staff = await requireStaff(c, "campaigns");
  if (!staff) return c.json({ error: "Admin only" }, 403);
  const status = String(c.req.query("status") ?? "pending");
  const where = status === "all" ? "1=1" : "a.status = ?";
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.body, a.status, a.created_at, a.rejection_reason,
            c.title AS campaign_title, c.id AS campaign_id, c.campaign_type,
            u.username AS author
     FROM announcements a
     JOIN campaigns c ON c.id = a.campaign_id
     LEFT JOIN users u ON u.id = a.user_id
     WHERE ${where}
     ORDER BY a.created_at DESC LIMIT 100`
  ).bind(status === "all" ? [] : [status]).all<Record<string, any>>();

  return c.json({
    announcements: rows.results.map((a) => ({
      id: a.id,
      body: a.body,
      status: a.status,
      campaignId: a.campaign_id,
      campaignTitle: a.campaign_title,
      campaignType: a.campaign_type,
      author: a.author ?? "Host",
      rejectionReason: a.rejection_reason ?? null,
      createdAt: a.created_at,
    })),
  });
});

/** Admin: approve a pending host update -> publish + push donors. */
app.post("/api/admin/announcements/:id/approve", async (c) => {
  const staff = await requireStaff(c, "campaigns");
  if (!staff) return c.json({ error: "Admin only" }, 403);
  const id = Number(c.req.param("id"));

  const row = await c.env.DB.prepare(
    "SELECT * FROM announcements WHERE id = ? AND status = 'pending'"
  ).bind(id).first<Record<string, any>>();
  if (!row) return c.json({ error: "Pending update not found" }, 404);

  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(row.campaign_id).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  await c.env.DB.prepare(
    "UPDATE announcements SET status = 'approved', reviewer_user_id = ?, reviewed_at = datetime('now') WHERE id = ?"
  ).bind(staff.sub, id).run();

  // Push to every confirmed donor of this campaign (multi-device).
  if (envPushConfigured(c.env)) {
    const donors = await c.env.DB.prepare(
      `SELECT DISTINCT dt.token, dt.user_id FROM device_tokens dt
       JOIN contributions co ON co.donor_user_id = dt.user_id
       WHERE co.campaign_id = ? AND co.status = 'confirmed'`
    ).bind(campaign.id).all<{ token: string; user_id: number }>();
    const tokens = donors.results.map((d) => d.token);
    if (tokens.length) {
      await sendMulticastPush(fbEnv(c.env), tokens,
        `${campaign.title} update`,
        row.body.slice(0, 100),
        { type: "announcement", campaignId: String(campaign.id) })
        .catch((e) => console.error("announcement push failed:", e));
    }
    for (const uid of new Set(donors.results.map((d) => d.user_id))) {
      await recordNotification(c.env, uid, "announcement",
        `${campaign.title} update`, row.body.slice(0, 120),
        { type: "announcement", campaignId: String(campaign.id) }).catch(() => {});
    }
  }

  return c.json({ ok: true, message: "Update published and donors were notified." });
});

/** Admin: reject a pending host update with a reason (sent to the host). */
app.post("/api/admin/announcements/:id/reject", async (c) => {
  const staff = await requireStaff(c, "campaigns");
  if (!staff) return c.json({ error: "Admin only" }, 403);
  const id = Number(c.req.param("id"));

  const row = await c.env.DB.prepare(
    "SELECT * FROM announcements WHERE id = ? AND status = 'pending'"
  ).bind(id).first<Record<string, any>>();
  if (!row) return c.json({ error: "Pending update not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason ?? "").trim().slice(0, 300) || null;

  await c.env.DB.prepare(
    "UPDATE announcements SET status = 'rejected', reviewer_user_id = ?, reviewed_at = datetime('now'), rejection_reason = ? WHERE id = ?"
  ).bind(staff.sub, reason, id).run();

  const campaign = await c.env.DB.prepare("SELECT title FROM campaigns WHERE id = ?")
    .bind(row.campaign_id).first<{ title: string }>();
  await pushToUser(c.env, row.user_id,
    "Update not published",
    reason ? `Your update on "${campaign?.title ?? "your campaign"}" was declined: ${reason}` : `Your update on "${campaign?.title ?? "your campaign"}" was declined.`,
    { type: "announcement_rejected", campaignId: String(row.campaign_id) }).catch(() => {});

  return c.json({ ok: true, message: "Update rejected and the host was notified." });
});

// ---------- Campaign / event chat ----------
// A private, campaign-scoped conversation between the host and confirmed
// supporters (donors, ticket holders, RSVPs). Anyone who has contributed to the
// campaign can read + post; the host and staff can too. New messages push to
// everyone else who supports the campaign (via the `chat` channel).

/** Who may read/post in a campaign's chat: the host, staff, and anyone with a
 *  confirmed contribution OR an RSVP for this campaign. */
/** Who may POST in a campaign's chat: the host, staff, and anyone with a
 *  confirmed contribution OR an RSVP for this campaign. Reading is open to
 *  everyone who can see the campaign (public campaigns), so visitors can see
 *  the conversation and are motivated to join. */
async function chatCanPost(env: Bindings, campaign: Record<string, any>, user: TokenPayload): Promise<boolean> {
  if (Number(campaign.host_user_id) === Number(user.sub)) return true;
  if (isAdminPhone(env, user.phone)) return true;
  const staff = await env.DB.prepare("SELECT 1 FROM admin_assistants WHERE user_id = ? LIMIT 1")
    .bind(user.sub).first();
  if (staff) return true;
  const contributed = await env.DB.prepare(
    `SELECT 1 FROM contributions WHERE campaign_id = ? AND donor_user_id = ? AND status = 'confirmed' LIMIT 1`
  ).bind(campaign.id, user.sub).first();
  if (contributed) return true;
  const rsvp = await env.DB.prepare(
    `SELECT 1 FROM event_rsvps WHERE event_id = ? AND user_id = ? LIMIT 1`
  ).bind(campaign.id, user.sub).first();
  return !!rsvp;
}

/** Campaign chat: recent messages (oldest-first for a normal conversation view).
 *  Reading is open to any signed-in user who can view the campaign, so the
 *  conversation is visible (and motivating) even before someone donates. */
app.get("/api/campaigns/:id/chat", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const campaignId = Number(c.req.param("id"));
  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?")
    .bind(campaignId).first<Record<string, any>>();
  if (!campaign || campaign.status === "draft") return c.json({ error: "Campaign not found" }, 404);
  if (campaign.visibility === "private") {
    // Private campaigns: only the host, staff, and confirmed supporters.
    if (!(await chatCanPost(c.env, campaign, user))) {
      return c.json({ error: "This conversation is private" }, 403);
    }
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, user_id, name, avatar_url, body, created_at
     FROM campaign_chat WHERE campaign_id = ?
     ORDER BY id ASC LIMIT 200`
  ).bind(campaignId).all<Record<string, any>>();
  const isCurrentHost = Number(campaign.host_user_id) === Number(user.sub);
  const currentIsStaff = isAdminPhone(c.env, user.phone)
    || await c.env.DB.prepare("SELECT 1 FROM admin_assistants WHERE user_id = ? LIMIT 1")
      .bind(user.sub).first();
  return c.json({
    messages: rows.results.map((m) => ({
      id: m.id,
      userId: m.user_id,
      name: m.name,
      avatarUrl: m.avatar_url,
      body: m.body,
      createdAt: m.created_at,
      isMine: Number(m.user_id) === Number(user.sub),
      isHost: Number(m.user_id) === Number(campaign.host_user_id),
      canDelete: Number(m.user_id) === Number(user.sub) || isCurrentHost || !!currentIsStaff,
    })),
  });
});

/** Post a message to a campaign/event chat (host + confirmed supporters). */
app.post("/api/campaigns/:id/chat", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const campaignId = Number(c.req.param("id"));
  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?")
    .bind(campaignId).first<Record<string, any>>();
  if (!campaign || campaign.status === "draft") return c.json({ error: "Campaign not found" }, 404);
  if (!(await chatCanPost(c.env, campaign, user))) {
    return c.json({ error: "Support this campaign to join the conversation" }, 403);
  }
  const body = await c.req.json();
  const text = String(body.body ?? "").trim().slice(0, 1000);
  if (!text) return c.json({ error: "Message cannot be empty" }, 400);

  // Rate-limit: max 5 messages per 30s per user (prevents spam floods).
  const recent = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM campaign_chat WHERE user_id = ? AND created_at > datetime('now', '-30 seconds')"
  ).bind(user.sub).first<{ n: number }>())?.n ?? 0;
  if (recent >= 5) return c.json({ error: "You're sending messages too fast. Slow down a moment." }, 429);

  const r = await c.env.DB.prepare(
    `INSERT INTO campaign_chat (campaign_id, user_id, name, avatar_url, body)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    campaignId,
    user.sub,
    user.username ?? "Supporter",
    null,
    text,
  ).run();
  const messageId = Number(r.meta.last_row_id);

  // Look up the poster's live profile (name + avatar) so chat bubbles show the
  // user's real picture, not a stale token value.
  const profile = await c.env.DB.prepare(
    "SELECT username, name, avatar_url FROM users WHERE id = ?"
  ).bind(user.sub).first<{ username: string | null; name: string | null; avatar_url: string | null }>();
  const poster = {
    name: profile?.name || profile?.username || user.username || "Supporter",
    avatarUrl: profile?.avatar_url ?? null,
  };
  await c.env.DB.prepare(
    "UPDATE campaign_chat SET name = ?, avatar_url = ? WHERE id = ?"
  ).bind(poster.name, poster.avatarUrl, messageId).run();

  // Push the new message to the campaign's other confirmed supporters
  // (multi-device), so they're alerted in real time even with the app closed.
  if (envPushConfigured(c.env)) {
    const others = await c.env.DB.prepare(
      `SELECT DISTINCT dt.token, dt.user_id FROM device_tokens dt
       JOIN contributions co ON co.donor_user_id = dt.user_id
       WHERE co.campaign_id = ? AND co.status = 'confirmed' AND co.donor_user_id != ?
       UNION
       SELECT DISTINCT dt.token, dt.user_id FROM device_tokens dt
       WHERE dt.user_id = ? AND dt.user_id != ?
       LIMIT 2000`
    ).bind(campaignId, user.sub, campaign.host_user_id, user.sub).all<{ token: string; user_id: number }>();
    const sender = poster.name;
    const isEvent = campaign.campaign_type === "event"
      || (campaign.event_tiers != null && campaign.event_tiers !== "");
    const pushTitle = `${sender} in ${isEvent ? "event chat" : "campaign chat"}`;
    const pushBody = text.slice(0, 120);
    const result = await sendMulticastPush(fbEnv(c.env), others.results.map((o) => o.token),
      pushTitle, pushBody,
      { type: "chat", campaignId: String(campaignId), messageId: String(messageId) })
      .catch((e) => { console.error("chat push failed:", e); return { success: 0, failure: 0, failedTokens: [] as string[] }; });
    if (result.failedTokens.length) await pruneInvalidTokens(c.env, result.failedTokens);
    for (const uid of [...new Set(others.results.map((o) => o.user_id))]) {
      await recordNotification(c.env, uid, "chat", pushTitle, pushBody,
        { type: "chat", campaignId: String(campaignId) }).catch(() => {});
    }
  }

  return c.json({ ok: true, id: messageId });
});

/** Delete a chat message. The author may delete their own message; the campaign
 *  host (or any staff) may delete any message in their campaign's chat. */
app.delete("/api/campaigns/:id/chat/:messageId", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const campaignId = Number(c.req.param("id"));
  const messageId = Number(c.req.param("messageId"));
  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?")
    .bind(campaignId).first<Record<string, any>>();
  if (!campaign || campaign.status === "draft") return c.json({ error: "Campaign not found" }, 404);

  const message = await c.env.DB.prepare(
    "SELECT * FROM campaign_chat WHERE id = ? AND campaign_id = ?"
  ).bind(messageId, campaignId).first<Record<string, any>>();
  if (!message) return c.json({ error: "Message not found" }, 404);

  const isAuthor = Number(message.user_id) === Number(user.sub);
  const isHost = Number(campaign.host_user_id) === Number(user.sub);
  const isAdmin = isAdminPhone(c.env, user.phone);
  const isStaff = await c.env.DB.prepare("SELECT 1 FROM admin_assistants WHERE user_id = ? LIMIT 1")
    .bind(user.sub).first();
  if (!isAuthor && !isHost && !isAdmin && !isStaff) {
    return c.json({ error: "You can only delete your own messages" }, 403);
  }

  await c.env.DB.prepare("DELETE FROM campaign_chat WHERE id = ?").bind(messageId).run();
  return c.json({ ok: true });
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
  // Account linking is a security action — notify via push + in-app (SMS is
  // reserved strictly for verification codes to keep costs minimal).
  const requesterName = (me?.username && me.username.trim()) ? me.username.trim() : "A Kingdom Sponsor user";
  await smsAndPush(c.env, target.id, null, "",
    "Account link request",
    `${requesterName} wants to link accounts with you (${linkType}). Open Settings > Linked accounts to accept or decline.`,
    { type: "link_request", linkId: String(linkId) });

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
  if (await activePromotionCount(c.env) >= (await promoSlots(c.env))) {
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
  const referenceId = moneyRef("PRO", campaign.id);

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
    // Alert the admin team that a host is promoting their campaign.
    await pushAdmins(c.env, "Campaign promotion requested",
      `${user.username ?? "A host"} is promoting "${campaign.title}" for ${days} days (${formatKwacha(price)}).`,
      { type: "promotion_active", campaignId: String(campaign.id) }).catch(() => {});
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
  const slots = await promoSlots(c.env);
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
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  return c.json({
    priceCents: await promoPrice(c.env),
    days: await promoDays(c.env),
    slots: await promoSlots(c.env),
  });
});

app.post("/api/admin/promotion-config", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const price = Math.round(Number(body.priceCents));
  const days = Math.round(Number(body.days));
  const slots = body.slots != null ? Math.round(Number(body.slots)) : await promoSlots(c.env);
  if (!Number.isFinite(price) || price < 1000 || price > 200000) {
    return c.json({ error: "Price must be between K10 and K2,000." }, 400);
  }
  if (!Number.isFinite(days) || days < 1 || days > 30) {
    return c.json({ error: "Days must be between 1 and 30." }, 400);
  }
  if (!Number.isFinite(slots) || slots < 1 || slots > 20) {
    return c.json({ error: "Slots must be between 1 and 20." }, 400);
  }

  await c.env.DB.batch([
    envDB(c).prepare("INSERT INTO app_settings (key, value) VALUES ('promo_price_cents', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(price)),
    envDB(c).prepare("INSERT INTO app_settings (key, value) VALUES ('promo_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(days)),
    envDB(c).prepare("INSERT INTO app_settings (key, value) VALUES ('promo_slots', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(slots)),
  ]);
  return c.json({ ok: true, priceCents: price, days, slots });
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

// ---------- in-app notifications center ----------

app.get("/api/me/notifications", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
  const rows = await c.env.DB.prepare(
    "SELECT id, type, title, body, data, read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?"
  ).bind(user.sub, limit).all<Record<string, any>>();
  return c.json({
    notifications: rows.results.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      data: n.data ? JSON.parse(n.data) : null,
      read: !!n.read,
      createdAt: n.created_at,
    })),
  });
});

app.get("/api/me/notifications/unread-count", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0"
  ).bind(user.sub).first<{ n: number }>();
  return c.json({ unread: row?.n ?? 0 });
});

app.post("/api/me/notifications/:id/read", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  await c.env.DB.prepare(
    "UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?"
  ).bind(Number(c.req.param("id")), user.sub).run();
  return c.json({ ok: true });
});

app.post("/api/me/notifications/read-all", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  await c.env.DB.prepare("UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0")
    .bind(user.sub).run();
  return c.json({ ok: true });
});

/** User/host: export a personal backup of everything tied to this account
 *  (profile, giving history, hosted campaigns/events, pledges, links, badges).
 *  Downloadable as JSON from Settings → Backup my data. */
app.get("/api/me/backup", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const profile = await c.env.DB.prepare(
    "SELECT id, phone, username, name, is_host, host_status, host_org, host_role, host_verified, created_at FROM users WHERE id = ?"
  ).bind(user.sub).first<Record<string, any>>();

  const contributions = (await c.env.DB.prepare(
    `SELECT co.id, co.campaign_id, cam.title AS campaign_title, co.donor_name, co.is_anonymous,
            co.hide_amount, co.amount_cents, co.platform_fee_cents, co.lipila_fee_cents,
            co.status, co.tier_name, co.ticket_qty, co.created_at
     FROM contributions co JOIN campaigns cam ON cam.id = co.campaign_id
     WHERE co.donor_user_id = ? OR co.phone = ?
     ORDER BY co.created_at DESC LIMIT 500`
  ).bind(user.sub, user.phone).all<Record<string, any>>()).results;

  const hosted = (await c.env.DB.prepare(
    `SELECT c.id, c.title, c.campaign_type, c.status, c.category, c.visibility, c.goal_cents,
            c.event_capacity, c.event_tiers, c.event_date, c.event_venue, c.created_at
     FROM campaigns c WHERE c.host_user_id = ? ORDER BY c.created_at DESC LIMIT 200`
  ).bind(user.sub).all<Record<string, any>>()).results;

  const pledges = (await c.env.DB.prepare(
    "SELECT id, campaign_id, amount_cents, day_of_month, active, created_at FROM recurring_pledges WHERE user_id = ?"
  ).bind(user.sub).all<Record<string, any>>()).results;

  const links = (await c.env.DB.prepare(
    "SELECT id, link_type, status, created_at FROM user_links WHERE user_id = ? OR linked_user_id = ?"
  ).bind(user.sub, user.sub).all<Record<string, any>>()).results;

  const badges = (await c.env.DB.prepare(
    "SELECT id, tier, status, amount_cents, purchased_at, expires_at FROM host_badges WHERE user_id = ?"
  ).bind(user.sub).all<Record<string, any>>()).results;

  return c.json({
    exportedAt: new Date().toISOString(),
    app: "kingdom-sponsor",
    user: profile,
    contributions,
    hosted,
    pledges,
    links,
    badges,
  });
});

// ---------- gamification: achievements ----------

app.get("/api/me/achievements", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const [giving, campaigns, events, referrals, tier] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT COUNT(*) AS gifts, COALESCE(SUM(amount_cents),0) AS cents FROM contributions WHERE donor_user_id = ? AND status = 'confirmed'"
    ).bind(user.sub),
    c.env.DB.prepare(
      "SELECT COUNT(DISTINCT campaign_id) AS n FROM contributions WHERE donor_user_id = ? AND status = 'confirmed'"
    ).bind(user.sub),
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT c.id) AS n FROM contributions co JOIN campaigns c ON c.id = co.campaign_id
       WHERE co.donor_user_id = ? AND co.status = 'confirmed' AND c.event_tiers IS NOT NULL AND c.event_tiers != ''`
    ).bind(user.sub),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM referrals WHERE referred_user_id = ?").bind(user.sub),
    c.env.DB.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM contributions WHERE donor_user_id = ? AND status = 'confirmed'").bind(user.sub),
  ]);
  const g = (r: any) => r?.results?.[0] ?? r?.[0] ?? {};
  const stats = {
    gifts: g(giving).gifts ?? 0,
    cents: g(giving).cents ?? 0,
    campaigns: g(campaigns).n ?? 0,
    events: g(events).n ?? 0,
    referred: g(referrals).n ?? 0,
    tier: tierFor(g(tier).s ?? 0),
  };

  const badges = [
    { key: "first_gift", label: "First Gift", desc: "Make your first confirmed gift", icon: "heart", earned: stats.gifts >= 1, progress: Math.min(1, stats.gifts) },
    { key: "five_gifts", label: "Five Gifts", desc: "Gift 5 times", icon: "star", earned: stats.gifts >= 5, progress: Math.min(1, stats.gifts / 5) },
    { key: "ten_gifts", label: "Ten Gifts", desc: "Gift 10 times", icon: "trophy", earned: stats.gifts >= 10, progress: Math.min(1, stats.gifts / 10) },
    { key: "three_campaigns", label: "Community Builder", desc: "Support 3 different campaigns", icon: "users", earned: stats.campaigns >= 3, progress: Math.min(1, stats.campaigns / 3) },
    { key: "big_giver", label: "Big Giver", desc: "Give K1,000+ in total", icon: "crown", earned: stats.cents >= 100000, progress: Math.min(1, stats.cents / 100000) },
    { key: "event_goer", label: "Event Goer", desc: "Buy a ticket to an event", icon: "ticket", earned: stats.events >= 1, progress: Math.min(1, stats.events) },
    { key: "referrer", label: "Inviter", desc: "Get a friend to join", icon: "userPlus", earned: stats.referred >= 1, progress: Math.min(1, stats.referred) },
    { key: "sponsor_tier", label: "Sponsor Tier", desc: "Reach the Sponsor giving tier", icon: "gem", earned: stats.tier === "Sponsor", progress: 0 },
  ];

  return c.json({ stats, badges, level: stats.gifts, points: stats.cents / 100 });
});

// ---------- admin tax & compliance ----------

/** Taxable income = platform fees earned (donations + payouts + fee sweeps). */
async function taxSettings(env: Bindings): Promise<{ ratePct: number; dueDay: number; tin: string }> {
  const rate = Number(await getSetting(env, "tax_rate_pct")) || 4;
  const dueDay = Number(await getSetting(env, "tax_due_day")) || 14;
  const tin = (await getSetting(env, "tax_tin")) || "";
  return { ratePct: Math.min(100, Math.max(0, rate)), dueDay: Math.min(28, Math.max(1, dueDay)), tin };
}

app.get("/api/admin/tax", async (c) => {
  const admin = await requireStaff(c, "finance");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const settings = await taxSettings(c.env);
  // Monthly income from platform fees (confirmed donations + successful payouts).
  const monthly = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m', created_at) AS month,
            COALESCE(SUM(CASE WHEN kind='collection' THEN amount_cents ELSE 0 END),0) AS fees
     FROM lipila_logs WHERE kind = 'collection' AND status = 'success' AND created_at >= date('now', '-11 months', 'start of month')
     GROUP BY month ORDER BY month ASC`
  ).all<Record<string, any>>();

  const feesTotal = (await c.env.DB.prepare(
    "SELECT COALESCE(SUM(platform_fee_cents),0) AS s FROM contributions WHERE status = 'confirmed'"
  ).first<{ s: number }>())?.s ?? 0;
  const payoutFees = (await c.env.DB.prepare(
    "SELECT COALESCE(SUM(platform_fee_cents),0) AS s FROM withdrawals WHERE status = 'success'"
  ).first<{ s: number }>())?.s ?? 0;

  const now = new Date();
  const nextDue = new Date(now.getFullYear(), now.getMonth(), settings.dueDay);
  if (nextDue < now) nextDue.setMonth(nextDue.getMonth() + 1);

  return c.json({
    settings,
    totalIncomeCents: feesTotal + payoutFees,
    monthly: monthly.results.map((r) => ({
      month: r.month,
      incomeCents: Math.round(Number(r.fees) || 0),
      taxCents: Math.round((Number(r.fees) || 0) * settings.ratePct / 100),
    })),
    nextDue: `${nextDue.getFullYear()}-${String(nextDue.getMonth() + 1).padStart(2, "0")}-${String(nextDue.getDate()).padStart(2, "0")}`,
    daysUntilDue: Math.max(0, Math.ceil((nextDue.getTime() - now.getTime()) / 86400000)),
    compliance: [
      { id: "tax_turnover", label: "Turnover tax (est. rate)", done: settings.ratePct > 0, detail: `${settings.ratePct}% of platform fee income` },
      { id: "tin", label: "TPIN / TIN number", done: !!settings.tin, detail: settings.tin || "Not set — update in settings" },
      { id: "records", label: "Keep 5 years of records", done: true, detail: "Contributions + payouts are stored" },
      { id: "invoices", label: "Issue tax invoices", done: true, detail: "PDF receipts are generated for donors" },
      { id: "registration", label: "Business registration (PACRA)", done: true, detail: "Confirmed with owner" },
      { id: "psp", label: "Use a licensed PSP", done: true, detail: "Lipila is the licensed payment gateway" },
      { id: "data_protection", label: "Data Protection (Zambia DP Act 2021)", done: false, detail: "Appoint/register a Data Protection Officer; privacy policy published" },
      { id: "aml", label: "AML/CFT (FIC accountable institution)", done: false, detail: "Consider registering with the FIC once volumes grow" },
    ],
  });
});

app.post("/api/admin/tax", async (c) => {
  const admin = await requireStaff(c, "finance");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  if (body.ratePct != null) await setSetting(c.env, "tax_rate_pct", String(Math.min(100, Math.max(0, Math.round(Number(body.ratePct))))));
  if (body.dueDay != null) await setSetting(c.env, "tax_due_day", String(Math.min(28, Math.max(1, Math.round(Number(body.dueDay))))));
  if (body.tin != null) await setSetting(c.env, "tax_tin", String(body.tin).trim().slice(0, 50));
  return c.json({ ok: true });
});

/** Generates a smart tax invoice (PDF) for a given month (YYYY-MM). */
app.get("/api/admin/tax/invoice", async (c) => {
  const admin = await requireStaff(c, "finance");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const month = String(c.req.query("month") ?? "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: "month must be YYYY-MM" }, 400);

  const settings = await taxSettings(c.env);
  const rows = await c.env.DB.prepare(
    `SELECT kind, amount_cents, phone, status, created_at FROM lipila_logs
     WHERE strftime('%Y-%m', created_at) = ? AND status = 'success'
     ORDER BY created_at ASC LIMIT 2000`
  ).bind(month).all<Record<string, any>>();
  const incomeCents = rows.results.filter((r) => r.kind === "collection").reduce((s, r) => s + Number(r.amount_cents), 0);
  const taxCents = Math.round(incomeCents * settings.ratePct / 100);

  const doc = await PDFDocument.create();
  const page = doc.addPage([540, 720]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Kingdom Sponsor — Smart Tax Invoice", { x: 40, y: 680, size: 18, font: bold });
  page.drawText(`Period: ${month}`, { x: 40, y: 650, size: 12, font: body });
  page.drawText(`TPIN: ${settings.tin || "not set"}`, { x: 40, y: 632, size: 12, font: body });
  page.drawText(`Taxable platform fee income: K${(incomeCents / 100).toFixed(2)}`, { x: 40, y: 600, size: 13, font: body });
  page.drawText(`Estimated ${settings.ratePct}% turnover tax: K${(taxCents / 100).toFixed(2)}`, { x: 40, y: 580, size: 13, font: bold });
  page.drawText(`Due on the ${settings.dueDay}th of each month`, { x: 40, y: 560, size: 12, font: body });
  page.drawText(`Records: ${rows.results.length} settled transactions`, { x: 40, y: 540, size: 11, font: body });
  page.drawText("Generated " + new Date().toISOString().slice(0, 10), { x: 40, y: 40, size: 10, font: body });

  const pdfBytes = await doc.save();
  return new Response(pdfBytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="kingdom-sponsor-invoice-${month}.pdf"`,
    },
  });
});

// ---------- live sessions (host LIVE toggle + real-time donor feed) ----------

app.get("/api/campaigns/:id/live", async (c) => {
  const id = Number(c.req.param("id"));
  const live = (await getSetting(c.env, `live_${id}`)) === "1";
  return c.json({ live });
});

/** Host/admin starts or stops a live session for a campaign/event. */
app.post("/api/campaigns/:id/live", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const id = Number(c.req.param("id"));
  const campaign = await c.env.DB.prepare("SELECT host_user_id FROM campaigns WHERE id = ?").bind(id).first<{ host_user_id: number }>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  const admin = await requireAdmin(c);
  if (Number(campaign.host_user_id) !== Number(user.sub) && !admin) {
    return c.json({ error: "Only the host or an admin can toggle live" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const live = body.live === true;
  await setSetting(c.env, `live_${id}`, live ? "1" : "0");
  return c.json({ ok: true, live });
});

/** Live donor feed: latest confirmed gifts for a campaign/event. */
app.get("/api/campaigns/:id/live/donations", async (c) => {
  const id = Number(c.req.param("id"));
  const rows = await c.env.DB.prepare(
    `SELECT co.amount_cents, co.donor_name, co.is_anonymous, co.hide_amount, u.username, co.created_at
     FROM contributions co LEFT JOIN users u ON u.id = co.donor_user_id
     WHERE co.campaign_id = ? AND co.status = 'confirmed'
     ORDER BY co.created_at DESC LIMIT 25`
  ).bind(id).all<Record<string, any>>();
  return c.json({
    donations: rows.results.map((r) => {
      const anonymous = !!r.is_anonymous;
      const hideAmount = !!r.hide_amount;
      return {
        // Never leak a name the donor chose to keep private…
        name: anonymous ? "Anonymous" : (r.donor_name || r.username || "Giver"),
        // …and never leak an amount the donor hid. Show a dot instead so the
        // live feed stays lively without exposing hidden figures.
        amountCents: hideAmount ? null : r.amount_cents,
        hidden: hideAmount,
        createdAt: r.created_at,
      };
    }),
  });
});

// ---------- admin push broadcast ----------

const PUSH_GROUPS: Record<string, string> = {
  all: "All users",
  hosts: "Approved hosts",
  donors: "Donors (made a gift)",
};

app.get("/api/admin/push/groups", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  return c.json({ groups: PUSH_GROUPS });
});

/** Admin: send a broadcast push to all users, hosts or donors. */
app.post("/api/admin/push/broadcast", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  if (!envPushConfigured(c.env)) return c.json({ error: "Push not configured" }, 503);
  const body = await c.req.json();
  const group = String(body.group ?? "");
  const title = String(body.title ?? "").trim().slice(0, 100);
  const message = String(body.message ?? "").trim().slice(0, 500);
  if (!PUSH_GROUPS[group]) return c.json({ error: "Unknown group" }, 400);
  if (!title || !message) return c.json({ error: "Title and message are required" }, 400);

  const where: Record<string, string> = {
    all: "1=1",
    hosts: "host_status = 'approved'",
    donors: "EXISTS (SELECT 1 FROM contributions c WHERE c.donor_user_id = users.id AND c.status = 'confirmed')",
  };
  const rows = await c.env.DB.prepare(
    `SELECT DISTINCT dt.token, dt.user_id FROM device_tokens dt
     JOIN users u ON u.id = dt.user_id
     WHERE u.notifications_enabled = 1 AND ${where[group]} LIMIT 5000`
  ).all<{ token: string; user_id: number }>();
  const tokens = rows.results.map((r) => r.token);
  if (!tokens.length) return c.json({ ok: true, sentCount: 0, total: 0 });

  const result = await sendMulticastPush(fbEnv(c.env), tokens, title, message, { type: "broadcast" })
    .catch((e) => { console.error("broadcast push failed:", e); return { success: 0, failure: tokens.length, failedTokens: tokens as string[] }; });
  if (result.failedTokens.length) await pruneInvalidTokens(c.env, result.failedTokens);
  // Record in-app notifications for the recipients too.
  for (const uid of [...new Set(rows.results.map((r) => r.user_id))]) {
    await recordNotification(c.env, uid, "broadcast", title, message, { type: "broadcast" });
  }
  return c.json({ ok: true, sentCount: result.success, total: tokens.length });
});

/** Admin: send a test push to the requester's own devices (diagnostics). */
app.post("/api/admin/push/test", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  if (!envPushConfigured(c.env)) return c.json({ error: "Push not configured (FIREBASE secrets missing)" }, 503);
  const rows = await c.env.DB.prepare(
    "SELECT token FROM device_tokens WHERE user_id = ?"
  ).bind(admin.sub).all<{ token: string }>();
  const tokens = rows.results.map((r) => r.token);
  if (!tokens.length) {
    return c.json({ ok: false, error: "No device registered on this account yet — open the app so it registers itself, then try again." }, 200);
  }
  const result = await sendMulticastPush(fbEnv(c.env), tokens, "Kingdom Sponsor test",
    "Your notifications are working. This is a test from your admin dashboard.",
    { type: "test" })
    .catch((e) => { console.error("test push failed:", e); return { success: 0, failure: tokens.length, failedTokens: tokens as string[] }; });
  if (result.failedTokens.length) await pruneInvalidTokens(c.env, result.failedTokens);
  await recordNotification(c.env, admin.sub, "test", "Kingdom Sponsor test",
    "Your notifications are working. This is a test from your admin dashboard.", { type: "test" });
  return c.json({ ok: true, sentCount: result.success, total: tokens.length });
});

/** Admin: send a test push to ANY user by id (used from the push-reachability
 *  screen to verify a specific phone actually receives a notification). */
app.post("/api/admin/push/test-user", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  const userId = Number(body.userId) || 0;
  if (!userId) return c.json({ error: "userId required" }, 400);
  if (!envPushConfigured(c.env)) return c.json({ error: "Push not configured (FIREBASE secrets missing)" }, 503);
  const user = await c.env.DB.prepare(
    "SELECT id, username, name, phone FROM users WHERE id = ?"
  ).bind(userId).first<{ id: number; username: string; name: string | null; phone: string }>();
  if (!user) return c.json({ error: "User not found" }, 404);
  const rows = await c.env.DB.prepare(
    "SELECT token FROM device_tokens WHERE user_id = ?"
  ).bind(userId).all<{ token: string }>();
  const tokens = rows.results.map((r) => r.token);
  if (!tokens.length) {
    return c.json({ ok: false, error: "No device registered on this account yet — they need to open the app once to register.", sentCount: 0 }, 200);
  }
  const result = await sendMulticastPush(fbEnv(c.env), tokens, "Kingdom Sponsor test",
    "Your notifications are working — sent by your admin team. Check your phone!", { type: "test" })
    .catch((e) => { console.error("test-user push failed:", e); return { success: 0, failure: tokens.length, failedTokens: tokens as string[] }; });
  if (result.failedTokens.length) await pruneInvalidTokens(c.env, result.failedTokens);
  await recordNotification(c.env, userId, "test", "Kingdom Sponsor test",
    "Your notifications are working — sent by your admin team.", { type: "test" });
  const name = user.name || user.username || user.phone;
  return c.json({
    ok: true,
    message: `Test push sent to ${name}: ${result.success} of ${tokens.length} device${tokens.length === 1 ? "" : "s"} delivered.`,
    sentCount: result.success,
    total: tokens.length,
  });
});

/** User: send a test push to your own devices (notification diagnostics). */
app.post("/api/user/push/test", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not logged in" }, 401);
  if (!envPushConfigured(c.env)) return c.json({ error: "Push not configured (FIREBASE secrets missing)" }, 503);
  const rows = await c.env.DB.prepare(
    "SELECT token FROM device_tokens WHERE user_id = ?"
  ).bind(user.sub).all<{ token: string }>();
  const tokens = rows.results.map((r) => r.token);
  if (!tokens.length) {
    return c.json({ ok: false, error: "No device registered on this account yet — open the app so it registers itself, then try again." }, 200);
  }
  const result = await sendMulticastPush(fbEnv(c.env), tokens, "Kingdom Sponsor test",
    "Your notifications are working. This is a test from your device.",
    { type: "test" })
    .catch((e) => { console.error("test push failed:", e); return { success: 0, failure: tokens.length, failedTokens: tokens as string[] }; });
  if (result.failedTokens.length) await pruneInvalidTokens(c.env, result.failedTokens);
  await recordNotification(c.env, user.sub, "test", "Kingdom Sponsor test",
    "Your notifications are working. This is a test from your device.", { type: "test" });
  return c.json({ ok: true, message: `Test push sent to ${result.success} of ${tokens.length} device${tokens.length === 1 ? "" : "s"}`, sentCount: result.success });
});

// ---------- admin events analytics ----------

/** Admin: dedicated events stats — separate from campaigns. */
app.get("/api/admin/events/stats", async (c) => {
  const admin = await requireAnyStaff(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const base = "WHERE c.event_tiers IS NOT NULL AND c.event_tiers != ''";
  const active = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM campaigns c ${base} AND c.status = 'active'`
  ).first<{ n: number }>())?.n ?? 0;
  const total = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM campaigns c ${base}`
  ).first<{ n: number }>())?.n ?? 0;
  const sales = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(co.amount_cents),0) AS s, COALESCE(SUM(co.ticket_qty),0) AS t
     FROM contributions co JOIN campaigns c ON c.id = co.campaign_id
     WHERE co.status = 'confirmed' ${base.replace("WHERE c.", "AND c.")}`
  ).first<{ s: number; t: number }>();
  const sold = sales?.t ?? 0;
  const capacity = (await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN event_capacity > 0 THEN event_capacity ELSE 0 END),0) AS s, COUNT(*) AS n
     FROM campaigns c ${base} AND c.status = 'active' AND c.event_capacity > 0`
  ).first<{ s: number; n: number }>()) ?? { s: 0, n: 0 };
  const rsvps = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM event_rsvps"
  ).first<{ n: number }>())?.n ?? 0;
  const recent = await c.env.DB.prepare(
    `SELECT co.id, c.title, co.tier_name, co.ticket_qty, co.amount_cents, co.created_at
     FROM contributions co JOIN campaigns c ON c.id = co.campaign_id
     WHERE co.status = 'confirmed' ${base.replace("WHERE c.", "AND c.")}
     ORDER BY co.created_at DESC LIMIT 20`
  ).all<Record<string, any>>();
  const top = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.event_capacity, c.event_date,
            COALESCE(SUM(co.amount_cents),0) AS s, COALESCE(SUM(co.ticket_qty),0) AS t
     FROM campaigns c LEFT JOIN contributions co ON co.campaign_id = c.id AND co.status = 'confirmed'
     ${base} AND c.status = 'active'
     GROUP BY c.id ORDER BY t DESC LIMIT 10`
  ).all<Record<string, any>>();

  return c.json({
    stats: {
      totalEvents: total,
      activeEvents: active,
      ticketsSold: sold,
      ticketsSoldValueCents: sales?.s ?? 0,
      capacity: capacity.s,
      cappedEvents: capacity.n,
      sellThrough: capacity.s > 0 ? Math.min(100, Math.round(((sold) / capacity.s) * 100)) : 0,
      rsvps,
      avgTicketCents: sold > 0 ? Math.round((sales?.s ?? 0) / sold) : 0,
    },
    recentSales: recent.results.map((r) => ({
      id: r.id,
      title: r.title,
      tierName: r.tier_name ?? null,
      ticketQty: r.ticket_qty ?? 1,
      amountCents: r.amount_cents,
      createdAt: r.created_at,
    })),
    topEvents: top.results.map((r) => ({
      id: r.id,
      title: r.title,
      capacity: r.event_capacity ?? 0,
      eventDate: r.event_date ?? null,
      revenueCents: r.s ?? 0,
      sold: r.t ?? 0,
    })),
  });
});

// ---------- team chat room ----------

app.get("/api/admin/team/room", async (c) => {
  const team = await requireTeam(c);
  if (!team) return c.json({ error: "Team only" }, 403);
  const name = (await getSetting(c.env, "team_room_name")) || "Team Chat";
  return c.json({ name });
});

app.post("/api/admin/team/room", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  const name = String(body.name ?? "").trim().slice(0, 60);
  if (!name) return c.json({ error: "Room name required" }, 400);
  await setSetting(c.env, "team_room_name", name);
  return c.json({ ok: true, name });
});

// ---------- event attendee check-in (hosts scan QR codes at events) ----------

/** Host or admin of an event: check an attendee in by their phone number. */
app.post("/api/events/:id/check-in", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const eventId = Number(c.req.param("id"));
  const campaign = await c.env.DB.prepare("SELECT host_user_id, title FROM campaigns WHERE id = ?").bind(eventId).first<{ host_user_id: number; title: string }>();
  if (!campaign) return c.json({ error: "Event not found" }, 404);
  const admin = await requireAdmin(c);
  if (Number(campaign.host_user_id) !== Number(user.sub) && !admin) {
    return c.json({ error: "Only the host or an admin can check in attendees" }, 403);
  }
  const body = await c.req.json();
  const phone = normalizePhone(String(body.phone ?? ""));
  if (!phone) return c.json({ error: "Phone required" }, 400);

  const attendee = await c.env.DB.prepare(
    "SELECT id, phone, username, name FROM users WHERE phone = ?"
  ).bind(phone).first<{ id: number; phone: string; username: string; name: string | null }>();
  if (!attendee) return c.json({ error: "No user found for that code" }, 404);

  // Ticket verification: if a contribution id is provided, make sure this user
  // actually bought a ticket for THIS event before checking them in.
  const ticketId = Number(body.ticketId) || 0;
  if (ticketId > 0) {
    const ticket = await c.env.DB.prepare(
      `SELECT co.id, co.donor_user_id, co.tier_name, co.status
       FROM contributions co WHERE co.id = ? AND co.campaign_id = ?`
    ).bind(ticketId, eventId).first<{ id: number; donor_user_id: number | null; tier_name: string | null; status: string }>();
    if (!ticket || ticket.status !== "confirmed") {
      return c.json({ error: "This ticket is not valid for this event" }, 403);
    }
    if (ticket.donor_user_id && ticket.donor_user_id !== attendee.id) {
      return c.json({ error: "This ticket belongs to a different account" }, 403);
    }
    if (!ticket.tier_name) {
      return c.json({ error: "This is a donation, not a ticket" }, 403);
    }
  }

  const res = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO event_attendees (event_id, user_id) VALUES (?, ?)"
  ).bind(eventId, attendee.id).run();
  const first = (res.meta?.changes ?? 0) > 0;
  const checked = await c.env.DB.prepare(
    "SELECT checked_in_at FROM event_attendees WHERE event_id = ? AND user_id = ?"
  ).bind(eventId, attendee.id).first<{ checked_in_at: string }>();
  const total = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM event_attendees WHERE event_id = ?"
  ).bind(eventId).first<{ n: number }>())?.n ?? 0;

  // Notify the attendee they're in.
  await recordNotification(c.env, attendee.id, "check_in", "Checked in!",
    `You're checked in to "${campaign.title}". Enjoy the event!`, { type: "check_in", campaignId: String(eventId) });

  // Alert the admin team about a check-in at an event.
  await pushAdmins(c.env, "Event check-in",
    `${attendee.username ?? attendee.name ?? "Someone"} checked in to "${campaign.title}".`,
    { type: "check_in", campaignId: String(eventId) }).catch(() => {});

  return c.json({
    ok: true,
    first,
    total,
    attendee: {
      userId: attendee.id,
      username: attendee.username ?? "Giver",
      name: attendee.name ?? null,
      checkedInAt: checked?.checked_in_at ?? null,
    },
  });
});

/** Host or admin: list who has checked in to an event. */
app.get("/api/events/:id/attendees", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const eventId = Number(c.req.param("id"));
  const campaign = await c.env.DB.prepare("SELECT host_user_id, event_capacity FROM campaigns WHERE id = ?").bind(eventId).first<{ host_user_id: number; event_capacity: number }>();
  if (!campaign) return c.json({ error: "Event not found" }, 404);
  const admin = await requireAdmin(c);
  if (Number(campaign.host_user_id) !== Number(user.sub) && !admin) {
    return c.json({ error: "Host or admin only" }, 403);
  }
  const rows = await c.env.DB.prepare(
    `SELECT ea.id, ea.checked_in_at, u.username, u.name, u.phone
     FROM event_attendees ea JOIN users u ON u.id = ea.user_id
     WHERE ea.event_id = ? ORDER BY ea.checked_in_at DESC LIMIT 500`
  ).bind(eventId).all<Record<string, any>>();
  return c.json({
    total: rows.results.length,
    capacity: campaign.event_capacity ?? 0,
    attendees: rows.results.map((r) => ({
      username: r.username ?? "Giver",
      name: r.name ?? null,
      phone: r.phone,
      checkedInAt: r.checked_in_at,
    })),
  });
});

// ---------- event RSVP (free events: "I'm going") ----------

/** RSVP to an event (free attendance). Works signed out too (name + phone). */
app.post("/api/events/:id/rsvp", async (c) => {
  const user = await authUser(c);
  const eventId = Number(c.req.param("id"));
  const campaign = await c.env.DB.prepare("SELECT event_tiers, status, title FROM campaigns WHERE id = ?").bind(eventId).first<{ event_tiers: string | null; status: string; title: string }>();
  if (!campaign) return c.json({ error: "Event not found" }, 404);
  if (campaign.status !== "active") return c.json({ error: "Event is closed" }, 400);
  if (parseEventTiers(campaign.event_tiers).length > 0) {
    return c.json({ error: "This event sells tickets — buy a ticket instead." }, 400);
  }
  const body = await c.req.json();
  const phone = normalizePhone(String(body.phone ?? user?.phone ?? ""));
  if (!/^\+260\d{9}$/.test(phone)) {
    return c.json({ error: "Enter a valid Zambian phone number" }, 400);
  }
  const name = String(body.name ?? user?.username ?? "").trim().slice(0, 80) || null;
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO event_rsvps (event_id, user_id, name, phone) VALUES (?, ?, ?, ?)"
  ).bind(eventId, user?.sub ?? null, name, phone).run();
  if (user) {
    await recordNotification(c.env, user.sub, "rsvp", "You're going!",
      `Your RSVP for the event is confirmed. See you there!`, { type: "rsvp", campaignId: String(eventId) });
    await pushToUser(c.env, user.sub, "You're going!", "Your RSVP for the event is confirmed. See you there!", { type: "rsvp", campaignId: String(eventId) });
  }
  // Alert the admin team about every RSVP.
  await pushAdmins(c.env, "New event RSVP",
    `${name || user?.username || "Someone"} RSVP'd to "${campaign?.title ?? `event ${eventId}`}".`,
    { type: "rsvp", campaignId: String(eventId) }).catch(() => {});
  const total = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM event_rsvps WHERE event_id = ?"
  ).bind(eventId).first<{ n: number }>())?.n ?? 0;
  return c.json({ ok: true, rsvpCount: total });
});

/** Public RSVP count for an event. */
app.get("/api/events/:id/rsvp-count", async (c) => {
  const eventId = Number(c.req.param("id"));
  const total = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM event_rsvps WHERE event_id = ?"
  ).bind(eventId).first<{ n: number }>())?.n ?? 0;
  return c.json({ rsvpCount: total });
});

/** Team = superadmins + admin assistants (everyone who helps run the platform). */
async function requireTeam(c: any): Promise<TokenPayload | null> {
  const user = await authUser(c);
  if (!user) return null;
  if (isAdminPhone(c.env, user.phone)) return user;
  const row = await c.env.DB.prepare("SELECT 1 FROM admin_assistants WHERE user_id = ? LIMIT 1")
    .bind(user.sub).first();
  return row ? user : null;
}

app.get("/api/team/messages", async (c) => {
  const team = await requireTeam(c);
  if (!team) return c.json({ error: "Team only" }, 403);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), 300);
  const rows = await c.env.DB.prepare(
    "SELECT id, user_id, username, body, image_url, created_at FROM team_messages ORDER BY id DESC LIMIT ?"
  ).bind(limit).all<Record<string, any>>();
  return c.json({
    messages: rows.results.reverse().map((m) => ({
      id: m.id,
      userId: m.user_id,
      username: m.username ?? "Team",
      body: m.body,
      imageUrl: m.image_url ?? null,
      createdAt: m.created_at,
    })),
  });
});

app.post("/api/team/messages", async (c) => {
  const team = await requireTeam(c);
  if (!team) return c.json({ error: "Team only" }, 403);
  const body = await c.req.json();
  const text = String(body.body ?? "").trim().slice(0, 1000);
  const imageUrl = body.imageUrl != null ? String(body.imageUrl).slice(0, 500) || null : null;
  if (!text && !imageUrl) return c.json({ error: "Message cannot be empty" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO team_messages (user_id, username, body, image_url) VALUES (?, ?, ?, ?)"
  ).bind(team.sub, team.username ?? "Team", text, imageUrl).run();
  return c.json({ ok: true });
});

app.post("/api/team/upload", async (c) => {
  const team = await requireTeam(c);
  if (!team) return c.json({ error: "Team only" }, 403);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "Upload an image" }, 400);
  const type = file.type.toLowerCase();
  const ext = LOGO_TYPES[type];
  if (!ext) return c.json({ error: "Image must be PNG, JPG or WebP" }, 400);
  if (file.size > 5_000_000) return c.json({ error: "Image must be under 5 MB" }, 400);
  const key = `team/${Date.now()}-${team.sub}.${ext}`;
  await c.env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: type } });
  return c.json({ ok: true, url: `${c.env.APP_URL}/media/${key}` });
});

// ---------- admin host application editing ----------

/** Admin: edit an (approved or pending) host's application details in place. */
app.put("/api/admin/hosts/:id/application", async (c) => {
  const admin = await requireStaff(c, "campaigns");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  const org = body.org != null ? String(body.org).trim().slice(0, 200) : null;
  const role = body.role != null ? String(body.role).trim().slice(0, 200) : null;
  const reason = body.reason != null ? String(body.reason).trim().slice(0, 1000) : null;
  const orgType = body.orgType != null ? String(body.orgType).trim() : null;
  if (orgType !== null && !["individual", "ngo", "agency"].includes(orgType)) {
    return c.json({ error: "Invalid organisation type" }, 400);
  }
  const sets: string[] = [];
  const vals: any[] = [];
  if (org !== null) { sets.push("host_org = ?"); vals.push(org); }
  if (role !== null) { sets.push("host_role = ?"); vals.push(role); }
  if (reason !== null) { sets.push("host_reason = ?"); vals.push(reason); }
  if (orgType !== null) { sets.push("org_type = ?"); vals.push(orgType); }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);
  const userId = Number(c.req.param("id"));
  vals.push(userId);
  const res = await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: "Host not found" }, 404);
  await logAdminAction(c.env, admin.sub, "host_application_edit", "user", userId,
    `Edited host application for #${userId} (${org ?? role ?? orgType ?? "details"})`);
  return c.json({ ok: true });
});

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
  page.drawText("Kingdom Sponsor  •  Built with Purpose", { x: 50, y, size: 8, font, color: rgb(0.55, 0.55, 0.55) });

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

/** User: their purchased event tickets, each with a scannable code so hosts
 *  can check them in by scanning the QR from the phone. */
app.get("/api/me/tickets", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const rows = await c.env.DB.prepare(
    `SELECT co.id, co.tier_name, co.ticket_qty, co.amount_cents, co.confirmed_at,
            cam.id AS campaign_id, cam.title AS campaign_title, cam.event_date, cam.event_time, cam.event_venue,
            cam.event_capacity, cam.campaign_type
     FROM contributions co JOIN campaigns cam ON cam.id = co.campaign_id
     WHERE co.donor_user_id = ? AND co.status = 'confirmed'
       AND co.tier_name IS NOT NULL
     ORDER BY co.confirmed_at DESC LIMIT 100`
  ).bind(user.sub).all<Record<string, any>>();

  return c.json({
    tickets: rows.results.map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      campaignTitle: r.campaign_title,
      tierName: r.tier_name,
      ticketQty: r.ticket_qty ?? 1,
      amountCents: r.amount_cents,
      date: r.confirmed_at ?? r.created_at,
      eventDate: r.event_date ?? null,
      eventTime: r.event_time ?? null,
      eventVenue: r.event_venue ?? null,
      eventCapacity: r.event_capacity ?? 0,
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
    const ack = `Thanks for reaching out${user.username ? `, ${user.username}` : ""}! This is an automatic confirmation — your request #${ticketId} ("${subject}") has been received and an admin will reply here shortly.\n— ${assistantName}`;
    await c.env.DB.prepare(
      "UPDATE support_tickets SET admin_reply = ?, status = 'answered', updated_at = datetime('now', '+2 hours') WHERE id = ?"
    ).bind(ack, ticketId).run();
    await pushToUser(c.env, Number(user.sub), "We got your request",
      `Thanks for contacting us${user.username ? `, ${user.username}` : ""}! An admin will reply to "${subject}" shortly.\n— ${assistantName}`,
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
    // Admin answers: mark answered and notify the user (push only).
    await c.env.DB.prepare(
      "UPDATE support_tickets SET admin_reply = ?, status = 'answered', updated_at = datetime('now', '+2 hours') WHERE id = ?"
    ).bind(text, ticket.id).run();
    await pushOnly(c.env, ticket.user_id, "Support replied",
      `Your request "${ticket.subject}" has a new reply.`, { type: "ticket_reply", ticketId: String(ticket.id) });
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
  const admin = await requireStaff(c, "tickets");
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
  const admin = await requireStaff(c, "tickets");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json();
  const name = String(body.assistantName ?? "").trim();
  if (!name || name.length > 60) return c.json({ error: "Assistant name is required (max 60 characters)." }, 400);

  await setSetting(c.env, "support_assistant_name", name);
  return c.json({ ok: true, assistantName: name });
});

// ---------- admin: resolve a support ticket ----------

app.put("/api/admin/tickets/:id/resolve", async (c) => {
  const admin = await requireStaff(c, "tickets");
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

  await pushOnly(c.env, user.sub, "Delete request received",
    `We'll review your request to remove "${campaign.title}".`, { type: "delete_request", campaignId: String(campaign.id) });
  await pushAdmins(c.env,
    "Campaign delete request", `"${campaign.title}" wants to be removed.`).catch(() => {});

  return c.json({ ok: true });
});

app.get("/api/admin/delete-requests", async (c) => {
  const admin = await requireStaff(c, "campaigns");
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

  if (campaign.host_user_id) {
    await pushOnly(env, campaign.host_user_id, "Campaign removed", hostBody, { type: "campaign_deleted", campaignId: String(campaignId) });
  }

  // Alert the campaign's donors via push (SMS is reserved for transactions).
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
  if (host?.host_user_id) {
    await pushOnly(c.env, host.host_user_id, "Campaign restored",
      `"${campaign.title}" is live again after being restored by the administrator.`,
      { type: "campaign_restored", campaignId: String(campaignId) });
  }

  return c.json({ ok: true, message: `"${campaign.title}" restored.` });
});

/** List recent sensitive admin actions (restore-scoped staff can audit). */
app.get("/api/admin/actions", async (c) => {
  const admin = await requireStaff(c, "restore");
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

/** List soft-deleted campaigns (restorable) � superadmin or 'restore'-scoped staff. */
app.get("/api/admin/campaigns/deleted", async (c) => {
  const staff = await requireStaff(c, "restore");
  if (!staff) return c.json({ error: "Admin only" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.status, c.created_at, u.username AS host_name, u.host_verified, u.host_org AS host_org
     FROM campaigns c LEFT JOIN users u ON u.id = c.host_user_id
     WHERE c.status = 'deleted' ORDER BY c.created_at DESC LIMIT 100`
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
  const admin = await requireStaff(c, "campaigns");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?")
    .bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.status === "deleted") return c.json({ error: "Campaign already deleted." }, 400);

  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason ?? "").trim().slice(0, 500) || null;

  await deleteCampaign(c.env, campaign.id, reason);
  await logAdminAction(c.env, admin.sub, "campaign_delete", "campaign", campaign.id, reason ? `"${campaign.title}" � ${reason}` : `"${campaign.title}"`);
  await c.env.DB.prepare(
    "UPDATE campaign_delete_requests SET status = 'approved', resolved_at = datetime('now', '+2 hours') WHERE campaign_id = ? AND status = 'pending'"
  ).bind(campaign.id).run();

  return c.json({ ok: true, message: reason ? `Campaign deleted. Host and donors were alerted with your note.` : "Campaign deleted. Host and donors were alerted." });
});

app.post("/api/admin/delete-requests/:id/approve", async (c) => {
  const admin = await requireStaff(c, "campaigns");
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
  const admin = await requireStaff(c, "campaigns");
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
  if (campaign?.host_user_id) {
    await pushOnly(c.env, campaign.host_user_id, "Delete request declined",
      `Your request to remove "${campaign.title}" was declined.`, { type: "delete_request_rejected", campaignId: String(req.campaign_id) });
  }
  return c.json({ ok: true });
});

// ---------- Admin: review host campaign-edit requests ----------

app.get("/api/admin/edit-requests", async (c) => {
  const admin = await requireStaff(c, "campaigns");
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
  const admin = await requireStaff(c, "campaigns");
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
  if (proposed.waivePayoutFees !== undefined) { sets.push("waive_payout_fees = ?"); vals.push(proposed.waivePayoutFees ? 1 : 0); }
  if (proposed.eventCapacity !== undefined) { sets.push("event_capacity = ?"); vals.push(proposed.eventCapacity); }
  if (proposed.eventDate !== undefined) { sets.push("event_date = ?"); vals.push(proposed.eventDate); }
  if (proposed.eventTime !== undefined) { sets.push("event_time = ?"); vals.push(proposed.eventTime); }
  if (proposed.eventVenue !== undefined) { sets.push("event_venue = ?"); vals.push(proposed.eventVenue); }
  if ("eventTiers" in proposed) { sets.push("event_tiers = ?"); vals.push(proposed.eventTiers ? JSON.stringify(parseEventTiers(proposed.eventTiers)) : null); }
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
  if (campaign?.host_user_id) {
    await pushOnly(c.env, campaign.host_user_id, "Campaign update approved",
      `Your requested changes to "${campaign.title}" have been approved and applied.`,
      { type: "campaign_edit_approved", campaignId: String(req.campaign_id) });
  }
  return c.json({ ok: true, message: "Edit request approved and applied." });
});

app.post("/api/admin/edit-requests/:id/reject", async (c) => {
  const admin = await requireStaff(c, "campaigns");
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
    `Rejected edit request #${req.id}${notes ? ` � ${notes}` : ""}`);

  const campaign = await c.env.DB.prepare(
    "SELECT c.title, u.phone AS host_phone, u.id AS host_user_id FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(req.campaign_id).first<Record<string, any>>();
  if (campaign?.host_user_id) {
    await pushOnly(c.env, campaign.host_user_id, "Campaign update declined",
      `Your requested changes to "${campaign.title}" were declined.${notes ? ` Reason: ${notes}` : ""}`,
      { type: "campaign_edit_rejected", campaignId: String(req.campaign_id) });
  }
  return c.json({ ok: true });
});

// ---------- Admin: Ban/unban users, hosts, or phone numbers ----------

app.post("/api/admin/ban", async (c) => {
  const admin = await requireStaff(c, "users");
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
  const admin = await requireStaff(c, "users");
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
  const admin = await requireStaff(c, "users");
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
  const admin = await requireStaff(c, "users");
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
  const admin = await requireStaff(c, "users");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  return c.json({ threshold: await referralRewardThreshold(c.env) });
});

// ---------- event finder's commission + editable platform fees (admin) ----------

/** Admin: get event commission + editable fee config. */
app.get("/api/admin/event-commission", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const cfg = await adminFeeConfig(c.env);
  return c.json({
    enabled: (await getSetting(c.env, "event_commission_enabled")) === "true",
    finderFeeCents: Number(await getSetting(c.env, "event_commission_finder_fee_cents")) || 1000,
    cardFinderFeeCents: Number(await getSetting(c.env, "event_commission_card_finder_fee_cents")) || 1000,
    platformPct: cfg.platformPct,
    platformMinFeeCents: cfg.platformMinFeeCents,
    platformFixedFeeCents: cfg.platformFixedFeeCents,
    cardPlatformPct: cfg.cardPlatformPct,
    cardPlatformMinFeeCents: cfg.cardPlatformMinFeeCents,
    cardLipilaCollectionPct: cfg.cardLipilaCollectionPct,
    momoPct: cfg.lipilaCollectionPct,
  });
});

/** Admin: update event commission + fee config (all dashboard-editable). */
app.put("/api/admin/event-commission", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();

  if (typeof body.enabled === "boolean") {
    await setSetting(c.env, "event_commission_enabled", body.enabled ? "true" : "false");
  }
  const clamp = (v: unknown, min: number, max: number, dflt: number) => Math.min(max, Math.max(min, Math.round(Number(v) || dflt)));
  if (body.finderFeeCents !== undefined) {
    const v = clamp(body.finderFeeCents, 0, 100000, 1000);
    await setSetting(c.env, "event_commission_finder_fee_cents", String(v));
  }
  if (body.cardFinderFeeCents !== undefined) {
    const v = clamp(body.cardFinderFeeCents, 0, 100000, 1000);
    await setSetting(c.env, "event_commission_card_finder_fee_cents", String(v));
  }
  if (body.platformPct !== undefined) await setSetting(c.env, "platform_fee_pct", String(clamp(body.platformPct, 0, 100, 1)));
  if (body.platformMinFeeCents !== undefined) await setSetting(c.env, "platform_min_fee_cents", String(clamp(body.platformMinFeeCents, 0, 10000, 300)));
  if (body.platformFixedFeeCents !== undefined) await setSetting(c.env, "platform_fixed_fee_cents", String(clamp(body.platformFixedFeeCents, 0, 500, 48)));
  if (body.cardPlatformPct !== undefined) await setSetting(c.env, "card_platform_fee_pct", String(clamp(body.cardPlatformPct, 0, 100, 2)));
  if (body.cardPlatformMinFeeCents !== undefined) await setSetting(c.env, "card_platform_min_fee_cents", String(clamp(body.cardPlatformMinFeeCents, 0, 10000, 500)));
  if (body.cardLipilaCollectionPct !== undefined) await setSetting(c.env, "card_lipila_collection_fee_pct", String(Math.max(0, Math.min(50, Number(body.cardLipilaCollectionPct) || 2.5))));

  const cfg = await adminFeeConfig(c.env);
  return c.json({
    ok: true,
    enabled: (await getSetting(c.env, "event_commission_enabled")) === "true",
    finderFeeCents: Number(await getSetting(c.env, "event_commission_finder_fee_cents")) || 1000,
    cardFinderFeeCents: Number(await getSetting(c.env, "event_commission_card_finder_fee_cents")) || 1000,
    platformPct: cfg.platformPct,
    platformMinFeeCents: cfg.platformMinFeeCents,
    platformFixedFeeCents: cfg.platformFixedFeeCents,
    cardPlatformPct: cfg.cardPlatformPct,
    cardPlatformMinFeeCents: cfg.cardPlatformMinFeeCents,
    cardLipilaCollectionPct: cfg.cardLipilaCollectionPct,
    momoPct: cfg.lipilaCollectionPct,
  });
});

/** Admin: milestone thresholds (percentages) for donation celebration pushes. */
app.get("/api/admin/milestone-config", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  return c.json({ thresholds: await milestoneThresholds(c.env) });
});

app.put("/api/admin/milestone-config", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  const list: number[] = Array.isArray(body.thresholds)
    ? body.thresholds.map((n: any) => Number(n)).filter((n: number) => n > 0 && n <= 100)
    : String(body.thresholds ?? "").split(",").map((s) => Number(s.trim())).filter((n: number) => n > 0 && n <= 100);
  if (!list.length) return c.json({ error: "Enter at least one threshold (1–100)" }, 400);
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  await setSetting(c.env, "milestone_thresholds", sorted.join(","));
  return c.json({ ok: true, thresholds: sorted });
});

/** Admin: non-transactional SMS alerts config (all off by default). */
app.get("/api/admin/sms-alerts", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  return c.json({ config: await smsAlertConfig(c.env) });
});

app.put("/api/admin/sms-alerts", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  if (typeof body.master === "boolean") {
    await setSetting(c.env, "sms_alerts_master", body.master ? "true" : "false");
  }
  for (const key of SMS_ALERT_KEYS) {
    if (typeof body[key] === "boolean") {
      await setSetting(c.env, key, body[key] ? "true" : "false");
    }
  }
  return c.json({ ok: true, config: await smsAlertConfig(c.env) });
});

/** Admin: set or clear the per-event platform-fee waiver. */
app.put("/api/admin/campaigns/:id/waive-event-fees", async (c) => {
  const admin = await requireStaff(c, "campaigns");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const waive = body.waive === true;
  const res = await c.env.DB.prepare(
    "UPDATE campaigns SET waive_event_fees = ? WHERE id = ? AND (event_tiers IS NOT NULL AND event_tiers != '')"
  ).bind(waive ? 1 : 0, id).run();
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: "Event not found" }, 404);
  return c.json({ ok: true, waive });
});

app.put("/api/admin/referral-threshold", async (c) => {
  const admin = await requireStaff(c, "users");
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
  const admin = await requireStaff(c, "users");
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
  await pushOnly(c.env, user.id, "Referral reward earned", msg, { type: "referral_rewarded" });

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
  const out = await Promise.all(campaigns.results.map(async (row) => {
    const available = await availableBalance(c.env, row.id);
    return { ...(await campaignPublic(c.env, row)), availableCents: available, minWithdrawCents: row.min_withdraw_cents };
  }));

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
      assistantScopes: [...(await assistantScopes(c.env, user.sub))],
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
 * Admin capabilities for the signed-in user, exposed to the app so it can show
 * the right admin features. Superadmins get isAdmin=true; assistants get the
 * scope list they were granted (the app gates tiles/screens on these).
 */
async function adminInfo(env: Bindings, userId: number, phone: string): Promise<{ isAdmin: boolean; assistantScopes: string[] }> {
  if (isAdminPhone(env, phone)) return { isAdmin: true, assistantScopes: [] };
  const scopes = await assistantScopes(env, userId);
  return { isAdmin: false, assistantScopes: scopes.size ? [...scopes] : [] };
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

/** Auth for read-only dashboard stats/analytics: any admin staff member passes. */
async function requireAnyStaff(c: any): Promise<TokenPayload | null> {
  const user = await authUser(c);
  if (!user) return null;
  if (isAdminPhone(c.env, user.phone)) return user;
  const allowed = await assistantScopes(c.env, user.sub);
  return allowed.size ? user : null;
}

app.get("/api/admin/applications", async (c) => {
  const admin = await requireStaff(c, "campaigns");
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
  const admin = await requireStaff(c, "campaigns");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const r = await c.env.DB.prepare(
    "UPDATE users SET host_status = 'approved', is_host = 1, host_rejection = NULL WHERE id = ?"
  ).bind(c.req.param("id")).run();
  if (!r.meta.changes) return c.json({ error: "User not found" }, 404);
  return c.json({ ok: true });
});

app.post("/api/admin/applications/:id/reject", async (c) => {
  const admin = await requireStaff(c, "campaigns");
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
  const admin = await requireStaff(c, "campaigns");
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
  const admin = await requireStaff(c, "campaigns");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const approve = body.approve === true;
  const notes = String(body.notes ?? "").trim().slice(0, 500) || null;

  const res = await c.env.DB.prepare(
    "UPDATE users SET host_kyc_status = ?, host_kyc_notes = ?, host_verified = ? WHERE id = ?"
  ).bind(approve ? "approved" : "rejected", notes, approve ? 1 : 0, c.req.param("id")).run();
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: "User not found" }, 404);
  await logAdminAction(c.env, admin.sub, "host_kyc", "user", c.req.param("id"),
    `${approve ? "Approved" : "Rejected"} KYC${notes ? ` � ${notes}` : ""}`);

  const user = await c.env.DB.prepare("SELECT phone, username FROM users WHERE id = ?")
    .bind(c.req.param("id")).first<{ phone: string; username: string }>();
  if (user?.phone) {
    await pushToUser(c.env, Number(c.req.param("id")),
      approve ? "You're a verified host" : "Host verification updated",
      approve
        ? "Great news! Your identity document was approved � your campaigns now show the verified badge."
        : `Your host verification was not approved.${notes ? ` Reason: ${notes}` : ""}`,
      { type: "host_verified" }).catch((e) => console.error("kyc push failed:", e));
  }
  return c.json({ ok: true, kycStatus: approve ? "approved" : "rejected" });
});

app.get("/api/admin/promotions", async (c) => {
  const admin = await requireStaff(c, "campaigns");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const rows = await c.env.DB.prepare(
    `SELECT p.*, c.title AS campaign_title, c.campaign_type, c.event_tiers, u.phone AS host_phone
     FROM promotions p JOIN campaigns c ON c.id = p.campaign_id JOIN users u ON u.id = c.host_user_id
     ORDER BY p.created_at DESC LIMIT 50`
  ).all<Record<string, any>>();

  return c.json({
    promotions: rows.results.map((p) => ({
      id: p.id,
      campaignId: p.campaign_id,
      campaignTitle: p.campaign_title,
      isEvent: p.campaign_type === "event" || (p.event_tiers != null && p.event_tiers !== ""),
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
  const admin = await requireStaff(c, "campaigns");
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
  const admin = await requireStaff(c, "campaigns");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ? AND status != 'deleted'"
  ).bind(c.req.param("id")).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  if (campaign.promoted) return c.json({ error: "This campaign is already promoted." }, 400);
  if (await activePromotionCount(c.env) >= (await promoSlots(c.env))) {
    return c.json({ error: "All promotion slots are taken. End or un-promote one first." }, 409);
  }

  const body = await c.req.json().catch(() => ({}));
  let days = Math.round(Number(body.days));
  if (!Number.isFinite(days) || days < 1 || days > 30) days = await promoDays(c.env);
  const until = new Date(Date.now() + days * 86400000).toISOString();

  const referenceId = moneyRef("ADMIN", campaign.id);
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
    await pushOnly(c.env, host.user_id, "Your campaign is promoted",
      `"${campaign.title}" is now at the top of Kingdom Sponsor for ${days} days.`,
      { type: "promotion_active", campaignId: String(campaign.id) });
  }

  return c.json({ ok: true, days, until, message: `"${campaign.title}" is promoted to the top for ${days} days.` });
});

app.post("/api/admin/promotions/:id/reject", async (c) => {
  const admin = await requireStaff(c, "campaigns");
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
  const admin = await requireStaff(c, "campaigns");
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
  const admin = await requireStaff(c, "donations");
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
  const admin = await requireAnyStaff(c);
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
  const topList = await Promise.all(topCampaigns.results.map((row) => campaignPublic(c.env, row)));

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

  // Newest registrations so admins can see exactly who just joined.
  const recentUsers = await c.env.DB.prepare(
    `SELECT id, phone, username, name, host_status, created_at
     FROM users ORDER BY created_at DESC LIMIT 20`
  ).all<Record<string, any>>();

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

  const activeEvents = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM campaigns WHERE event_tiers IS NOT NULL AND event_tiers != '' AND status = 'active'"
  ).first<{ n: number }>())?.n ?? 0;
  const ticketSales = (await c.env.DB.prepare(
    `SELECT COALESCE(SUM(co.amount_cents),0) AS s, COALESCE(SUM(co.ticket_qty),0) AS t
     FROM contributions co JOIN campaigns c ON c.id = co.campaign_id
     WHERE co.status = 'confirmed' AND c.event_tiers IS NOT NULL AND c.event_tiers != ''`
  ).first<{ s: number; t: number }>()) ?? { s: 0, t: 0 };
  const pendingAnnouncements = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM announcements WHERE status = 'pending'"
  ).first<{ n: number }>())?.n ?? 0;
  const cardEmails = (await c.env.DB.prepare(
    "SELECT COUNT(DISTINCT email) AS n FROM contributions WHERE email IS NOT NULL AND email != '' AND status = 'confirmed'"
  ).first<{ n: number }>())?.n ?? 0;

  // Sponsor Desk coverage: how many opportunities exist / are published / active.
  const sponsorDesk = (await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM sponsor_desk) AS total,
       (SELECT COUNT(*) FROM sponsor_desk WHERE published = 1) AS published,
       (SELECT COUNT(*) FROM sponsor_desk WHERE status = 'active' AND published = 1) AS active`
  ).first<{ total: number; published: number; active: number }>()) ?? { total: 0, published: 0, active: 0 };

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
      activeEvents,
      ticketsSold: ticketSales.t,
      ticketsSoldValueCents: ticketSales.s,
      pendingAnnouncements,
      cardEmails,
      sponsorDeskTotal: sponsorDesk.total,
      sponsorDeskPublished: sponsorDesk.published,
      sponsorDeskActive: sponsorDesk.active,
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
    recentUsers: recentUsers.results.map((u) => ({
      id: u.id,
      phone: u.phone,
      username: u.username ?? "Giver",
      name: u.name ?? null,
      hostStatus: u.host_status ?? "none",
      createdAt: u.created_at,
    })),
  });
});

// ---------- admin analytics (charts) ----------

app.get("/api/admin/analytics", async (c) => {
  const admin = await requireAnyStaff(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);

  // Daily confirmed donation totals (last 30 days).
  const daily = await c.env.DB.prepare(
    `SELECT date(confirmed_at) AS day, COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS n
     FROM contributions WHERE status = 'confirmed' AND confirmed_at >= date('now', '-30 days')
     GROUP BY date(confirmed_at) ORDER BY day ASC`
  ).all<Record<string, any>>();

  // Per-campaign conversion: views -> gifts.
  const conversion = await c.env.DB.prepare(
    `SELECT c.id, c.title,
            (SELECT COUNT(*) FROM campaign_views v WHERE v.campaign_id = c.id) AS views,
            (SELECT COUNT(*) FROM contributions co WHERE co.campaign_id = c.id AND co.status = 'confirmed') AS gifts
     FROM campaigns c WHERE c.status = 'active' ORDER BY views DESC LIMIT 20`
  ).all<Record<string, any>>();

  // Top events by tickets sold.
  const topEvents = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.event_capacity,
            (SELECT COUNT(*) FROM contributions co WHERE co.campaign_id = c.id AND co.status = 'confirmed') AS sold
     FROM campaigns c WHERE c.event_tiers IS NOT NULL AND c.event_tiers != '' AND c.status = 'active'
     ORDER BY sold DESC LIMIT 10`
  ).all<Record<string, any>>();

  return c.json({
    daily: daily.results.map((r) => ({ day: r.day, cents: r.cents ?? 0, count: r.n ?? 0 })),
    conversion: conversion.results.map((r) => ({
      campaignId: r.id,
      title: r.title,
      views: r.views ?? 0,
      gifts: r.gifts ?? 0,
      rate: r.views && r.views > 0 ? Math.round(((r.gifts ?? 0) / r.views) * 1000) / 10 : 0,
    })),
    topEvents: topEvents.results.map((r) => ({
      campaignId: r.id,
      title: r.title,
      sold: r.sold ?? 0,
      capacity: r.event_capacity ?? 0,
    })),
  });
});

// ---------- host campaign analytics ----------

app.get("/api/campaigns/:id/analytics", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const id = Number(c.req.param("id"));
  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  const admin = await requireAdmin(c);
  if (Number(campaign.host_user_id) !== Number(user.sub) && !admin) {
    return c.json({ error: "Only the host or an admin can view analytics" }, 403);
  }

  const views = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM campaign_views WHERE campaign_id = ?"
  ).bind(id).first<{ n: number }>())?.n ?? 0;
  const gifts = (await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
  ).bind(id).first<{ n: number }>())?.n ?? 0;
  const raised = (await c.env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
  ).bind(id).first<{ s: number }>())?.s ?? 0;
  const attendees = (await c.env.DB.prepare(
    "SELECT COUNT(DISTINCT COALESCE(donor_user_id, phone)) AS n FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
  ).bind(id).first<{ n: number }>())?.n ?? 0;
  const shortUrl = `${c.env.APP_URL}/share/${id}`;
  const share = await c.env.DB.prepare(
    "SELECT clicks FROM short_links WHERE long_url = ?"
  ).bind(shortUrl).first<{ clicks: number }>();
  const shareClicks = share?.clicks ?? 0;
  const last14d = await c.env.DB.prepare(
    `SELECT date(confirmed_at) AS day, COALESCE(SUM(amount_cents),0) AS cents
     FROM contributions WHERE campaign_id = ? AND status = 'confirmed' AND confirmed_at >= date('now', '-13 days')
     GROUP BY date(confirmed_at) ORDER BY day ASC`
  ).bind(id).all<Record<string, any>>();

  const isEvent = !!(campaign.event_tiers && String(campaign.event_tiers).length > 2);
  const tiers = isEvent ? parseEventTiers(campaign.event_tiers) : [];
  const capacity = Math.max(0, Number(campaign.event_capacity) || 0);

  // Referral attribution: donations that arrived through a shared link that
  // carried a referral code, vs. direct (no code). Uses the registered
  // referrer on the donor (referralCodeProvider stamps users.referral_code).
  const referred = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(co.amount_cents),0) AS s
     FROM contributions co JOIN users u ON u.id = co.donor_user_id
     WHERE co.campaign_id = ? AND co.status = 'confirmed'
       AND u.referral_code IS NOT NULL AND u.referral_code != ''`
  ).bind(id).first<{ n: number; s: number }>()) ?? { n: 0, s: 0 };

  return c.json({
    views,
    gifts,
    raisedCents: raised,
    conversionRate: views > 0 ? Math.round((gifts / views) * 1000) / 10 : 0,
    shareClicks,
    last14d: last14d.results.map((r) => ({ day: r.day, cents: r.cents ?? 0 })),
    // Referral attribution.
    referredGifts: referred.n,
    referredCents: referred.s,
    referredRate: gifts > 0 ? Math.round((referred.n / gifts) * 1000) / 10 : 0,
    // Event analytics.
    isEvent,
    ticketsSold: gifts,
    ticketCapacity: capacity,
    revenueCents: raised,
    attendees,
    avgTicketCents: gifts > 0 ? Math.round(raised / gifts) : 0,
    sellThrough: capacity > 0 ? Math.min(100, Math.round((gifts / capacity) * 100)) : null,
    tierBreakdown: tiers.map((t) => ({ name: t.name, amountCents: t.amountCents })),
  });
});

// ---------- global search (campaigns / users / tickets / transactions) ----------

app.get("/api/search", async (c) => {
  const q = String(c.req.query("q") ?? "").trim().slice(0, 80);
  if (!q) return c.json({ campaigns: [], users: [], tickets: [], transactions: [] });
  const like = `%${q}%`;

  const campaigns = await c.env.DB.prepare(
    `SELECT c.*, u.username AS host_name, u.host_verified, u.host_org AS host_org
     FROM campaigns c LEFT JOIN users u ON u.id = c.host_user_id
     WHERE c.status = 'active' AND c.visibility = 'public'
       AND (c.campaign_type != 'event' OR c.campaign_type IS NULL)
       AND (c.event_tiers IS NULL OR c.event_tiers = '')
       AND (c.title LIKE ? OR c.description LIKE ? OR c.category LIKE ?)
     ORDER BY c.promoted DESC, c.created_at DESC LIMIT 20`
  ).bind(like, like, like).all<Record<string, any>>();
  const campaignOut = (await Promise.allSettled(campaigns.results.map((row) => campaignPublic(c.env, row))))
    .map((r) => {
      if (r.status === "fulfilled") return r.value;
      console.error("search campaign fail", r.reason);
      return null;
    })
    .filter((v): v is Record<string, any> => v != null);

  // The rest requires auth; richer data requires admin.
  const user = await authUser(c);
  if (!user) return c.json({ campaigns: campaignOut, users: [], tickets: [], transactions: [] });
  const admin = await requireAdmin(c);

  let users = { results: [] as Record<string, any>[] };
  let tickets = { results: [] as Record<string, any>[] };
  let transactions = { results: [] as Record<string, any>[] };

  if (admin) {
    users = await c.env.DB.prepare(
      "SELECT id, phone, username, name, host_status FROM users WHERE phone LIKE ? OR username LIKE ? OR COALESCE(name,'') LIKE ? ORDER BY created_at DESC LIMIT 20"
    ).bind(like, like, like).all<Record<string, any>>();
    tickets = await c.env.DB.prepare(
      `SELECT t.id, t.subject, t.status, u.username, u.phone
       FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id
       WHERE t.subject LIKE ? OR t.message LIKE ? OR u.phone LIKE ? OR u.username LIKE ?
       ORDER BY t.id DESC LIMIT 20`
    ).bind(like, like, like, like).all<Record<string, any>>();
    transactions = await c.env.DB.prepare(
      `SELECT co.id, co.amount_cents, co.status, co.phone, cam.title AS campaign_title
       FROM contributions co JOIN campaigns cam ON cam.id = co.campaign_id
       WHERE co.phone LIKE ? OR co.lipila_reference LIKE ? OR cam.title LIKE ?
       ORDER BY co.id DESC LIMIT 20`
    ).bind(like, like, like).all<Record<string, any>>();
  }

  return c.json({
    campaigns: campaignOut,
    users: users.results.map((u) => ({
      id: u.id, phone: u.phone, username: u.username ?? "Giver", name: u.name ?? null, hostStatus: u.host_status ?? "none",
    })),
    tickets: tickets.results.map((t) => ({
      id: t.id, subject: t.subject, status: t.status, username: t.username ?? "Giver", phone: t.phone ?? "",
    })),
    transactions: transactions.results.map((t) => ({
      id: t.id, amountCents: t.amount_cents, status: t.status, phone: t.phone, campaignTitle: t.campaign_title,
    })),
  });
});

// ---------- bulk SMS groups ----------

const SMS_GROUPS: Record<string, string> = {
  all_users: "All users",
  new_7d: "New users (last 7 days)",
  new_30d: "New users (last 30 days)",
  hosts: "Approved hosts",
  donors: "Donors (made a confirmed gift)",
  active_30d: "Active last 30 days",
};

app.get("/api/admin/sms/groups", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  return c.json({ groups: SMS_GROUPS });
});

app.post("/api/admin/sms/group", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  const group = String(body.group ?? "");
  const message = clampSms(String(body.message ?? "").trim());
  if (!SMS_GROUPS[group]) return c.json({ error: "Unknown group" }, 400);
  if (!message) return c.json({ error: "Enter a message" }, 400);

  const where: Record<string, string> = {
    all_users: "1=1",
    new_7d: "created_at >= datetime('now', '-7 days')",
    new_30d: "created_at >= datetime('now', '-30 days')",
    hosts: "host_status = 'approved'",
    donors: "EXISTS (SELECT 1 FROM contributions c WHERE c.donor_user_id = users.id AND c.status = 'confirmed')",
    active_30d: "last_login_at >= datetime('now', '-30 days')",
  };

  const rows = await c.env.DB.prepare(
    `SELECT id, phone FROM users WHERE ${where[group]} AND phone IS NOT NULL AND banned = 0 LIMIT 500`
  ).all<{ id: number; phone: string }>();

  let sent = 0, failed = 0;
  for (const r of rows.results) {
    try {
      await sendSms(c.env, r.phone, message);
      await recordNotification(c.env, r.id, "broadcast", "Kingdom Sponsor", message);
      sent++;
    } catch {
      failed++;
    }
  }
  return c.json({ ok: true, group, sentCount: sent, failedCount: failed, total: rows.results.length });
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
  const admin = await requireAnyStaff(c);
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
  const admin = await requireAnyStaff(c);
  if (!admin) return c.json({ error: "Admin only" }, 403);
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
  const admin = await requireStaff(c, "donations");
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
  const admin = await requireStaff(c, "donations");
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
  const admin = await requireStaff(c, "donations");
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

// ---------- Lipila diagnostic endpoint ----------
app.get("/api/admin/lipila-diagnostic", async (c) => {
  const admin = await requireStaff(c, "finance");
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
  const admin = await requireStaff(c, "donations");
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
  const admin = await requireStaff(c, "donations");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const DEFAULT_MIN_WITHDRAW = 20000;
  const cfg = loadFeeConfig(c.env);
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.host_user_id, u.phone AS hostPhone,
            c.min_withdraw_cents AS minWithdrawCents, c.waive_payout_fees AS waive_payout_fees
     FROM campaigns c JOIN users u ON u.id = c.host_user_id
     WHERE c.status = 'active'`
  ).all<Record<string, any>>();

  const eligible: Record<string, any>[] = [];
  for (const row of rows.results) {
    const available = await availableBalance(c.env, row.id);
    const minW = row.minWithdrawCents ?? DEFAULT_MIN_WITHDRAW;
    if (available < minW) continue;
    const waiveFees = !!row.waive_payout_fees;
    const payoutCents = waiveFees ? available : payoutAmountCents(available, cfg);
    const lipilaFee = waiveFees ? 0 : disbursementFeeCents(available, cfg);
    const platformFee = waiveFees ? 0 : platformDisbursementFeeCents(available, cfg);
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
      waiveFees,
    });
  }
  return c.json({ campaigns: eligible });
});

// ---------- Admin: disburse a specific campaign ----------

app.post("/api/admin/disburse", async (c) => {
  const admin = await requireStaff(c, "donations");
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
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json().catch(() => ({}));
  const userId = Number(body.userId) || admin.sub;

  const sent = await pushToUser(c.env, userId, "Kingdom Sponsor Test", "This is a test push notification from the admin dashboard.", { type: "test" });
  return c.json({ ok: true, message: `Test push sent (delivered to ${sent} device${sent === 1 ? "" : "s"})`, sent });
});

// ---------- Lipila wallet balance (superadmin) ----------

app.get("/api/admin/wallet-balance", async (c) => {
  const admin = await requireStaff(c, "finance");
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
  const admin = await requireStaff(c, "finance");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  const amountCents = Math.round(Number(body.amountCents) || 0);
  const phone = String(body.phone ?? "").trim();
  if (amountCents < 100) return c.json({ error: "Minimum withdraw is K1" }, 400);
  if (!phone || phone.length < 10) return c.json({ error: "Valid phone number required" }, 400);
  const referenceId = moneyRef("ADMIN-WITHDRAW", Date.now());
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
app.get("/api/admin/users", async (c) => {
  const admin = await requireStaff(c, "users");
  if (!admin) return c.json({ error: "Admin only" }, 403);

  const q = String(c.req.query("q") ?? "").trim().slice(0, 50);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), 500);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const like = q ? `%${q}%` : null;

  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.phone, u.username, u.name, u.avatar_url, u.host_status, u.host_org,
            u.org_type, u.last_login_at, u.host_kyc_status, u.host_kyc_type, u.host_kyc_doc_url,
            u.is_host, u.banned, u.ban_reason, u.referral_rewarded_at, u.created_at,
            (SELECT COALESCE(SUM(co.amount_cents),0) FROM contributions co WHERE co.donor_user_id = u.id AND co.status = 'confirmed') AS given_cents,
            (SELECT COUNT(*) FROM referrals r WHERE r.referrer_user_id = u.id) AS invites
     FROM users u
     WHERE (? IS NULL OR u.phone LIKE ? OR u.username LIKE ? OR COALESCE(u.name,'') LIKE ?)
     ORDER BY u.created_at DESC LIMIT ? OFFSET ?`
  ).bind(like, like, like, like, limit, offset).all<Record<string, any>>();

  return c.json({
    users: rows.results.map((u) => ({
      id: u.id,
      phone: u.phone,
      username: u.username ?? "Giver",
      name: u.name ?? null,
      avatarUrl: u.avatar_url ?? null,
      hostStatus: u.host_status ?? "none",
      hostOrg: u.host_org ?? null,
      orgType: u.org_type ?? null,
      lastLoginAt: u.last_login_at ?? null,
      kycStatus: u.host_kyc_status ?? "none",
      kycType: u.host_kyc_type ?? null,
      kycDocUrl: u.host_kyc_doc_url ?? null,
      isHost: !!u.is_host,
      banned: !!u.banned,
      banReason: u.ban_reason ?? null,
      referralRewardedAt: u.referral_rewarded_at ?? null,
      givenCents: u.given_cents ?? 0,
      invites: u.invites ?? 0,
      createdAt: u.created_at,
    })),
  });
});

/** Admin: list donor emails captured on card contributions (donations + tickets). */
app.get("/api/admin/emails", async (c) => {
  const staff = await requireStaff(c, "donations");
  if (!staff) return c.json({ error: "Admin only" }, 403);

  const q = String(c.req.query("q") ?? "").trim().slice(0, 80);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "200", 10) || 200, 1), 1000);
  const like = q ? `%${q}%` : null;

  const rows = await c.env.DB.prepare(
    `SELECT co.email, COALESCE(co.donor_name, u.username, 'Giver') AS donor,
            MAX(co.created_at) AS last_contribution,
            COUNT(*) AS contributions,
            SUM(co.amount_cents) AS total_cents
     FROM contributions co
     LEFT JOIN users u ON u.id = co.donor_user_id
     WHERE co.email IS NOT NULL AND co.email != '' AND co.status = 'confirmed'
       AND (? IS NULL OR co.email LIKE ? OR co.donor_name LIKE ?)
     GROUP BY co.email, COALESCE(co.donor_name, u.username, 'Giver')
     ORDER BY last_contribution DESC LIMIT ?`
  ).bind(like, like, like, limit).all<Record<string, any>>();

  const total = (await c.env.DB.prepare(
    "SELECT COUNT(DISTINCT email) AS n FROM contributions WHERE email IS NOT NULL AND email != '' AND status = 'confirmed'"
  ).first<{ n: number }>())?.n ?? 0;

  return c.json({
    total,
    emails: rows.results.map((r) => ({
      email: r.email,
      donor: r.donor,
      lastContribution: r.last_contribution,
      contributions: r.contributions,
      totalCents: r.total_cents ?? 0,
    })),
  });
});

app.get("/api/admin/users/search", async (c) => {
  const admin = await requireStaff(c, "users");
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
    return c.json({ error: "That phone belongs to a superadmin � already has full access." }, 400);
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
  const admin = await requireStaff(c, "campaigns");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT cam.*, u.username AS host_username FROM campaigns cam
     JOIN users u ON u.id = cam.host_user_id ORDER BY cam.created_at DESC`
  ).all<Record<string, any>>();

  const out = await Promise.all(rows.results.map(async (row) => {
    const pub = await campaignPublic(c.env, row);
    const available = await availableBalance(c.env, row.id);
    return { ...pub, hostUsername: row.host_username, availableCents: available, minWithdrawCents: row.min_withdraw_cents };
  }));
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
  // KYC documents are private � only admins can view them.
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

  // The campaign owner (host) may upload its own image; admins may upload any.
  const isOwner = Number(campaign.host_user_id) === Number(user.sub);
  const admin = await requireAdmin(c);
  if (!isOwner && !admin) return c.json({ error: "Admin or campaign owner only" }, 403);

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

// ---------- admin sample images (uploaded posters hosts/events can reuse) ----------

/** Public: the admin-uploaded sample images shown in the host/event create
 *  screens alongside the bundled ones. */
app.get("/api/sample-images", async (c) => {
  const raw = (await getSetting(c.env, "sample_images")) || "[]";
  let list: string[] = [];
  try { list = JSON.parse(raw); } catch { list = []; }
  return c.json({ images: list.filter((u): u is string => typeof u === "string" && u.startsWith("http")) });
});

/** Admin: list the uploaded sample images. */
app.get("/api/admin/sample-images", async (c) => {
  const staff = await requireAnyStaff(c);
  if (!staff) return c.json({ error: "Admin only" }, 403);
  const raw = (await getSetting(c.env, "sample_images")) || "[]";
  let list: string[] = [];
  try { list = JSON.parse(raw); } catch { list = []; }
  return c.json({ images: list });
});

/** Admin: upload a sample image hosts/events can use as a poster. */
app.post("/api/admin/sample-images", async (c) => {
  const staff = await requireStaff(c, "settings");
  if (!staff) return c.json({ error: "Admin only" }, 403);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "Upload an image" }, 400);
  const type = file.type.toLowerCase();
  const ext = LOGO_TYPES[type];
  if (!ext) return c.json({ error: "Photo must be PNG, JPG or WebP" }, 400);
  if (file.size > 3_000_000) return c.json({ error: "Photo must be under 3 MB" }, 400);

  const key = `samples/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await c.env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: type } });
  const url = `${c.env.APP_URL}/media/${key}`;

  const raw = (await getSetting(c.env, "sample_images")) || "[]";
  let list: string[] = [];
  try { list = JSON.parse(raw); } catch { list = []; }
  if (!list.includes(url)) list.push(url);
  await setSetting(c.env, "sample_images", JSON.stringify(list.slice(-30)));

  return c.json({ ok: true, url, images: list.slice(-30) });
});

/** Admin: remove a sample image. */
app.delete("/api/admin/sample-images", async (c) => {
  const staff = await requireStaff(c, "settings");
  if (!staff) return c.json({ error: "Admin only" }, 403);
  const url = String(c.req.query("url") ?? "").trim();
  if (!url) return c.json({ error: "url required" }, 400);
  const raw = (await getSetting(c.env, "sample_images")) || "[]";
  let list: string[] = [];
  try { list = JSON.parse(raw); } catch { list = []; }
  list = list.filter((u) => u !== url);
  await setSetting(c.env, "sample_images", JSON.stringify(list));
  return c.json({ ok: true });
});

// ---------- Sponsor Desk (curated grant / funding intelligence) ----------
// Admin curates 3-5 active grant & empowerment opportunities and publishes the
// batch to active campaign hosts. Hosts get the app's "Sponsor Desk" screen and
// a push/in-app notification so they keep coming back for funding intelligence,
// not just payment processing.

/** Public: active opportunities a host sees on the Sponsor Desk. */
app.get("/api/sponsor-desk", async (c) => {
  // Host-only feature: approved hosts (and staff) see the curated opportunities.
  // Ordinary donors never see this feed or its push.
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const staff = await requireAnyStaff(c);
  if (!staff) {
    const host = await c.env.DB.prepare(
      "SELECT host_status FROM users WHERE id = ?"
    ).bind(user.sub).first<{ host_status: string }>();
    if (!host || host.host_status !== "approved") {
      return c.json({ error: "Only approved hosts can view the Sponsor Desk" }, 403);
    }
  }
  // The host's active campaign categories -> eligibility match scoring.
  const hostCats = (await c.env.DB.prepare(
    `SELECT DISTINCT c.category FROM campaigns c
     WHERE c.host_user_id = ? AND c.status = 'active' AND c.category IS NOT NULL`
  ).bind(user.sub).all<{ category: string }>()).results.map((r) => r.category);
  const rows = await c.env.DB.prepare(
    `SELECT id, title, description, organization, category, amount_label, deadline, link,
            audience, match_categories, applied_count, published_at
     FROM sponsor_desk
     WHERE status = 'active' AND published = 1
     ORDER BY COALESCE(deadline, '9999') ASC, published_at DESC
     LIMIT 50`
  ).all<Record<string, any>>();
  return c.json({
    opportunities: rows.results.map((o) => {
      const matchList = String(o.match_categories ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const matched = matchList.length === 0 || hostCats.some((hc) => matchList.includes(hc));
      return {
        id: o.id,
        title: o.title,
        description: o.description,
        organization: o.organization,
        category: o.category,
        amountLabel: o.amount_label,
        deadline: o.deadline ?? null,
        link: o.link,
        audience: o.audience,
        matched,
        appliedCount: o.applied_count ?? 0,
        publishedAt: o.published_at ?? null,
      };
    }),
  });
});

/** Admin: full list (drafts + published + archived) for management. */
app.get("/api/admin/sponsor-desk", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT sd.*, u.username AS created_by_name
     FROM sponsor_desk sd LEFT JOIN users u ON u.id = sd.created_by
     ORDER BY sd.created_at DESC LIMIT 200`
  ).all<Record<string, any>>();
  return c.json({
    opportunities: rows.results.map((o) => ({
      id: o.id,
      title: o.title,
      description: o.description,
      organization: o.organization,
      category: o.category,
      amountLabel: o.amount_label,
      deadline: o.deadline ?? null,
      link: o.link,
      audience: o.audience,
      status: o.status,
      published: !!o.published,
      publishedAt: o.published_at ?? null,
      createdAt: o.created_at,
      createdByName: o.created_by_name ?? null,
      matchCategories: String(o.match_categories ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      appliedCount: o.applied_count ?? 0,
    })),
  });
});

/** Admin: create or update an opportunity (draft by default). */
app.post("/api/admin/sponsor-desk", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  const title = String(body.title ?? "").trim().slice(0, 200);
  if (!title) return c.json({ error: "Title is required" }, 400);
  const description = String(body.description ?? "").trim().slice(0, 4000);
  const organization = String(body.organization ?? "").trim().slice(0, 200);
  const category = String(body.category ?? "Grant").trim().slice(0, 60);
  const amountLabel = String(body.amountLabel ?? "").trim().slice(0, 120);
  const link = String(body.link ?? "").trim().slice(0, 1000);
  if (link && !/^https?:\/\//.test(link)) {
    return c.json({ error: "link must be a full http(s) URL" }, 400);
  }
  let deadline: string | null = null;
  if (body.deadline) {
    const parsed = new Date(String(body.deadline));
    if (isNaN(parsed.getTime())) return c.json({ error: "deadline must be a valid date" }, 400);
    deadline = parsed.toISOString().slice(0, 10);
  }
  const audience = ["hosts", "events", "all"].includes(body.audience) ? String(body.audience) : "hosts";
  // Optional categories this opportunity is a good fit for (comma list).
  const matchCats = Array.isArray(body.matchCategories)
    ? body.matchCategories.map((c: any) => String(c).trim()).filter(Boolean).slice(0, 8).join(",")
    : String(body.matchCategories ?? "").trim().slice(0, 300);

  const id = body.id ? Number(body.id) : 0;
  if (id > 0) {
    const existing = await c.env.DB.prepare("SELECT id FROM sponsor_desk WHERE id = ?").bind(id).first();
    if (!existing) return c.json({ error: "Opportunity not found" }, 404);
    await c.env.DB.prepare(
      `UPDATE sponsor_desk SET title = ?, description = ?, organization = ?, category = ?,
       amount_label = ?, deadline = ?, link = ?, audience = ?, match_categories = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(title, description, organization, category, amountLabel, deadline, link, audience, matchCats, id).run();
    return c.json({ ok: true, id });
  }

  const res = await c.env.DB.prepare(
    `INSERT INTO sponsor_desk (title, description, organization, category, amount_label, deadline, link, audience, match_categories, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(title, description, organization, category, amountLabel, deadline, link, audience, matchCats, admin.sub).run();
  return c.json({ ok: true, id: res.meta.last_row_id }, 201);
});

/** Admin or host: mark an opportunity as applied so the team sees interest. */
app.post("/api/sponsor-desk/:id/apply", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare(
    "UPDATE sponsor_desk SET applied_count = applied_count + 1 WHERE id = ?"
  ).bind(id).run();
  await pushAdmins(c.env, "Sponsor Desk application",
    `${user.username ?? "A host"} applied to a funding opportunity.`,
    { type: "sponsor_desk" }).catch(() => {});
  return c.json({ ok: true });
});

/** Admin: publish a batch of draft/active opportunities to active hosts. */
app.post("/api/admin/sponsor-desk/publish", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return c.json({ error: "Pick at least one opportunity to publish" }, 400);
  const placeholders = ids.map(() => "?").join(",");
  const rows = await c.env.DB.prepare(
    `SELECT id, title, organization, deadline FROM sponsor_desk WHERE id IN (${placeholders})`
  ).bind(...ids).all<Record<string, any>>();
  const picked = rows.results;
  if (!picked.length) return c.json({ error: "No matching opportunities found" }, 404);
  await c.env.DB.prepare(
    `UPDATE sponsor_desk SET published = 1, published_at = COALESCE(published_at, datetime('now')) WHERE id IN (${placeholders})`
  ).bind(...ids).run();

  // Push + in-app notification to ACTIVE hosts (approved hosts with an active
  // campaign). These are the hosts most likely to apply for a grant today.
  const hostRows = await c.env.DB.prepare(
    `SELECT DISTINCT u.id, u.phone FROM users u
     WHERE u.host_status = 'approved'
       AND u.notifications_enabled = 1
       AND EXISTS (SELECT 1 FROM campaigns c WHERE c.host_user_id = u.id AND c.status = 'active')`
  ).all<{ id: number; phone: string }>();
  const title = `New funding opportunities (${picked.length})`;
  const firstLine = picked.slice(0, 3).map((p) => `• ${p.title}`).join("\n");
  const bodyText = `Your weekly Sponsor Desk is in: ${picked.length} new grant/empowerment opportunities.\n${firstLine}\n\nOpen the app to apply.`;
  let sentCount = 0;
  for (const host of hostRows.results) {
    const tokens = await c.env.DB.prepare("SELECT token FROM device_tokens WHERE user_id = ?")
      .bind(host.id).all<{ token: string }>();
    if (!tokens.results.length) continue;
    const result = await sendMulticastPush(fbEnv(c.env), tokens.results.map((t) => t.token),
      title, `New funding opportunities are on your Sponsor Desk — tap to view.`,
      { type: "sponsor_desk", opportunityCount: String(picked.length) })
      .catch((e) => { console.error("sponsor desk push failed:", e); return { success: 0, failure: 0, failedTokens: [] as string[] }; });
    sentCount += result.success;
    if (result.failedTokens.length) await pruneInvalidTokens(c.env, result.failedTokens);
    await recordNotification(c.env, host.id, "sponsor_desk", title,
      `${picked.length} new grant/empowerment opportunities are on your Sponsor Desk.`, { type: "sponsor_desk" });
    // Optional SMS alert (toggle off by default).
    await sendAlertSms(c.env, "sms_alert_sponsor_desk", host.phone,
      `${picked.length} new funding opportunities on your Sponsor Desk. Open the app to apply.`);
  }
  // Let the team know the batch went out (and who published it).
  await pushAdmins(c.env, "Sponsor Desk published",
    `${picked.length} opportunities sent to ${hostRows.results.length} active hosts.`,
    { type: "sponsor_desk" }).catch(() => {});
  return c.json({ ok: true, published: picked.length, hostsNotified: hostRows.results.length, sentCount });
});

/** Admin: toggle an opportunity's status (active <-> archived). */
app.post("/api/admin/sponsor-desk/:id/status", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const status = body.status === "archived" ? "archived" : "active";
  const res = await c.env.DB.prepare(
    "UPDATE sponsor_desk SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(status, id).run();
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: "Opportunity not found" }, 404);
  return c.json({ ok: true, status });
});

/** Admin: permanently delete an opportunity. */
app.delete("/api/admin/sponsor-desk/:id", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM sponsor_desk WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---------- public share page (WhatsApp links + QR-friendly) ----------
// Orange app theme, and a full payment flow (mobile money PIN prompt or card)
// so ANYONE — including iPhone users without the app — can give or buy event
// tickets straight from the shared link. Payments run through the same
// contribute endpoints and lipila_logs as the app.

const SHARE_STYLE = "body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:linear-gradient(160deg,#431407 0%,#7c2d12 40%,#E65100 100%);background-attachment:fixed;color:#fef3e2;display:flex;min-height:100vh;align-items:flex-start;justify-content:center;padding:20px 14px}.card{max-width:430px;width:100%;background:#fff;border-radius:20px;padding:22px;color:#1c1917;box-shadow:0 20px 50px rgba(0,0,0,.45);margin-top:14px}h1{font-size:21px;margin:0 0 6px;color:#1c1917;line-height:1.25}.sub{color:#78716c;font-size:13.5px;line-height:1.5;margin:0 0 12px}.amt{font-size:26px;font-weight:800;color:#E65100;margin:4px 0 10px}.brand{color:#FCD34D;font-weight:800;letter-spacing:.4px;font-size:13px;margin-bottom:10px}.sec{font-size:14px;font-weight:800;color:#1c1917;margin:16px 0 8px}.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{border:1.5px solid #d6d3d1;border-radius:10px;padding:9px 13px;font-size:13.5px;font-weight:700;background:#fff;color:#1c1917;cursor:pointer}.chip.sel{background:#E65100;border-color:#E65100;color:#fff}label{font-size:12px;font-weight:700;color:#57534e;display:block;margin:12px 0 4px}input{width:100%;box-sizing:border-box;border:1.5px solid #d6d3d1;border-radius:10px;padding:11px 12px;font-size:15px;outline:none}input:focus{border-color:#E65100}.pay{display:block;width:100%;box-sizing:border-box;border:none;border-radius:12px;padding:14px;font-size:15px;font-weight:800;cursor:pointer;margin-top:12px;color:#fff;background:linear-gradient(90deg,#E65100,#f97316)}.pay.card{background:#1c1917}.pay.wa{background:#25D366;color:#06281b;margin-top:8px}.pay.ghost{background:#fff;color:#E65100;border:1.5px solid #E65100;margin-top:8px}.pay:disabled{opacity:.6}.note{font-size:12px;color:#78716c;line-height:1.5;margin:10px 0 0;text-align:center}.ok{display:none;background:#ecfdf5;border:1px solid #6ee7b7;color:#065f46;border-radius:12px;padding:14px;font-size:14px;font-weight:600;margin-top:12px;line-height:1.5}.bad{display:none;background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;border-radius:12px;padding:14px;font-size:14px;font-weight:600;margin-top:12px;line-height:1.5}.wait{display:none;background:#fff7ed;border:1px solid #fdba74;color:#9a3412;border-radius:12px;padding:16px;font-size:14px;font-weight:600;margin-top:12px;line-height:1.6}.tier{border:1.5px solid #d6d3d1;border-radius:12px;padding:11px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;cursor:pointer}.tier.sel{border-color:#E65100;background:#fff7ed}.tier .tn{font-weight:800;font-size:14px}.tier .tp{color:#E65100;font-weight:800;font-size:13.5px}.qty{display:flex;align-items:center;gap:10px;justify-content:center;margin-top:10px}.qty button{width:38px;height:38px;border-radius:10px;border:1.5px solid #d6d3d1;background:#fff;font-size:18px;font-weight:800;color:#1c1917;cursor:pointer}.qty .qv{font-size:16px;font-weight:800;min-width:34px;text-align:center}.deep{display:block;text-align:center;color:#E65100;font-weight:700;font-size:13.5px;text-decoration:none;margin-top:14px}.foot{color:#fda4af;font-size:11.5px;text-align:center;margin-top:14px;line-height:1.5}.pill{display:inline-block;background:#E65100;color:#fff;font-size:11px;font-weight:800;border-radius:12px;padding:3px 10px;margin-bottom:8px}img.thumb{width:96px;height:96px;border-radius:16px;object-fit:cover;margin-bottom:12px;border:3px solid #FCD34D}.row{display:flex;gap:8px}.row .pay{margin-top:12px;flex:1}";

function escHtml(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function jsonSafe(v: unknown): string {
  return JSON.stringify(v ?? null).replace(/</g, "\\u003c");
}

/** Full interactive share page: give / buy tickets / RSVP + pay with PIN. */
function sharePageHtml(opts: {
  env: Bindings; pub: Record<string, any>; id: string; refQuery: string; pageUrl: string;
  wa: string; endsLine: string; ogImage: string; verifiedBadge: string; hostLine: string;
}): string {
  const { env, pub, id, refQuery, pageUrl, wa, endsLine, ogImage, verifiedBadge, hostLine } = opts;
  const tiers = Array.isArray(pub.eventTiers) ? pub.eventTiers : [];
  const isEvent = tiers.length > 0;
  const goalLine = pub.hasGoal
    ? `<div class="amt">${formatKwacha(pub.raisedCents)} raised of ${formatKwacha(pub.goalCents)}</div>`
    : `<div class="amt">${formatKwacha(pub.raisedCents)} raised</div>`;
  const appScheme = isEvent ? `kingdomsponsor://event/${id}` : `kingdomsponsor://campaign/${id}`;
  const appSchemeLink = appScheme + (refQuery ? "?ref=" + refQuery.slice(1) : "");
  const priceHTML = isEvent
    ? tiers.map((t, i) =>
        `<div class="tier" id="tier${i}" onclick="pickTier(${i})"><span class="tn">${escHtml(t.name)}</span><span class="tp">${formatKwacha(t.amountCents)}</span></div>`
      ).join("")
    : "";
  const presetsHTML = isEvent
    ? ""
    : [5000, 10000, 25000, 50000, 100000, 250000].map((p) =>
        `<button type="button" class="chip${p === 10000 ? " sel" : ""}" onclick="preset(${p},this)">${formatKwacha(p)}</button>`
      ).join("");
  const soldLine = isEvent && pub.eventCapacity > 0
    ? `<div class="note">${pub.ticketsSold}/${pub.eventCapacity} tickets sold</div>`
    : "";
  const freeRsvp = isEvent ? "" : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="${escHtml(pub.title)}"><meta property="og:description" content="${escHtml(pub.blurb)}">
<meta property="og:type" content="website"><meta property="og:url" content="${escHtml(pageUrl)}">${ogImage}
<meta name="theme-color" content="#E65100"><title>${escHtml(pub.title)} - Kingdom Sponsor</title>
<style>${SHARE_STYLE}</style></head><body>
<div class="card">
  <div class="brand">Kingdom Sponsor</div>
  ${pub.imageUrl ? `<img class="thumb" src="${escHtml(pub.imageUrl)}" alt="">` : ""}
  <h1>${escHtml(pub.title)}</h1>
  ${verifiedBadge}${hostLine}
  <p class="sub">${escHtml(pub.blurb)}</p>
  ${goalLine}
  ${isEvent && pub.eventVenue ? `<p class="sub">${escHtml(pub.eventVenue)}${pub.eventDate ? " &middot; " + escHtml(pub.eventDate) : ""}</p>` : ""}
  ${soldLine}
  <div id="formArea">
    ${isEvent ? `<div class="sec">Choose a ticket tier</div>${priceHTML}<div class="sec">How many?</div>
      <div class="qty"><button type="button" onclick="qty(-1)">&minus;</button><span class="qv" id="qv">1</span><button type="button" onclick="qty(1)">+</button></div>
      <label>Total: <b id="total" style="color:#E65100"></b></label>` : `<div class="sec">Choose an amount</div><div class="chips">${presetsHTML}
      <button type="button" class="chip" id="chipCust" onclick="preset(0,this)">Custom</button></div>`}
    <label>Your mobile money number</label>
    <input id="phone" inputmode="tel" placeholder="+260 97 000 0000">
    <label>Your name (optional)</label>
    <input id="name" placeholder="e.g. Pastor John">
    ${isEvent ? "" : `<label>How much? (K)</label><input id="custom" inputmode="numeric" placeholder="e.g. 100" style="display:none">`}
    <label>Email for card (required for card)</label>
    <input id="email" inputmode="email" placeholder="you@example.com">
    ${isEvent ? `<div class="note">iPhone? Pay right here with mobile money or card — no app needed.</div>` : `<div class="note">iPhone? You can give right here — no app needed. You'll get a payment prompt on your phone.</div>`}
    <button class="pay" id="btnMomo" onclick="start('momo')">${isEvent ? "Buy ticket with Mobile Money" : "Give with Mobile Money"}</button>
    <button class="pay card" id="btnCard" onclick="start('card')">${isEvent ? "Buy ticket by Card" : "Give by Card"}</button>
  </div>
  <div class="wait" id="waitPanel"><b>Check your phone</b><br><span id="waitMsg">A payment prompt has been sent to your mobile money — enter your PIN to complete it.</span><br><span id="refLine" style="font-size:12px;color:#78716c;margin-top:6px;display:block"></span><br><button class="pay ghost" onclick="location.reload()">Cancel</button></div>
  <div class="ok" id="okPanel"><b>Thank you!</b><br><span id="okMsg">Your payment is confirmed. The host has been notified.</span></div>
  <div class="bad" id="badPanel"><b>Payment not completed</b><br><span id="badMsg">The payment did not go through. You can try again.</span><br><button class="pay ghost" onclick="location.reload()">Try again</button></div>
  <a class="deep" href="${appSchemeLink}">Open in the Kingdom Sponsor app</a>
  <button class="pay wa" onclick="window.open('${escHtml(wa)}','_blank')">Share on WhatsApp</button>
  <a class="pay ghost" style="display:block;text-align:center;text-decoration:none" href="https://play.google.com/store/apps/details?id=com.kingdomsponsor.app" target="_blank">No app? Get it on Play Store</a>
  <div class="foot">${pub.donorCount ?? 0} givers &middot; ${endsLine}</div>
</div>
<script>
var CAMPAIGN=${jsonSafe({ id: Number(id) })};
var TIERS=${jsonSafe(tiers)};
var IS_EVENT=${isEvent ? "true" : "false"};
var CUR={ amount:10000, tier:0, qty:1 };
function byId(x){return document.getElementById(x);}
function fmt(c){return "K"+(c/100).toFixed(2);}
function preset(p,el){
  CUR.amount=p;
  var chips=document.querySelectorAll(".chip");for(var i=0;i<chips.length;i++){chips[i].classList.remove("sel");}
  if(el){el.classList.add("sel");}
  byId("custom").style.display=(p===0)?"block":"none";
  if(p>0){byId("custom").value="";}
}
function pickTier(i){CUR.tier=i;CUR.amount=TIERS[i].amountCents;
  var t=document.querySelectorAll(".tier");for(var k=0;k<t.length;k++){t[k].classList.remove("sel");}
  byId("tier"+i).classList.add("sel");total();
}
function qty(d){CUR.qty=Math.min(10,Math.max(1,CUR.qty+d));byId("qv").textContent=CUR.qty;total();}
function total(){var c=TIERS[CUR.tier].amountCents*CUR.qty;byId("total").textContent=fmt(c);}
function esc(s){var d=document.createElement("div");d.textContent=s||"";return d.innerHTML;}
function start(method){
  var phone=byId("phone").value.trim();
  var name=byId("name").value.trim();
  var email=byId("email")?byId("email").value.trim():"";
  var cust=byId("custom")?parseFloat(byId("custom").value.replace(/,/g,"")):NaN;
  var amountCents;
  if(IS_EVENT){amountCents=TIERS[CUR.tier].amountCents*CUR.qty;}
  else if(CUR.amount===0){if(!(cust>0)){alert("Enter an amount");return;}amountCents=Math.round(cust*100);}
  else{amountCents=CUR.amount;}
  if(amountCents<500){alert("Minimum is K5.00");return;}
  if(method==="card" && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)){alert("Enter your email address for the card receipt.");return;}
  if(!/^\\+?260[0-9]{9}$/.test(phone.replace(/[\\s-]/g,""))){alert("Enter a valid Zambian number, e.g. +260 97 000 0000");return;}
  localStorage.setItem("ksPhone",phone);
  var body={amountCents:amountCents,phone:phone,donorName:name};
  if(IS_EVENT){body.tierName=TIERS[CUR.tier].name;body.ticketQty=CUR.qty;}
  if(method==="card"){body.email=email;}
  var path="/api/campaigns/"+CAMPAIGN.id+"/"+(method==="card"?"contribute-card":"contribute");
  byId("btnMomo").disabled=true;byId("btnCard").disabled=true;
  fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
  .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
  .then(function(res){
    if(res.ok && res.j.referenceId){
      byId("refLine").textContent="Reference: "+res.j.referenceId;
      if(method==="card" && res.j.cardRedirectionUrl){byId("waitMsg").innerHTML="Complete your payment in the secure checkout window that just opened.";window.open(res.j.cardRedirectionUrl,"_blank");}
      byId("formArea").style.display="none";byId("badPanel").style.display="none";
      byId("waitPanel").style.display="block";byId("okPanel").style.display="none";
      poll(res.j.referenceId);
    }else{byId("btnMomo").disabled=false;byId("btnCard").disabled=false;alert(res.j.error||"Could not start the payment. Try again.");}
  }).catch(function(e){byId("btnMomo").disabled=false;byId("btnCard").disabled=false;alert("Network error. Please try again.");});
}
function poll(ref){
  var tries=0;
  var t=setInterval(function(){
    tries++;
    if(tries>60){clearInterval(t);byId("waitPanel").style.display="none";byId("badPanel").style.display="block";byId("badMsg").textContent="We're still waiting for your payment. If you completed it, it may take a moment to reflect.";return;}
    fetch("/api/contributions/status/"+ref).then(function(r){return r.json();}).then(function(j){
      if(j.status==="confirmed"){clearInterval(t);byId("waitPanel").style.display="none";
        byId("okMsg").innerHTML="Your "+((IS_EVENT)?"ticket is confirmed!":"payment is confirmed!")+" The host has been notified and your reference is "+esc(ref)+".";
        byId("okPanel").style.display="block";}
      else if(j.status==="failed"){clearInterval(t);byId("waitPanel").style.display="none";byId("badPanel").style.display="block";byId("badMsg").textContent="The payment did not go through. Please try again.";}
    }).catch(function(){});},3000);
}
var saved=localStorage.getItem("ksPhone");if(saved){byId("phone").value=saved;}
if(IS_EVENT){total();}
</script>
</body></html>`;
}

function embedWidgetHtml(env: Bindings, campaign: Record<string, any>, pub: Record<string, any>): string {
  const id = campaign.id;
  const goalLine = pub.hasGoal
    ? `<div class="amt">${formatKwacha(pub.raisedCents)} of ${formatKwacha(pub.goalCents)} raised</div>`
    : `<div class="amt">${formatKwacha(pub.raisedCents)} raised</div>`;
  const img = pub.imageUrl ? `<img src="${pub.imageUrl}" alt="" style="width:64px;height:64px;border-radius:12px;margin-bottom:12px;object-fit:cover;border:2px solid #FCD34D">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(pub.title)} - Kingdom Sponsor</title><style>body{font-family:system-ui,sans-serif;margin:0;background:transparent;color:#fef3e2;display:flex;min-height:100%;align-items:center;justify-content:center;padding:16px}.card{max-width:360px;width:100%;background:linear-gradient(160deg,#7c2d12,#E65100);border:1px solid #FCD34D55;border-radius:16px;padding:20px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{color:#ffedd5;line-height:1.5;margin:0 0 16px}.amt{font-size:22px;font-weight:700;color:#FCD34D;margin-bottom:16px}a.btn{display:block;background:#FCD34D;color:#431407;font-weight:700;text-decoration:none;padding:12px;border-radius:10px}a.btn2{display:block;background:#fff;color:#E65100;font-weight:700;text-decoration:none;padding:12px;border-radius:10px;margin-top:8px}.foot{color:#ffedd5;font-size:11px;margin-top:12px}</style></head><body><div class="card">${img}<h1>${escHtml(pub.title)}</h1><p>${escHtml(pub.blurb)}</p>${goalLine}<a class="btn" href="${env.APP_URL}/share/${id}" target="_top">Give on Kingdom Sponsor</a><a class="btn2" href="kingdomsponsor://${pub.eventTiers?.length ? "event" : "campaign"}/${id}">Open in app</a><div class="foot">${pub.donorCount ?? 0} givers</div></div></body></html>`;
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
  const endsLine = pub.endsAt ? "ends " + new Date(pub.endsAt).toLocaleDateString() : "";
  const ogImage = pub.imageUrl ? `<meta property="og:image" content="${escHtml(pub.imageUrl)}">` : "";
  const verifiedBadge = pub.hostVerified
    ? `<span class="pill">\u2713 Verified host</span>`
    : "";
  const hostLine = pub.hostName
    ? `<div style="color:#78716c;font-size:12px;margin-bottom:8px">Hosted by ${escHtml(pub.hostName)}${pub.hostVerified ? " &middot; verified" : ""}</div>`
    : "";
  return c.html(sharePageHtml({ env: c.env, pub, id, refQuery, pageUrl, wa, endsLine, ogImage, verifiedBadge, hostLine }));
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
    "SELECT id, title FROM campaigns WHERE status = 'active' AND visibility = 'public' AND (campaign_type != 'event' OR campaign_type IS NULL) AND (event_tiers IS NULL OR event_tiers = '') ORDER BY created_at DESC LIMIT 5"
  ).all<{ id: number; title: string }>();
  const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const rows = top.results.map((t) => `<a class="btn2" href="${c.env.APP_URL}/share/${t.id}${refQuery}">${escHtml(t.title)}</a>`).join("");
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta property=\"og:title\" content=\"Kingdom Sponsor\"><meta property=\"og:description\" content=\"Give to campaigns in Zambia.\"><meta name=\"theme-color\" content=\"#E65100\"><title>Kingdom Sponsor</title><style>" + SHARE_STYLE + "</style></head><body><div class=\"card\"><div class=\"brand\">Kingdom Sponsor</div><h1>Kingdom Sponsor</h1><p class=\"sub\">Choose a campaign to support:</p>" + rows + "<div class=\"foot\">Kingdom Sponsor</div></div></body></html>";
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
      "SELECT id, title FROM campaigns WHERE status = 'active' AND visibility = 'public' AND (campaign_type != 'event' OR campaign_type IS NULL) AND (event_tiers IS NULL OR event_tiers = '') ORDER BY created_at DESC LIMIT 10"
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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Accept link — Kingdom Sponsor</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;padding:24px;max-width:420px;margin:0 auto;text-align:center}h1{font-size:22px;margin:0 0 12px;color:#34d399}p{color:#94a3b8;line-height:1.5}a.btn{display:block;background:#25D366;color:#06281b;font-weight:700;text-decoration:none;padding:14px;border-radius:10px;margin:12px 0}a.btn2{display:block;background:#334155;color:#cbd5e1;font-weight:700;text-decoration:none;padding:12px;border-radius:10px;margin:12px 0}</style></head><body><h1>Accept account link?</h1><p>${row.sender_username ?? "Someone"} wants to link their account to yours as ${row.link_type}.</p><a class="btn" href="${deepLink}">Open in app to accept</a><a class="btn2" href="https://play.google.com/store/apps/details?id=com.kingdomsponsor.app">Don't have the app? Get it on Play Store</a></body></html>`;
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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Decline link — Kingdom Sponsor</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;padding:24px;max-width:420px;margin:0 auto;text-align:center}h1{font-size:22px;margin:0 0 12px;color:#34d399}p{color:#94a3b8;line-height:1.5}a.btn{display:block;background:#ef4444;color:#fff;font-weight:700;text-decoration:none;padding:14px;border-radius:10px;margin:12px 0}a.btn2{display:block;background:#334155;color:#cbd5e1;font-weight:700;text-decoration:none;padding:12px;border-radius:10px;margin:12px 0}</style></head><body><h1>Decline account link?</h1><p>Decline the link request from ${row.sender_username ?? "someone"}.</p><a class="btn" href="${deepLink}">Open in app to decline</a><a class="btn2" href="https://play.google.com/store/apps/details?id=com.kingdomsponsor.app">Don't have the app? Get it on Play Store</a></body></html>`;
  return c.html(html);
});

app.get("/privacy", (c) => {
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Privacy Policy — Kingdom Sponsor</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;padding:24px;max-width:800px;margin:0 auto;line-height:1.6}h1{font-size:24px;margin:0 0 16px;color:#34d399}h2{font-size:18px;margin:24px 0 8px;color:#94a3b8}p{margin:0 0 12px}ul{margin:0 0 12px;padding-left:20px}li{margin:4px 0}a{color:#34d399}</style></head><body><h1>Privacy Policy</h1><p><strong>Last updated:</strong> August 2026</p><p>Kingdom Sponsor (\"we,\" \"our,\" or \"us\") operates a fundraising platform that allows users to donate to campaigns and hosts to create and manage fundraising campaigns. This privacy policy describes how we collect, use, and protect your personal data.</p><h2>1. Information We Collect</h2><h3>1.1 Account Data</h3><ul><li><strong>Phone number</strong> — required for registration and OTP-based authentication via Africa's Talking SMS</li><li><strong>Username</strong> — chosen during registration</li><li><strong>User ID</strong> — internally generated identifier</li></ul><h3>1.2 Donation Data</h3><ul><li><strong>Amount donated</strong> (in ngwee/cents)</li><li><strong>Donor name</strong> (optional, can be anonymous)</li><li><strong>Phone number</strong> — used for Lipila payment prompts and SMS notifications</li><li><strong>Transaction reference ID</strong> — unique identifier for each donation</li><li><strong>Campaign ID</strong> — the campaign being supported</li></ul><h3>1.3 Campaign Data</h3><ul><li><strong>Campaign title, description, and goal</strong></li><li><strong>Campaign status</strong> (active, draft, ended)</li><li><strong>Logo URL</strong> (if uploaded by the host)</li><li><strong>Sponsor count and amounts</strong></li></ul><h3>1.4 Payment Data</h3><ul><li><strong>Lipila collection and disbursement references</strong></li><li><strong>Payment status</strong> (pending, success, failed, cancelled)</li><li><strong>Platform fees and Lipila fees</strong> (calculated automatically)</li></ul><h3>1.5 USSD Session Data</h3><ul><li><strong>Session ID</strong> — temporary identifier for USSD interactions</li><li><strong>Phone number</strong> — the user's phone dialing the USSD code</li><li><strong>Menu selections</strong> — choices made during the USSD flow</li><li><strong>Donation amount and reference</strong> — recorded when a USSD donation is confirmed</li></ul><h3>1.6 Technical Data</h3><ul><li><strong>IP address</strong> — logged automatically by Cloudflare</li><li><strong>User agent and device information</strong> — collected by the Flutter app</li><li><strong>FCM tokens</strong> — used for push notifications (stored per device)</li></ul><h2>2. How We Use Your Data</h2><ul><li><strong>Authentication</strong> — your phone number is used to send and verify OTPs via Africa's Talking SMS</li><li><strong>Payment processing</strong> — donation amounts and phone numbers are sent to Lipila for mobile money transactions</li><li><strong>SMS notifications</strong> — we send transaction confirmations and pledge reminders via Africa's Talking</li><li><strong>USSD interactions</strong> — your USSD session data is processed in real time to provide the interactive menu experience</li><li><strong>Campaign management</strong> — campaign data is displayed publicly (except donor phone numbers, which are never exposed)</li><li><strong>Analytics and reporting</strong> — aggregated, anonymised data is used for platform statistics and admin dashboards</li><li><strong>Fee calculation</strong> — platform fees and Lipila fees are calculated and deducted automatically from each transaction</li></ul><h2>3. Data Storage</h2><ul><li>All data is stored in <strong>Cloudflare D1</strong> (SQLite) databases</li><li>Media files (campaign logos) are stored in <strong>Cloudflare R2</strong></li><li>No data is stored on our own servers — all infrastructure is provided by Cloudflare</li></ul><h2>4. Data Retention</h2><ul><li><strong>Contributions and transactions</strong> — retained indefinitely for financial records</li><li><strong>USSD session data</strong> — not persisted; processed in real time and discarded after the session ends</li><li><strong>User accounts</strong> — retained until the account is deleted</li><li><strong>Campaigns</strong> — retained until the host ends the campaign</li><li><strong>Payout/withdrawal records</strong> — retained indefinitely</li></ul><h2>5. Data Sharing</h2><p>We do not sell your personal data. We share data only with:</p><ul><li><strong>Lipila</strong> — for payment processing (phone number, amount, reference ID)</li><li><strong>Africa's Talking</strong> — for SMS and USSD services (phone number, session data)</li><li><strong>Cloudflare</strong> — as our infrastructure provider (IP address, technical data)</li><li><strong>Firebase</strong> — for FCM push notifications (device tokens)</li></ul><h2>6. Your Rights</h2><p>You have the right to:</p><ul><li><strong>Access</strong> — request a copy of your personal data</li><li><strong>Rectification</strong> — correct inaccurate information</li><li><strong>Erasure</strong> — request deletion of your account and associated data</li><li><strong>Portability</strong> — receive your data in a machine-readable format</li><li><strong>Object</strong> — object to processing of your data for direct marketing</li></ul><p>To exercise any of these rights, contact us through the platform or reach out to the superadmin.</p><h2>7. Security</h2><ul><li>All API endpoints are protected by JWT authentication</li><li>Phone numbers are never exposed publicly</li><li>Payment data is processed by Lipila and never stored in full</li><li>USSD session data is processed in real time and not persisted</li><li>We use HTTPS for all data transmission</li></ul><h2>8. Children's Privacy</h2><p>Kingdom Sponsor is not intended for users under the age of 13. We do not knowingly collect data from children.</p><h2>9. Changes to This Policy</h2><p>We may update this privacy policy from time to time. Changes will be posted on this page with a new \"Last updated\" date.</p><h2>10. Contact</h2><p>For privacy-related inquiries, contact the platform administrator or the superadmin phone number configured in the backend.</p><p><strong>Platform:</strong> Kingdom Sponsor<br><strong>Backend:</strong> https://kingdom-sponsor-api.godfreymoseskalambo.workers.dev<br><strong>GitHub:</strong> https://github.com/Carpso/chisomo</p></body></html>";
  return c.html(html);
});

app.get("/delete-account", (c) => {
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Delete Account — Kingdom Sponsor</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;padding:24px;max-width:600px;margin:0 auto;line-height:1.6}h1{font-size:24px;margin:0 0 16px;color:#34d399}h2{font-size:18px;margin:24px 0 8px;color:#94a3b8}p{margin:0 0 12px}ul{margin:0 0 12px;padding-left:20px}li{margin:4px 0}a{color:#34d399}</style></head><body><h1>Delete Account</h1><h2>Kingdom Sponsor</h2><p><strong>In the app:</strong> open the app, tap the settings icon, then \"Delete account\". Your account and personal data are deleted immediately.</p><p><strong>By email:</strong> email <strong>support@kingdom-sponsor.app</strong> with the subject \"Delete Account\" and the phone number associated with your account. Requests are processed within 30 days.</p><h2>Data Deleted</h2><ul><li>Username and profile information</li><li>Pledge records</li><li>User links</li><li>FCM device tokens</li><li>Donor name and identity on contributions</li></ul><h2>Data Retained</h2><ul><li>Transaction records (required for financial compliance) — retained for 7 years</li><li>Anonymized analytics — retained indefinitely</li><li>Audit logs — retained for 1 year</li></ul><p>If you simply want to stop receiving SMS notifications, you can reply STOP to any SMS from us.</p></body></html>";
  return c.html(html);
});

app.get("/", (c) => c.json({ name: "Kingdom Sponsor API", version: "0.3.0", pushConfigured: envPushConfigured(c.env) }));

// ---------- Push notification diagnostic (admin) ----------

app.get("/api/admin/push-status", async (c) => {
  const admin = await requireStaff(c, "settings");
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

/** Admin: per-user push reachability — who has a registered device token (can
 *  be pushed even with the app closed) vs. who hasn't opened the app yet. */
app.get("/api/admin/push-users", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const q = String(c.req.query("q") ?? "").trim().slice(0, 60);
  const like = `%${q}%`;

  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.phone, u.username, u.name, u.host_status, u.created_at, u.last_login_at,
            u.notifications_enabled,
            (SELECT COUNT(*) FROM device_tokens dt WHERE dt.user_id = u.id) AS token_count,
            (SELECT MAX(dt.last_seen_at) FROM device_tokens dt WHERE dt.user_id = u.id) AS token_last_seen_at
     FROM users u
     WHERE ? = '' OR u.phone LIKE ? OR u.username LIKE ? OR COALESCE(u.name,'') LIKE ?
     ORDER BY token_count DESC, u.created_at DESC
     LIMIT 300`
  ).bind(q, like, like, like).all<Record<string, any>>();

  return c.json({
    users: rows.results.map((u) => ({
      id: u.id,
      phone: u.phone,
      username: u.username ?? "Giver",
      name: u.name ?? null,
      hostStatus: u.host_status ?? "none",
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at ?? null,
      notificationsEnabled: u.notifications_enabled == 1,
      tokenCount: u.token_count ?? 0,
      tokenLastSeenAt: u.token_last_seen_at ?? null,
      reachable: (u.token_count ?? 0) > 0,
    })),
    summary: {
      total: rows.results.length,
      reachable: rows.results.filter((u) => (u.token_count ?? 0) > 0).length,
      notReachable: rows.results.filter((u) => (u.token_count ?? 0) === 0).length,
    },
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
      // 15-minute cron: intruder alert scan, MNO health check, auto-disburse,
      // + airtime fulfillment so paid-but-undelivered airtime is retried fast.
      if (controller.cron === "*/15 * * * *") {
        ctx.waitUntil(runIntruderAlerts(env));
        ctx.waitUntil(refreshMnoHealth(env));
        ctx.waitUntil(runAutoDisburse(env));
        ctx.waitUntil(runAirtimeFulfillment(env));
        return;
      }
      // Hourly cron: event countdown reminders (48h / 2h).
      if (controller.cron === "0 * * * *") {
        ctx.waitUntil(runEventReminders(env));
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
      ctx.waitUntil(runWeeklyReport(env));
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
          "SELECT id, title FROM campaigns WHERE status = 'active' AND visibility = 'public' AND (campaign_type != 'event' OR campaign_type IS NULL) AND (event_tiers IS NULL OR event_tiers = '') ORDER BY promoted DESC, created_at DESC LIMIT 5"
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
  const admin = await requireStaff(c, "settings");
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

  // Alert the admin team about a badge purchase (revenue signal).
  await pushAdmins(c.env, "Verified Host badge purchased",
    `${user.username ?? "A host"} subscribed to the ${tier} badge (${formatKwacha(priceCents)}).`,
    { type: "badge_activated" }).catch(() => {});

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

// Get airtime provider list (public - shows which supplier is configured).
app.get("/api/airtime/providers", async (c) => {
  return c.json({ providers: airtimeProviders(), current: getAirtimeProvider(c.env).id });
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
  if (costCents <= 0) return c.json({ error: "Amount is fully covered by credits — enter an amount above your credits." }, 400);

  const referenceId = moneyRef("AIR", user.sub);
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

  // Alert the admin team about every airtime order placed.
  await pushAdmins(c.env, "New airtime order",
    `${user.username ?? "A user"} ordered ${formatKwacha(amountCents)} of ${network} airtime for ${phone}.`,
    { type: "airtime_sent" }).catch(() => {});

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

/** Deliver airtime for a paid order through the configured provider
 *  (MTN MoMo for Zambia; Africa's Talking for other markets; manual = admin
 *  fulfils by hand). Moves the order to `sent` and stores the provider's
 *  requestId so the status callback can confirm real MNO delivery. */
async function fulfillAirtimeOrder(env: Bindings, orderId: number): Promise<void> {
  const order = await env.DB.prepare("SELECT * FROM airtime_orders WHERE id = ?")
    .bind(orderId).first<Record<string, any>>();
  if (!order || order.status !== "paid") return;
  try {
    const provider = getAirtimeProvider(env);
    const requestId = await sendAirtime(env, order.phone, order.amount_cents / 100);
    await env.DB.prepare(
      "UPDATE airtime_orders SET status = 'sent', at_request_id = ?, sent_at = datetime('now', '+2 hours'), completed_at = NULL, error = NULL WHERE id = ?"
    ).bind(requestId || null, orderId).run();
    // Manual provider has no status callback: if we're using it, the admin
    // confirms delivery from the dashboard (never auto-complete).
    if (provider.id !== "manual") {
      const msg = airtimeSentSms(order.amount_cents);
      const user = await env.DB.prepare("SELECT phone FROM users WHERE id = ?")
        .bind(order.user_id).first<{ phone: string }>();
      await smsAndPush(env, order.user_id, user?.phone ?? null, msg,
        "Airtime sent", `Your airtime order for ${order.phone} has been submitted.`, { type: "airtime_sent" });
    } else {
      const user = await env.DB.prepare("SELECT phone FROM users WHERE id = ?")
        .bind(order.user_id).first<{ phone: string }>();
      await smsAndPush(env, order.user_id, user?.phone ?? null, `KSPONSOR: Your ${formatKwacha(order.amount_cents)} airtime order for ${order.phone} is being processed by our team.`,
        "Airtime processing", `Your airtime order for ${order.phone} is being processed.`, { type: "airtime_sent" });
    }
    console.log("[AIRTIME] order", orderId, "sent via", provider.id, "; requestId =", requestId);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 500);
    const lower = msg.toLowerCase();
    // Permanent failures: AT product not enabled/disabled on the account, bad
    // credentials, or a telco rejection � retrying will never help, so stop
    // burning attempts and mark it clearly for admin review/refund.
    const permanent =
      lower.includes("not enabled") || lower.includes("disabled") ||
      lower.includes("invalid apikey") || lower.includes("invalid api key") ||
      lower.includes("authentication failed") || lower.includes("unauthorised") ||
      lower.includes("invalid phone") || lower.includes("cannot send to") ||
      lower.includes("rejected");
    if (permanent) {
      await env.DB.prepare(
        "UPDATE airtime_orders SET status = 'failed', attempts = attempts + 1, error = ? WHERE id = ?"
      ).bind(msg, orderId).run();
      // Tell the user it needs manual attention (push only; SMS stays for tx).
      await pushToUser(env, order.user_id, "Airtime could not be sent",
        `Your airtime order could not be delivered and needs an admin's attention. We'll follow up.`,
        { type: "airtime_failed" }).catch(() => {});
      // Flag it for the superadmins so they can refund/resolve.
      await pushAdmins(env, "Airtime delivery issue",
        `Order #${orderId} (${formatKwacha(order.amount_cents)} to ${order.phone}) failed: ${msg}`, {})
        .catch(() => {});
    } else {
      await env.DB.prepare(
        "UPDATE airtime_orders SET attempts = attempts + 1, error = ? WHERE id = ?"
      ).bind(msg, orderId).run();
    }
    console.error("[AIRTIME] fulfillment failed for order", orderId, msg);
  }
}

/** Africa's Talking airtime STATUS callback � the one that confirms real MNO
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
    const msg = airtimeDeliveredSms(order.amount_cents);
    const user = await c.env.DB.prepare("SELECT phone FROM users WHERE id = ?")
      .bind(order.user_id).first<{ phone: string }>();
    await smsAndPush(c.env, order.user_id, user?.phone ?? null, msg,
      "Airtime delivered", `Your airtime has been delivered to ${order.phone}.`, { type: "airtime_delivered" });
    console.log("[AIRTIME] delivered:", requestId);
  } else if (status.includes("fail")) {
    const res = await c.env.DB.prepare(
      "UPDATE airtime_orders SET status = 'failed', error = ?, completed_at = NULL WHERE id = ? AND status = 'sent'"
    ).bind(description || "Delivery failed", order.id).run();
    if ((res.meta?.changes ?? 0) === 0) return c.json({ ok: true, ignored: true });
    const msg = airtimeFailedSms(order.amount_cents);
    const user = await c.env.DB.prepare("SELECT phone FROM users WHERE id = ?")
      .bind(order.user_id).first<{ phone: string }>();
    await smsAndPush(c.env, order.user_id, user?.phone ?? null, msg,
      "Airtime delivery failed", `Your airtime to ${order.phone} could not be delivered. We'll retry, or contact support.`, { type: "airtime_failed" });
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
  await updateLipilaLogStatus(env.DB, referenceId, "success");
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
  await updateLipilaLogStatus(env.DB, referenceId, "failed", "Payment not completed");
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
  // Orders we sent but never got a status callback for (MNO silence) � resend
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
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json();
  if (body.enabled !== undefined) await setSetting(c.env, "airtime_enabled", body.enabled ? "true" : "false");
  if (body.markupPct !== undefined) await setSetting(c.env, "airtime_markup_pct", String(Math.max(0, Math.min(100, Math.round(Number(body.markupPct))))));
  if (body.minAmountCents !== undefined) await setSetting(c.env, "airtime_min_amount_cents", String(Math.max(100, Math.round(Number(body.minAmountCents)))));
  if (body.maxAmountCents !== undefined) await setSetting(c.env, "airtime_max_amount_cents", String(Math.max(500, Math.round(Number(body.maxAmountCents)))));
  if (body.bonusPct !== undefined) await setSetting(c.env, "airtime_bonus_pct", String(Math.max(0, Math.min(50, Math.round(Number(body.bonusPct))))));
  return c.json({ ok: true });
});

/** Admin: every airtime order (pending/paid/sent/completed/failed) with the
 *  stored AT error so stuck purchases are visible and diagnosable. */
app.get("/api/admin/airtime-orders", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT o.*, u.username, u.phone AS user_phone
     FROM airtime_orders o JOIN users u ON u.id = o.user_id
     ORDER BY o.id DESC LIMIT 200`
  ).all<Record<string, any>>();
  return c.json({
    orders: rows.results.map((o) => ({
      id: o.id,
      userId: o.user_id,
      username: o.username,
      userPhone: o.user_phone,
      phone: o.phone,
      network: o.network,
      amountCents: o.amount_cents,
      costCents: o.cost_cents,
      creditsUsedCents: o.credits_used_cents,
      lipilaReference: o.lipila_reference,
      atRequestId: o.at_request_id,
      status: o.status,
      error: o.error ?? null,
      attempts: o.attempts ?? 0,
      createdAt: o.created_at,
      sentAt: o.sent_at,
      deliveredAt: o.delivered_at,
    })),
  });
});

/** Admin: retry a failed/stuck airtime order immediately (re-queues it). */
app.post("/api/admin/airtime-orders/:id/retry", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const id = Number(c.req.param("id"));
  const order = await c.env.DB.prepare("SELECT * FROM airtime_orders WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!order) return c.json({ error: "Order not found" }, 404);
  if (order.status === "completed") return c.json({ error: "Already delivered" }, 400);
  await c.env.DB.prepare("UPDATE airtime_orders SET status = 'paid', error = NULL WHERE id = ?").bind(id).run();
  await fulfillAirtimeOrder(c.env, id);
  const after = await c.env.DB.prepare("SELECT status, error FROM airtime_orders WHERE id = ?").bind(id).first<{ status: string; error: string | null }>();
  return c.json({ ok: true, status: after?.status ?? "paid", error: after?.error ?? null });
});

/** Admin: mark a MANUAL-mode order as delivered after the admin topped up the
 *  phone by hand. Completes the order and notifies the buyer. */
app.post("/api/admin/airtime-orders/:id/complete", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const id = Number(c.req.param("id"));
  const order = await c.env.DB.prepare(
    `SELECT o.*, u.phone AS user_phone FROM airtime_orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?`
  ).bind(id).first<Record<string, any>>();
  if (!order) return c.json({ error: "Order not found" }, 404);
  if (order.status === "completed") return c.json({ error: "Already delivered" }, 400);
  await c.env.DB.prepare(
    "UPDATE airtime_orders SET status = 'completed', delivered_at = datetime('now', '+2 hours'), error = NULL WHERE id = ?"
  ).bind(id).run();
  const msg = airtimeDeliveredSms(order.amount_cents);
  await smsAndPush(c.env, order.user_id, order.user_phone ?? null, msg,
    "Airtime delivered", `Your airtime has been delivered to ${order.phone}.`, { type: "airtime_delivered" });
  return c.json({ ok: true, message: `Marked ${formatKwacha(order.amount_cents)} airtime as delivered.` });
});

/** Admin: refund a failed airtime order's cost back to the buyer's mobile
 *  money (used when AT could never deliver, e.g. the product is disabled). */
app.post("/api/admin/airtime-orders/:id/refund", async (c) => {
  const admin = await requireStaff(c, "settings");
  if (!admin) return c.json({ error: "Admin only" }, 403);
  const id = Number(c.req.param("id"));
  const order = await c.env.DB.prepare(
    `SELECT o.*, u.phone AS user_phone FROM airtime_orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?`
  ).bind(id).first<Record<string, any>>();
  if (!order) return c.json({ error: "Order not found" }, 404);
  if (order.status === "completed") return c.json({ error: "Airtime was delivered � no refund needed." }, 400);
  if (!order.user_phone || order.cost_cents <= 0) return c.json({ error: "Nothing to refund" }, 400);

  const referenceId = moneyRef("AIRREF", order.id);
  await envDB(c).prepare(
    "INSERT INTO refunds (promo_id, amount_cents, lipila_reference, status) VALUES (NULL, ?, ?, 'pending')"
  ).bind(order.cost_cents, referenceId).run();

  try {
    await createDisbursement(c.env, {
      referenceId,
      amountCents: order.cost_cents,
      accountNumber: order.user_phone.replace("+", ""),
      narration: `Kingdom Sponsor airtime refund ${order.id}`,
      callbackUrl: `${c.env.APP_URL}/api/webhooks/lipila?secret=${encodeURIComponent(c.env.LIPILA_WEBHOOK_SECRET)}`,
    });
  } catch (e) {
    return c.json({ error: `Refund could not be started: ${e instanceof Error ? e.message : e}` }, 502);
  }

  await c.env.DB.prepare(
    "UPDATE airtime_orders SET status = 'refunded', error = 'Refunded by admin' WHERE id = ?"
  ).bind(id).run();
  await smsAndPush(c.env, order.user_id, order.user_phone,
    `KSPONSOR: Airtime refund ${formatKwacha(order.cost_cents)} on its way to your phone.`,
    "Airtime refunded",
    `Your ${formatKwacha(order.cost_cents)} airtime payment was refunded to your mobile money.`,
    { type: "airtime_refunded" });

  return c.json({ ok: true, message: `Refund of ${formatKwacha(order.cost_cents)} initiated to ${order.user_phone}` });
});

// Admin: verify the configured airtime provider credentials by sending a real
// K1 top-up to a provided Zambian number. Reports the active provider + status.
app.post("/api/admin/airtime/test", async (c) => {
  const admin = await requireStaff(c, "settings");
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
  const provider = getAirtimeProvider(c.env);
  if (provider.id === "manual") {
    return c.json({
      ok: true,
      provider: provider.id,
      message: "Airtime is in manual mode — no supplier is wired up yet. Orders are queued for manual fulfilment.",
      sandbox: true,
    });
  }
  const e164 = digits.startsWith("260") ? `+${digits}` : `+260${digits.slice(1)}`;
  try {
    const requestId = await sendAirtime(c.env, e164, 1);
    await logLipilaEvent(c.env.DB, "airtime_test", `TEST-${Date.now()}`, e164, 100, `provider=${provider.id} requestId=${requestId}`);
    return c.json({
      ok: true,
      provider: provider.id,
      message: "K1 airtime sent — check the recipient phone for delivery.",
      requestId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logLipilaEvent(c.env.DB, "airtime_test", `TEST-${Date.now()}`, e164, 100, `provider=${provider.id}: ${msg}`);
    return c.json({ error: `Airtime test failed (${provider.id}): ${msg}` }, 502);
  }
});

// ===================================================================
// CAMPAIGN IMAGE EDIT (Admin - update logo/image on existing campaign)
// ===================================================================

app.put("/api/admin/campaigns/:id/image", async (c) => {
  const admin = await requireStaff(c, "campaigns");
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
  const admin = await requireStaff(c, "donations");
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
