import { z } from "zod";

/**
 * Campaign configuration: what counts as a qualified job, how it is scored,
 * and how far automation is allowed to go. All policy lives here so the server
 * itself stays generic.
 */

const nonEmpty = z.string().trim().min(1);

export const LocationClassSchema = z.enum([
  "bay-area",
  "us-other",
  "canada",
  "remote-us",
  "remote-canada",
  "remote-global",
  "spain",
  "remote-spain",
  "europe",
  "remote-europe",
  "other",
  "unknown",
]);
export type LocationClass = z.infer<typeof LocationClassSchema>;

export const KeywordSchema = z.object({
  term: nonEmpty,
  weight: z.number().min(0).max(10).default(1),
  aliases: z.array(nonEmpty).default([]),
});

export const TrackSchema = z.object({
  id: nonEmpty,
  label: nonEmpty,
  /** Share of the campaign target allocated to this track (0..1). */
  allocation: z.number().min(0).max(1).default(0),
  titleIncludes: z.array(nonEmpty).default([]),
  titleExcludes: z.array(nonEmpty).default([]),
  keywords: z.array(KeywordSchema).default([]),
  resumeId: nonEmpty,
});

export const ScoringWeightsSchema = z.object({
  roleAlignment: z.number().min(0).default(25),
  domainAlignment: z.number().min(0).default(25),
  stackAlignment: z.number().min(0).default(15),
  seniority: z.number().min(0).default(10),
  compensation: z.number().min(0).default(10),
  workAuthorization: z.number().min(0).default(10),
  freshness: z.number().min(0).default(5),
});

export const CompensationPolicySchema = z.object({
  currency: z.string().length(3).default("USD"),
  /** Minimum acceptable total compensation per ISO country code. */
  floors: z.record(z.string(), z.number().positive()),
  /** Static FX rates to the campaign currency. Documented, not fetched. */
  fx: z.record(z.string(), z.number().positive()).default({ USD: 1 }),
  /** Keep postings with no published compensation instead of rejecting them. */
  allowUnknown: z.boolean().default(true),
  /** Reject when the top of the published range is under the floor. */
  rejectBelowFloor: z.boolean().default(true),
});

export const SUBMISSION_MODES = ["auto", "assisted"] as const;
export type SubmissionMode = (typeof SUBMISSION_MODES)[number];
/** The removed mode, still accepted on load and read as "auto". */
export const LEGACY_MANUAL_MODE = "manual";

export const SubmissionPolicySchema = z.object({
  /**
   * auto     - the agent fills and submits approved applications by itself
   * assisted - server fills the form in a visible window, a person presses submit
   *
   * A "manual" mode used to return the packet for a person to send. It was
   * removed so the agent does the work end to end; a config file written
   * before that still says "manual", and failing to load it would strand the
   * whole campaign over one word, so it reads as "auto" and `doctor` warns.
   * Nothing is sent without approval either way: the guards still demand it.
   */
  mode: z
    .preprocess((value) => (value === LEGACY_MANUAL_MODE ? "auto" : value), z.enum(SUBMISSION_MODES))
    .default("auto"),
  allowedAtsDomains: z.array(nonEmpty).default([
    "boards.greenhouse.io",
    "job-boards.greenhouse.io",
    "jobs.lever.co",
    "jobs.ashbyhq.com",
  ]),
  allowedCompanies: z.array(nonEmpty).default([]),
  /** Null explicitly disables the daily ceiling; other submission guards still apply. */
  dailyLimit: z.number().int().positive().nullable().default(25),
  /**
   * Hard ceiling on how many applications may be prepared or submitted in a
   * single batch. Keeps a run reviewable by a human and avoids tripping ATS
   * rate limiting, which rejects rapid consecutive submissions. Applies even
   * when a caller passes a larger explicit limit.
   */
  maxBatchSize: z.number().int().positive().default(3),
  /**
   * Hard ceiling on how many applications may exist for any one company.
   * Several employers cap applications per candidate over a rolling window and
   * reject the excess outright, so spreading across companies is worth more
   * than depth at one. Counts every application that still occupies a slot;
   * withdrawn and failed ones are not counted.
   */
  maxPerCompany: z.number().int().positive().default(3),
  minDelaySeconds: z.number().int().min(0).default(45),
  /** Question categories that always require a human decision. */
  blockedQuestionCategories: z.array(nonEmpty).default([
    "work-authorization",
    "sponsorship",
    "citizenship",
    "clearance",
    "criminal-history",
    "compensation",
    "demographic",
    "veteran",
    "disability",
    "legal-attestation",
    "essay",
    "reference",
  ]),
  captureScreenshots: z.boolean().default(true),
});

export const CampaignSchema = z.object({
  version: z.literal(1),
  name: nonEmpty,
  targetApplications: z.number().int().positive().default(100),
  tracks: z.array(TrackSchema).min(1),
  locations: z
    .object({
      allow: z.array(LocationClassSchema).min(1),
      includePatterns: z.array(nonEmpty).default([]),
      excludePatterns: z.array(nonEmpty).default([]),
      workplaceTypes: z.array(z.enum(["onsite", "hybrid", "remote", "unknown"])).default([
        "onsite",
        "hybrid",
        "remote",
        "unknown",
      ]),
    })
    .strict(),
  compensation: CompensationPolicySchema,
  seniority: z
    .object({
      allow: z.array(nonEmpty).default(["senior", "staff", "principal", "unspecified"]),
      reject: z.array(nonEmpty).default(["intern", "new-grad", "junior", "manager", "director", "executive"]),
    })
    .prefault({}),
  exclusions: z
    .object({
      titlePatterns: z.array(nonEmpty).default([]),
      descriptionPatterns: z.array(nonEmpty).default([]),
      companies: z.array(nonEmpty).default([]),
    })
    .prefault({}),
  scoring: z
    .object({
      weights: ScoringWeightsSchema.prefault({}),
      thresholds: z
        .object({ tierA: z.number().default(85), tierB: z.number().default(75), tierC: z.number().default(68) })
        .prefault({}),
    })
    .prefault({}),
  freshnessDays: z.number().int().positive().default(45),
  submission: SubmissionPolicySchema.prefault({}),
});

export type Campaign = z.infer<typeof CampaignSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type ScoringWeights = z.infer<typeof ScoringWeightsSchema>;
export type CompensationPolicy = z.infer<typeof CompensationPolicySchema>;
export type SubmissionPolicy = z.infer<typeof SubmissionPolicySchema>;

/**
 * `google`, `meta`, `amazon` and `apple` are the employers' own career sites.
 * They only take applications from a signed-in account, so submitting to them
 * runs in a browser profile the candidate signed in to by hand.
 */
export const AtsKindSchema = z.enum([
  "greenhouse",
  "lever",
  "ashby",
  "workday",
  "smartrecruiters",
  "workable",
  "recruitee",
  "google",
  "meta",
  "amazon",
  "apple",
]);
export type AtsKind = z.infer<typeof AtsKindSchema>;

export const CompanySchema = z.object({
  name: nonEmpty,
  ats: AtsKindSchema,
  /**
   * Board token / site slug used by the ATS public API.
   * Workday has no single token, so it carries the `tenant/datacenter/site`
   * triple read off the employer's career-site URL, e.g.
   * `nvidia/wd5/NVIDIAExternalCareerSite`.
   */
  board: nonEmpty,
  tier: z.enum(["A", "B", "C"]).default("B"),
  tags: z.array(nonEmpty).default([]),
  active: z.boolean().default(true),
  /** Lever and Ashby have EU-hosted instances. */
  region: z.enum(["global", "eu"]).default("global"),
  /**
   * Server-side search filter, for boards that support one. Large Workday
   * tenants and SmartRecruiters boards publish thousands of unrelated postings,
   * and each posting costs a second request to read its description, so
   * narrowing at the source is both cheaper and more polite than filtering
   * after the fact. Ignored by boards with no search endpoint.
   */
  query: z.string().default(""),
});
export type Company = z.infer<typeof CompanySchema>;

export const CompanyListSchema = z.object({
  version: z.literal(1),
  companies: z.array(CompanySchema),
});
