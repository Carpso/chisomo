// Minimal HS256 JWT using Web Crypto (no dependencies).

const enc = new TextEncoder();

function b64url(data: Uint8Array): string {
  let bin = "";
  data.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function secretKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export interface TokenPayload {
  sub: number; // user id
  phone: string;
  isHost: boolean;
  iat: number;
  exp: number;
}

export async function signToken(payload: Omit<TokenPayload, "iat" | "exp">, secret: string, ttlSeconds = 60 * 60 * 24 * 30): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds })));
  const data = `${header}.${body}`;
  const key = await secretKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyToken(token: string, secret: string): Promise<TokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const key = await secretKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), enc.encode(`${header}.${body}`));
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as TokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
