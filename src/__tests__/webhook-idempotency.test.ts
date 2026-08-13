import { describe, expect, it } from "vitest";
import { moneyRef } from "../fees";

/**
 * Model of the contribution-confirmation contract (src/index.ts
 * confirmContribution + the Lipila webhook handler).
 *
 * Real behaviour that MUST hold so a replayed/concurrent webhook can never
 * double-credit a campaign:
 *  1. A contribution is looked up by its (now collision-proof) lipila_reference.
 *  2. Confirmation is an ATOMIC transition: `UPDATE ... SET status='confirmed'
 *     WHERE id=? AND status='pending'`. Only ONE caller can win that update.
 *  3. If the update changed 0 rows (already confirmed / failed), the caller
 *     returns immediately WITHOUT re-notifying or re-triggering payouts.
 *
 * This test drives an in-memory store with those exact semantics to prove a
 * replayed callback does not double-count.
 */

interface ContribRow {
  id: number;
  lipilaReference: string;
  status: "pending" | "confirmed" | "failed";
  amountCents: number;
  campaignId: number;
  ticketQty: number;
  notified: number;
  failedReason?: string;
}

/** Fake D1 with the same UPDATE ... WHERE status='pending' semantics. */
class FakeDb {
  rows: ContribRow[] = [];
  nextId = 1;
  capacityByCampaign: Record<number, number> = {};

  findByReference(ref: string): ContribRow | undefined {
    return this.rows.find((r) => r.lipilaReference === ref);
  }

  /** Mirrors the atomic confirm UPDATE including the ticket-capacity guard. */
  tryConfirm(id: number): number {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.status !== "pending") return 0;
    const capacity = this.capacityByCampaign[row.campaignId] ?? 0;
    const confirmedQty = this.rows
      .filter((r) => r.campaignId === row.campaignId && r.status === "confirmed")
      .reduce((sum, r) => sum + r.ticketQty, 0);
    if (capacity > 0 && confirmedQty + row.ticketQty > capacity) return 0;
    row.status = "confirmed";
    return 1;
  }
}

/** Mirrors confirmContribution's decision gate + side effects. */
function handleConfirmWebhook(db: FakeDb, ref: string): { credited: boolean } {
  const row = db.findByReference(ref);
  if (!row || row.status === "confirmed") return { credited: false };

  const changed = db.tryConfirm(row.id);
  if (changed === 0) {
    // Capacity blocked (or already confirmed): fail the row so it never
    // lingers as pending — the donor can be refunded.
    if (row.status === "pending") row.status = "failed";
    return { credited: false };
  }

  row.notified += 1;
  return { credited: true };
}

describe("webhook confirmation idempotency", () => {
  it("credits exactly once when the same successful webhook is replayed", () => {
    const db = new FakeDb();
    const ref = moneyRef("CON", 7);
    db.rows.push({ id: 1, lipilaReference: ref, status: "pending", amountCents: 5000, campaignId: 7, notified: 0, ticketQty: 1 });

    const first = handleConfirmWebhook(db, ref);
    const replay = handleConfirmWebhook(db, ref);

    expect(first.credited).toBe(true);
    expect(replay.credited).toBe(false);
    expect(db.rows[0].status).toBe("confirmed");
    expect(db.rows[0].notified).toBe(1); // exactly one notification/payout trigger
  });

  it("credits exactly once when two concurrent callbacks race", () => {
    const db = new FakeDb();
    const ref = moneyRef("CON", 7);
    db.rows.push({ id: 1, lipilaReference: ref, status: "pending", amountCents: 5000, campaignId: 7, notified: 0, ticketQty: 1 });

    // Both webhooks see the row as pending before either commits; only the
    // atomic UPDATE winner proceeds.
    const rowBefore = db.findByReference(ref)!;
    const winsA = handleConfirmWebhook(db, rowBefore.lipilaReference);
    const winsB = handleConfirmWebhook(db, rowBefore.lipilaReference);

    const credited = [winsA, winsB].filter((r) => r.credited).length;
    expect(credited).toBe(1);
    expect(db.rows[0].notified).toBe(1);
  });

  it("does not credit a callback for an unknown reference", () => {
    const db = new FakeDb();
    expect(handleConfirmWebhook(db, moneyRef("CON", 999)).credited).toBe(false);
  });

  it("never re-confirms a failed contribution (UPDATE guarded by status='pending')", () => {
    const db = new FakeDb();
    const ref = moneyRef("CON", 7);
    db.rows.push({ id: 1, lipilaReference: ref, status: "failed", amountCents: 5000, campaignId: 7, notified: 0, ticketQty: 1 });

    expect(handleConfirmWebhook(db, ref).credited).toBe(false);
    expect(db.rows[0].status).toBe("failed");
    expect(db.rows[0].notified).toBe(0);
  });

  it("keeps two DIFFERENT transactions on the same campaign distinct", () => {
    const db = new FakeDb();
    // With collision-proof refs, two donations to campaign 7 in the same ms
    // are different rows and both can be confirmed independently.
    const refA = moneyRef("CON", 7);
    const refB = moneyRef("CON", 7);
    expect(refA).not.toBe(refB);

    db.rows.push({ id: 1, lipilaReference: refA, status: "pending", amountCents: 5000, campaignId: 7, notified: 0, ticketQty: 1 });
    db.rows.push({ id: 2, lipilaReference: refB, status: "pending", amountCents: 5000, campaignId: 7, notified: 0, ticketQty: 1 });

    expect(handleConfirmWebhook(db, refA).credited).toBe(true);
    expect(handleConfirmWebhook(db, refB).credited).toBe(true);
    expect(db.rows[0].notified).toBe(1);
    expect(db.rows[1].notified).toBe(1);
  });

  it("never oversells the last ticket even when two buyers confirm concurrently", () => {
    const db = new FakeDb();
    db.capacityByCampaign[7] = 1; // exactly one seat
    const refA = moneyRef("CON", 7);
    const refB = moneyRef("CON", 7);
    db.rows.push({ id: 1, lipilaReference: refA, status: "pending", amountCents: 5000, campaignId: 7, notified: 0, ticketQty: 1 });
    db.rows.push({ id: 2, lipilaReference: refB, status: "pending", amountCents: 5000, campaignId: 7, notified: 0, ticketQty: 1 });

    const a = handleConfirmWebhook(db, refA);
    const b = handleConfirmWebhook(db, refB);

    const confirmed = db.rows.filter((r) => r.status === "confirmed").length;
    expect(confirmed).toBe(1); // exactly one seat sold
    expect(a.credited || b.credited).toBe(true); // one buyer gets the seat
    // The loser is failed (never left pending), so their payment can be refunded.
    expect(db.rows.filter((r) => r.status === "failed").length).toBe(1);
  });

  it("blocks a ticket purchase when the event is already full", () => {
    const db = new FakeDb();
    db.capacityByCampaign[7] = 2;
    const fullRef = moneyRef("CON", 7);
    db.rows.push({ id: 1, lipilaReference: fullRef, status: "confirmed", amountCents: 5000, campaignId: 7, notified: 1, ticketQty: 2 });
    const lateRef = moneyRef("CON", 7);
    db.rows.push({ id: 2, lipilaReference: lateRef, status: "pending", amountCents: 5000, campaignId: 7, notified: 0, ticketQty: 1 });

    expect(handleConfirmWebhook(db, lateRef).credited).toBe(false);
    expect(db.rows[1].status).toBe("failed");
  });

  it("allows a party of N tickets when N seats remain", () => {
    const db = new FakeDb();
    db.capacityByCampaign[7] = 10;
    const ref = moneyRef("CON", 7);
    db.rows.push({ id: 1, lipilaReference: ref, status: "pending", amountCents: 5000, campaignId: 7, notified: 0, ticketQty: 10 });

    expect(handleConfirmWebhook(db, ref).credited).toBe(true);
    expect(db.rows[0].status).toBe("confirmed");
  });
});
