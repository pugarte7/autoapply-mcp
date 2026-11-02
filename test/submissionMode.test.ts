import { describe, expect, it } from "vitest";
import { findLegacyCampaignSettings } from "../src/config/legacySettings.js";
import { findStrayKeys } from "../src/config/strayKeys.js";
import { CampaignSchema, SubmissionPolicySchema } from "../src/domain/campaign.js";
import { makeCampaign } from "./factories.js";

describe("submission mode", () => {
  it("defaults to auto", () => {
    expect(SubmissionPolicySchema.parse({}).mode).toBe("auto");
    expect(makeCampaign().submission.mode).toBe("auto");
  });

  it("keeps assisted as the alternative", () => {
    expect(SubmissionPolicySchema.parse({ mode: "assisted" }).mode).toBe("assisted");
  });

  it("loads a legacy manual campaign as auto instead of failing", () => {
    expect(SubmissionPolicySchema.parse({ mode: "manual" }).mode).toBe("auto");
    expect(makeCampaign({ submission: { mode: "manual" } }).submission.mode).toBe("auto");
  });

  it("still rejects a mode that never existed", () => {
    expect(SubmissionPolicySchema.safeParse({ mode: "yolo" }).success).toBe(false);
  });

  it("does not report a legacy mode as a stray key", () => {
    const raw = { ...(makeCampaign() as Record<string, unknown>), submission: { mode: "manual" } };
    expect(findStrayKeys(CampaignSchema, raw)).toEqual([]);
  });
});

describe("findLegacyCampaignSettings", () => {
  it("warns that manual was removed and is treated as auto", () => {
    const warnings = findLegacyCampaignSettings({ submission: { mode: "manual" } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"manual" was removed');
    expect(warnings[0]).toContain('treated as "auto"');
  });

  it.each([
    { submission: { mode: "auto" } },
    { submission: { mode: "assisted" } },
    { submission: {} },
    {},
    null,
    "not an object",
  ])("says nothing about %j", (raw) => {
    expect(findLegacyCampaignSettings(raw)).toEqual([]);
  });
});
