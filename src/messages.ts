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
export function donationConfirmedSms(campaignTitle: string, amountCents: number, reference: string, shareLink?: string): string {
  const link = shareLink ? `\nView: ${shareLink}` : "";
  return `KSPONSOR: Gift of ${kwacha(amountCents)} to "${campaignTitle}" confirmed. Ref: ${reference}${link}\nReceipt: app > Settings > My Receipts.`;
}

/** Sent to the host when a donation lands. */
export function donationReceivedSms(campaignTitle: string, amountCents: number, balanceCents: number, shareLink?: string): string {
  const link = shareLink ? `\nView: ${shareLink}` : "";
  return `KSPONSOR: New gift of ${kwacha(amountCents)} for "${campaignTitle}". Balance: ${kwacha(balanceCents)}${link}`;
}

/** Sent to the host when a payout is dispatched to their mobile money. */
export function payoutSentSms(campaignTitle: string, amountCents: number, shareLink?: string): string {
  const link = shareLink ? `\nView: ${shareLink}` : "";
  return `KSPONSOR: Payout of ${kwacha(amountCents)} for "${campaignTitle}" sent to your mobile money.${link}\nCheck your wallet (arrives in minutes).`;
}

/** Sent to the host when a payout could not be dispatched (auto-retried later). */
export function payoutFailedSms(campaignTitle: string, amountCents: number, shareLink?: string): string {
  const link = shareLink ? `\nView: ${shareLink}` : "";
  return `KSPONSOR: Payout of ${kwacha(amountCents)} for "${campaignTitle}" is delayed.${link}\nWe retry automatically — contact support if it persists.`;
}

/** Monthly reminder for a recurring pledge. `deepLink` opens the app to the
 *  campaign; `shareLink` is the web page for people without the app. */
export function pledgeReminderSms(campaignTitle: string, amountCents: number, deepLink?: string, shareLink?: string): string {
  const links = [deepLink ? `App: ${deepLink}` : "", shareLink ? `Donate: ${shareLink}` : ""].filter(Boolean).join("\n");
  return `KSPONSOR: Your monthly pledge of ${kwacha(amountCents)} to "${campaignTitle}" is due.\n${links ? `${links}\n` : ""}Thank you for your support.`;
}

/** Sent to the host once a paid promotion slot goes live. */
export function promotionActiveSms(campaignTitle: string, days: number, until: string, shareLink?: string): string {
  const link = shareLink ? `\nView: ${shareLink}` : "";
  return `KSPONSOR: "${campaignTitle}" is now promoted at the top for ${days} days (until ${until}).${link}`;
}

/** Sent to the host when a paid promotion is rejected. */
export function promotionRejectedSms(campaignTitle: string): string {
  return `KSPONSOR: Your promotion for "${campaignTitle}" was not approved. Contact support to arrange a refund.`;
}

/** Sent to the host when their campaign-delete request is approved / removed by admin. */
export function campaignDeletedSms(campaignTitle: string): string {
  return `KSPONSOR: Your campaign "${campaignTitle}" has been removed from the platform. Records are kept for compliance.`;
}

/** Sent to the host when their campaign-delete request is received. */
export function deleteRequestReceivedSms(campaignTitle: string): string {
  return `KSPONSOR: We received your request to delete "${campaignTitle}". An admin will review it.`;
}

/** Sent to the host when their campaign-delete request is declined. */
export function deleteRequestRejectedSms(campaignTitle: string): string {
  return `KSPONSOR: Your request to delete "${campaignTitle}" was not approved. Contact support for help.`;
}

/** Sent to the host when their requested campaign edit is approved and applied. */
export function editRequestApprovedSms(campaignTitle: string): string {
  return `KSPONSOR: Your requested changes to "${campaignTitle}" have been approved and applied. Open the app to view.`;
}

/** Sent to a user when an admin answers their support ticket. */
export function supportReplySms(subject: string, assistantName = "Kingdom Sponsor Care Team"): string {
  return `KSPONSOR: Your request "${subject}" has a reply. Open the app to view.\n— ${assistantName}`;
}

/** Sent to superadmin phones when a new support ticket arrives. */
export function supportReceivedSms(ticketId: number, subject: string): string {
  return `KSPONSOR: New support request #${ticketId}: "${subject}". Open the admin panel to reply.`;
}

/** Sent to the host when their promotion fee is refunded to mobile money. */
export function promotionRefundedSms(campaignTitle: string, amountCents: number): string {
  return `KSPONSOR: Promotion payment of ${kwacha(amountCents)} for "${campaignTitle}" refunded to your mobile money.`;
}

/** Sent to the host when a paid promotion window ends (with a renew hint). */
export function promotionExpiredSms(campaignTitle: string): string {
  return `KSPONSOR: Your promotion for "${campaignTitle}" has ended. Promote it again anytime from the app.`;
}

/** Sent to donors when a campaign they supported reaches a milestone. */
export function milestoneSms(campaignTitle: string, pct: number): string {
  return `KSPONSOR: "${campaignTitle}" just reached ${pct}% of its goal. Thank you for being part of it!`;
}

/** Sent to a campaign's donors when it ends (final report). */
export function campaignEndedSms(campaignTitle: string, raisedCents: number, supporters: number, shareLink?: string): string {
  const link = shareLink ? `\nResults: ${shareLink}` : "";
  return `KSPONSOR: "${campaignTitle}" has ended.\nTotal raised: ${kwacha(raisedCents)} from ${supporters} supporters.${link}\nThank you for your generosity.`;
}

/** Sent when an airtime order is accepted by Africa's Talking (awaiting MNO delivery). */
export function airtimeSentSms(phone: string, amountCents: number): string {
  return `KSPONSOR: ${kwacha(amountCents)} airtime sent to ${phone}. We'll confirm the moment it's delivered.`;
}

/** Sent the instant Africa's Talking confirms MNO delivery (status callback). */
export function airtimeDeliveredSms(phone: string, amountCents: number): string {
  return `KSPONSOR: ${kwacha(amountCents)} airtime delivered to ${phone}. Thank you for using Kingdom Sponsor!`;
}

/** Sent when Africa's Talking reports the delivery failed. */
export function airtimeFailedSms(phone: string, amountCents: number): string {
  return `KSPONSOR: ${kwacha(amountCents)} airtime to ${phone} could not be delivered. We'll retry, or contact support for help.`;
}
