import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { resetWorkspaceCache } from "../src/config/load.js";
import { fixtureResumePath } from "./factories.js";

/**
 * A fictional candidate's home and a fake Greenhouse board for the standing
 * rules tests: no network, no real person.
 */

const profile = {
  version: 1,
  identity: {
    fullName: "Alex Candidate",
    email: "alex@example.com",
    phone: "555-0100",
    location: { city: "Vancouver", region: "BC", country: "Canada" },
    links: {},
  },
  workAuthorization: {
    citizenships: ["Canada"],
    authorizedIn: ["CA"],
    requiresSponsorshipIn: ["US"],
    statement: "Canadian citizen; US roles require employer support for work authorization.",
    alwaysReviewManually: true,
  },
  compensation: { currency: "USD", targetTotal: 300000, minimumTotal: 200000, disclosurePolicy: "decline" },
  resumes: [{ id: "sec", label: "Security", path: fixtureResumePath(), tracks: ["sec"], isDefault: true }],
  skills: [{ name: "Python", level: "strong", tags: [] }],
  facts: [{ id: "f1", statement: "Built security guardrails with policy engines.", tags: ["security", "policy"] }],
  answers: [
    { key: "source", label: "How did you hear about us?", patterns: ["how did you hear"], answer: "Careers page", allowAutoFill: true },
  ],
};

function campaign() {
  return {
    version: 1,
    name: "rules-campaign",
    targetApplications: 100,
    tracks: [
      {
        id: "sec",
        label: "Security",
        allocation: 1,
        titleIncludes: ["security engineer"],
        keywords: [
          { term: "security", weight: 3 },
          { term: "policy", weight: 2 },
          { term: "python", weight: 1 },
        ],
        resumeId: "sec",
      },
    ],
    locations: { allow: ["bay-area"], workplaceTypes: ["onsite", "hybrid", "remote", "unknown"] },
    compensation: { currency: "USD", floors: { US: 200000 }, fx: { USD: 1 }, allowUnknown: true, rejectBelowFloor: true },
    scoring: { thresholds: { tierA: 80, tierB: 70, tierC: 60 } },
    submission: { dailyLimit: 20, minDelaySeconds: 0, maxBatchSize: 5, maxPerCompany: 5 },
  };
}

const companies = { version: 1, companies: [{ name: "Acme", ats: "greenhouse", board: "acme", tier: "A" }] };

function posting(id: number, title: string) {
  return {
    id,
    title,
    first_published: new Date().toISOString(),
    absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    content: "Build security tooling with policy enforcement in Python.",
    location: { name: "San Francisco, CA" },
    pay_input_ranges: [{ min_cents: 20000000, max_cents: 30000000, currency_type: "USD", title: "SF" }],
  };
}

const plainForm = {
  questions: [
    { label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text" }] },
    { label: "Email", required: true, fields: [{ name: "email", type: "input_text" }] },
    { label: "How did you hear about us?", required: false, fields: [{ name: "hear", type: "input_text" }] },
  ],
  compliance: [],
};

/** Job 9's form asks something only the person can answer. */
const authorizationForm = {
  questions: [
    ...plainForm.questions,
    {
      label: "Are you legally authorized to work in the United States?",
      required: true,
      fields: [{ name: "auth", type: "multi_value_single_select", values: [{ label: "Yes", value: 1 }, { label: "No", value: 0 }] }],
    },
  ],
  compliance: [],
};

/** Job 8's form asks for an essay, which the agent can draft. */
const essayForm = {
  questions: [
    ...plainForm.questions,
    { label: "Describe a security system you designed and why", required: true, fields: [{ name: "essay", type: "textarea" }] },
  ],
  compliance: [],
};

export function stubBoard(jobCount = 3, withAuthorizationJob = false, withEssayJob = false): void {
  const titles = ["Detection", "Platform", "Identity", "Cloud"];
  const jobs = titles.slice(0, jobCount).map((name, index) => posting(index + 1, `Senior Security Engineer, ${name}`));
  if (withAuthorizationJob) jobs.push(posting(9, "Senior Security Engineer, Authorization"));
  if (withEssayJob) jobs.push(posting(8, "Senior Security Engineer, Essays"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.toString();
      const detail = href.match(/\/jobs\/(\d+)/);
      const forms: Record<string, unknown> = { "9": authorizationForm, "8": essayForm };
      const body = detail ? (forms[detail[1]!] ?? plainForm) : { jobs };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

export function makeRulesHome(): string {
  const home = mkdtempSync(join(tmpdir(), "autoapply-rules-"));
  writeFileSync(join(home, "profile.json"), JSON.stringify(profile));
  writeFileSync(join(home, "campaign.json"), JSON.stringify(campaign()));
  writeFileSync(join(home, "companies.json"), JSON.stringify(companies));
  process.env.AUTOAPPLY_HOME = home;
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  process.env.AUTOAPPLY_LOG_LEVEL = "error";
  for (const key of ["AUTOAPPLY_PROFILE", "AUTOAPPLY_CAMPAIGN", "AUTOAPPLY_COMPANIES", "AUTOAPPLY_DB"]) {
    delete process.env[key];
  }
  resetWorkspaceCache();
  return home;
}
