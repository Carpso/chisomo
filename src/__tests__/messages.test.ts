import { describe, expect, it } from "vitest";
import {
  kwacha,
  campaignLink,
  donationConfirmedSms,
  donationReceivedSms,
  payoutSentSms,
  pledgeReminderSms,
  promotionActiveSms,
  promotionRejectedSms,
  promotionRefundedSms,
  promotionExpiredSms,
  milestoneSms,
  campaignEndedSms,
  supportReplySms,
  supportReceivedSms,
} from "../messages";

describe("kwacha", () => {
  it("renders whole kwacha without decimals and fractions with two decimals", () => {
    expect(kwacha(100)).toBe("K1");
    expect(kwacha(1000)).toBe("K10");
    expect(kwacha(150)).toBe("K1.50");
    expect(kwacha(123456)).toBe("K1,234.56");
  });
});

describe("campaignLink", () => {
  it("points at the public share page", () => {
    expect(campaignLink(42)).toBe("https://kingdom-sponsor-api.godfreymoseskalambo.workers.dev/share/42");
  });
});

describe("transaction messages", () => {
  it("donationConfirmedSms includes amount, campaign and reference", () => {
    const msg = donationConfirmedSms("Back to school", 5000, "CON-7-1234");
    expect(msg).toContain("K50");
    expect(msg).toContain("Back to school");
    expect(msg).toContain("CON-7-1234");
  });

  it("donationConfirmedSms embeds the share link when one is given", () => {
    expect(donationConfirmedSms("Back to school", 5000, "CON-7-1234", "https://bit.ly/xyz")).toContain("https://bit.ly/xyz");
  });

  it("donationReceivedSms shows the current available balance", () => {
    expect(donationReceivedSms("Back to school", 5000, 12300)).toContain("K123");
  });

  it("donationReceivedSms embeds the share link when one is given", () => {
    expect(donationReceivedSms("Back to school", 5000, 12300, "https://bit.ly/xyz")).toContain("https://bit.ly/xyz");
  });

  it("payoutSentSms mentions mobile money", () => {
    expect(payoutSentSms("Back to school", 9500)).toContain("mobile money");
  });

  it("payoutSentSms embeds the share link when one is given", () => {
    expect(payoutSentSms("Back to school", 9500, "https://bit.ly/xyz")).toContain("https://bit.ly/xyz");
  });

  it("pledgeReminderSms embeds the share link when one is given", () => {
    const msg = pledgeReminderSms("Back to school", 5000, "https://bit.ly/xyz");
    expect(msg).toContain("https://bit.ly/xyz");
    expect(msg).toContain("K50");
  });

  it("pledgeReminderSms omits the link without one", () => {
    expect(pledgeReminderSms("Back to school", 5000)).not.toContain("share/");
  });
});

describe("promotion messages", () => {
  it("promotionActiveSms states days and end date", () => {
    expect(promotionActiveSms("Back to school", 7, "2026-08-12")).toContain("7 days");
    expect(promotionActiveSms("Back to school", 7, "2026-08-12")).toContain("2026-08-12");
  });

  it("promotionActiveSms embeds the share link when one is given", () => {
    expect(promotionActiveSms("Back to school", 7, "2026-08-12", "https://bit.ly/xyz")).toContain("https://bit.ly/xyz");
  });

  it("promotionRejectedSms points to support for a refund", () => {
    expect(promotionRejectedSms("Back to school")).toContain("support");
  });

  it("promotionRefundedSms carries the refunded amount", () => {
    expect(promotionRefundedSms("Back to school", 15000)).toContain("K150");
  });

  it("promotionExpiredSms hints at renewing", () => {
    expect(promotionExpiredSms("Back to school")).toContain("again");
  });
});

describe("milestone + campaign-end messages", () => {
  it("milestoneSms reports the percentage", () => {
    expect(milestoneSms("Back to school", 50)).toContain("50%");
  });

  it("campaignEndedSms reports raised amount and supporter count", () => {
    const msg = campaignEndedSms("Back to school", 500000, 12);
    expect(msg).toContain("K5,000");
    expect(msg).toContain("12 supporters");
  });

  it("campaignEndedSms embeds the share link when one is given", () => {
    expect(campaignEndedSms("Back to school", 500000, 12, "https://bit.ly/xyz")).toContain("https://bit.ly/xyz");
  });

  it("campaignEndedSms omits the link without one", () => {
    expect(campaignEndedSms("Back to school", 500000, 12)).not.toContain("bit.ly");
  });
});

describe("support messages", () => {
  it("supportReplySms names the ticket subject", () => {
    expect(supportReplySms("Payout issue")).toContain("Payout issue");
  });

  it("supportReceivedSms carries ticket id + subject", () => {
    const msg = supportReceivedSms(3, "Payout issue");
    expect(msg).toContain("#3");
    expect(msg).toContain("Payout issue");
  });
});
