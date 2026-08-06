// Short-link helper using our own Workers domain.
//
// Generates short codes on the APP_URL domain (e.g.
// https://kingdom-sponsor-api.godfreymoseskalambo.workers.dev/go/Ab3x9k)
// so the public share link never exposes the workers.dev hostname.
// Results are cached in D1 (one short link per unique long URL), so the
// same long URL always reuses the same short code.

interface ShortenEnv {
  APP_URL: string;
  DB: D1Database;
}

function generateCode(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 7; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export async function shortenUrl(env: ShortenEnv, longUrl: string): Promise<string> {
  if (!longUrl) return longUrl;

  const cached = await env.DB.prepare(
    "SELECT short_url FROM short_links WHERE long_url = ?"
  )
    .bind(longUrl)
    .first<{ short_url: string }>();
  if (cached) return cached.short_url;

  let code = generateCode();
  let attempts = 0;
  while (attempts < 10) {
    const existing = await env.DB.prepare(
      "SELECT 1 FROM short_links WHERE short_url = ?"
    )
      .bind(`${env.APP_URL}/go/${code}`)
      .first();
    if (!existing) break;
    code = generateCode();
    attempts++;
  }

  const shortUrl = `${env.APP_URL}/go/${code}`;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO short_links (long_url, short_url, clicks) VALUES (?, ?, 0)"
  )
    .bind(longUrl, shortUrl)
    .run();

  return shortUrl;
}