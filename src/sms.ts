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

  const send = async (from?: string) => {
    // AT requires lowercase form field names (username/to/message/from).
    const form = new URLSearchParams({
      username: env.AT_USERNAME,
      to: safePhone(phone),
      message: message,
      ...(from ? { from } : {}),
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
  };

  try {
    await send(env.AT_FROM);
  } catch (e) {
    // AT returns 400 with "Invalid senderId" until a sender ID is approved.
    // Fall back to the account's default sender so OTPs keep flowing; when
    // KSPONSOR gets approved, this fallback stops being used automatically.
    if (env.AT_FROM && String(e).includes("(400)")) {
      console.error("[SMS] sender ID rejected, retrying without FROM:", String(e).slice(0, 200));
      await send(undefined);
      console.warn("[SMS] delivered with default sender (KSPONSOR not approved yet)");
      return;
    }
    throw e;
  }
}
