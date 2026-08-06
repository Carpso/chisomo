// Fee model: both Kingdom Sponsor and Lipila take a small cut on collection AND
// on disbursement. All values in ngwee (cents). Configure percentages via [vars]
// in wrangler.toml.
//
// Collection: customer pays platform + Lipila collection together on MoMo
// Platform fee: flat K3 minimum + ZMW 0.24 per transaction, or 1% of the donation when that is higher.
// Lipila collection fee: 2.5% (momo fee). Total collection fee shown as one "platform fees" line.
// Disbursement: Lipila's payout fee (1.5%) and Kingdom Sponsor's payout cut (K3 min / 1%) are both deducted from the host's payout at payout time.

export const PLATFORM_FIXED_FEE_CENTS = 24; // ZMW 0.24 per transaction

export interface FeeConfig {
  platformPct: number;         // e.g. 1  -> 1% above the minimum
  platformMinFeeCents: number; // flat minimum platform fee (default K3 = 300)
  lipilaCollectionPct: number; // Lipila's collection fee % (momo fee)
  lipilaDisbursementPct: number; // Lipila's disbursement fee % (key, deducted at payout)
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
  };
}

export function pctOf(cents: number, pct: number): number {
  return Math.round((cents * pct) / 100);
}

/** Donation -> fees taken from that donation. Platform fee is K3 min + ZMW 0.24 per tx, else pct. Always the real K3/1% + ZMW 0.24. */
export function donationFees(amountCents: number, cfg: FeeConfig) {
  const lipilaFeeCents = pctOf(amountCents, cfg.lipilaCollectionPct);
  const platformFeeCents = Math.max(
    cfg.platformMinFeeCents + PLATFORM_FIXED_FEE_CENTS,
    pctOf(amountCents, cfg.platformPct) + PLATFORM_FIXED_FEE_CENTS
  );
  return {
    platformFeeCents,
    lipilaFeeCents,
  };
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

/** Kingdom Sponsor's payout cut: flat K3 minimum, else the platform pct. */
export function platformDisbursementFeeCents(availableCents: number, cfg: FeeConfig): number {
  return Math.max(cfg.platformMinFeeCents, pctOf(availableCents, cfg.platformPct));
}

export function formatKwacha(cents: number): string {
  const k = cents / 100;
  const [whole, frac] = k.toFixed(2).split(".");
  return `K${Number(whole).toLocaleString("en-US")}.${frac}`;
}
