// Lipila payment gateway client.
// Docs: https://docs.lipila.dev
// Sandbox dashboard: https://dashboard.lipila.dev   Live: https://dashboard.lipila.io
// NOTE: production API base is blz.lipila.io (NOT api.lipila.io — the flutter SDK has it wrong).

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

  const res = await fetch(`${lipilaBase(env)}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Lipila ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

export function toKwacha(cents: number): number {
  return Math.round(cents) / 100;
}

/** Initiate a mobile-money collection (sends a USSD prompt to the payer's phone). */
export async function createCollection(
  env: LipilaEnv,
  params: { referenceId: string; amountCents: number; accountNumber: string; narration: string; callbackUrl: string }
): Promise<CollectionResult> {
  const data = await lipilaFetch(
    env,
    "/collections/mobile-money",
    {
      referenceId: params.referenceId,
      amount: toKwacha(params.amountCents),
      accountNumber: params.accountNumber,
      currency: "ZMW",
      narration: params.narration,
    },
    params.callbackUrl
  );
  return {
    referenceId: data.referenceId,
    identifier: data.identifier,
    status: data.status,
    amount: data.amount,
  };
}

/** Check status of a collection by referenceId. */
export async function checkCollectionStatus(env: LipilaEnv, referenceId: string): Promise<LipilaStatus> {
  const res = await fetch(
    `${lipilaBase(env)}/collections/status/${encodeURIComponent(referenceId)}`,
    { headers: { accept: "application/json", "x-api-key": env.LIPILA_API_KEY } }
  );
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Lipila status check failed (${res.status}): ${JSON.stringify(data)}`);
  return { status: data.status, message: data.message, amount: data.amount };
}

/** Check status of a disbursement by referenceId. */
export async function checkDisbursementStatus(env: LipilaEnv, referenceId: string): Promise<LipilaStatus> {
  const res = await fetch(
    `${lipilaBase(env)}/disbursements/status/${encodeURIComponent(referenceId)}`,
    { headers: { accept: "application/json", "x-api-key": env.LIPILA_API_KEY } }
  );
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Lipila disbursement status check failed (${res.status}): ${JSON.stringify(data)}`);
  return { status: data.status, message: data.message, amount: data.amount };
}

/** Current available wallet balance in kwacha. */
export async function getWalletBalance(env: LipilaEnv): Promise<number> {
  const res = await fetch(
    `${lipilaBase(env)}/merchants/balance`,
    { headers: { accept: "application/json", "x-api-key": env.LIPILA_API_KEY } }
  );
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Lipila balance failed (${res.status}): ${JSON.stringify(data)}`);
  const bal = Number(data?.data?.balance ?? 0);
  return Number.isFinite(bal) ? bal : 0;
}

/** Disburse to mobile money (host payout). Near-instant. */
export async function createDisbursement(
  env: LipilaEnv,
  params: { referenceId: string; amountCents: number; accountNumber: string; narration: string; callbackUrl: string }
): Promise<DisbursementResult> {
  const data = await lipilaFetch(
    env,
    "/disbursements/mobile-money",
    {
      referenceId: params.referenceId,
      amount: toKwacha(params.amountCents),
      accountNumber: params.accountNumber,
      currency: "ZMW",
      narration: params.narration,
    },
    params.callbackUrl
  );
  return {
    referenceId: data.referenceId,
    identifier: data.identifier,
    status: data.status,
    amount: data.amount,
  };
}
