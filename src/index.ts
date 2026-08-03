// Kingdom Sponsor API - neutral fundraising platform.
// Stack: Cloudflare Worker + D1 + Lipila (payments) + Africa's Talking (OTP SMS).
// Money is stored in ngwee (integer cents). 100 ngwee = K1.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { signToken, verifyToken, sha256Hex, type TokenPayload } from "./jwt";
import { createCollection, checkCollectionStatus, createDisbursement, getWalletBalance, type LipilaEnv } from "./lipila";
import { sendOtpSms, sendSms } from "./sms";
import { loadFeeConfig, donationFees, payoutAmountCents, disbursementFeeCents, platformDisbursementFeeCents, feeConfigPublic, formatKwacha } from "./fees";
import { generateUsername, ensureUser, donorTotalCents, tierFor } from "./donors";
import { donationConfirmedSms, donationReceivedSms, payoutSentSms, pledgeReminderSms, promotionActiveSms } from "./messages";
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

/** Confirm a contribution (webhook or polling) and credit the campaign. */
async function confirmContribution(env: Bindings, referenceId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM contributions WHERE lipila_reference = ?"
  ).bind(referenceId).first<Record<string, any>>();
  if (!row || row.status === "confirmed") return;

  await env.DB.prepare(
    "UPDATE contributions SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?"
  ).bind(row.id).run();

  const campaign = await env.DB.prepare(
    "SELECT c.*, u.phone AS host_phone FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(row.campaign_id).first<Record<string, any>>();
  const available = await availableBalance(env, row.campaign_id);
  if (campaign?.host_phone) {
    await sendSms(env, campaign.host_phone, donationReceivedSms(campaign.title, row.amount_cents, available))
      .catch((e) => console.error("host sms failed:", e));
  }
  if (row.phone) {
    await sendSms(env, row.phone, donationConfirmedSms(campaign?.title ?? "campaign", row.amount_cents, referenceId))
      .catch((e) => console.error("donor sms failed:", e));
  }

  await maybeAutoDisburse(env, row.campaign_id);
}

/** If the campaign's available balance >= minimum threshold, pay it out to the host immediately. */
async function maybeAutoDisburse(env: Bindings, campaignId: number): Promise<void> {
  const campaign = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(campaignId).first<Record<string, any>>();
  if (!campaign) return;

  const available = await availableBalance(env, campaignId);
  if (available < campaign.min_withdraw_cents) return; // hold below threshold; sweep later

  await createWithdrawal(env, campaignId);
}

/** raised - platform fees - collection fees - already withdrawn - payout fees */
async function availableBalance(env: Bindings, campaignId: number): Promise<number> {
  const raised = (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
  ).bind(campaignId).first<{ s: number }>()) ?? { s: 0 };
  const platformFees = (await env.DB.prepare(
    "SELECT COALESCE(SUM(platform_fee_cents),0) AS s FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
  ).bind(campaignId).first<{ s: number }>()) ?? { s: 0 };
  const lipilaFees = (await env.DB.prepare(
    "SELECT COALESCE(SUM(lipila_fee_cents),0) AS s FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
  ).bind(campaignId).first<{ s: number }>()) ?? { s: 0 };
  const withdrawn = (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','success')"
  ).bind(campaignId).first<{ s: number }>()) ?? { s: 0 };
  const disbursementFees = (await env.DB.prepare(
    "SELECT COALESCE(SUM(disbursement_fee_cents),0) AS s FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','success')"
  ).bind(campaignId).first<{ s: number }>()) ?? { s: 0 };
  const payoutPlatformFees = (await env.DB.prepare(
    "SELECT COALESCE(SUM(platform_fee_cents),0) AS s FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','success')"
  ).bind(campaignId).first<{ s: number }>()) ?? { s: 0 };
  return raised.s - platformFees.s - lipilaFees.s - withdrawn.s - disbursementFees.s - payoutPlatformFees.s;
}

/** Create a payout of the campaign's available balance, deducting Lipila's disbursement fee and Kingdom Sponsor's payout cut. Returns the host payout cents sent (0 if none). */
async function createWithdrawal(env: Bindings, campaignId: number): Promise<number> {
  const cfg = loadFeeConfig(env);
  const campaign = await env.DB.prepare(
    "SELECT c.*, u.phone AS host_phone FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(campaignId).first<Record<string, any>>();
  if (!campaign) return 0;

  const available = await availableBalance(env, campaignId);
  if (available < campaign.min_withdraw_cents) return 0;

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

/** Accumulated donation platform fees that have been earned but not yet settled to Kingdom Sponsor. */
async function pendingDonationFees(env: Bindings): Promise<number> {
  const earned = (await env.DB.prepare(
    "SELECT COALESCE(SUM(platform_fee_cents),0) AS s FROM contributions WHERE status = 'confirmed'"
  ).first<{ s: number }>())?.s ?? 0;
  const settled = (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM fee_sweeps WHERE status = 'success'"
  ).first<{ s: number }>())?.s ?? 0;
  return earned - settled;
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

function promoPrice(env: Bindings): number {
  return parseInt(env.PROMO_PRICE_CENTS ?? "", 10) > 0 ? parseInt(env.PROMO_PRICE_CENTS!, 10) : 15000;
}

function promoDays(env: Bindings): number {
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

  const days = promo.days || promoDays(env);
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
    "SELECT c.*, u.phone AS host_phone FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(promo.campaign_id).first<Record<string, any>>();
  if (campaign?.host_phone) {
    await sendSms(env, campaign.host_phone, promotionActiveSms(campaign.title, days, until.slice(0, 10)))
      .catch((e) => console.error("promo sms failed:", e));
  }
}

/** Scheduled: expire promoted campaigns whose paid window has passed. */
async function runPromotionExpiry(env: Bindings): Promise<void> {
  await env.DB.prepare(
    "UPDATE campaigns SET promoted = 0 WHERE promoted = 1 AND promoted_until IS NOT NULL AND promoted_until < ?"
  ).bind(new Date().toISOString()).run();
  await env.DB.prepare(
    "UPDATE promotions SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?"
  ).bind(new Date().toISOString()).run();
}

// ---------- recurring pledges (monthly reminders) ----------

/** Daily cron: SMS a reminder to donors whose pledge day is today (Zambia time, UTC+2). */
async function runPledgeReminders(env: Bindings): Promise<void> {
  const zambia = new Date(Date.now() + 2 * 3600000); // UTC+2
  const today = zambia.getUTCDate();

  const rows = await env.DB.prepare(
    `SELECT p.id, p.phone, p.amount_cents, p.day_of_month, p.user_id,
            c.title AS campaign_title, c.id AS campaign_id
     FROM recurring_pledges p JOIN campaigns c ON c.id = p.campaign_id
     WHERE p.active = 1 AND p.day_of_month = ?`
  ).bind(today).all<Record<string, any>>();

  for (const row of rows.results) {
    const message = pledgeReminderSms(row.campaign_title, row.amount_cents, row.campaign_id);
    await sendSms(env, row.phone, message).catch((e) => console.error("pledge sms failed:", e));

    // Push notification
    const user = await env.DB.prepare("SELECT fcm_token FROM users WHERE id = ?")
      .bind(row.user_id).first<{ fcm_token: string | null }>();
    if (user?.fcm_token && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
      const fbEnv = {
        FIREBASE_CLIENT_EMAIL: env.FIREBASE_CLIENT_EMAIL,
        FIREBASE_PRIVATE_KEY: env.FIREBASE_PRIVATE_KEY,
      };
      await sendPushNotification(fbEnv, user.fcm_token,
        "Monthly giving reminder",
        `Your pledge of K${(row.amount_cents / 100).toLocaleString()} to "${row.campaign_title}" is due today.`,
        { type: "pledge_reminder", campaignId: String(row.campaign_id) }
      ).catch((e) => console.error("push failed:", e));
    }

    await env.DB.prepare("UPDATE recurring_pledges SET last_reminded_at = datetime('now') WHERE id = ?")
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
    "SELECT c.*, u.phone AS host_phone FROM campaigns c JOIN users u ON u.id = c.host_user_id WHERE c.id = ?"
  ).bind(row.campaign_id).first<Record<string, any>>();
  if (campaign?.host_phone) {
    await sendSms(env, campaign.host_phone, payoutSentSms(campaign.title, row.amount_cents))
      .catch((e) => console.error("payout sms failed:", e));
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

  let debugCode: string | undefined;
  try {
    await sendOtpSms(c.env, phone, code);
  } catch (e) {
    if (c.env.ENV === "production") {
      console.error("SMS failed:", e);
      return c.json({ error: "Could not send SMS. Try again." }, 502);
    }
    debugCode = code; // sandbox / no AT creds: return the code for testing
  }

  return c.json({ message: "Code sent", expiresInSeconds: ttlMin * 60, ...(debugCode ? { debugCode } : {}) });
});

app.post("/api/auth/verify-otp", async (c) => {
  const { phone: rawPhone, code } = await c.req.json();
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

  const token = await signToken({ sub: user.id, phone: user.phone, isHost: !!user.is_host }, c.env.JWT_SECRET);
  return c.json({
    token,
    user: {
      id: user.id,
      phone: user.phone,
      username: user.username,
      name: user.name,
      isHost: !!user.is_host,
      isAdmin: isAdminPhone(c.env, user.phone),
      hostStatus: user.host_status ?? "none",
    },
  });
});

// ---------- public campaign views ----------

async function campaignPublic(env: Bindings, row: Record<string, any>): Promise<Record<string, any>> {
  const raised = (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS n FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
  ).bind(row.id).first<{ s: number; n: number }>()) ?? { s: 0, n: 0 };
  const withdrawn = (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM withdrawals WHERE campaign_id = ? AND status IN ('pending','success')"
  ).bind(row.id).first<{ s: number }>()) ?? { s: 0 };
  const avg = (await env.DB.prepare(
    "SELECT COALESCE(AVG(amount_cents),0) AS s FROM contributions WHERE campaign_id = ? AND status = 'confirmed'"
  ).bind(row.id).first<{ s: number }>()) ?? { s: 0 };

  const daysSince = Math.max(1, Math.floor((Date.now() - new Date(row.created_at.replace(" ", "T") + "Z").getTime()) / 86400000));
  const hasGoal = Number(row.goal_cents) > 0;
  const remaining = hasGoal ? Math.max(0, Number(row.goal_cents) - raised.s) : null;
  const donorsNeededAtAvg = hasGoal && avg.s > 0 ? Math.ceil(remaining! / avg.s) : null;
  const dailyRate = Math.round(raised.s / daysSince);
  const estDays = hasGoal && remaining! > 0 && dailyRate > 0 ? Math.ceil(remaining! / dailyRate) : null;
  const estimatedEndDate = estDays
    ? new Date(Date.now() + estDays * 86400000).toISOString().slice(0, 10)
    : null;

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    logoUrl: row.logo_url ?? null,
    goalCents: Number(row.goal_cents),
    hasGoal: hasGoal,
    raisedCents: raised.s,
    withdrawnCents: withdrawn.s,
    donorCount: raised.n,
    avgDonationCents: Math.round(avg.s),
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
  return c.json({ campaigns: out });
});

app.get("/api/campaigns/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "Campaign not found" }, 404);
  const pub = await campaignPublic(c.env, row);

  const donors = await c.env.DB.prepare(
    `SELECT co.donor_user_id, u.username, co.donor_name, co.is_anonymous, co.hide_amount, co.amount_cents, co.created_at
     FROM contributions co LEFT JOIN users u ON u.id = co.donor_user_id
     WHERE co.campaign_id = ? AND co.status = 'confirmed' ORDER BY co.created_at DESC LIMIT 50`
  ).bind(row.id).all<Record<string, any>>();

  const donorList = [];
  for (const d of donors.results) {
    const total = await donorTotalCents(c.env.DB, d.donor_user_id);
    const username = d.username ?? "Giver";
    donorList.push({
      username,
      name: d.is_anonymous ? null : (d.donor_name ?? null),
      isAnonymous: !!d.is_anonymous,
      amountCents: d.hide_amount ? null : d.amount_cents,
      tier: d.hide_amount ? null : tierFor(total),
      date: d.created_at,
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
  const minWithdrawCents = Math.round(Number(body.minWithdrawCents) || 20000);
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

  await c.env.DB.prepare(
    "UPDATE users SET fcm_token = ? WHERE id = ?"
  ).bind(token, user.sub).run();

  return c.json({ ok: true });
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
  await sendSms(c.env, target.phone,
    `${user.username} wants to link accounts as ${linkType}. Open Kingdom Sponsor to accept.`
  ).catch((e) => console.error("link sms failed:", e));

  return c.json({ ok: true, message: "Link request sent. Waiting for acceptance." });
});

app.get("/api/user/links", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const rows = await c.env.DB.prepare(
    `SELECT ul.*, u.username AS linked_username, u.phone AS linked_phone
     FROM user_links ul JOIN users u ON u.id = ul.linked_user_id
     WHERE ul.user_id = ? OR ul.linked_user_id = ?`
  ).bind(user.sub, user.sub).all<Record<string, any>>();

  return c.json({
    links: rows.results.map((l) => ({
      id: l.id,
      linkType: l.link_type,
      status: l.status,
      isInitiator: l.user_id === user.sub,
      otherUser: {
        userId: l.linked_user_id,
        username: l.linked_username,
        phone: l.linked_phone,
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

  const price = promoPrice(c.env);
  const days = promoDays(c.env);
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
    priceCents: promoPrice(c.env),
    days: promoDays(c.env),
    promotedIds: (await c.env.DB.prepare("SELECT id FROM campaigns WHERE promoted = 1").all()).results.map((r: any) => r.id),
  });
});

// ---------- PDF receipts ----------

interface ReceiptInput {
  donorName: string;
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

  let y = 660;
  page.drawText("Kingdom Sponsor", { x: 50, y, size: 24, font: bold, color: rgb(0.12, 0.38, 0.72) });
  y -= 26;
  page.drawText("Donation Receipt", { x: 50, y, size: 16, font: bold });
  page.drawRectangle({
    x: 50, y: y - 8, width: width - 100, height: 1,
    color: rgb(0.8, 0.85, 0.92),
  });

  y -= 46;
  const row = (label: string, value: string) => {
    page.drawText(label, { x: 50, y, size: 11, font });
    page.drawText(value, { x: 240, y, size: 11, font: bold });
    y -= 22;
  };

  row("Donor", i.donorName);
  row("Campaign", i.campaignTitle);
  row("Reference", i.reference);
  row("Date", new Date(i.date).toLocaleDateString());
  row("Status", i.status === "confirmed" ? "Confirmed" : i.status);

  y -= 10;
  row("Total donated", `K${(i.amountCents / 100).toLocaleString()}`);

  y -= 16;
  page.drawRectangle({
    x: 50, y: y - 6, width: width - 100, height: 1,
    color: rgb(0.8, 0.85, 0.92),
  });
  y -= 28;
  page.drawText("Platform fee (charged to donors):", { x: 50, y, size: 10, font });
  page.drawText(`K${(i.platformFeeCents / 100).toLocaleString()}`, { x: 330, y, size: 10, font: bold });
  y -= 18;
  page.drawText("Gateway fee:", { x: 50, y, size: 10, font });
  page.drawText(`K${(i.lipilaFeeCents / 100).toLocaleString()}`, { x: 330, y, size: 10, font: bold });

  y -= 30;
  const received = i.amountCents - i.platformFeeCents - i.lipilaFeeCents;
  page.drawText("Campaign receives:", { x: 50, y, size: 11, font: bold });
  page.drawText(`K${(received / 100).toLocaleString()}`, { x: 240, y, size: 11, font: bold });

  y -= 60;
  page.drawText("Thank you for giving to Zambia.", { x: 50, y, size: 10, font });
  y -= 16;
  page.drawText("This receipt was issued automatically. It can be used for records.", { x: 50, y, size: 9, font, color: rgb(0.45, 0.5, 0.55) });

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

  const donorName = row.is_anonymous ? "Anonymous" : (String(row.donor_name ?? "").trim() || "Anonymous");
  const pdf = await buildReceiptPdf({
    donorName,
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
    headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" },
  });
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
  const isDisbursement = type.includes("disburs") || referenceId.startsWith("PAY-") || referenceId.startsWith("SET-") || referenceId.startsWith("SWEEP-");
  const isCollection = type.includes("collection") || referenceId.startsWith("CON-");

  if (referenceId.startsWith("PRO-") && (status.includes("success") || status.includes("complete"))) {
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

// ---------- host dashboard ----------

app.get("/api/host/me", async (c) => {
  const user = await authUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const me = (await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.sub).first<Record<string, any>>()) ?? {};
  const totalGiven = await donorTotalCents(c.env.DB, user.sub);

  const campaigns = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE host_user_id = ? ORDER BY created_at DESC"
  ).bind(user.sub).all<Record<string, any>>();
  const out = [];
  for (const row of campaigns.results) {
    const available = await availableBalance(c.env, row.id);
    out.push({ ...(await campaignPublic(c.env, row)), availableCents: available, minWithdrawCents: row.min_withdraw_cents });
  }

  const transactions = await c.env.DB.prepare(
    `SELECT co.id, co.campaign_id, c.title AS campaign_title, co.donor_name, co.is_anonymous, co.phone, co.amount_cents,
            co.platform_fee_cents, co.lipila_fee_cents, co.status, co.created_at
     FROM contributions co JOIN campaigns c ON c.id = co.campaign_id
     WHERE c.host_user_id = ? ORDER BY co.created_at DESC LIMIT 100`
  ).bind(user.sub).all<Record<string, any>>();

  return c.json({
    user: {
      id: user.sub,
      phone: user.phone,
      username: me.username ?? "Giver",
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
    "UPDATE campaigns SET status = 'ended', ended_at = datetime('now') WHERE id = ?"
  ).bind(campaign.id).run();

  await createWithdrawal(c.env, campaign.id); // sweep any remainder below threshold
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
      platformFeesPendingCents: platformFees.s - feeSettled,
      activeCampaigns: activeCampaigns.n,
      pendingApplications: pending.n,
      dailyRateCents: Math.round(total.s / days),
    },
    topCampaigns: topList,
    topDonors: topDonors.results.map((d) => ({
      username: d.username ?? "Giver",
      totalCents: d.total,
      tier: tierFor(d.total),
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
  const rows = await c.env.DB.prepare(
    `SELECT co.id, co.campaign_id, cam.title AS campaign_title, co.donor_name, co.is_anonymous,
            co.phone, co.amount_cents, co.platform_fee_cents, co.lipila_fee_cents, co.status,
            co.lipila_reference, co.lipila_identifier, co.confirmed_at, co.created_at
     FROM contributions co JOIN campaigns cam ON cam.id = co.campaign_id
     WHERE (? = '' OR lower(co.status) = ?)
     ORDER BY co.created_at DESC LIMIT 500`
  ).bind(status, status).all<Record<string, any>>();

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

app.get("/media/:key", async (c) => {
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

app.get("/share/:id", async (c) => {
  const id = c.req.param("id");
  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ? AND status != 'draft'")
    .bind(id).first<Record<string, any>>();
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);

  const pub = await campaignPublic(c.env, campaign);
  const pageUrl = c.env.APP_URL + "/share/" + id;
  const wa = "https://wa.me/?text=" + encodeURIComponent(pub.title + " - " + pub.blurb + "\nGive here: " + pageUrl);
  const goalLine = pub.hasGoal
    ? "<div class=\"amt\">" + formatKwacha(pub.raisedCents) + " raised of " + formatKwacha(pub.goalCents) + "</div>"
    : "<div class=\"amt\">" + formatKwacha(pub.raisedCents) + " raised</div>";
  const endsLine = pub.endsAt ? "ends " + new Date(pub.endsAt).toLocaleDateString() : "";
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta property=\"og:title\" content=\"" + pub.title + "\"><meta property=\"og:description\" content=\"" + pub.blurb + "\"><meta name=\"theme-color\" content=\"#1d4ed8\"><title>" + pub.title + " - Kingdom Sponsor</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}.card{max-width:420px;width:100%;background:#1e293b;border-radius:16px;padding:24px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#94a3b8;line-height:1.5;margin:0 0 20px}.amt{font-size:28px;font-weight:700;color:#34d399;margin-bottom:20px}a.btn{display:block;background:#25D366;color:#06281b;font-weight:700;text-decoration:none;padding:14px;border-radius:10px;margin:8px 0}a.btn2{display:block;background:#1d4ed8;color:#fff;font-weight:700;text-decoration:none;padding:14px;border-radius:10px;margin:8px 0}.foot{color:#64748b;font-size:12px;margin-top:16px}</style></head><body><div class=\"card\"><h1>" + pub.title + "</h1><p>" + pub.blurb + "</p>" + goalLine + "<a class=\"btn\" href=\"" + wa + "\" target=\"_blank\">Share on WhatsApp</a><a class=\"btn2\" href=\"" + pageUrl + "\">Open Kingdom Sponsor</a><div class=\"foot\">" + (pub.donorCount ?? 0) + " givers - " + endsLine + "</div></div></body></html>";
  return c.html(html);
});

app.post("/api/ussd", async (c) => {
  const body = await c.req.parseBody().catch(() => ({}));
  const sessionId = String(body.sessionId ?? c.req.query("sessionId") ?? "");
  const phone = String(body.phoneNumber ?? c.req.query("phoneNumber") ?? "");
  const text = String(body.text ?? c.req.query("text") ?? "");
  const serviceCode = String(body.serviceCode ?? c.req.query("serviceCode") ?? "");

  const parts = text.split("*");
  const level = parts.length;
  const choice = parts[parts.length - 1];

  if (level === 1 && choice === "") {
    const campaigns = await c.env.DB.prepare(
      "SELECT id, title FROM campaigns WHERE status = 'active' ORDER BY created_at DESC LIMIT 10"
    ).all<{ id: number; title: string }>();
    const menu = campaigns.results.map((camp, i) => `${i + 1}. ${camp.title}`).join("\n");
    const response = `CON ${menu}\n0. Exit`;
    return c.text(response);
  }

  if (level === 1 && choice === "0") {
    return c.text("END Thank you for using Kingdom Sponsor. Goodbye!");
  }

  if (level === 1) {
    const idx = parseInt(choice, 10) - 1;
    const campaigns = await c.env.DB.prepare(
      "SELECT id, title FROM campaigns WHERE status = 'active' ORDER BY created_at DESC LIMIT 10"
    ).all<{ id: number; title: string }>();
    const camp = campaigns.results[idx];
    if (!camp) return c.text("END Invalid selection.");
    const response = `CON ${camp.title}\n1. Donate K10\n2. Donate K50\n3. Donate K100\n4. Custom amount\n0. Back`;
    return c.text(response);
  }

  if (level === 2 && choice === "0") {
    return c.text("CON Main menu\n1. View campaigns\n0. Exit");
  }

  if (level === 2) {
    const amountMap: Record<string, number> = { "1": 1000, "2": 5000, "3": 10000 };
    let amountCents: number;
    if (choice === "4") {
      return c.text("CON Enter amount in kwacha (e.g. 50)");
    }
    amountCents = (amountMap[choice] ?? 0) * 100;
    if (amountCents === 0) return c.text("END Invalid amount.");

    const campaigns = await c.env.DB.prepare(
      "SELECT id, title FROM campaigns WHERE status = 'active' ORDER BY created_at DESC LIMIT 10"
    ).all<{ id: number; title: string }>();
    const idx = parseInt(parts[1], 10) - 1;
    const camp = campaigns.results[idx];
    if (!camp) return c.text("END Invalid selection.");

    const referenceId = `USSD-${camp.id}-${Date.now()}`;
    await c.env.DB.prepare(
      "INSERT INTO contributions (campaign_id, donor_user_id, giver_user_id, is_anonymous, phone, amount_cents, platform_fee_cents, lipila_fee_cents, lipila_reference, status) VALUES (?, NULL, NULL, 1, ?, ?, 0, 0, ?, 'pending')"
    ).bind(camp.id, phone, amountCents, referenceId).run();

    const response = `CON You are about to donate K${(amountCents / 100).toLocaleString()} to "${camp.title}".\nConfirm? 1. Yes 2. No`;
    return c.text(response);
  }

  if (level === 3 && choice === "1") {
    return c.text("CON Donation confirmed. Thank you for your support!");
  }

  return c.text("END Thank you for using Kingdom Sponsor. Goodbye!");
});

app.get("/", (c) => c.json({ name: "Kingdom Sponsor API", version: "0.2.0" }));

const appObject = {
  fetch: app.fetch,
  scheduled: async (_: unknown, env: Bindings, ctx: ExecutionContext) => {
    ctx.waitUntil(runFeeSweep(env));
    ctx.waitUntil(runPledgeReminders(env));
    ctx.waitUntil(runPromotionExpiry(env));
  },
};

export default appObject;
