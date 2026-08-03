// Friendly, mobile-money-style transaction SMS texts.
// All amounts are formatted as whole kwacha (e.g. K1,000).

export function kwacha(cents: number): string {
  const k = cents / 100;
  return k % 1 === 0 ? `K${k.toLocaleString()}` : `K${k.toFixed(2)}`;
}

/** Sent to the donor right after a donation is confirmed. */
export function donationConfirmedSms(campaignTitle: string, amountCents: number, reference: string): string {
  return `Thanks for your gift of ${kwacha(amountCents)} to "${campaignTitle}" on Kingdom Sponsor. Ref: ${reference}. May you be richly blessed.`;
}

/** Sent to the host when a donation lands. */
export function donationReceivedSms(campaignTitle: string, amountCents: number, balanceCents: number): string {
  return `New gift of ${kwacha(amountCents)} received for "${campaignTitle}". Available balance: ${kwacha(balanceCents)}. Kingdom Sponsor`;
}

/** Sent to the host when a payout is dispatched to their mobile money. */
export function payoutSentSms(campaignTitle: string, amountCents: number): string {
  return `Your payout of ${kwacha(amountCents)} for "${campaignTitle}" has been sent to your mobile money. Kingdom Sponsor`;
}

/** Monthly reminder for a recurring pledge. */
export function pledgeReminderSms(campaignTitle: string, amountCents: number, campaignId?: number): string {
  const link = campaignId ? `Give here: https://kingdom-sponsor-api.godfreymoseskalambo.workers.dev/share/${campaignId}` : "";
  return `It's that time again! Your monthly pledge of ${kwacha(amountCents)} to "${campaignTitle}" is due. ${link} Kingdom Sponsor`;
}

/** Sent to the host once a paid promotion slot goes live. */
export function promotionActiveSms(campaignTitle: string, days: number, until: string): string {
  return `Your campaign "${campaignTitle}" is now promoted to the top of Kingdom Sponsor for ${days} days (until ${until}).`;
}
