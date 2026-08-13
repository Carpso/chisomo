// Transaction SMS texts — the ONLY SMS the platform sends (verification + money
// movements). Everything else is a push notification only.
//
// Rule: every message must stay <= 96 characters so it always fits ONE
// Africa's Talking SMS unit (no double billing). Amounts are whole kwacha
// (e.g. K1,000).

export function kwacha(cents: number): string {
  const k = cents / 100;
  const [whole, frac] = k.toFixed(2).split(".");
  const grouped = Number(whole).toLocaleString("en-US");
  return frac === "00" ? `K${grouped}` : `K${grouped}.${frac}`;
}

/** Truncates a campaign title so the SMS stays inside a single unit. */
export function shortTitle(title: string, max = 18): string {
  const t = String(title ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Sent to the donor right after a donation is confirmed. */
export function donationConfirmedSms(campaignTitle: string, amountCents: number, reference: string): string {
  return `KSPONSOR: Gift ${kwacha(amountCents)} "${shortTitle(campaignTitle)}" confirmed. Ref ${reference}.`;
}

/** Sent to the host when a donation lands. */
export function donationReceivedSms(campaignTitle: string, amountCents: number, balanceCents: number): string {
  return `KSPONSOR: New gift ${kwacha(amountCents)}. Balance ${kwacha(balanceCents)}.`;
}

/** Sent to the host when a payout is dispatched to their mobile money. */
export function payoutSentSms(campaignTitle: string, amountCents: number): string {
  return `KSPONSOR: Payout ${kwacha(amountCents)} for "${shortTitle(campaignTitle)}" sent.`;
}

/** Sent to the host when a payout could not be dispatched (auto-retried later). */
export function payoutFailedSms(campaignTitle: string, amountCents: number): string {
  return `KSPONSOR: Payout ${kwacha(amountCents)} delayed. We retry automatically.`;
}

/** Sent when an airtime order is accepted by Africa's Talking (awaiting MNO delivery). */
export function airtimeSentSms(amountCents: number): string {
  return `KSPONSOR: ${kwacha(amountCents)} airtime order received.`;
}

/** Sent the instant Africa's Talking confirms MNO delivery (status callback). */
export function airtimeDeliveredSms(amountCents: number): string {
  return `KSPONSOR: ${kwacha(amountCents)} airtime delivered. Thank you!`;
}

/** Sent when Africa's Talking reports the delivery failed. */
export function airtimeFailedSms(amountCents: number): string {
  return `KSPONSOR: ${kwacha(amountCents)} airtime failed. We retry, or contact support.`;
}

/** Sent when a user requests to link accounts with someone (security action). */
export function accountLinkRequestSms(requesterName: string, linkType: string, linkId: number): string {
  return `KSPONSOR: ${shortTitle(requesterName, 14)} wants to link accounts (${linkType}). Open the app to accept.`;
}
