import { describe, expect, it } from "vitest";
import {
  kwacha,
  shortTitle,
  donationConfirmedSms,
  donationReceivedSms,
  payoutSentSms,
  payoutFailedSms,
  airtimeSentSms,
  airtimeDeliveredSms,
  airtimeFailedSms,
  accountLinkRequestSms,
} from "../messages";

const MAX_SMS_LEN = 96;

describe("kwacha", () => {
  it("renders whole kwacha without decimals and fractions with two decimals", () => {
    expect(kwacha(100)).toBe("K1");
    expect(kwacha(1000)).toBe("K10");
    expect(kwacha(150)).toBe("K1.50");
    expect(kwacha(123456)).toBe("K1,234.56");
  });
});

describe("shortTitle", () => {
  it("keeps short titles intact", () => {
    expect(shortTitle("Back to school")).toBe("Back to school");
  });
  it("truncates long titles with an ellipsis", () => {
    const t = shortTitle("A very long campaign title that keeps going and going and going");
    expect(t.length).toBeLessThanOrEqual(18);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("SMS length cap (single unit rule)", () => {
  const samples = [
    donationConfirmedSms("Back to school", 5000, "CON-7-1234"),
    donationConfirmedSms("A very long campaign title that keeps going and going and going", 123456789, "CON-123456789"),
    donationReceivedSms("Back to school", 5000, 12300),
    donationReceivedSms("A very long campaign title that keeps going and going and going", 5000, 123000000),
    payoutSentSms("Back to school", 9500),
    payoutSentSms("A very long campaign title that keeps going and going and going", 95000000),
    payoutFailedSms("Back to school", 9500),
    payoutFailedSms("A very long campaign title that keeps going and going and going", 95000000),
    airtimeSentSms(5000),
    airtimeSentSms(10000000),
    airtimeDeliveredSms(5000),
    airtimeDeliveredSms(10000000),
    airtimeFailedSms(5000),
    airtimeFailedSms(10000000),
    accountLinkRequestSms("John Doe", "family", 42),
  ];
  it("every SMS fits one 96-character unit", () => {
    for (const msg of samples) {
      expect(msg.length, msg).toBeLessThanOrEqual(MAX_SMS_LEN);
    }
  });
  it("every SMS is branded with KSPONSOR", () => {
    for (const msg of samples) {
      expect(msg.startsWith("KSPONSOR:")).toBe(true);
    }
  });
});

describe("transaction messages", () => {
  it("donationConfirmedSms includes amount, campaign and reference", () => {
    const msg = donationConfirmedSms("Back to school", 5000, "CON-7-1234");
    expect(msg).toContain("K50");
    expect(msg).toContain("Back to school");
    expect(msg).toContain("CON-7-1234");
  });

  it("donationReceivedSms shows the current available balance", () => {
    expect(donationReceivedSms("Back to school", 5000, 12300)).toContain("K123");
  });

  it("payoutSentSms mentions the amount", () => {
    expect(payoutSentSms("Back to school", 9500)).toContain("K95");
    expect(payoutSentSms("Back to school", 9500)).toContain("Back to school");
  });

  it("payoutFailedSms explains the retry", () => {
    expect(payoutFailedSms("Back to school", 9500)).toContain("retry");
  });

  it("airtime messages carry the amount", () => {
    expect(airtimeSentSms(5000)).toContain("K50");
    expect(airtimeDeliveredSms(5000)).toContain("K50");
    expect(airtimeFailedSms(5000)).toContain("K50");
  });

  it("accountLinkRequestSms names the requester and link type", () => {
    const msg = accountLinkRequestSms("John Doe", "family", 42);
    expect(msg).toContain("John Doe");
    expect(msg).toContain("family");
  });
});
