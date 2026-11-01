import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { listQueue, saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import { evaluateGates } from "../src/ranking/gates.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

describe("a posting with offices in two countries", () => {
  it("is found by a queue filter for the office the gate admitted it by", () => {
    const job = makeJob({ locationsRaw: ["San Francisco, CA", "Madrid, Spain"], locationClass: "bay-area" });
    const campaign = makeCampaign();
    campaign.locations.allow = ["spain"];
    const gate = evaluateGates(job, { campaign, profile: makeProfile() });
    expect(gate.passed).toBe(true);

    const db = openDatabase(":memory:");
    try {
      upsertJobs(db, [job]);
      saveEvaluation(db, {
        jobId: job.id, decision: "accept", gate, trackId: "ai-security", score: 90, tier: "A",
        components: [], flags: [], evaluatedAt: new Date().toISOString(),
      });
      expect(listQueue(db, { tiers: ["A"], locationClasses: ["spain"] })).toHaveLength(1);
      expect(listQueue(db, { tiers: ["A"], locationClasses: ["canada"] })).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
