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

export async function sendPushNotification(
  env: { FIREBASE_CLIENT_EMAIL: string; FIREBASE_PRIVATE_KEY: string },
  fcmToken: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<boolean> {
  try {
    const msg = getMessagingClient(env);
    await msg.send({
      token: fcmToken,
      notification: { title, body },
      data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
      android: { priority: "high" },
      apns: { payload: { aps: { contentAvailable: true } } },
    });
    return true;
  } catch (e) {
    console.error("FCM send failed:", e);
    return false;
  }
}

export async function sendMulticastPush(
  env: { FIREBASE_CLIENT_EMAIL: string; FIREBASE_PRIVATE_KEY: string },
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<{ success: number; failure: number }> {
  if (!tokens.length) return { success: 0, failure: 0 };
  try {
    const msg = getMessagingClient(env);
    const res = await msg.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
      android: { priority: "high" },
    });
    return { success: res.successCount, failure: res.failureCount };
  } catch (e) {
    console.error("FCM multicast failed:", e);
    return { success: 0, failure: tokens.length };
  }
}