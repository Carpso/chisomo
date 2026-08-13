import { describe, expect, it } from "vitest";
import { parseEventTiers } from "../index";

describe("parseEventTiers", () => {
  it("parses a JSON string of tiers", () => {
    const tiers = parseEventTiers('[{"name":"Standard","amountCents":20000},{"name":"VIP","amountCents":50000}]');
    expect(tiers).toEqual([
      { name: "Standard", amountCents: 20000 },
      { name: "VIP", amountCents: 50000 },
    ]);
  });

  it("parses an already-parsed array (what the Flutter app sends)", () => {
    const tiers = parseEventTiers([
      { name: "Standard", amountCents: 20000 },
      { name: "VIP", amountCents: 50000 },
    ]);
    expect(tiers.length).toBe(2);
    expect(tiers[0]).toEqual({ name: "Standard", amountCents: 20000 });
  });

  it("drops tiers with no name or zero amount", () => {
    expect(parseEventTiers([{ name: "", amountCents: 20000 }])).toEqual([]);
    expect(parseEventTiers([{ name: "Free", amountCents: 0 }])).toEqual([]);
  });

  it("returns [] for null, empty and garbage", () => {
    expect(parseEventTiers(null)).toEqual([]);
    expect(parseEventTiers(undefined)).toEqual([]);
    expect(parseEventTiers("not json")).toEqual([]);
    expect(parseEventTiers({})).toEqual([]);
    expect(parseEventTiers("")).toEqual([]);
  });
});
