// Airtime provider abstraction — Kingdom Sponsor can sell airtime through any
// supplier behind one seam:
//
//   africastalking — Africa's Talking airtime API (SMS-centric account).
//                    NOTE: AT does NOT offer airtime top-up for Zambia, so this
//                    is only useful for other markets / future expansion.
//   mtn_momo       — MTN Mobile Money API (momoapi.mtn.com) airtime product.
//                    The best official route for Zambia (MTN Zambia is live on
//                    the MoMo gateway). Requires an MTN MoMo API subscription.
//   manual         — no real send; orders are marked "manual" and an admin
//                    fulfils them by hand (phone top-up) then confirms via the
//                    dashboard. Useful until a live provider contract lands.
//
// The app (order/payment/refund flows) never calls a provider directly — it goes
// through sendAirtime() below. To add a new supplier (e.g. a local aggregator)
// implement the AirtimeProvider interface and register it in getAirtimeProvider.

import { safePhone } from "./sms";

export interface AirtimeProvider {
  /** Stable id stored on the order row (africastalking | mtn_momo | manual). */
  id: string;
  /** Human label shown in the admin config/test screens. */
  label: string;
  /**
   * Send `kwachaAmount` of airtime to `phone` (E.164).
   * Returns the supplier's reference for the order (stored in
   * airtime_orders.at_request_id so a status callback can resolve it).
   * Throws on a permanent/rejectable failure.
   */
  send(env: AirtimeEnv, phone: string, kwachaAmount: number): Promise<string>;
  /** Whether a status callback from this supplier is expected to arrive. */
  hasStatusCallback: boolean;
}

export interface AirtimeEnv {
  AIRTIME_PROVIDER?: string;
  ENV: string;
  // Africa's Talking (africastalking provider)
  AT_API_KEY?: string;
  AT_USERNAME?: string;
  // MTN MoMo (mtn_momo provider)
  MTN_MOMO_SUBSCRIPTION_KEY?: string;
  MTN_MOMO_API_USER?: string;
  MTN_MOMO_API_KEY?: string;
  MTN_MOMO_TARGET_ENV?: string;
  MTN_MOMO_BASE_URL?: string;
  MTN_MOMO_CALLBACK_HOST?: string;
}

// ---------------------------------------------------------------------------
// Africa's Talking provider (non-Zambia markets / legacy)
// ---------------------------------------------------------------------------

const AT_AIRTIME_URL = "https://api.africastalking.com/version1/airtime/send";

const africaSTalkingProvider: AirtimeProvider = {
  id: "africastalking",
  label: "Africa's Talking",
  hasStatusCallback: true,
  async send(env, phone, kwachaAmount): Promise<string> {
    if (env.ENV !== "production") {
      console.log(`[AIRTIME ${phone}] ZMW ${kwachaAmount.toFixed(2)} (AT sandbox, no network call)`);
      return `AT-SANDBOX-${Date.now()}`;
    }
    if (!env.AT_API_KEY || !env.AT_USERNAME) {
      throw new Error("Africa's Talking credentials not configured on the worker.");
    }
    const recipients = JSON.stringify([
      { phoneNumber: safePhone(phone), amount: `ZMW ${kwachaAmount.toFixed(2)}` },
    ]);
    const form = new URLSearchParams({ username: env.AT_USERNAME, recipients });
    const res = await fetch(AT_AIRTIME_URL, {
      method: "POST",
      headers: {
        Apikey: env.AT_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`Africa's Talking airtime failed (${res.status}): ${body || "empty body"}`);
    }
    const parsed = JSON.parse(body);
    const first = parsed?.responses?.[0];
    if (first && String(first.status).toLowerCase() !== "sent" && first.errorMessage) {
      throw new Error(`Africa's Talking airtime error: ${first.errorMessage}`);
    }
    return String(first?.requestId ?? `AT-${Date.now()}`).trim();
  },
};

// ---------------------------------------------------------------------------
// MTN MoMo provider (the route for Zambia)
// ---------------------------------------------------------------------------

/** Memoized OAuth token per subscription key so sends don't re-auth every time. */
const mtnTokenCache = new Map<string, { token: string; expiresAt: number }>();

const MTN_AIRTIME_PATH = "/airtime/v1_0/airtime";
const MTN_TOKEN_PATH = "/airtime/v1_0/token";

async function mtnGetToken(env: AirtimeEnv): Promise<string> {
  if (!env.MTN_MOMO_SUBSCRIPTION_KEY) {
    throw new Error("MTN_MOMO_SUBSCRIPTION_KEY not configured on the worker.");
  }
  const base = String(env.MTN_MOMO_BASE_URL ?? "").replace(/\/$/, "") ||
    "https://sandbox.momodeveloper.mtn.com";
  const cached = mtnTokenCache.get(env.MTN_MOMO_SUBSCRIPTION_KEY);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  if (env.ENV !== "production") {
    // No network call in non-prod: return a fake token so the flow is testable.
    const fake = `sandbox-token-${Date.now()}`;
    mtnTokenCache.set(env.MTN_MOMO_SUBSCRIPTION_KEY, { token: fake, expiresAt: Date.now() + 3_600_000 });
    return fake;
  }
  if (!env.MTN_MOMO_API_USER || !env.MTN_MOMO_API_KEY) {
    throw new Error("MTN_MOMO_API_USER / MTN_MOMO_API_KEY not configured on the worker.");
  }
  const basic = btoa(`${env.MTN_MOMO_API_USER}:${env.MTN_MOMO_API_KEY}`);
  const res = await fetch(`${base}${MTN_TOKEN_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Ocp-Apim-Subscription-Key": env.MTN_MOMO_SUBSCRIPTION_KEY,
      "Content-Type": "application/json",
    },
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`MTN MoMo token failed (${res.status}): ${body || "empty body"}`);
  }
  const parsed = JSON.parse(body);
  const token = String(parsed?.access_token ?? "");
  if (!token) throw new Error(`MTN MoMo token response missing access_token: ${body.slice(0, 200)}`);
  const ttl = Number(parsed?.expires_in ?? 3600);
  mtnTokenCache.set(env.MTN_MOMO_SUBSCRIPTION_KEY, { token, expiresAt: Date.now() + ttl * 1000 });
  return token;
}

const mtnMoMoProvider: AirtimeProvider = {
  id: "mtn_momo",
  label: "MTN Mobile Money",
  hasStatusCallback: true,
  async send(env, phone, kwachaAmount): Promise<string> {
    if (!env.MTN_MOMO_SUBSCRIPTION_KEY) {
      throw new Error("MTN_MOMO_SUBSCRIPTION_KEY not configured on the worker.");
    }
    const base = String(env.MTN_MOMO_BASE_URL ?? "").replace(/\/$/, "") ||
      "https://sandbox.momodeveloper.mtn.com";
    const targetEnv = String(env.MTN_MOMO_TARGET_ENV ?? "sandbox");
    const reference = crypto.randomUUID();

    // Amount in minor units (ngwee). MTN MoMo airtime takes a string amount.
    const amount = String(Math.round(kwachaAmount * 100));

    if (env.ENV !== "production") {
      // No network calls outside production: return the reference so the whole
      // order/fulfilment flow is testable end-to-end without an MTN sandbox.
      console.log(`[AIRTIME ${phone}] ZMW ${kwachaAmount.toFixed(2)} (MTN sandbox, no network call)`);
      return reference;
    }

    const token = await mtnGetToken(env);

    const res = await fetch(`${base}${MTN_AIRTIME_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Reference-Id": reference,
        "X-Target-Environment": targetEnv,
        "Ocp-Apim-Subscription-Key": env.MTN_MOMO_SUBSCRIPTION_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ msisdn: safePhone(phone), amount }),
    });
    const body = await res.text().catch(() => "");
    if (!res.ok && res.status !== 202) {
      throw new Error(`MTN MoMo airtime failed (${res.status}): ${body || "empty body"}`);
    }
    // 202 Accepted -> queued; callback will confirm real MNO delivery.
    if (res.status === 202) return reference;
    const parsed = body ? JSON.parse(body) : {};
    return String(parsed?.externalId ?? reference);
  },
};

// ---------------------------------------------------------------------------
// Manual provider — admin fulfils the top-up by hand and confirms on dashboard
// ---------------------------------------------------------------------------

const manualProvider: AirtimeProvider = {
  id: "manual",
  label: "Manual (admin fulfils)",
  hasStatusCallback: false,
  async send(_env, phone, kwachaAmount): Promise<string> {
    console.log(`[AIRTIME ${phone}] ZMW ${kwachaAmount.toFixed(2)} (MANUAL — admin must top up + confirm)`);
    return `MANUAL-${Date.now()}`;
  },
};

// ---------------------------------------------------------------------------

const PROVIDERS: AirtimeProvider[] = [africaSTalkingProvider, mtnMoMoProvider, manualProvider];

export function getAirtimeProvider(env: AirtimeEnv): AirtimeProvider {
  const id = String(env.AIRTIME_PROVIDER ?? "").trim().toLowerCase() || "manual";
  return PROVIDERS.find((p) => p.id === id) ?? manualProvider;
}

export function airtimeProviders(): { id: string; label: string }[] {
  return PROVIDERS.map((p) => ({ id: p.id, label: p.label }));
}

/** Provider-aware top-up. Returns the supplier reference for the order. */
export async function sendAirtime(
  env: AirtimeEnv,
  phone: string,
  kwachaAmount: number,
): Promise<string> {
  return getAirtimeProvider(env).send(env, phone, kwachaAmount);
}
