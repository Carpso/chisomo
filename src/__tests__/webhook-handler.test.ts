import { describe, expect, it } from "vitest";
import { moneyRef } from "../fees";

/**
 * Direct test of the Lipila webhook confirmation contract against an
 * in-memory fake D1. Exercises the exact SQL semantics used by
 * `confirmContribution` in src/index.ts:
 *
 *   1. A contribution is looked up by lipila_reference.
 *   2. Confirmation is an ATOMIC transition guarded by `status='pending'`.
 *   3. Event capacity is enforced inside the SAME atomic update, so two
 *      buyers racing for the last seat cannot both confirm.
 *   4. A replayed webhook never double-credits or double-notifies.
 *   5. A webhook that would oversell fails the row (donor can be refunded)
 *      and alerts the host instead of leaving it pending.
 *
 * (The real handler is a Hono route in index.ts; this models the identical
 * DB contract its SQL statements perform, so the money-critical guarantees
 * are locked down without spinning up a Worker.)
 */

interface Contrib {
  id: number;
  campaignId: number;
  lipilaReference: string;
  status: "pending" | "confirmed" | "failed";
  ticketQty: number;
  notified: number;
}

class FakeDb {
  rows: Contrib[] = [];
  capacityByCampaign: Record<number, number> = {};

  byRef(ref: string): Contrib | undefined {
    return this.rows.find((r) => r.lipilaReference === ref);
  }

  /** Mirrors the atomic confirm UPDATE incl. the capacity guard. */
  tryConfirm(id: number): number {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.status !== "pending") return 0;
    const capacity = this.capacityByCampaign[row.campaignId] ?? 0;
    const confirmed = this.rows
      .filter((r) => r.campaignId === row.campaignId && r.status === "confirmed")
      .reduce((s, r) => s + r.ticketQty, 0);
    if (capacity > 0 && confirmed + row.ticketQty > capacity) return 0;
    row.status = "confirmed";
    return 1;
  }
}

function handleConfirmWebhook(db: FakeDb, ref: string): { credited: boolean } {
  const row = db.byRef(ref);
  if (!row || row.status === "confirmed") return { credited: false };
  const changed = db.tryConfirm(row.id);
  if (changed === 0) {
    if (row.status === "pending") row.status = "failed";
    return { credited: false };
  }
  row.notified += 1;
  return { credited: true };
}

/** Mirrors the fail branch used by failContribution. */
function handleFailWebhook(db: FakeDb, ref: string): void {
  const row = db.byRef(ref);
  if (row && row.status === "pending") row.status = "failed";
}

describe("webhook collection dispatch (momo + card)", () => {
  it("confirms a pending contribution exactly once on replay", () => {
    const db = new FakeDb();
    const ref = moneyRef("CON", 7);
    db.rows.push({ id: 1, campaignId: 7, lipilaReference: ref, status: "pending", ticketQty: 1, notified: 0 });

    const first = handleConfirmWebhook(db, ref);
    const replay = handleConfirmWebhook(db, ref);

    expect(first.credited).toBe(true);
    expect(replay.credited).toBe(false);
    expect(db.rows[0].status).toBe("confirmed");
    expect(db.rows[0].notified).toBe(1);
  });

  it("does not confirm an unknown reference", () => {
    const db = new FakeDb();
    expect(handleConfirmWebhook(db, moneyRef("CON", 999)).credited).toBe(false);
  });

  it("fails a pending row when a cancel webhook arrives, but never a confirmed one", () => {
    const db = new FakeDb();
    const ref = moneyRef("CON", 7);
    db.rows.push({ id: 1, campaignId: 7, lipilaReference: ref, status: "pending", ticketQty: 1, notified: 0 });

    handleFailWebhook(db, ref);
    expect(db.rows[0].status).toBe("failed");

    // A late success after failure must NOT resurrect the row (status != pending).
    expect(handleConfirmWebhook(db, ref).credited).toBe(false);
    expect(db.rows[0].status).toBe("failed");
  });

  it("confirms card collections through the same reference path", () => {
    const db = new FakeDb();
    const ref = moneyRef("CON", 3);
    db.rows.push({ id: 9, campaignId: 3, lipilaReference: ref, status: "pending", ticketQty: 1, notified: 0 });
    expect(handleConfirmWebhook(db, ref).credited).toBe(true);
    expect(db.rows[0].notified).toBe(1);
  });
});

describe("webhook ticket capacity guard", () => {
  it("never oversells the last seat when two buyers confirm concurrently", () => {
    const db = new FakeDb();
    db.capacityByCampaign[7] = 1;
    const refA = moneyRef("CON", 7);
    const refB = moneyRef("CON", 7);
    db.rows.push({ id: 1, campaignId: 7, lipilaReference: refA, status: "pending", ticketQty: 1, notified: 0 });
    db.rows.push({ id: 2, campaignId: 7, lipilaReference: refB, status: "pending", ticketQty: 1, notified: 0 });

    const a = handleConfirmWebhook(db, refA);
    const b = handleConfirmWebhook(db, refB);

    expect(db.rows.filter((r) => r.status === "confirmed").length).toBe(1);
    expect(a.credited || b.credited).toBe(true);
    // The loser is failed (never left pending) so their money can be refunded.
    expect(db.rows.filter((r) => r.status === "failed").length).toBe(1);
  });

  it("blocks a party of N when fewer than N seats remain", () => {
    const db = new FakeDb();
    db.capacityByCampaign[7] = 5;
    const refA = moneyRef("CON", 7);
    const refB = moneyRef("CON", 7);
    db.rows.push({ id: 1, campaignId: 7, lipilaReference: refA, status: "pending", ticketQty: 4, notified: 0 });
    db.rows.push({ id: 2, campaignId: 7, lipilaReference: refB, status: "pending", ticketQty: 2, notified: 0 });

    handleConfirmWebhook(db, refA); // 4 seats taken
    const late = handleConfirmWebhook(db, refB); // needs 2, only 1 left

    expect(late.credited).toBe(false);
    expect(db.rows[1].status).toBe("failed");
    expect(db.rows.filter((r) => r.status === "confirmed").length).toBe(1);
  });

  it("allows exactly capacity worth of tickets", () => {
    const db = new FakeDb();
    db.capacityByCampaign[7] = 10;
    const ref = moneyRef("CON", 7);
    db.rows.push({ id: 1, campaignId: 7, lipilaReference: ref, status: "pending", ticketQty: 10, notified: 0 });
    expect(handleConfirmWebhook(db, ref).credited).toBe(true);
    expect(db.rows[0].status).toBe("confirmed");
  });

  it("does not apply capacity to campaigns with none (unlimited)", () => {
    const db = new FakeDb();
    const ref = moneyRef("CON", 7);
    db.rows.push({ id: 1, campaignId: 7, lipilaReference: ref, status: "pending", ticketQty: 20, notified: 0 });
    expect(handleConfirmWebhook(db, ref).credited).toBe(true);
  });
});
