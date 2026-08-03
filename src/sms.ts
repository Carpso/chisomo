// Africa's Talking SMS client (OTP delivery).
// Sign up: https://africastalking.com  |  Docs: https://build.at-labs.io/docs/sms

export interface SmsEnv {
  AT_USERNAME: string;
  AT_API_KEY: string;
  AT_FROM?: string; // optional shortcode/sender ID
  ENV: string;
}

const SMS_BASE = {
  sandbox: "https://sandbox-api.africastalking.com/version1/messaging",
  production: "https://api.africastalking.com/version1/messaging",
};

function safePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("0") ? `+260${digits.slice(1)}` : `+${digits}`;
}

export async function sendOtpSms(env: SmsEnv, phone: string, code: string): Promise<void> {
  return sendSms(env, phone, `Kingdom Sponsor verification code: ${code}. It expires in 5 minutes. Do not share it with anyone.`);
}

/** Generic branded SMS. In sandbox/ENV!=production the message is only logged (AT not wired). */
export async function sendSms(env: SmsEnv, phone: string, message: string): Promise<void> {
  if (env.ENV !== "production") {
    console.log(`[SMS ${phone}] ${message}`);
    return;
  }
  const url = SMS_BASE.production;
  const form = new URLSearchParams({
    username: env.AT_USERNAME,
    to: safePhone(phone),
    message,
  });
  if (env.AT_FROM) form.set("from", env.AT_FROM);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: env.AT_API_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Africa's Talking SMS failed (${res.status}): ${JSON.stringify(data)}`);
  }
}
