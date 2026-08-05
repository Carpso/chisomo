// Friendly, mobile-money-style transaction SMS texts.
// All amounts are formatted as whole kwacha (e.g. K1,000).

export function kwacha(cents: number): string {
  const k = cents / 100;
  const [whole, frac] = k.toFixed(2).split(".");
  const grouped = Number(whole).toLocaleString("en-US");
  return frac === "00" ? `K${grouped}` : `K${grouped}.${frac}`;
}

export function campaignLink(campaignId: number | string, baseUrl?: string): string {
  const url = baseUrl ?? "https://kingdom-sponsor-api.godfreymoseskalambo.workers.dev";
  return `${url}/share/${campaignId}`;
}

/** Sent to the donor right after a donation is confirmed. */
export function donationConfirmedSms(campaignTitle: string, amountCents: number, reference: string): string {
  return `Thank you! Your gift of ${kwacha(amountCents)} to "${campaignTitle}" is confirmed. Ref: ${reference}. Your receipt is in the app. Kingdom Sponsor`;
}

/** Sent to the host when a donation lands. */
export function donationReceivedSms(campaignTitle: string, amountCents: number, balanceCents: number): string {
  return `New gift ${kwacha(amountCents)} received for "${campaignTitle}". Available balance: ${kwacha(balanceCents)}. Kingdom Sponsor`;
}

/** Sent to the host when a payout is dispatched to their mobile money. */
export function payoutSentSms(campaignTitle: string, amountCents: number): string {
  return `Your payout of ${kwacha(amountCents)} for "${campaignTitle}" has been sent to your mobile money. Check your wallet shortly. Kingdom Sponsor`;
}

/** Sent to the host when a payout could not be dispatched (auto-retried later). */
export function payoutFailedSms(campaignTitle: string, amountCents: number): string {
  return `We could not send your payout of ${kwacha(amountCents)} for "${campaignTitle}" right now. Don't worry — we'll retry automatically. Kingdom Sponsor`;
}

/** Monthly reminder for a recurring pledge. */
export function pledgeReminderSms(campaignTitle: string, amountCents: number, campaignId?: number, baseUrl?: string): string {
  const link = campaignId ? `Give here: ${campaignLink(campaignId, baseUrl)}` : "";
  return `Friendly reminder: your monthly pledge of ${kwacha(amountCents)} to "${campaignTitle}" is due today. ${link} Kingdom Sponsor`;
}

/** Sent to the host once a paid promotion slot goes live. */
export function promotionActiveSms(campaignTitle: string, days: number, until: string): string {
  return `Your campaign "${campaignTitle}" is now promoted to the top of Kingdom Sponsor for ${days} days (until ${until}).`;
}

/** Sent to the host when a paid promotion is rejected. */
export function promotionRejectedSms(campaignTitle: string): string {
  return `Your promotion for "${campaignTitle}" was not approved. Contact support to arrange a refund. Kingdom Sponsor`;
}

/** Sent to the host when their campaign-delete request is approved / removed by admin. */
export function campaignDeletedSms(campaignTitle: string): string {
  return `Your campaign "${campaignTitle}" has been removed from Kingdom Sponsor. Your financial records stay on file for compliance. Kingdom Sponsor`;
}

/** Sent to the host when their campaign-delete request is received. */
export function deleteRequestReceivedSms(campaignTitle: string): string {
  return `We received your request to delete "${campaignTitle}". We'll confirm once the admin reviews it. Kingdom Sponsor`;
}

/** Sent to the host when their campaign-delete request is declined. */
export function deleteRequestRejectedSms(campaignTitle: string): string {
  return `Your request to delete "${campaignTitle}" was declined by the admin. Contact support if you need help. Kingdom Sponsor`;
}

/** Sent to a user when an admin answers their support ticket. */
export function supportReplySms(subject: string): string {
  return `Kingdom Sponsor support replied to your request "${subject}". Open the app to view the reply.`;
}

/** Sent to superadmin phones when a new support ticket arrives. */
export function supportReceivedSms(ticketId: number, subject: string): string {
  return `New support request #${ticketId}: "${subject}". Open the admin panel to reply. Kingdom Sponsor`;
}

/** Sent to the host when their promotion fee is refunded to mobile money. */
export function promotionRefundedSms(campaignTitle: string, amountCents: number): string {
  return `Your promotion payment of ${kwacha(amountCents)} for "${campaignTitle}" has been refunded to your mobile money. Kingdom Sponsor`;
}

/** Sent to the host when a paid promotion window ends (with a renew hint). */
export function promotionExpiredSms(campaignTitle: string): string {
  return `Your promotion for "${campaignTitle}" has ended. You can promote it again anytime in the app. Kingdom Sponsor`;
}

/** Sent to donors when a campaign they supported reaches a milestone. */
export function milestoneSms(campaignTitle: string, pct: number): string {
  return `"${campaignTitle}" just reached ${pct}% of its goal on Kingdom Sponsor. Thank you for being part of it!`;
}

/** Sent to a campaign's donors when it ends (final report). */
export function campaignEndedSms(campaignTitle: string, raisedCents: number, supporters: number): string {
  return `"${campaignTitle}" has ended. ${kwacha(raisedCents)} was raised from ${supporters} supporters. Thank you for giving — Kingdom Sponsor`;
}
