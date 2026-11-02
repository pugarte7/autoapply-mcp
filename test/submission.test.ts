import { describe, expect, it } from "vitest";
import { checkSubmissionAllowed } from "../src/submission/guards.js";
import { checkUrlAllowed } from "../src/submission/allowlist.js";
import { computePacketHash, renderPacketPreview } from "../src/submission/packet.js";
import type { Application, DraftAnswer } from "../src/domain/job.js";
import { makeCampaign, makeJob, fixtureResumePath } from "./factories.js";

const campaign = makeCampaign();
const job = makeJob();

function answer(overrides: Partial<DraftAnswer> = {}): DraftAnswer {
  return {
    questionKey: "email",
    label: "Email",
    answer: "alex@example.com",
    source: "profile",
    citation: "identity.email",
    requiresHuman: false,
    category: "contact",
    ...overrides,
  };
}

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: "app_1",
    jobId: job.id,
    status: "approved",
    resumeId: "ai-security",
    resumePath: fixtureResumePath(),
    packetHash: "hash-1",
    coverLetter: "",
    answers: [answer()],
    blockedQuestions: [],
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    submittedAt: null,
    submissionMode: null,
    confirmationRef: null,
    artifactPath: null,
    notes: "",
    ...overrides,
  };
}

const approval = {
  id: "apr_1",
  applicationId: "app_1",
  packetHash: "hash-1",
  decision: "approved",
  decidedAt: new Date().toISOString(),
  note: "",
};

const baseInput = {
  application: application(),
  job,
  campaign,
  approval,
  submittedToday: 0,
  lastSubmissionAt: null,
  requestedMode: "auto" as const,
};

describe("checkUrlAllowed", () => {
  it("allows known ATS hosts", () => {
    expect(checkUrlAllowed("https://job-boards.greenhouse.io/acme/jobs/1", campaign.submission).allowed).toBe(true);
    expect(checkUrlAllowed("https://jobs.lever.co/acme/1", campaign.submission).allowed).toBe(true);
  });

  it("rejects unknown hosts, http and malformed urls", () => {
    expect(checkUrlAllowed("https://evil.example.com/apply", campaign.submission).allowed).toBe(false);
    expect(checkUrlAllowed("http://jobs.lever.co/acme/1", campaign.submission).allowed).toBe(false);
    expect(checkUrlAllowed("not-a-url", campaign.submission).allowed).toBe(false);
  });
});

describe("checkSubmissionAllowed", () => {
  it("allows a fully approved auto submission under the default campaign", () => {
    expect(campaign.submission.mode).toBe("auto");
    expect(checkSubmissionAllowed(baseInput).allowed).toBe(true);
  });

  it.each(["auto", "assisted"] as const)("still refuses %s without an approval record", (requestedMode) => {
    const result = checkSubmissionAllowed({ ...baseInput, approval: null, requestedMode });
    expect(result.code).toBe("not_approved");
  });

  it("refuses an approval that was declined, in auto mode too", () => {
    const result = checkSubmissionAllowed({ ...baseInput, approval: { ...approval, decision: "rejected" } });
    expect(result.code).toBe("not_approved");
  });

  it("refuses a company on the exclusion list, however it was approved", () => {
    // The exclusion list used to be consulted only when gating newly discovered
    // jobs, so an application approved before the exclusion was added stayed
    // submittable. Submission cannot be undone, so the list has to hold here.
    const result = checkSubmissionAllowed({
      ...baseInput,
      campaign: {
        ...campaign,
        exclusions: { ...campaign.exclusions, companies: [job.companyName.toUpperCase()] },
      },
    });
    expect(result.code).toBe("company_excluded");
  });

  it("refuses when content changed after approval", () => {
    const result = checkSubmissionAllowed({
      ...baseInput,
      application: application({ packetHash: "hash-2" }),
    });
    expect(result.code).toBe("packet_changed");
  });

  it("refuses when a required human answer is still empty", () => {
    const result = checkSubmissionAllowed({
      ...baseInput,
      application: application({
        answers: [
          answer({ questionKey: "auth", label: "Work authorization", answer: "", requiresHuman: true, required: true }),
        ],
      }),
    });
    expect(result.code).toBe("unresolved_questions");
  });

  it("allows an empty optional question the candidate chose not to answer", () => {
    // Lyft's optional pronouns list offers no decline option, so the standing
    // "prefer not to say" has nowhere to go. A blank optional field asserts
    // nothing and cannot stop the form submitting, so it must not block.
    const result = checkSubmissionAllowed({
      ...baseInput,
      application: application({
        answers: [
          answer({ questionKey: "pronouns", label: "Pronouns", answer: "", requiresHuman: true, required: false }),
        ],
      }),
    });
    expect(result.code).toBe("ok");
  });

  it("refuses a mode stronger than the campaign allows", () => {
    const assisted = makeCampaign({ submission: { mode: "assisted" } });
    const result = checkSubmissionAllowed({ ...baseInput, campaign: assisted, requestedMode: "auto" });
    expect(result.code).toBe("mode_not_permitted");
  });

  it("lets a call ask for assisted under an auto campaign", () => {
    // The person may want to watch or press submit themselves; assisted is the
    // lesser mode, so an auto ceiling permits it.
    expect(checkSubmissionAllowed({ ...baseInput, requestedMode: "assisted" }).allowed).toBe(true);
  });

  it.each(["smartrecruiters", "workable", "recruitee", "apple"] as const)(
    "refuses %s, which has no browser submission, and points at record_submission",
    (ats) => {
      const input = {
        ...baseInput,
        job: makeJob({ ats, applyUrl: "https://apply.example.com/job/1" }),
        campaign: makeCampaign({
          submission: { mode: "auto", allowedAtsDomains: ["apply.example.com"], allowedCompanies: [job.companyName] },
        }),
      };
      for (const requestedMode of ["auto", "assisted"] as const) {
        const result = checkSubmissionAllowed({ ...input, requestedMode });
        expect(result.code).toBe("ats_browser_not_supported");
        expect(result.reason).toContain("https://apply.example.com/job/1");
        expect(result.reason).toContain("record_submission");
      }
      // Said before approval is looked at, so the agent does not chase one for
      // a packet that could never be sent.
      expect(checkSubmissionAllowed({ ...input, approval: null }).code).toBe("ats_browser_not_supported");
    },
  );

  it("refuses destinations off the allowlist", () => {
    const result = checkSubmissionAllowed({
      ...baseInput,
      job: makeJob({ applyUrl: "https://careers.evil.example.com/apply" }),
    });
    expect(result.code).toBe("destination_not_allowed");
  });

  it("enforces the daily limit", () => {
    const result = checkSubmissionAllowed({
      ...baseInput,
      campaign: makeCampaign({ submission: { dailyLimit: 15 } }),
      submittedToday: 15,
    });
    expect(result.code).toBe("daily_limit_reached");
  });

  it.each([0, 15, 101, Number.MAX_SAFE_INTEGER])(
    "does not apply a daily ceiling when explicitly unlimited, after %s submissions",
    (submittedToday) => {
      const result = checkSubmissionAllowed({
        ...baseInput,
        campaign: makeCampaign({ submission: { dailyLimit: null } }),
        submittedToday,
      });
      expect(result.code).toBe("ok");
    },
  );

  it("retains company caps, pacing and approval requirements with an unlimited daily limit", () => {
    const unlimited = {
      ...baseInput,
      campaign: makeCampaign({ submission: { dailyLimit: null, maxPerCompany: 3, minDelaySeconds: 90 } }),
      submittedToday: 101,
    };
    expect(checkSubmissionAllowed({ ...unlimited, companyApplicationCount: 4 }).code).toBe("company_cap_reached");
    expect(checkSubmissionAllowed({ ...unlimited, lastSubmissionAt: new Date().toISOString() }).code).toBe("pacing");
    expect(checkSubmissionAllowed({ ...unlimited, approval: null }).code).toBe("not_approved");
    expect(checkSubmissionAllowed({
      ...unlimited,
      application: application({ resumePath: `${fixtureResumePath()}.missing` }),
    }).code).toBe("resume_unusable");
    expect(checkSubmissionAllowed({
      ...unlimited,
      application: application({ answers: [answer({ answer: "", required: true, requiresHuman: true })] }),
    }).code).toBe("unresolved_questions");
  });

  it("enforces the per-company ceiling", () => {
    // The count includes this approved application, so the ceiling is only
    // breached once another one sits beyond it.
    const result = checkSubmissionAllowed({
      ...baseInput,
      companyApplicationCount: campaign.submission.maxPerCompany + 1,
    });
    expect(result.code).toBe("company_cap_reached");
  });

  it("lets an approved application spend the slot it already holds", () => {
    const result = checkSubmissionAllowed({
      ...baseInput,
      companyApplicationCount: campaign.submission.maxPerCompany,
    });
    expect(result.allowed).toBe(true);
  });

  it("enforces pacing between submissions", () => {
    const result = checkSubmissionAllowed({ ...baseInput, lastSubmissionAt: new Date().toISOString() });
    expect(result.code).toBe("pacing");
    expect(result.waitSeconds).toBeGreaterThan(0);
  });

  it("refuses to submit twice", () => {
    const result = checkSubmissionAllowed({
      ...baseInput,
      application: application({ status: "submitted", submittedAt: new Date().toISOString() }),
    });
    expect(result.code).toBe("already_submitted");
  });

  it("restricts auto mode to allowlisted companies", () => {
    const autoCampaign = makeCampaign({
      submission: { mode: "auto", allowedCompanies: ["Other Corp"] },
    });
    const result = checkSubmissionAllowed({ ...baseInput, campaign: autoCampaign, requestedMode: "auto" });
    expect(result.code).toBe("company_not_allowlisted");
  });

  it("does not restrict auto mode when allowedCompanies is empty", () => {
    expect(campaign.submission.allowedCompanies).toEqual([]);
    expect(checkSubmissionAllowed({ ...baseInput, requestedMode: "auto" }).allowed).toBe(true);
  });

  it("does not restrict assisted mode to allowlisted companies", () => {
    const narrowed = makeCampaign({ submission: { allowedCompanies: ["Other Corp"] } });
    expect(checkSubmissionAllowed({ ...baseInput, campaign: narrowed, requestedMode: "assisted" }).allowed).toBe(true);
  });
});

describe("packet hashing", () => {
  it("is stable for identical content regardless of answer order", () => {
    const a = { ...application(), answers: [answer({ questionKey: "a" }), answer({ questionKey: "b" })] };
    const b = { ...application(), answers: [answer({ questionKey: "b" }), answer({ questionKey: "a" })] };
    const base = { jobId: job.id, company: "c", jobTitle: "t", applyUrl: job.applyUrl, resumeId: "r", resumePath: "p", coverLetter: "" };
    expect(computePacketHash({ ...base, answers: a.answers })).toBe(computePacketHash({ ...base, answers: b.answers }));
  });

  it("changes when any answer changes", () => {
    const base = { jobId: job.id, company: "c", jobTitle: "t", applyUrl: job.applyUrl, resumeId: "r", resumePath: "p", coverLetter: "" };
    const first = computePacketHash({ ...base, answers: [answer()] });
    const second = computePacketHash({ ...base, answers: [answer({ answer: "different@example.com" })] });
    expect(first).not.toBe(second);
  });

  it("renders a preview that marks unresolved questions", () => {
    const preview = renderPacketPreview({
      applicationId: "app_1",
      jobId: job.id,
      company: "Test Corp",
      jobTitle: "Senior Security Engineer",
      applyUrl: job.applyUrl,
      resumeId: "ai-security",
      resumePath: fixtureResumePath(),
      coverLetter: "",
      answers: [answer({ label: "Work authorization", answer: "", requiresHuman: true })],
    });
    expect(preview).toContain("[NEEDS HUMAN]");
    expect(preview).toContain("(empty)");
  });
});
