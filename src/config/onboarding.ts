import { classifyQuestion } from "../drafting/blockedQuestions.js";
import { isPlainObject } from "./configFiles.js";

/**
 * What the profile and campaign still lack for the forms boards typically
 * show, as one grouped list of questions.
 *
 * Asking one thing per message is what makes setup feel like an interrogation:
 * the agent learns of each gap only when a form trips over it. Read up front,
 * the gaps become a single message the person answers once. The checks run on
 * the raw files, drafts included, because the point is to finish a profile
 * that does not validate yet.
 */

export type OnboardingQuestion = { field: string; question: string; optional?: boolean };
export type OnboardingGroup = { title: string; questions: OnboardingQuestion[] };
/** A gap the agent closes itself with a tool, so it is never put to the person. */
export type AgentFix = { field: string; gap: string; fix: { tool: string; arguments?: Record<string, unknown> }; note: string };
export type OnboardingReport = { complete: boolean; groups: OnboardingGroup[]; agentFixes: AgentFix[]; message: string };

/** How many blank answer-bank questions are listed by name before the rest are counted. */
const BANK_LISTED = 20;
/** The answer-bank entry for the notices a form requires: asked on its own, never left in the list. */
const CONSENT_KEY = "acknowledgement";

function at(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (isPlainObject(value) ? value[key] : undefined), root);
}

function blank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function storedBlank(root: unknown, path: string): boolean {
  return blank(at(root, `${path}.value`));
}

const SPAIN = new Set(["es", "esp", "spain", "españa", "espana"]);
const US_CANADA = new Set(["us", "usa", "united states", "ca", "can", "canada"]);
const US_CANADA_CLASSES = ["bay-area", "us-other", "canada", "remote-us", "remote-canada"];

/**
 * Which shipped company list fits this person, read from where they live and
 * where the campaign looks. Null when neither says, since a guess would fill
 * the queue with postings they cannot take.
 */
export function suggestedPreset(profile: Record<string, unknown> | null, campaign: Record<string, unknown> | null): "spain" | "us-canada" | null {
  const country = String(at(profile, "identity.location.country") ?? "").trim().toLowerCase();
  const allow = at(campaign, "locations.allow");
  const allowed = Array.isArray(allow) ? allow.map(String) : [];
  if (SPAIN.has(country) || allowed.includes("spain") || allowed.includes("remote-spain")) return "spain";
  if (US_CANADA.has(country) || allowed.some((entry) => US_CANADA_CLASSES.includes(entry))) return "us-canada";
  return null;
}

function companiesFix(
  profile: Record<string, unknown> | null,
  campaign: Record<string, unknown> | null,
  companies: Record<string, unknown> | null,
): AgentFix | null {
  const active = entries(companies?.companies).filter((entry) => entry.active !== false);
  if (active.length > 0) return null;
  const preset = suggestedPreset(profile, campaign);
  return {
    field: "companies",
    gap: "no companies configured",
    fix: { tool: "load_preset", arguments: preset ? { preset } : {} },
    note: preset
      ? `Call load_preset with preset ${preset}; discovery has no boards to read until then. Do not ask the person.`
      : "Call load_preset with the preset that matches where the person wants to work (spain or us-canada), or add their employers with add_company_board.",
  };
}

export type OnboardingInputs = {
  /** The raw companies file, null when it is missing. Left out, the company list is not checked. */
  companies?: Record<string, unknown> | null;
  /** True once the person chose about telemetry, or when the environment turned it off. */
  telemetryAnswered?: boolean;
};

/** What the person is told about telemetry during setup, word for word. */
export const TELEMETRY_NOTICE =
  "autoapply-mcp sends its author anonymous technical data so problems can be fixed: which tools run, how long they take, error codes, the version, Node.js, the operating system and your agent's name. Never your profile, CV, answers, the jobs or companies, or anything you type. Say if you would rather it did not, and it stops (set_telemetry with enabled false).";

export function onboardingQuestions(
  profile: Record<string, unknown> | null,
  campaign: Record<string, unknown> | null,
  { companies, telemetryAnswered = true }: OnboardingInputs = {},
): OnboardingReport {
  const p = profile ?? {};
  const c = campaign ?? {};
  const groups: OnboardingGroup[] = [];
  const group = (title: string, questions: Array<OnboardingQuestion | false>) => {
    const asked = questions.filter((question): question is OnboardingQuestion => question !== false);
    if (asked.length > 0) groups.push({ title, questions: asked });
  };

  group("About you", [
    blank(at(p, "identity.fullName")) && { field: "identity.fullName", question: "Your full name as it should appear on applications." },
    blank(at(p, "identity.email")) && { field: "identity.email", question: "The email address employers should use." },
    blank(at(p, "identity.phone")) && { field: "identity.phone", question: "A phone number, with country code." },
    (blank(at(p, "identity.location.city")) || blank(at(p, "identity.location.country"))) && {
      field: "identity.location",
      question: "Where you live: city, region and country.",
    },
    blank(at(p, "identity.links.linkedin")) && { field: "identity.links.linkedin", question: "Your LinkedIn URL, and GitHub or a portfolio if you have one.", optional: true },
  ]);

  const skills = entries(p.skills);
  const undated = skills.filter((skill) => blank(skill.since)).map((skill) => String(skill.name ?? "")).filter(Boolean);
  group("Your CV", [
    entries(p.resumes).length === 0 && { field: "resumes", question: "Your CV as a PDF or DOCX file, and where it is on your computer." },
    entries(p.experience).length === 0 && { field: "experience", question: "Your work history, if it is not all in the CV." },
    entries(p.education).length === 0 && { field: "education", question: "Your education, if it is not in the CV.", optional: true },
    skills.length === 0 && { field: "skills", question: "Your main skills and technologies." },
    undated.length > 0 && {
      field: "skills[].since",
      question: `Since which year have you used each of these professionally: ${undated.slice(0, 15).join(", ")}${undated.length > 15 ? ` and ${undated.length - 15} more` : ""}? Forms ask years of experience per technology.`,
    },
    entries(p.languages).length === 0 && { field: "languages", question: "Which languages you speak, and at what level (A1 to C2, or native)." },
  ]);

  group("Work authorization", [
    blank(at(p, "workAuthorization.citizenships")) && { field: "workAuthorization.citizenships", question: "Your citizenship(s)." },
    blank(at(p, "workAuthorization.authorizedIn")) && { field: "workAuthorization.authorizedIn", question: "Countries where you can already work without an employer's help." },
    blank(at(p, "workAuthorization.requiresSponsorshipIn")) && {
      field: "workAuthorization.requiresSponsorshipIn",
      question: "Countries where you would need the employer to sponsor a visa.",
      optional: true,
    },
    blank(at(p, "workAuthorization.statement")) && { field: "workAuthorization.statement", question: "One sentence employers should read about your right to work." },
    at(p, "workAuthorization.alwaysReviewManually") !== false && {
      field: "workAuthorization.alwaysReviewManually",
      question: "Should work-authorization and sponsorship questions be answered for you from these facts, or shown to you every time?",
      optional: true,
    },
  ]);

  group("Pay", [
    (blank(at(p, "compensation.targetTotal")) || blank(at(p, "compensation.minimumTotal"))) && {
      field: "compensation",
      question: "The yearly total pay you are aiming for and the least you would accept, with the currency.",
    },
    blank(at(p, "compensation.disclosurePolicy")) && {
      field: "compensation.disclosurePolicy",
      question: "When a form asks your salary expectation: decline, give a range, or give a figure?",
      optional: true,
    },
  ]);

  group("Where and how you want to work", [
    blank(at(c, "locations.allow")) && { field: "campaign.locations.allow", question: "Where you want to work: cities, countries, or remote from where." },
    blank(at(p, "preferences.workplaceTypes")) && { field: "preferences.workplaceTypes", question: "Onsite, hybrid, remote: which are fine?", optional: true },
    at(p, "preferences.willingToRelocate") === undefined && { field: "preferences.willingToRelocate", question: "Would you relocate, and where to?", optional: true },
    blank(at(p, "preferences.noticePeriod")) && { field: "preferences.noticePeriod", question: "Your notice period, or how soon you could start." },
  ]);

  group("What you are looking for", [
    entries(c.tracks).length === 0 && { field: "campaign.tracks", question: "The roles you want (titles and focus), and which CV goes with each." },
    blank(at(c, "compensation.floors")) && { field: "campaign.compensation.floors", question: "The lowest pay worth applying for, per country.", optional: true },
  ]);

  const demographics = ["gender", "raceEthnicity", "veteranStatus", "disabilityStatus"];
  const consent = entries(p.answers).find((entry) => entry.key === CONSENT_KEY);
  group("Questions most forms ask", [
    consent !== undefined && blank(consent.answer) && {
      field: `answers.${CONSENT_KEY}`,
      question:
        "Almost every form requires accepting the employer's privacy notice and the processing of your data for that application. May I accept those for you on every application (yes), or ask you each time (no)? Optional consents, such as a talent pool or marketing, are always declined. Record the answer with remember_answer, key acknowledgement.",
    },
    storedBlank(p, "personal.legalAgeConfirmation") && { field: "personal.legalAgeConfirmation", question: "Are you 18 or older?" },
    demographics.every((field) => storedBlank(p, `personal.demographics.${field}`)) && {
      field: "personal.demographics",
      question: "Voluntary self-identification (gender, ethnicity, veteran, disability): answer each, or decline to self-identify?",
      optional: true,
    },
  ]);

  const unanswered = entries(p.answers).filter(
    (entry) => blank(entry.answer) && entry.skip !== true && entry.key !== CONSENT_KEY,
  );
  if (unanswered.length > 0) {
    const byCategory = new Map<string, string[]>();
    for (const entry of unanswered) {
      const label = String(entry.label ?? entry.key ?? "");
      const category = classifyQuestion(label);
      byCategory.set(category, [...(byCategory.get(category) ?? []), label]);
    }
    const labels = [...byCategory.values()].flat();
    group("Your answer bank", [
      {
        field: "answers",
        question: `Saved questions with no answer yet; each one answered once is used on every application: ${labels.slice(0, BANK_LISTED).join("; ")}${
          labels.length > BANK_LISTED ? `; and ${labels.length - BANK_LISTED} more` : ""
        }.`,
        optional: true,
      },
    ]);
  }

  const companyGap = companies === undefined ? null : companiesFix(profile, campaign, companies);
  const agentFixes = companyGap ? [companyGap] : [];
  const complete = agentFixes.length === 0 && groups.every((entry) => entry.questions.every((question) => question.optional === true));
  // Told once, while setting up: it is on by default, and only a no is recorded.
  if (!telemetryAnswered && !complete) group("This tool", [{ field: "telemetry", question: TELEMETRY_NOTICE, optional: true }]);
  const message =
    groups.length === 0
      ? "Nothing is missing."
      : `To apply for you I need a few things. Answer what you can in one go:\n\n${groups
          .map((entry) => `${entry.title}\n${entry.questions.map((question) => `- ${question.question}${question.optional ? " (optional)" : ""}`).join("\n")}`)
          .join("\n\n")}`;
  return { complete, groups, agentFixes, message };
}
