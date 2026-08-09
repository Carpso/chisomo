import { describe, expect, it } from "vitest";
import {
  donationFees,
  payoutAmountCents,
  disbursementFeeCents,
  platformDisbursementFeeCents,
  feeConfigPublic,
  loadFeeConfig,
  formatKwacha,
  type FeeConfig,
} from "../fees";

const DEFAULT: FeeConfig = {
  platformPct: 1,
  platformMinFeeCents: 300,
  lipilaCollectionPct: 2.5,
  lipilaDisbursementPct: 1.5,
  cardPlatformPct: 2,
  cardPlatformMinFeeCents: 500,
  cardLipilaCollectionPct: 2.5,
};

describe("loadFeeConfig", () => {
  it("uses defaults when env is empty", () => {
    expect(loadFeeConfig({})).toEqual(DEFAULT);
  });

  it("parses env strings and ignores garbage", () => {
    expect(loadFeeConfig({ PLATFORM_FEE_PCT: "2", PLATFORM_MIN_FEE_CENTS: "500" }))
      .toMatchObject({ platformPct: 2, platformMinFeeCents: 500 });
    expect(loadFeeConfig({ PLATFORM_FEE_PCT: "abc" }).platformPct).toBe(1);
    expect(loadFeeConfig({ LIPILA_COLLECTION_FEE_PCT: "3.25" }).lipilaCollectionPct).toBe(3.25);
  });
});

describe("donationFees", () => {
  it("charges the flat K3 minimum + ZMW 0.24 on small donations", () => {
    const f = donationFees(1000, DEFAULT); // K10
    expect(f.platformFeeCents).toBe(324); // 300 (K3 min) + 24 (ZMW 0.24)
    expect(f.lipilaFeeCents).toBe(25);
  });

  it("charges 1% + ZMW 0.24 when the percentage exceeds the K3 minimum", () => {
    const f = donationFees(50000, DEFAULT); // K500 -> 1% = K5
    expect(f.platformFeeCents).toBe(524); // 500 (1%) + 24
  });

  it("never lets the platform fee exceed the donation after Lipila's fee", () => {
    const f = donationFees(350, DEFAULT); // K3.50
    expect(f.platformFeeCents).toBeLessThan(350);
    expect(f.platformFeeCents + f.lipilaFeeCents).toBeLessThan(350);
  });
});

describe("donationFees (cards)", () => {
  it("charges the flat K5 minimum + ZMW 0.24 on small card donations", () => {
    const f = donationFees(1000, DEFAULT, "card"); // K10
    expect(f.platformFeeCents).toBe(524); // 500 (K5 min) + 24 (ZMW 0.24)
    expect(f.lipilaFeeCents).toBe(25); // 2.5% Lipila card collection fee
  });

  it("charges 2% + ZMW 0.24 when the percentage exceeds the K5 minimum", () => {
    const f = donationFees(100000, DEFAULT, "card"); // K1000 -> 2% = K20
    expect(f.platformFeeCents).toBe(2024); // 2000 (2%) + 24
  });

  it("momo donations still use K3 min / 1%", () => {
    const f = donationFees(1000, DEFAULT, "momo");
    expect(f.platformFeeCents).toBe(324);
  });
});

describe("payoutAmountCents", () => {
  it("deducts both disbursement fees including the ZMW 0.24 fixed fee", () => {
    const available = 10000; // K100
    const payout = payoutAmountCents(available, DEFAULT);
    expect(payout).toBe(available - disbursementFeeCents(available, DEFAULT) - platformDisbursementFeeCents(available, DEFAULT));
    expect(payout).toBe(10000 - 150 - 324); // 1.5% + K3 min + ZMW 0.2400
  });

  it("applies the ZMW 0.24 fixed fee when the percentage exceeds the K3 minimum", () => {
    const available = 100000; // K1000 -> 1% = K10
    const fee = platformDisbursementFeeCents(available, DEFAULT);
    expect(fee).toBe(1024); // 1000 (1%) + 24 (ZMW 0.24)
  });

  it("never goes negative", () => {
    expect(payoutAmountCents(10, DEFAULT)).toBe(0);
  });
});

describe("feeConfigPublic", () => {
  it("exposes total momo percentage for transparent UI", () => {
    expect(feeConfigPublic(DEFAULT)).toMatchObject({
      platformPct: 1,
      momoPct: 2.5,
      totalPct: 3.5,
      disbursementPct: 1.5,
      cardPct: 2,
      cardMinFeeCents: 500,
      cardLipilaPct: 2.5,
    });
  });
});

describe("formatKwacha", () => {
  it("formats ngwee as kwacha with two decimals", () => {
    expect(formatKwacha(100)).toBe("K1.00");
    expect(formatKwacha(123456)).toBe("K1,234.56");
    expect(formatKwacha(0)).toBe("K0.00");
  });
});
