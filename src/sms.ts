// SMS delivery via Africa's Talking (OTP + donor/host notifications).
// Airtime top-up lives in airtime.ts (Africa's Talking does NOT offer the
// airtime product for Zambia — MTN MoMo / manual providers are used there).
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
