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

/** Africa's Talking requires E.164, no leading 0. Assumes +260 Zambian numbers here. */
export function safePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("0") ? `+260${digits.slice(1)}` : `+${digits}`;
}

export async function sendOtpSms(env: SmsEnv, phone: string, code: string): Promise<void> {
  return sendSms(
    env,
    phone,
    `Kingdom Sponsor verification code: ${code}. It expires in 5 minutes. Do not share it with anyone.`,
  );
}

/** Sends a branded SMS via Africa's Talking.
 *  - ENV=production -> real AT API call (requires AT_API_KEY secret).
 *  - other            -> logged only (no network, no billing during dev/sandbox).
 */
export async function sendSms(env: SmsEnv, phone: string, message: string): Promise<void> {
  if (env.ENV !== "production") {
    console.log(`[SMS ${phone}] ${message}`);
    return;
  }

  const form = new URLSearchParams({
    USERNAME: env.AT_USERNAME,
    TO: safePhone(phone),
    MESSAGE: message,
    ...(env.AT_FROM ? { FROM: env.AT_FROM } : {}),
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

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Africa's Talking SMS failed (${res.status}): ${JSON.stringify(data)}`);
  }
}
