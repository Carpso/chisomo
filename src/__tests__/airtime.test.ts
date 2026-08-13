import { describe, expect, it } from "vitest";
import { getAirtimeProvider, sendAirtime, airtimeProviders } from "../airtime";

describe("getAirtimeProvider", () => {
  it("defaults to manual when no provider is configured", () => {
    expect(getAirtimeProvider({ ENV: "production" }).id).toBe("manual");
  });

  it("selects the configured provider by id", () => {
    expect(getAirtimeProvider({ ENV: "production", AIRTIME_PROVIDER: "mtn_momo" }).id).toBe("mtn_momo");
    expect(getAirtimeProvider({ ENV: "production", AIRTIME_PROVIDER: "africastalking" }).id).toBe("africastalking");
    expect(getAirtimeProvider({ ENV: "production", AIRTIME_PROVIDER: "manual" }).id).toBe("manual");
  });

  it("falls back to manual for unknown ids", () => {
    expect(getAirtimeProvider({ ENV: "production", AIRTIME_PROVIDER: "nonsense" }).id).toBe("manual");
  });
});

describe("airtimeProviders", () => {
  it("lists every registered provider", () => {
    const ids = airtimeProviders().map((p) => p.id);
    expect(ids).toContain("manual");
    expect(ids).toContain("mtn_momo");
    expect(ids).toContain("africastalking");
  });
});

describe("sendAirtime", () => {
  it("returns a manual reference without requiring credentials", async () => {
    const ref = await sendAirtime({ ENV: "production" }, "260977123456", 1);
    expect(ref).toMatch(/^MANUAL-/);
  });

  it("throws when MTN MoMo credentials are missing", async () => {
    const env = { ENV: "production", AIRTIME_PROVIDER: "mtn_momo" };
    await expect(sendAirtime(env, "260977123456", 1)).rejects.toThrow(/MTN_MOMO_SUBSCRIPTION_KEY/);
  });

  it("uses the MTN sandbox token path in non-production", async () => {
    const env = { ENV: "sandbox", AIRTIME_PROVIDER: "mtn_momo", MTN_MOMO_SUBSCRIPTION_KEY: "sk-test" };
    const ref = await sendAirtime(env, "260977123456", 1);
    expect(ref).toMatch(/^[0-9a-f-]{36}$/); // randomUUID reference
  });

  it("throws when Africa's Talking credentials are missing in production", async () => {
    const env = { ENV: "production", AIRTIME_PROVIDER: "africastalking" };
    await expect(sendAirtime(env, "260977123456", 1)).rejects.toThrow(/credentials not configured/);
  });
});
