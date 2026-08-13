// SMS delivery via Africa's Talking (OTP + donor/host notifications).
// Sign up: https://africastalking.com | Docs: https://apidocs.africastalking.com/
export interface SmsEnv {
  /** Africa's Talking username for this app (e.g. "ChurchOnApp"). Not a secret. */
  AT_USERNAME: string;
  /** Africa's Talking API key (secret). */
  AT_API_KEY: string;
  /** Optional sender ID / shortcode registered on AT. */
  AT_FROM?: string;
  ENV: string;
}

const AT_MESSAGES_URL = "https://api.africastalking.com/version1/messaging";
const AT_AIRTIME_URL = "https://api.africastalking.com/version1/airtime/send";

/** Africa's Talking requires E.164, no leading 0. Assumes +260 Zambian numbers here. */
export function safePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("0") ? `+260${digits.slice(1)}` : `+${digits}`;
}

export async function sendOtpSms(env: SmsEnv, phone: string, code: string): Promise<void> {
  return sendSms(
    env,
    phone,
    `KSPONSOR: Your verification code is ${code}. Valid 5 min. Never share it.`,
  );
}

/** Sends airtime to a Zambian number via Africa's Talking airtime API.
 *  - ENV=production -> real AT API call (requires AT_API_KEY secret).
 *  - other            -> logged only (no network, no billing during dev/sandbox).
 *  Recipient numbers must be E.164 (e.g. +260977123456).
 *  Returns the AT response body on success; throws on failure.
 */
export async function sendAirtime(
  env: SmsEnv,
  phone: string,
  kwachaAmount: number,
): Promise<Record<string, any>> {
  if (env.ENV !== "production") {
    console.log(`[AIRTIME ${phone}] ZMW ${kwachaAmount.toFixed(2)} (sandbox, no network call)`);
    return { responses: [{ status: "Sent", phoneNumber: safePhone(phone), sandbox: true }] };
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
  return parsed;
}

/** Hard cap so a message can never exceed ONE Africa's Talking SMS unit.
 *  `max` defaults to 96 — the platform standard (see messages.ts). */
export function clampSms(message: string, max = 96): string {
  if (message.length <= max) return message;
  return `${message.slice(0, max - 3).trimEnd()}...`;
}

/** Sends a branded SMS via Africa's Talking.
 *  - ENV=production -> real AT API call (requires AT_API_KEY secret).
 *  - other            -> logged only (no network, no billing during dev/sandbox).
 *
 *  The approved, MNO-registered sender ID "KSPONSOR" is ALWAYS used — this
 *  account never sends from Lipila or any other default sender.
 */
export async function sendSms(env: SmsEnv, phone: string, message: string): Promise<void> {
  // Keep every SMS inside one unit (never double-billed).
  const text = clampSms(message);
  if (env.ENV !== "production") {
    console.log(`[SMS ${phone}] ${text}`);
    return;
  }

  // AT requires lowercase form field names (username/to/message/from).
  const form = new URLSearchParams({
    username: env.AT_USERNAME,
    to: safePhone(phone),
    message: text,
    from: "KSPONSOR",
  });
  const res = await fetch(AT_MESSAGES_URL, {
    method: "POST",
    headers: {
      Apikey: env.AT_API_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });
  const body = await res.text().catch(() => "");
  if (res.ok) return;
  throw new Error(`Africa's Talking SMS failed (${res.status}): ${body || "empty body"}`);
}
