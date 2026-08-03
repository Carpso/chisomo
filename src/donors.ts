// Fun, gamified giver/sponsor usernames + donor tiers.

import type { D1Database } from "@cloudflare/workers-types";

const ADJECTIVES = [
  "Brave", "Golden", "Swift", "Radiant", "Mighty", "Generous", "Cheerful",
  "Bold", "Loyal", "Wise", "Joyful", "Blessed", "Kind", "Eager", "Faithful",
  "Noble", "Bright", "Gentle", "Fearless", "Sunny", "Gracious", "Valiant",
  "Sparkling", "Steadfast", "Grateful",
];

const NOUNS = [
  "Giver", "Sponsor", "Supporter", "Donor", "Angel", "Helper", "Lion",
  "Eagle", "Falcon", "Dove", "Star", "Champion", "Pillar", "Beacon",
  "Friend", "Breeze", "Flame", "Oak", "River", "Summit", "Lantern",
  "Patron", "Backer", "Ally", "Torch",
];

const TIERS = [
  { min: 200000, name: "Sponsor" },   // K2,000+
  { min: 50000, name: "Champion" },   // K500+
  { min: 10000, name: "Supporter" },  // K100+
  { min: 0, name: "Giver" },          // anything
];

export async function generateUsername(db: D1Database): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const digits = String(Math.floor(Math.random() * 900) + 100);
    const username = `${adj}${noun}${digits}`;
    const existing = await db.prepare(
      "SELECT id FROM users WHERE username = ?"
    ).bind(username).first();
    if (!existing) return username;
  }
  return `Giver${Date.now() % 100000}`;
}

/** Ensure a user exists for a phone, with a fun username. Returns user id, username, and phone. */
export async function ensureUser(db: D1Database, phone: string): Promise<{ id: number; username: string; phone: string }> {
  let user = await db.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first<Record<string, any>>();
  if (!user) {
    const username = await generateUsername(db);
    const r = await db.prepare("INSERT INTO users (phone, username) VALUES (?, ?)").bind(phone, username).run();
    user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(r.meta.last_row_id).first<Record<string, any>>();
  }
  if (!user) throw new Error("Could not create user");
  if (!user.username) {
    const username = await generateUsername(db);
    await db.prepare("UPDATE users SET username = ? WHERE id = ?").bind(username, user.id).run();
    user.username = username;
  }
  return { id: user.id, username: user.username, phone: user.phone };
}

/** Total visible giving of a donor across all campaigns. */
export async function donorTotalCents(db: D1Database, donorUserId: number | null): Promise<number> {
  if (!donorUserId) return 0;
  const row = (await db.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS s FROM contributions WHERE donor_user_id = ? AND status = 'confirmed' AND hide_amount = 0"
  ).bind(donorUserId).first<{ s: number }>()) ?? { s: 0 };
  return row.s;
}

export function tierFor(totalCents: number): string {
  for (const t of TIERS) {
    if (totalCents >= t.min) return t.name;
  }
  return "Giver";
}
