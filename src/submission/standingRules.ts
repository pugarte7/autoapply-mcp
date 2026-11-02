import { z } from "zod";
import { AtsKindSchema, type Campaign } from "../domain/campaign.js";
import type { Application, DraftAnswer, Evaluation, Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { sha256 } from "../util/hash.js";

/**
 * Standing rules: the person approves a description of the applications they
 * are happy to send, once, and every packet that fits it can then go out
 * without asking them again.
 *
 * A rule set widens what may be sent without a per-packet look, so it is kept
 * deliberately narrow. It never relaxes another guard, it expires, and it
 * never covers a question only the person can answer: such a question must
 * already carry a standing answer they recorded in the profile.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RULES_DAYS = 30;
export const MAX_RULES_DAYS = 90;

const name = z.string().trim().min(1);

export const StandingRulesSchema = z
  .object({
    tiers: z.array(z.enum(["A", "B", "C"])).min(1).default(["A", "B"]),
    minScore: z.number().min(0).max(100).optional(),
    /** Empty means any company whose posting passed the campaign gates. */
    companies: z.array(name).default([]),
    excludeCompanies: z.array(name).default([]),
    tracks: z.array(name).default([]),
    atsKinds: z.array(AtsKindSchema).default([]),
    maxPerDay: z.number().int().positive().max(200),
    /** Cover letters and essays the agent wrote from profile facts. */
    allowAgentDraftedText: z.boolean().default(false),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type StandingRulesInput = z.input<typeof StandingRulesSchema>;
export type StandingRules = Omit<z.infer<typeof StandingRulesSchema>, "expiresAt"> & { expiresAt: string };

/**
 * Settles defaults and the expiry date, so the hash and the summary the
 * person sees cover exactly what will be enforced.
 */
export function normalizeRules(input: unknown, now = new Date()): StandingRules {
  const parsed = StandingRulesSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new AppError("rules_invalid", `standing rules failed validation: ${issues.join("; ")}`);
  }
  const rules = parsed.data;
  const expires = rules.expiresAt ? new Date(rules.expiresAt) : new Date(now.getTime() + DEFAULT_RULES_DAYS * DAY_MS);
  if (expires.getTime() <= now.getTime()) {
    throw new AppError("rules_invalid", "expiresAt must be in the future");
  }
  if (expires.getTime() > now.getTime() + MAX_RULES_DAYS * DAY_MS) {
    throw new AppError("rules_invalid", `standing rules last at most ${MAX_RULES_DAYS} days; pick an earlier expiresAt`);
  }
  const sorted = (values: readonly string[]) => [...new Set(values)].sort();
  return {
    tiers: sorted(rules.tiers) as StandingRules["tiers"],
    ...(rules.minScore === undefined ? {} : { minScore: rules.minScore }),
    companies: sorted(rules.companies),
    excludeCompanies: sorted(rules.excludeCompanies),
    tracks: sorted(rules.tracks),
    atsKinds: sorted(rules.atsKinds) as StandingRules["atsKinds"],
    maxPerDay: rules.maxPerDay,
    allowAgentDraftedText: rules.allowAgentDraftedText,
    expiresAt: expires.toISOString(),
  };
}

export function rulesHash(rules: StandingRules): string {
  const keys = Object.keys(rules).sort() as Array<keyof StandingRules>;
  return sha256(JSON.stringify(keys.map((key) => [key, rules[key]])));
}

const any = (values: readonly string[], all: string) => (values.length === 0 ? all : values.join(", "));

/** What the person reads before saying yes. It has to say what they give up, too. */
export function rulesSummary(rules: StandingRules, rulesId: string, hash: string, campaign: Campaign): string {
  const personOnly = personOnlyCategories(campaign).join(", ");
  return [
    "Let the agent send applications that match these rules without asking you each time?",
    "",
    `Tiers:             ${rules.tiers.join(", ")}`,
    `Minimum score:     ${rules.minScore ?? "any score the campaign accepts"}`,
    `Companies:         ${any(rules.companies, "any company whose posting passes the campaign gates")}`,
    `Never these:       ${any(rules.excludeCompanies, "none beyond the campaign exclusions")}`,
    `Tracks:            ${any(rules.tracks, "every campaign track")}`,
    `Boards:            ${any(rules.atsKinds, "every supported board")}`,
    `At most:           ${rules.maxPerDay} a day`,
    `Agent-written text: ${
      rules.allowAgentDraftedText
        ? "allowed: cover letters and essays the agent writes from your profile facts are sent unseen"
        : "not allowed: any cover letter or essay waits for you"
    }`,
    `Expires:           ${rules.expiresAt}`,
    "",
    "What stays with you: a question in these categories goes out only with an answer you recorded in your",
    `profile, never one the agent wrote: ${personOnly}.`,
    "Other questions the agent answers from your profile and CV are sent as written.",
    "Every other limit still applies: campaign mode, allowed boards, exclusions, per-company cap, daily limit, pacing.",
    "You can revoke these rules at any time with revoke_rules.",
    "",
    `Rules ${rulesId}, hash ${hash}`,
  ].join("\n");
}

/** Essays are the one blocked category the rules can hand to the agent. */
const AGENT_TEXT_CATEGORIES = new Set(["essay", "narrative"]);

/**
 * Always the person's, whatever campaign.json says: trimming the campaign's
 * blocked list must not let standing rules send an agent's answer to these.
 */
const ALWAYS_PERSON_ONLY = [
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
];

export function personOnlyCategories(campaign: Campaign): string[] {
  const categories = new Set([...ALWAYS_PERSON_ONLY, ...campaign.submission.blockedQuestionCategories]);
  return [...categories].filter((category) => !AGENT_TEXT_CATEGORIES.has(category));
}

/**
 * Sources the person wrote ahead of time: a profile field, a profile.answers
 * entry or a profile.personal value with autoFill. Anything else, "human"
 * included, may be the agent: set_application_content stores what the agent
 * passes it under that label.
 */
const PERSON_RECORDED = new Set<string>(["profile", "approved-answer"]);

const filled = (answer: DraftAnswer) => answer.answer.trim().length > 0 && answer.notApplicable !== true;

/**
 * An answer to a person-only question is the person's only when it came from
 * a standing answer they recorded and the drafting engine did not flag it.
 * Without a per-packet approval nothing else shows the person gave it.
 */
function answeredByAgentForPerson(answer: DraftAnswer, personOnly: ReadonlySet<string>): boolean {
  if (!filled(answer)) return false;
  if (personOnly.has(answer.category)) return answer.requiresHuman || !PERSON_RECORDED.has(answer.source);
  // A flagged suggestion nobody confirmed, such as an unauthorised narrative
  // template, is not an answer anybody gave.
  return answer.requiresHuman && PERSON_RECORDED.has(answer.source);
}

/**
 * The questions an application still waits on, split by who can clear them:
 * the person (a person-only question, or a suggestion nobody confirmed) or
 * the agent (a required question it can answer from the profile and CV).
 */
export function waitingOn(application: Application, campaign: Campaign): { person: DraftAnswer[]; agent: DraftAnswer[] } {
  const personOnly = new Set(personOnlyCategories(campaign));
  const open = (answer: DraftAnswer) => answer.requiresHuman && answer.required && answer.answer.trim() === "" && answer.notApplicable !== true;
  return {
    person: application.answers.filter(
      (answer) => answeredByAgentForPerson(answer, personOnly) || (open(answer) && personOnly.has(answer.category)),
    ),
    agent: application.answers.filter((answer) => open(answer) && !personOnly.has(answer.category)),
  };
}

function agentDraftedText(application: Application): string[] {
  const texts = application.answers
    .filter((answer) => filled(answer) && AGENT_TEXT_CATEGORIES.has(answer.category) && !PERSON_RECORDED.has(answer.source))
    .map((answer) => answer.label);
  return application.coverLetter.trim().length > 0 ? ["cover letter", ...texts] : texts;
}

export type ActiveRules = {
  id: string;
  rules: StandingRules;
  usedToday: number;
};

export type StandingCheck = {
  rules: readonly ActiveRules[];
  evaluation: Evaluation | null;
};

export type RulesVerdict =
  | { allowed: true; rulesId: string }
  | { allowed: false; code: string; reason: string; deferrable?: boolean };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Why one rule set does not cover this posting, whatever the packet says, or null when it does. */
export function jobMismatch(rules: StandingRules, job: Job, evaluation: Evaluation | null): string | null {
  if (!evaluation || evaluation.decision !== "accept") return "the posting has not passed the campaign gates";
  if (!(rules.tiers as string[]).includes(evaluation.tier)) return `tier ${evaluation.tier} is outside ${rules.tiers.join("/")}`;
  if (rules.minScore !== undefined && evaluation.score < rules.minScore) {
    return `score ${evaluation.score} is under ${rules.minScore}`;
  }
  if (rules.tracks.length > 0 && !rules.tracks.includes(evaluation.trackId ?? "")) {
    return `track ${evaluation.trackId ?? "none"} is not one of ${rules.tracks.join(", ")}`;
  }
  if (rules.companies.length > 0 && !rules.companies.some((company) => sameName(company, job.companyName))) {
    return `${job.companyName} is not one of the rules' companies`;
  }
  if (rules.excludeCompanies.some((company) => sameName(company, job.companyName))) {
    return `${job.companyName} is excluded by the rules`;
  }
  if (rules.atsKinds.length > 0 && !rules.atsKinds.includes(job.ats)) return `${job.ats} is not one of the rules' boards`;
  return null;
}

/** Why one rule set does not cover this application, or null when it does. */
function mismatch(rules: StandingRules, application: Application, job: Job, check: StandingCheck, campaign: Campaign): string | null {
  const jobReason = jobMismatch(rules, job, check.evaluation);
  if (jobReason) return jobReason;
  const personOnly = new Set(personOnlyCategories(campaign));
  const forPerson = application.answers.filter((answer) => answeredByAgentForPerson(answer, personOnly));
  if (forPerson.length > 0) {
    return `answers only the person can give were not given by them: ${forPerson.map((answer) => answer.label).slice(0, 5).join("; ")}`;
  }
  const drafted = agentDraftedText(application);
  if (drafted.length > 0 && !rules.allowAgentDraftedText) {
    return `the rules do not cover agent-written text: ${drafted.slice(0, 5).join("; ")}`;
  }
  return null;
}

/**
 * Finds an active rule set that covers this application and still has room
 * under its caps. A cap is reported as deferrable: tomorrow, or the next run,
 * the same application is covered again.
 */
export function authoriseByRules(
  application: Application,
  job: Job,
  campaign: Campaign,
  check: StandingCheck | undefined,
  now = new Date(),
): RulesVerdict {
  const active = (check?.rules ?? []).filter((entry) => new Date(entry.rules.expiresAt).getTime() > now.getTime());
  if (active.length === 0) {
    return { allowed: false, code: "not_approved", reason: "no recorded human approval for this application, and no active standing rules" };
  }
  const reasons: string[] = [];
  let capped: RulesVerdict | null = null;
  for (const entry of active) {
    const why = mismatch(entry.rules, application, job, check!, campaign);
    if (why) {
      reasons.push(`${entry.id}: ${why}`);
      continue;
    }
    if (entry.usedToday >= entry.rules.maxPerDay) {
      capped ??= { allowed: false, code: "rules_daily_cap_reached", reason: `rules ${entry.id} allow ${entry.rules.maxPerDay} a day`, deferrable: true };
      continue;
    }
    return { allowed: true, rulesId: entry.id };
  }
  return capped ?? { allowed: false, code: "rules_not_matched", reason: `no standing rules cover this application (${reasons.join(" | ")})` };
}
