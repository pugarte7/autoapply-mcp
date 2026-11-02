import { describe, expect, it } from "vitest";
import { checkSubmissionAllowed, type GuardInput } from "../src/submission/guards.js";
import { normalizeRules, rulesHash, rulesSummary, type ActiveRules, type StandingRulesInput } from "../src/submission/standingRules.js";
import type { Application, DraftAnswer, Evaluation } from "../src/domain/job.js";
import { fixtureResumePath, makeCampaign, makeJob } from "./factories.js";

const NOW = new Date("2026-11-02T10:00:00Z");
const campaign = makeCampaign({ submission: { minDelaySeconds: 0 } });
const job = makeJob({ companyName: "Test Corp", ats: "greenhouse" });

const evaluation: Evaluation = {
  jobId: job.id,
  decision: "accept",
  gate: { passed: true, rule: null, reason: "", evidence: "" },
  trackId: "ai-security",
  score: 88,
  tier: "A",
  components: [],
  flags: [],
  evaluatedAt: NOW.toISOString(),
};

function answer(overrides: Partial<DraftAnswer> = {}): DraftAnswer {
  return {
    questionKey: "email",
    label: "Email",
    answer: "alex@example.com",
    source: "profile",
    citation: "identity.email",
    requiresHuman: false,
    required: true,
    category: "contact",
    guidance: "",
    ...overrides,
  };
}

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: "app_1",
    jobId: job.id,
    status: "awaiting_approval",
    resumeId: "ai-security",
    resumePath: fixtureResumePath(),
    packetHash: "hash-1",
    coverLetter: "",
    answers: [answer()],
    blockedQuestions: [],
    createdAt: NOW.toISOString(),
    approvedAt: null,
    submittedAt: null,
    submissionMode: null,
    confirmationRef: null,
    artifactPath: null,
    notes: "",
    ...overrides,
  };
}

function active(input: Partial<StandingRulesInput> = {}, used: Partial<Pick<ActiveRules, "usedToday">> = {}): ActiveRules {
  return {
    id: "rules_1",
    rules: normalizeRules({ maxPerDay: 5, ...input }, NOW),
    usedToday: used.usedToday ?? 0,
  };
}

function input(overrides: Partial<GuardInput> = {}, rules: ActiveRules[] = [active()]): GuardInput {
  return {
    application: application(),
    job,
    campaign,
    approval: null,
    submittedToday: 0,
    lastSubmissionAt: null,
    standing: { rules, evaluation },
    now: NOW,
    ...overrides,
  };
}

describe("normalizeRules", () => {
  it("defaults to 30 days and A/B tiers, and refuses more than 90 days or the past", () => {
    const rules = normalizeRules({ maxPerDay: 3 }, NOW);
    expect(rules.tiers).toEqual(["A", "B"]);
    expect(rules.expiresAt).toBe("2026-12-02T10:00:00.000Z");
    expect(rules.allowAgentDraftedText).toBe(false);
    expect(() => normalizeRules({ maxPerDay: 3, expiresAt: "2027-03-01T00:00:00Z" }, NOW)).toThrow(/90 days/);
    expect(() => normalizeRules({ maxPerDay: 3, expiresAt: "2026-11-01T00:00:00Z" }, NOW)).toThrow(/future/);
    expect(() => normalizeRules({ maxPerDay: 3, sneaky: true }, NOW)).toThrow(/rules_invalid|Unrecognized/);
  });

  it("hashes the same rules the same way whatever the order they were written in", () => {
    const a = normalizeRules({ maxPerDay: 3, companies: ["B", "A"], tiers: ["B", "A"] }, NOW);
    const b = normalizeRules({ tiers: ["A", "B"], companies: ["A", "B"], maxPerDay: 3 }, NOW);
    expect(rulesHash(a)).toBe(rulesHash(b));
    expect(rulesHash(a)).not.toBe(rulesHash({ ...a, maxPerDay: 4 }));
  });

  it("tells the person what stays with them", () => {
    const summary = rulesSummary(normalizeRules({ maxPerDay: 3 }, NOW), "rules_1", "abc", campaign);
    expect(summary).toContain("work-authorization");
    expect(summary).toContain("any company whose posting passes the campaign gates");
    expect(summary).toContain("not allowed");
    expect(summary).not.toContain("essay,");
  });
});

describe("standing rules in the submission guard", () => {
  it("authorises a matching application without a per-packet approval", () => {
    const result = checkSubmissionAllowed(input());
    expect(result).toMatchObject({ allowed: true, rulesId: "rules_1" });
  });

  it("does not authorise anything without rules", () => {
    expect(checkSubmissionAllowed(input({}, [])).code).toBe("not_approved");
    expect(checkSubmissionAllowed(input({ standing: undefined })).code).toBe("not_approved");
  });

  it("refuses applications the rules do not describe", () => {
    const cases: Array<[Partial<StandingRulesInput>, Partial<GuardInput>?]> = [
      [{ tiers: ["B"] }],
      [{ minScore: 90 }],
      [{ tracks: ["software"] }],
      [{ companies: ["Other Inc"] }],
      [{ excludeCompanies: ["test corp"] }],
      [{ atsKinds: ["lever"] }],
      [{}, { standing: { rules: [active()], evaluation: { ...evaluation, decision: "review" } } }],
    ];
    for (const [rules, overrides] of cases) {
      const result = checkSubmissionAllowed(input(overrides ?? {}, [active(rules)]));
      expect(result.code, JSON.stringify(rules)).toBe("rules_not_matched");
    }
    expect(checkSubmissionAllowed(input({}, [active({ companies: ["TEST CORP"], atsKinds: ["greenhouse"] })])).allowed).toBe(true);
  });

  it("never lets the agent answer a question only the person can", () => {
    const byAgent = application({
      answers: [answer(), answer({ questionKey: "auth", label: "Are you authorized to work?", answer: "Yes", source: "human", requiresHuman: true, category: "work-authorization" })],
    });
    const result = checkSubmissionAllowed(input({ application: byAgent }));
    expect(result.code).toBe("rules_not_matched");
    expect(result.reason).toContain("Are you authorized to work?");

    // Whatever label a writer gives the agent's answer, it is not the person's.
    for (const source of ["agent", "human"] as Array<DraftAnswer["source"]>) {
      const salary = application({ answers: [answer({ questionKey: "pay", label: "Expected salary", answer: "60000", source, category: "compensation" })] });
      expect(checkSubmissionAllowed(input({ application: salary })).code).toBe("rules_not_matched");
    }
    // Even a campaign that stopped blocking a category does not hand it to the rules.
    const loose = makeCampaign({ submission: { blockedQuestionCategories: [] } });
    expect(checkSubmissionAllowed(input({ campaign: loose, application: byAgent })).code).toBe("rules_not_matched");

    // A standing answer the person recorded in the profile is theirs.
    const standing = application({
      answers: [answer({ questionKey: "auth", label: "Are you authorized to work?", answer: "Yes", source: "approved-answer", category: "work-authorization" })],
    });
    expect(checkSubmissionAllowed(input({ application: standing })).allowed).toBe(true);

    // A flagged suggestion nobody confirmed is not an answer either.
    const suggestion = application({
      answers: [answer({ questionKey: "why", label: "Why us?", answer: "Template", source: "approved-answer", requiresHuman: true, category: "narrative" })],
    });
    expect(checkSubmissionAllowed(input({ application: suggestion })).code).toBe("rules_not_matched");
  });

  it("lets ordinary questions the agent answered from the CV through", () => {
    const fromCv = application({ answers: [answer({ questionKey: "years", label: "Years with Python", answer: "6", source: "human", requiresHuman: true, category: "general" })] });
    expect(checkSubmissionAllowed(input({ application: fromCv })).allowed).toBe(true);
  });

  it("sends agent-written cover letters and essays only when the rules allow it", () => {
    const letter = application({ coverLetter: "Dear Test Corp" });
    expect(checkSubmissionAllowed(input({ application: letter })).code).toBe("rules_not_matched");
    expect(checkSubmissionAllowed(input({ application: letter }, [active({ allowAgentDraftedText: true })])).allowed).toBe(true);

    const essay = application({ answers: [answer({ questionKey: "e", label: "Tell us about a project", answer: "I built...", source: "human", requiresHuman: true, category: "essay" })] });
    expect(checkSubmissionAllowed(input({ application: essay })).reason).toContain("agent-written text");
    expect(checkSubmissionAllowed(input({ application: essay }, [active({ allowAgentDraftedText: true })])).allowed).toBe(true);
  });

  it("stops at the rules' daily cap, as a refusal that lifts by itself", () => {
    const day = checkSubmissionAllowed(input({}, [active({}, { usedToday: 5 })]));
    expect(day).toMatchObject({ allowed: false, code: "rules_daily_cap_reached", deferrable: true });
    // Another rule set with room still covers it.
    const spare = { ...active(), id: "rules_2" };
    expect(checkSubmissionAllowed(input({}, [active({}, { usedToday: 5 }), spare])).rulesId).toBe("rules_2");
  });

  it("ignores rules that have expired", () => {
    const later = new Date("2026-12-03T00:00:00Z");
    expect(checkSubmissionAllowed(input({ now: later })).code).toBe("not_approved");
  });

  it("keeps the person's own decision on a packet over any rules", () => {
    const rejected = { id: "apr", applicationId: "app_1", packetHash: "hash-1", decision: "rejected", decidedAt: "", note: "" };
    expect(checkSubmissionAllowed(input({ approval: rejected })).code).toBe("not_approved");
    const stale = { ...rejected, decision: "approved", packetHash: "older" };
    expect(checkSubmissionAllowed(input({ approval: stale })).code).toBe("packet_changed");
  });

  it("leaves every other guard in force", () => {
    expect(checkSubmissionAllowed(input({ job: makeJob({ applyUrl: "https://evil.example.com/apply" }) })).code).toBe("destination_not_allowed");
    expect(checkSubmissionAllowed(input({ submittedToday: 25 })).code).toBe("daily_limit_reached");
    expect(checkSubmissionAllowed(input({ companyApplicationCount: 3 })).code).toBe("company_cap_reached");
    const excluded = makeCampaign({ exclusions: { companies: ["Test Corp"] } });
    expect(checkSubmissionAllowed(input({ campaign: excluded })).code).toBe("company_excluded");
    const unresolved = application({ answers: [answer({ answer: "", source: "blocked", requiresHuman: true })] });
    expect(checkSubmissionAllowed(input({ application: unresolved })).code).toBe("unresolved_questions");
    expect(checkSubmissionAllowed(input({ application: application({ resumePath: "/nope.pdf" }) })).code).toBe("resume_unusable");
  });
});
