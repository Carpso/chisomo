import { getApps, initializeApp, cert, App } from "firebase-admin/app";
import { getMessaging, Messaging } from "firebase-admin/messaging";

let _app: App | null = null;
let _messaging: Messaging | null = null;

export function getFirebaseAdmin(env: { FIREBASE_CLIENT_EMAIL: string; FIREBASE_PRIVATE_KEY: string }): App {
  if (_app) return _app;
  const privateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
  _app = initializeApp({
    credential: cert({
      projectId: "kingdom-sponsor",
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
  return _app;
}

export function getMessagingClient(env: { FIREBASE_CLIENT_EMAIL: string; FIREBASE_PRIVATE_KEY: string }): Messaging {
  if (_messaging) return _messaging;
  const app = getFirebaseAdmin(env);
  _messaging = getMessaging(app);
  return _messaging;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Maps a Kingdom Sponsor notification `type` to an Android channel id. Each
 * channel is created (Importance.max, sound + vibration) on the app side, so
 * every alert lands on the right channel and — crucially — POPS on the phone
 * instead of being silent. Unknown types fall back to "giving_updates".
 */
export function channelForType(type: string | undefined): string {
  switch (type) {
    case "donation":
    case "donation_received":
    case "new_donor":
    case "donation_confirmed":
    case "new_campaign":
    case "milestone":
    case "campaign_ended":
    case "campaign_ending":
    case "campaign_updated":
    case "campaign_deleted":
    case "campaign_restored":
    case "campaign_edit_approved":
    case "campaign_edit_rejected":
    case "campaign_edit_request":
    case "delete_request":
    case "delete_request_rejected":
    case "announcement":
    case "announcement_rejected":
      return "giving_updates"; // donations + campaign news
    case "check_in":
    case "rsvp":
    case "ticket_oversold":
    case "new_event":
    case "ticket_confirmed":
    case "ticket_sold":
      return "events"; // event tickets, RSVPs, check-ins
    case "ticket_created":
    case "ticket_ack":
    case "ticket_reply":
    case "ticket_closed":
    case "ticket_resolved":
      return "support"; // support ticket updates
    case "payout_started":
    case "payout_failed":
    case "payout_sent":
    case "airtime_sent":
    case "airtime_delivered":
    case "airtime_failed":
    case "airtime_refunded":
      return "payments"; // payouts, refunds, airtime money events
    case "new_user":
    case "host_application":
    case "admin_alert":
    case "announcement_review":
      return "admin"; // staff/admin-only alerts
    case "promotion_active":
    case "promotion_rejected":
    case "promotion_refunded":
    case "promotion_expired":
      return "promotions"; // promotion status
    case "sponsor_desk":
      return "sponsor_desk"; // curated funding opportunities
    case "broadcast":
      return "broadcast"; // admin broadcasts
    case "referral_rewarded":
      return "referrals"; // referral rewards
    case "badge_activated":
    case "host_verified":
      return "host"; // verified-host badge
    case "link_request":
      return "links"; // linked-account requests
    case "test":
      return "giving_updates";
    default:
      return "giving_updates";
  }
}

export async function sendPushNotification(
  env: { FIREBASE_CLIENT_EMAIL: string; FIREBASE_PRIVATE_KEY: string },
  fcmToken: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const msg = getMessagingClient(env);
      await msg.send({
        token: fcmToken,
        notification: { title, body },
        data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
        android: {
          priority: "high" as const,
          ttl: 3600000,
          notification: {
            channelId: channelForType(data?.type),
            sound: "default",
            priority: "high" as const,
            visibility: "public" as const,
            color: "#E65100",
            notificationCount: 1,
            clickAction: "FLUTTER_NOTIFICATION_CLICK",
          },
        },
        apns: { payload: { aps: { contentAvailable: true, sound: "default", badge: 1 } } },
      });
      return true;
    } catch (e: any) {
      const code = e?.code ?? "";
      // Don't retry on invalid tokens or permission issues — they won't resolve
      if (code.includes("invalid-registration-token") || code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
        console.error("FCM non-retryable error:", code);
        return false;
      }
      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS * (attempt + 1));
      } else {
        console.error("FCM send failed after retries:", e);
      }
    }
  }
  return false;
}

export async function sendMulticastPush(
  env: { FIREBASE_CLIENT_EMAIL: string; FIREBASE_PRIVATE_KEY: string },
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<{ success: number; failure: number; failedTokens: string[]; bulkError?: boolean }> {
  if (!tokens.length) return { success: 0, failure: 0, failedTokens: [] };

  const payload = {
    tokens,
    notification: { title, body },
    data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
    android: {
      priority: "high" as const,
      ttl: 3600000,
      notification: {
        channelId: channelForType(data?.type),
        sound: "default",
        priority: "high" as const,
        visibility: "public" as const,
        color: "#E65100",
        notificationCount: 1,
        clickAction: "FLUTTER_NOTIFICATION_CLICK",
      },
    },
    apns: { payload: { aps: { contentAvailable: true, sound: "default", badge: 1 } } },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const msg = getMessagingClient(env);
      const res = await msg.sendEachForMulticast(payload);
      const failedTokens: string[] = [];
      const nonRetryableErrors = ["invalid-registration-token", "registration-token-not-registered", "invalid-argument"];
      res.responses.forEach((r, i) => {
        if (!r.success && r.error) {
          const code = r.error.code ?? "";
          if (nonRetryableErrors.some((e) => code.includes(e))) {
            failedTokens.push(tokens[i]);
          } else if (attempt < MAX_RETRIES) {
            // Will retry on next attempt
          } else {
            // Per-token transient failure after retries: do NOT prune (the token
            // may be fine next time). Only permanently-invalid tokens are pruned.
          }
          if (i < 3) console.error("FCM token error:", code || r.error.message);
        }
      });
      return { success: res.successCount, failure: res.failureCount, failedTokens };
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS * (attempt + 1));
      } else {
        // Bulk failure (auth key, quota, network, etc.). Return NO failedTokens
        // so callers don't prune every registered token — a broken credential
        // or transient outage must never wipe the push database.
        console.error("FCM multicast failed after retries:", e);
        return { success: 0, failure: tokens.length, failedTokens: [], bulkError: true };
      }
    }
  }
  return { success: 0, failure: tokens.length, failedTokens: [], bulkError: true };
}
