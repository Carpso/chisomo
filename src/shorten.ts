// Self-hosted link shortener (no third-party service).
//
// Short URLs are deterministic: the code is derived from the long URL, so
// generating a link needs no lookups and no retries. Links are stored in the
// `short_links` table (long_url PRIMARY KEY, short_url, clicks) for click
// tracking. A short URL looks like `<SHORT_BASE_URL>/go/<code>`; when
// SHORT_BASE_URL is unset we fall back to APP_URL. To rebrand to a custom
// domain, set SHORT_BASE_URL and redeploy — new links use the new domain
// while /go/:code still resolves old ones (it checks both bases).

const CODE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export type ShortLinkEnv = {
  DB: D1Database;
  APP_URL: string;
  SHORT_BASE_URL?: string;
};

/** The base used to build short URLs (custom domain if configured). */
export function shortBaseUrl(env: ShortLinkEnv): string {
  return env.SHORT_BASE_URL ?? env.APP_URL;
}

/** FNV-1a 32-bit hash -> base36 code. */
function hashCode(input: string, salt: number): string {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let code = "";
  while (code.length < 6) {
    code = CODE_CHARS[h % 36] + code;
    h = Math.floor(h / 36);
  }
  return code;
}

/** Deterministic 8-character code for a long URL (two salted FNV passes). */
export function shortCodeFor(longUrl: string): string {
  return hashCode(longUrl, 0).slice(0, 4) + hashCode(longUrl, 0x5eed).slice(0, 4);
}

/**
 * Returns a short URL for [longUrl]. Reuses the stored one if it already
 * exists, otherwise inserts it. Deterministic code — but a previously-stored
 * random code (old shortener) or a different base URL must be reused so the
 * returned link always actually resolves.
 */
export async function createShortLink(env: ShortLinkEnv, longUrl: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT short_url FROM short_links WHERE long_url = ? LIMIT 1"
  ).bind(longUrl).first<{ short_url: string }>();
  if (row?.short_url) return row.short_url;
  const shortUrl = `${shortBaseUrl(env)}/go/${shortCodeFor(longUrl)}`;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO short_links (long_url, short_url, clicks) VALUES (?, ?, 0)"
  ).bind(longUrl, shortUrl).run();
  // Re-check in case a concurrent request inserted a different short URL for
  // this long_url (e.g. the old random shortener) between our SELECT and INSERT.
  const after = await env.DB.prepare(
    "SELECT short_url FROM short_links WHERE long_url = ? LIMIT 1"
  ).bind(longUrl).first<{ short_url: string }>();
  return after?.short_url ?? shortUrl;
}

/** Resolves `/go/:code` -> stored long URL and bumps its click counter.
 *  Also matches links created under a previous base URL, so a domain switch
 *  never breaks old links. */
export async function resolveShortLink(env: ShortLinkEnv, code: string): Promise<string | null> {
  const shortUrl = `${shortBaseUrl(env)}/go/${code}`;
  const legacyUrl = `${env.APP_URL}/go/${code}`;
  const row = await env.DB.prepare(
    "SELECT long_url FROM short_links WHERE short_url IN (?, ?) LIMIT 1"
  ).bind(shortUrl, legacyUrl).first<{ long_url: string }>();
  if (!row) return null;
  await env.DB.prepare(
    "UPDATE short_links SET clicks = clicks + 1 WHERE long_url = ?"
  ).bind(row.long_url).run();
  return row.long_url;
}
