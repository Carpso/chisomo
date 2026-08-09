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
    `KSPONSOR: Your Kingdom Sponsor verification code is ${code}. It expires in 5 minutes. Do not share it.`,
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
    // Approved sender ID for this account is "KSPONSOR". Use it for ALL SMS
    // (OTP + notifications) so messages arrive branded and pass MNO filtering.
    const sender = (env.AT_FROM && env.AT_FROM.trim()) ? env.AT_FROM.trim() : "KSPONSOR";
    await send(sender);
  } catch (e) {
    // AT returns 400 with "Invalid senderId" until a sender ID is approved.
    // Fall back to the account's default sender so OTPs keep flowing.
    if (String(e).includes("(400)")) {
      console.error("[SMS] sender ID rejected, retrying without FROM:", String(e).slice(0, 200));
      await send(undefined);
      console.warn("[SMS] delivered with AT default sender (KSPONSOR rejected)");
      return;
    }
    throw e;
  }
}
