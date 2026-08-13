// Fee model: both Kingdom Sponsor and Lipila take a small cut on collection AND
// on disbursement. All values in ngwee (cents). Configure percentages via [vars]
// in wrangler.toml.
//
// Every transaction (collection OR disbursement) carries the same platform fee:
//   ZMW 0.4800 flat per transaction + 1% (K3 minimum)  -> "platform fee"
// plus Lipila's fee for that leg (2.5% collection / 1.5% disbursement).
// The full amount is shown to users as one line: "Processing fees".
//
// Collection: customer pays platform + Lipila collection together on MoMo.
// Disbursement: Lipila's payout fee (1.5%) and Kingdom Sponsor's payout cut
// (K3 min / 1% + ZMW 0.48) are both deducted from the host's payout at payout time.

export const PLATFORM_FIXED_FEE_CENTS = 48; // ZMW 0.4800 per transaction (collection and disbursement)

/**
 * Collision-proof reference for money flows. A bare millisecond timestamp can
 * collide when two transactions hit the same campaign (or phone) in the same
 * ms, which would silently corrupt webhook idempotency (two rows sharing one
 * lipila_reference -> double-credit risk). We append a short random suffix.
 */
export function moneyRef(prefix: string, scopeId: number | string, time = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${scopeId}-${time}-${rand}`;
}

export interface FeeConfig {
  platformPct: number;         // e.g. 1  -> 1% above the minimum
  platformMinFeeCents: number; // flat minimum platform fee (default K3 = 300)
  lipilaCollectionPct: number; // Lipila's collection fee % (momo fee)
  lipilaDisbursementPct: number; // Lipila's disbursement fee % (key, deducted at payout)
  cardPlatformPct: number;     // card platform fee % (default 2)
  cardPlatformMinFeeCents: number; // card platform minimum (default K5 = 500)
  cardLipilaCollectionPct: number; // Lipila's card collection fee % (donor pays)
}

export function parsePct(v: string | undefined, fallback: number): number {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadFeeConfig(env: object): FeeConfig {
  const e = env as Record<string, string | undefined>;
  return {
    platformPct: parsePct(e.PLATFORM_FEE_PCT, 1),
    platformMinFeeCents: Math.round(parsePct(e.PLATFORM_MIN_FEE_CENTS, 300)),
    lipilaCollectionPct: parsePct(e.LIPILA_COLLECTION_FEE_PCT, 2.5),
    lipilaDisbursementPct: parsePct(e.LIPILA_DISBURSEMENT_FEE_PCT, 1.5),
    cardPlatformPct: parsePct(e.CARD_PLATFORM_FEE_PCT, 2),
    cardPlatformMinFeeCents: Math.round(parsePct(e.CARD_PLATFORM_MIN_FEE_CENTS, 500)),
    cardLipilaCollectionPct: parsePct(e.CARD_LIPILA_COLLECTION_FEE_PCT, 2.5),
  };
}

/** Collection fee percentages exposed to the app for transparent fee display. */
export function feeConfigPublic(cfg: FeeConfig) {
  return {
    platformPct: cfg.platformPct,
    platformMinFeeCents: cfg.platformMinFeeCents,
    platformFixedFeeCents: PLATFORM_FIXED_FEE_CENTS,
    momoPct: cfg.lipilaCollectionPct,
    totalPct: cfg.platformPct + cfg.lipilaCollectionPct,
    disbursementPct: cfg.lipilaDisbursementPct,
    cardPct: cfg.cardPlatformPct,
    cardMinFeeCents: cfg.cardPlatformMinFeeCents,
    cardLipilaPct: cfg.cardLipilaCollectionPct,
  };
}

export function pctOf(cents: number, pct: number): number {
  return Math.round((cents * pct) / 100);
}

/** Optional fee overrides for a specific transaction (event commission). */
export interface FeeOverrides {
  /** Flat % charged by Kingdom Sponsor (replaces platformPct). */
  platformPct?: number;
  /** Minimum platform fee in cents (replaces platformMinFeeCents). */
  platformMinFeeCents?: number;
  /** Fixed fee in cents (defaults to PLATFORM_FIXED_FEE_CENTS). */
  fixedFeeCents?: number;
  /** When true, Kingdom Sponsor takes NO platform fee (only Lipila's fee). */
  waivePlatform?: boolean;
}

/**
 * Donation / event-ticket fees. Platform fee is K3 min + ZMW 0.48 per tx,
 * else pct; cards K5 min / 2% + ZMW 0.48 + Lipila's card fee. Pass [overrides]
 * to waive the platform cut (admin "waive event fees").
 */
export function donationFees(
  amountCents: number,
  cfg: FeeConfig,
  method: "momo" | "card" = "momo",
  overrides?: FeeOverrides
) {
  const fixed = overrides?.fixedFeeCents ?? PLATFORM_FIXED_FEE_CENTS;
  const lipilaPct = method === "card" ? cfg.cardLipilaCollectionPct : cfg.lipilaCollectionPct;
  const lipilaFeeCents = pctOf(amountCents, lipilaPct);

  if (overrides?.waivePlatform) {
    // Admin waived the platform commission: the donor only pays Lipila's fee.
    return { platformFeeCents: 0, lipilaFeeCents };
  }

  if (method === "card") {
    const platformPct = overrides?.platformPct ?? cfg.cardPlatformPct;
    const platformMin = overrides?.platformMinFeeCents ?? cfg.cardPlatformMinFeeCents;
    const platformFeeCents = Math.max(
      platformMin + fixed,
      pctOf(amountCents, platformPct) + fixed
    );
    return { platformFeeCents, lipilaFeeCents };
  }

  const platformPct = overrides?.platformPct ?? cfg.platformPct;
  const platformMin = overrides?.platformMinFeeCents ?? cfg.platformMinFeeCents;
  const platformFeeCents = Math.max(
    platformMin + fixed,
    pctOf(amountCents, platformPct) + fixed
  );
  return { platformFeeCents, lipilaFeeCents };
}

/**
 * What the host actually receives on a payout of `availableCents`
 * after Lipila's disbursement fee and Kingdom Sponsor's payout cut.
 */
export function payoutAmountCents(availableCents: number, cfg: FeeConfig): number {
  return Math.max(
    0,
    availableCents - disbursementFeeCents(availableCents, cfg) - platformDisbursementFeeCents(availableCents, cfg)
  );
}

/** Lipila's disbursement fee on a payout of `availableCents`. */
export function disbursementFeeCents(availableCents: number, cfg: FeeConfig): number {
  return pctOf(availableCents, cfg.lipilaDisbursementPct);
}

/** Kingdom Sponsor's payout cut: ZMW 0.48 + flat K3 minimum, or ZMW 0.48 + the platform pct when that is higher. */
export function platformDisbursementFeeCents(availableCents: number, cfg: FeeConfig): number {
  return Math.max(
    cfg.platformMinFeeCents + PLATFORM_FIXED_FEE_CENTS,
    pctOf(availableCents, cfg.platformPct) + PLATFORM_FIXED_FEE_CENTS
  );
}

export function formatKwacha(cents: number): string {
  const k = cents / 100;
  const [whole, frac] = k.toFixed(2).split(".");
  return `K${Number(whole).toLocaleString("en-US")}.${frac}`;
}
