// Lipila payment gateway client.
// Docs: https://docs.lipila.dev
// Sandbox dashboard: https://dashboard.lipila.dev   Live: https://dashboard.lipila.io
// Sandbox API: https://api.lipila.dev/api/v1   Production API: https://blz.lipila.io/api/v1

export interface LipilaEnv {
  LIPILA_API_KEY: string;
  LIPILA_ENV: string; // "sandbox" | "production"
  LIPILA_WEBHOOK_SECRET: string;
}

const BASE_URLS = {
  sandbox: "https://api.lipila.dev/api/v1",
  production: "https://blz.lipila.io/api/v1",
};

export interface CollectionResult {
  referenceId: string;
  identifier: string;
  status: string;
  amount: number;
}

export interface DisbursementResult {
  referenceId: string;
  identifier: string;
  status: string;
  amount: number;
}

export interface CardCollectionResult {
  referenceId: string;
  identifier: string;
  status: string;
  amount: number;
  cardRedirectionUrl: string;
}

export interface LipilaStatus {
  status: string; // Pending | Successful | Failed ...
  message?: string;
  amount?: number;
}

export function lipilaBase(env: LipilaEnv): string {
  return BASE_URLS[env.LIPILA_ENV === "production" ? "production" : "sandbox"];
}

async function lipilaFetch(
  env: LipilaEnv,
  path: string,
  body: Record<string, unknown>,
  callbackUrl?: string
): Promise<any> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "x-api-key": env.LIPILA_API_KEY,
  };
  if (callbackUrl) headers.callbackUrl = callbackUrl;

  const url = `${lipilaBase(env)}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const rawText = await res.text().catch(() => "");
  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = {};
  }
  if (!res.ok) {
    const detail = rawText.slice(0, 500) || JSON.stringify(data);
    throw new Error(`Lipila ${path} failed (${res.status}) url=${url}: ${detail}`);
  }
  return data;
}

export function toKwacha(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Lipila only allows letters, numbers and spaces in narrations — anything else
 * (colons, apostrophes, ampersands, emoji, etc.) makes the API reject the
 * request with "narration can only contain letters, numbers and spaces".
 * Strips every non-alphanumeric character and collapses runs of spaces.
 */
export function sanitizeNarration(s: string): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
}

/** Initiate a mobile-money collection (sends a USSD prompt to the payer's phone). */
export async function createCollection(
  env: LipilaEnv,
  params: { referenceId: string; amountCents: number; accountNumber: string; narration: string; callbackUrl: string },
  db?: D1Database
): Promise<CollectionResult> {
  const data = await lipilaFetch(
    env,
    "/collections/mobile-money",
    {
      referenceId: params.referenceId,
      amount: toKwacha(params.amountCents),
      accountNumber: params.accountNumber,
      currency: "ZMW",
      narration: sanitizeNarration(params.narration),
    },
    params.callbackUrl
  );
  const result: CollectionResult = {
    referenceId: data.referenceId,
    identifier: data.identifier,
    status: data.status,
    amount: data.amount,
  };
  await logLipilaEvent(db, "collection", result.referenceId, params.accountNumber, params.amountCents, result);
  return result;
}

/** Initiate a card collection (Visa / Mastercard / American Express).
 *  Lipila returns a `cardRedirectionUrl` to its hosted checkout page —
 *  the cardholder enters card details there, so we never handle card
 *  numbers (PCI-safe). Confirmations arrive via the same webhook /
 *  status-check flow as mobile-money collections.
 */
export async function createCardCollection(
  env: LipilaEnv,
  params: {
    referenceId: string;
    amountCents: number;
    narration: string;
    callbackUrl: string;
    customerInfo: {
      firstName: string;
      lastName: string;
      phoneNumber: string;
      email: string;
      city?: string;
      country?: string;
      address?: string;
      zip?: string;
    };
    backUrl?: string;
    referenceData?: string;
  },
  db?: D1Database
): Promise<CardCollectionResult> {
  const data = await lipilaFetch(
    env,
    "/collections/card",
    {
      customerInfo: {
        firstName: sanitizeNarration(params.customerInfo.firstName),
        lastName: sanitizeNarration(params.customerInfo.lastName),
        phoneNumber: params.customerInfo.phoneNumber.replace(/[^0-9]/g, ""),
        city: sanitizeNarration(params.customerInfo.city ?? "Lusaka"),
        country: sanitizeNarration(params.customerInfo.country ?? "Zambia"),
        address: sanitizeNarration(params.customerInfo.address ?? "N A"),
        email: params.customerInfo.email,
        zip: sanitizeNarration(params.customerInfo.zip ?? "10101"),
      },
      collectionRequest: {
        referenceId: params.referenceId,
        amount: toKwacha(params.amountCents),
        narration: sanitizeNarration(params.narration),
        accountNumber: params.customerInfo.email,
        currency: "ZMW",
        backUrl: params.backUrl ?? "",
        referenceData: sanitizeNarration(
          params.referenceData ?? `Kingdom Sponsor donation ${params.referenceId}`
        ),
      },
    },
    params.callbackUrl
  );
  const result: CardCollectionResult = {
    referenceId: data.referenceId,
    identifier: data.identifier,
    status: data.status,
    amount: data.amount,
    cardRedirectionUrl: data.cardRedirectionUrl ?? "",
  };
  await logLipilaEvent(db, "collection", result.referenceId, params.customerInfo.phoneNumber, params.amountCents, result);
  return result;
}

/** Check status of a collection by referenceId. */
export async function checkCollectionStatus(env: LipilaEnv, referenceId: string): Promise<LipilaStatus> {
  const url = `${lipilaBase(env)}/collections/check-status?referenceId=${encodeURIComponent(referenceId)}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "x-api-key": env.LIPILA_API_KEY },
  });
  const rawText = await res.text().catch(() => "");
  let data: any;
  try { data = JSON.parse(rawText); } catch { data = {}; }
  if (!res.ok) {
    const detail = rawText.slice(0, 500) || JSON.stringify(data);
    throw new Error(`Lipila collection status check failed (${res.status}) url=${url}: ${detail}`);
  }
  return { status: data.status, message: data.message, amount: data.amount };
}

/** Check status of a disbursement by referenceId. */
export async function checkDisbursementStatus(env: LipilaEnv, referenceId: string): Promise<LipilaStatus> {
  const url = `${lipilaBase(env)}/disbursements/check-status?referenceId=${encodeURIComponent(referenceId)}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "x-api-key": env.LIPILA_API_KEY },
  });
  const rawText = await res.text().catch(() => "");
  let data: any;
  try { data = JSON.parse(rawText); } catch { data = {}; }
  if (!res.ok) {
    const detail = rawText.slice(0, 500) || JSON.stringify(data);
    throw new Error(`Lipila disbursement status check failed (${res.status}) url=${url}: ${detail}`);
  }
  return { status: data.status, message: data.message, amount: data.amount };
}

/** Current available wallet balance in kwacha. */
export async function getWalletBalance(env: LipilaEnv): Promise<number> {
  const url = `${lipilaBase(env)}/merchants/balance`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "x-api-key": env.LIPILA_API_KEY },
  });
  const rawText = await res.text().catch(() => "");
  let data: any;
  try { data = JSON.parse(rawText); } catch { data = {}; }
  if (!res.ok) {
    const detail = rawText.slice(0, 500) || JSON.stringify(data);
    throw new Error(`Lipila balance failed (${res.status}) url=${url}: ${detail}`);
  }
  const d = data?.data ?? {};
  const raw = d.balance ?? d.availableBalance ?? d.available ?? d.bookedBalance ?? 0;
  const bal = Number(raw);
  return Number.isFinite(bal) ? bal : 0;
}

/** Disburse to mobile money (host payout). Near-instant. */
export async function createDisbursement(
  env: LipilaEnv,
  params: { referenceId: string; amountCents: number; accountNumber: string; narration: string; callbackUrl: string },
  db?: D1Database
): Promise<DisbursementResult> {
  const data = await lipilaFetch(
    env,
    "/disbursements/mobile-money",
    {
      referenceId: params.referenceId,
      amount: toKwacha(params.amountCents),
      accountNumber: params.accountNumber,
      currency: "ZMW",
      narration: sanitizeNarration(params.narration),
    },
    params.callbackUrl
  );
  const result: DisbursementResult = {
    referenceId: data.referenceId,
    identifier: data.identifier,
    status: data.status,
    amount: data.amount,
  };
  await logLipilaEvent(db, "disbursement", result.referenceId, params.accountNumber, params.amountCents, result);
  return result;
}

/** Record a Lipila collection/disbursement event for admin auditing. */
export async function logLipilaEvent(
  db: D1Database | undefined,
  kind: "collection" | "disbursement" | "airtime_test",
  referenceId: string,
  phone: string | undefined,
  amountCents: number,
  result: { status?: string; message?: string; identifier?: string } | string
): Promise<void> {
  if (!db) return;
  const isObj = typeof result === "object" && result !== null;
  const status = typeof result === "string"
      ? result
      : (result as { status?: string }).status ?? "unknown";
  const message = typeof result === "string"
      ? result
      : (result as { message?: string }).message;
  const ref = `${referenceId}${isObj ? `-${(result as { identifier?: string }).identifier ?? ""}` : ""}`;
  const normStatus = ["success", "successful", "complete", "pending"].includes(status.toLowerCase())
      ? status.toLowerCase()
      : status.toLowerCase().includes("fail") || status.toLowerCase().includes("error")
        ? "failed"
        : "error";
  try {
    await db
      .prepare(
        `INSERT INTO lipila_logs (kind, reference_id, phone, amount_cents, status, lipila_status, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(kind, ref, phone ?? null, amountCents, normStatus, status, message ?? null)
      .run();
  } catch (e) {
    console.error("lipila_log insert failed:", e);
  }
}

/** Flips a previously-"pending" lipila_log row to its final status once the
 *  Lipila webhook confirms the transaction (success/failed). Keeps the admin
 *  Lipila logs screen truthful instead of showing everything as pending. */
export async function updateLipilaLogStatus(
  db: D1Database | undefined,
  referenceId: string,
  status: "success" | "failed",
  message?: string
): Promise<void> {
  if (!db || !referenceId) return;
  try {
    await db
      .prepare(
        `UPDATE lipila_logs SET status = ?, lipila_status = ?, message = COALESCE(?, message),
                updated_at = datetime('now')
         WHERE reference_id LIKE ? AND status IN ('pending', 'unknown', 'error')`
      )
      .bind(status, status, message ?? null, `${referenceId}%`)
      .run();
  } catch (e) {
    console.error("lipila_log update failed:", e);
  }
}
