import { existsSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z, type ZodType } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { draftPathFor, isPlainObject, issuesOf, mergeConfig, readRawJson, writeJsonAtomic } from "../config/configFiles.js";
import { closeWorkspace, getWorkspace, loadCampaign, type Workspace } from "../config/load.js";
import { onboardingQuestions } from "../config/onboarding.js";
import { resolvePaths, type WorkspacePaths } from "../config/paths.js";
import {
  applyPending,
  applySafe,
  campaignStandingChanges,
  defaultBlockedCategories,
  describeChanges,
  dropPending,
  profileStandingChanges,
  stagePending,
  type StandingChange,
} from "../config/standing.js";
import { CampaignSchema, type Campaign } from "../domain/campaign.js";
import { ProfileSchema, type ApprovedAnswer, type Profile } from "../domain/profile.js";
import { draftAnswers } from "../drafting/answers.js";
import { redraftOpenApplications, type RedraftedApplication } from "../drafting/redraft.js";
import { askPerson } from "../submission/approvals.js";
import { validateResumeFile } from "../submission/resume.js";
import { AppError, isAppError, toErrorMessage } from "../util/errors.js";
import { handler, ok } from "./helpers.js";

/**
 * Setup from inside the conversation.
 *
 * Without these tools a client with no file access - Claude Desktop without a
 * filesystem server, ChatGPT - cannot set anything up, and the person ends up
 * hand-editing JSON. Here the agent writes what it read from the CV and the
 * person's message, and the server keeps the lines it always keeps: every
 * value is validated, the previous file is kept as a .bak, and the fields that
 * turn a sensitive question into a standing answer wait for the person's own
 * yes (see config/standing.ts).
 */

export type Standing =
  | { state: "none" }
  | { state: "applied"; changes: string[] }
  | { state: "declined"; changes: string[]; note: string }
  | { state: "pending"; id: string; changes: string[]; nextStep: string };

/**
 * Asks the person to make the staged changes standing. A client with no
 * dialog gets the terminal command back instead; the change stays staged
 * under `pending/` until they run it.
 */
async function confirmStanding(
  server: McpServer,
  paths: WorkspacePaths,
  changes: readonly StandingChange[],
  redraftKeys: readonly string[] = [],
): Promise<Standing> {
  if (changes.length === 0) return { state: "none" };
  const summaries = changes.map((change) => change.summary);
  const pending = stagePending(paths, changes, redraftKeys);
  let yes: boolean;
  try {
    yes = await askPerson(server, describeChanges(changes), `--setup ${pending.id}`);
  } catch (error) {
    if (isAppError(error) && error.code === "person_approval_needed") {
      return { state: "pending", id: pending.id, changes: summaries, nextStep: error.message };
    }
    dropPending(paths, pending.id);
    throw error;
  }
  if (!yes) {
    dropPending(paths, pending.id);
    return {
      state: "declined",
      changes: summaries,
      note: "The person did not make these standing. Everything else was saved; these questions will keep being asked.",
    };
  }
  applyPending(paths, pending);
  return { state: "applied", changes: summaries };
}

/** Reloads the server's configuration, reporting rather than throwing when a file is still missing. */
function reload(): { loaded: true; workspace: Workspace } | { loaded: false; reason: string } {
  closeWorkspace();
  try {
    return { loaded: true, workspace: getWorkspace() };
  } catch (error) {
    return { loaded: false, reason: toErrorMessage(error) };
  }
}

function blockedCategories(paths: WorkspacePaths): string[] {
  try {
    return loadCampaign(paths.campaign).submission.blockedQuestionCategories;
  } catch {
    return defaultBlockedCategories();
  }
}

function stillMissing(paths: WorkspacePaths) {
  const profile = readRawJson(paths.profile) ?? readRawJson(draftPathFor(paths.profile));
  const campaign = readRawJson(paths.campaign) ?? readRawJson(draftPathFor(paths.campaign));
  return onboardingQuestions(profile, campaign);
}

/** A CV path the ATS will accept: absolute, present, and really a PDF or DOCX. */
function checkResumes(patch: Record<string, unknown>): void {
  if (!Array.isArray(patch.resumes)) return;
  for (const resume of patch.resumes) {
    if (!isPlainObject(resume) || typeof resume.path !== "string") continue;
    const path = isAbsolute(resume.path) ? resume.path : resolve(resume.path);
    const check = validateResumeFile(path);
    if (!check.ok || (check.format !== "pdf" && check.format !== "docx")) {
      throw new AppError(
        "resume_invalid",
        `resume ${String(resume.id ?? path)} cannot be uploaded: ${check.ok ? `${check.format} is not a PDF or DOCX` : check.reason}`,
      );
    }
    resume.path = path;
  }
}

type SaveResult = {
  saved: "file" | "draft";
  path: string;
  backup: string | null;
  issues: string[];
  changes: StandingChange[];
};

/**
 * Merges a patch into profile.json or campaign.json. A file that does not exist
 * yet and does not validate is kept as a draft beside it; an existing file is
 * never replaced by an invalid one.
 */
function saveMerged<T>(
  path: string,
  patch: Record<string, unknown>,
  schema: ZodType<T>,
  standingChanges: (before: T | null, after: T) => StandingChange[],
): SaveResult {
  const draft = draftPathFor(path);
  const exists = existsSync(path);
  const base = (exists ? readRawJson(path) : readRawJson(draft)) ?? { version: 1 };
  const merged = mergeConfig(base, patch) as Record<string, unknown>;
  merged.version = 1;
  const { data, issues } = issuesOf(schema, merged);
  if (!data) {
    if (exists) {
      throw new AppError("config_invalid", `not saved: the change would make ${path} invalid:\n  - ${issues.join("\n  - ")}`);
    }
    writeJsonAtomic(draft, merged);
    return { saved: "draft", path: draft, backup: null, issues, changes: [] };
  }
  const before = exists ? issuesOf(schema, base).data : null;
  const changes = standingChanges(before, data);
  writeJsonAtomic(path, applySafe(merged, changes));
  rmSync(draft, { force: true });
  return { saved: "file", path, backup: exists ? `${path}.bak` : null, issues: [], changes };
}

const objectPatch = (description: string) => z.record(z.string(), z.unknown()).optional().describe(description);
const listPatch = (description: string) => z.array(z.record(z.string(), z.unknown())).optional().describe(description);

/** Lowercased, decoration removed, as the drafting matcher compares labels. */
export function patternFor(label: string): string {
  return label
    .toLowerCase()
    .replace(/\(required\)|\(optional\)|\*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s?:.!]+$/, "")
    .slice(0, 500);
}

function slug(label: string): string {
  return patternFor(label).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "answer";
}

export type RememberInput = {
  label: string;
  answer: string;
  statedByPerson: boolean;
  key?: string;
  patterns?: string[];
  alternatives?: string[];
  allowAutoFill?: boolean;
  skip?: boolean;
  note?: string;
};

/**
 * The answer-bank entry this question already belongs to, so answering it
 * fills the shipped blank entry instead of adding a near-duplicate beside it.
 * The drafting engine's own match is preferred, since it applies every guard
 * against a pattern meeting the wrong question; a question in a blocked
 * category never reaches that match, so the longest pattern decides there.
 */
function bankEntryFor(profile: Profile, campaign: Campaign | null, label: string): ApprovedAnswer | undefined {
  if (campaign) {
    const [drafted] = draftAnswers([{ key: "probe", label, required: true, type: "unknown" }], profile, campaign).answers;
    const cited = /^profile\.answers\.(\S+)$/.exec(drafted?.citation ?? "")?.[1];
    const entry = cited ? profile.answers.find((answer) => answer.key === cited) : undefined;
    if (entry) return entry;
  }
  const asked = label.toLowerCase();
  let best: { entry: ApprovedAnswer; length: number } | undefined;
  for (const entry of profile.answers) {
    for (const pattern of entry.patterns) {
      const needle = pattern.toLowerCase();
      if (asked.includes(needle) && needle.length > (best?.length ?? 0)) best = { entry, length: needle.length };
    }
  }
  return best?.entry;
}

function entryFor(input: RememberInput, profile: Profile, campaign: Campaign | null): ApprovedAnswer {
  const matched = input.key ? profile.answers.find((entry) => entry.key === input.key) : bankEntryFor(profile, campaign, input.label);
  let key = input.key ?? matched?.key ?? slug(input.label);
  // A slug that collides with an unrelated entry would overwrite it.
  if (!input.key && !matched) {
    const taken = new Set(profile.answers.map((entry) => entry.key));
    for (let n = 2; taken.has(key); n += 1) key = `${slug(input.label)}-${n}`;
  }
  const own = patternFor(input.label);
  const covered = matched?.patterns.some((pattern) => input.label.toLowerCase().includes(pattern.toLowerCase())) ?? false;
  const patterns = input.patterns ?? (matched ? (covered ? matched.patterns : [...matched.patterns, own]) : [own]);
  return {
    key,
    label: matched?.label ?? input.label,
    patterns: patterns.length > 0 ? patterns : [own],
    answer: input.answer,
    alternatives: input.alternatives ?? matched?.alternatives ?? [],
    allowAutoFill: input.allowAutoFill ?? true,
    skip: input.skip ?? false,
    ...(matched?.whenNoDecline ? { whenNoDecline: matched.whenNoDecline } : {}),
    ...((input.note ?? matched?.note) ? { note: input.note ?? matched?.note } : {}),
  };
}

export type Remembered = {
  remembered: Array<{ key: string; label: string; matchedExisting: boolean }>;
  standing: Standing;
  updatedApplications: RedraftedApplication[];
};

/**
 * Stores standing answers in profile.answers and fills every open application
 * the drafting engine now answers from them. Shared by remember_answer and by
 * set_application_content's `remember` flag, so both ask the person once for
 * all the answers in one call.
 */
export async function rememberAnswers(server: McpServer, inputs: readonly RememberInput[]): Promise<Remembered> {
  const paths = resolvePaths();
  const raw = readRawJson(paths.profile);
  if (!raw) throw new AppError("config_missing", `no profile at ${paths.profile}; finish setup_profile first`);
  const before = ProfileSchema.parse(raw);
  let campaign: Campaign | null = null;
  try {
    campaign = loadCampaign(paths.campaign);
  } catch {
    campaign = null;
  }

  const entries = inputs.map((input) => ({ input, entry: entryFor(input, before, campaign) }));
  const next = structuredClone(raw);
  const answers = Array.isArray(next.answers) ? (next.answers as unknown[]) : [];
  for (const { entry } of entries) {
    const at = answers.findIndex((existing) => isPlainObject(existing) && existing.key === entry.key);
    if (at >= 0) answers[at] = entry;
    else answers.push(entry);
  }
  next.answers = answers;
  const { data: after, issues } = issuesOf(ProfileSchema, next);
  if (!after) throw new AppError("config_invalid", `answer not saved:\n  - ${issues.join("\n  - ")}`);

  const inferred = new Set(entries.filter(({ input }) => !input.statedByPerson).map(({ entry }) => entry.key));
  const blocked = campaign?.submission.blockedQuestionCategories ?? defaultBlockedCategories();
  const changes = profileStandingChanges(before, after, blocked, inferred).filter((change) => change.pointer[0]?.startsWith("answers["));
  writeJsonAtomic(paths.profile, applySafe(next, changes));

  const keys = entries.map(({ entry }) => entry.key);
  const standing = await confirmStanding(server, paths, changes, keys);
  const loaded = reload();
  const updatedApplications = loaded.loaded
    ? redraftOpenApplications(loaded.workspace.db, loaded.workspace.profile, loaded.workspace.campaign, keys)
    : [];
  return {
    remembered: entries.map(({ entry }) => ({
      key: entry.key,
      label: entry.label,
      matchedExisting: before.answers.some((existing) => existing.key === entry.key),
    })),
    standing,
    updatedApplications,
  };
}

const rememberShape = {
  label: z.string().min(1).describe("The question as the form words it."),
  answer: z.string().describe("The answer to give on every application that asks it."),
  statedByPerson: z
    .boolean()
    .describe("True only when the person gave this answer in their own words. Anything you inferred needs their confirmation."),
  key: z.string().min(1).optional().describe("Answer-bank key to update. Omitted: the entry the question already matches, or a new one."),
  patterns: z.array(z.string().min(1).max(500)).optional().describe("Substrings matched against question labels. Default: the label itself."),
  alternatives: z.array(z.string()).optional().describe("Ordered fallbacks for dropdowns that do not offer the answer verbatim."),
  allowAutoFill: z.boolean().optional().describe("Default true. False stores it as a suggestion that is still asked each time."),
  skip: z.boolean().optional().describe("Leave this question blank on purpose."),
  note: z.string().optional(),
};

export function registerSetupTools(server: McpServer): void {
  server.registerTool(
    "setup_profile",
    {
      title: "Create or update the candidate profile",
      description:
        "Writes profile.json from what you extracted from the person's CV and messages: a full profile or a partial patch, deep-merged into the existing file (lists merge by id, key or name; null removes a key). Only facts the person gave or the CV states. Until the profile validates it is kept as profile.draft.json and the reply lists what is missing. The previous file is kept as profile.json.bak. Turning work-authorization review off, disclosing pay, or auto-filling a sensitive answer is saved at its safe value and asked of the person, who must confirm it themselves.",
      inputSchema: {
        identity: objectPatch("fullName, headline, email, phone, location {city, region, country}, links {linkedin, github, website}"),
        personal: objectPatch("address, dateOfBirth, legalAgeConfirmation, previousEmployment, demographics; each stored answer is {value, autoFill}"),
        experience: listPatch("[{company, title, location, start YYYY-MM, end YYYY-MM or present, highlights[]}], as the CV states them"),
        education: listPatch("[{institution, credential, field, location, start, end}]"),
        skills: listPatch("[{name, aliases[], level expert|strong|working|familiar, tags[], since: year or YYYY-MM first used professionally}]"),
        facts: listPatch("[{id, statement, category, metrics[], tags[]}]: achievements the CV states, in its words"),
        languages: listPatch("[{name, level A1|A2|B1|B2|C1|C2|native, aliases[]}]"),
        preferences: objectPatch("willingToRelocate, relocationTargets[], workplaceTypes[onsite|hybrid|remote], noticePeriod, roleSearchNotes"),
        workAuthorization: objectPatch("citizenships[], authorizedIn[], noSponsorshipRequiredIn[], requiresSponsorshipIn[] (ISO codes), statement, alwaysReviewManually"),
        compensation: objectPatch("currency, targetTotal, minimumTotal, disclosurePolicy decline|range|exact, rangeStatement"),
        resumes: listPatch("[{id, label, path: absolute path to the CV PDF or DOCX on disk, tracks[], isDefault}]"),
        answers: listPatch("Answer-bank entries; prefer remember_answer for single questions"),
        narratives: listPatch("[{key, label, patterns[], template, allowAutoFill}]"),
        statedByPerson: z.boolean().optional().describe("True when the answers in this patch are the person's own words."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: Record<string, unknown>) => {
      const { statedByPerson, ...patch } = args;
      const paths = resolvePaths();
      checkResumes(patch);
      const blocked = blockedCategories(paths);
      const answerKeys = Array.isArray(patch.answers)
        ? patch.answers.filter(isPlainObject).map((entry) => String(entry.key ?? "")).filter(Boolean)
        : [];
      const inferred = new Set(statedByPerson === true ? [] : answerKeys);
      const result = saveMerged<Profile>(paths.profile, patch, ProfileSchema, (before, after) =>
        profileStandingChanges(before, after, blocked, inferred),
      );
      const standing = await confirmStanding(server, paths, result.changes, answerKeys);
      const loaded = reload();
      const updatedApplications =
        loaded.loaded && answerKeys.length > 0
          ? redraftOpenApplications(loaded.workspace.db, loaded.workspace.profile, loaded.workspace.campaign, answerKeys)
          : [];
      return ok({
        saved: result.saved,
        path: result.path,
        backup: result.backup,
        validationIssues: result.issues,
        standing,
        updatedApplications,
        workspace: loaded.loaded ? { loaded: true } : loaded,
        stillMissing: stillMissing(paths),
        nextStep:
          result.saved === "draft"
            ? "The profile is not complete yet. Ask the person everything in stillMissing.message in one message, then call setup_profile again."
            : standing.state === "pending"
              ? "Saved. Pass the command in standing.nextStep to the person; the sensitive settings apply once they confirm it."
              : "Saved. Ask anything left in stillMissing in one message, then continue with update_campaign or discover_jobs.",
      });
    }),
  );

  server.registerTool(
    "update_campaign",
    {
      title: "Create or update the campaign",
      description:
        "Writes campaign.json: which roles to look for, where, pay floors, seniority, exclusions and submission limits. Deep-merged like setup_profile; kept as campaign.draft.json until it validates. Raising submission.mode or removing a category from blockedQuestionCategories is asked of the person through the approval dialog and only applies once they confirm. Use add_company_board for companies.",
      inputSchema: {
        name: z.string().min(1).optional(),
        targetApplications: z.number().int().positive().optional(),
        tracks: listPatch("[{id, label, allocation 0..1, titleIncludes[], titleExcludes[], keywords[{term, weight, aliases[]}], resumeId}]"),
        locations: objectPatch("allow[bay-area|us-other|canada|remote-us|remote-canada|remote-global|spain|remote-spain|europe|remote-europe|other|unknown], includePatterns[], excludePatterns[], workplaceTypes[]"),
        compensation: objectPatch("currency, floors {ISO country: minimum total}, fx {currency: rate to campaign currency}, allowUnknown, rejectBelowFloor"),
        seniority: objectPatch("allow[], reject[]"),
        exclusions: objectPatch("titlePatterns[], descriptionPatterns[], companies[]"),
        submission: objectPatch("mode manual|assisted|auto, dailyLimit, maxBatchSize, maxPerCompany, minDelaySeconds, allowedAtsDomains[], allowedCompanies[], blockedQuestionCategories[]"),
        freshnessDays: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: Record<string, unknown>) => {
      const paths = resolvePaths();
      const result = saveMerged<Campaign>(paths.campaign, args, CampaignSchema, campaignStandingChanges);
      const standing = await confirmStanding(server, paths, result.changes);
      const loaded = reload();
      return ok({
        saved: result.saved,
        path: result.path,
        backup: result.backup,
        validationIssues: result.issues,
        standing,
        workspace: loaded.loaded ? { loaded: true, submissionMode: loaded.workspace.campaign.submission.mode } : loaded,
        stillMissing: stillMissing(paths),
      });
    }),
  );

  server.registerTool(
    "remember_answer",
    {
      title: "Remember an answer for every application",
      description:
        "Stores the person's answer to a recurring question in the answer bank, so it is used on every application that asks it instead of being asked again, and fills it into every open application (drafted, needs_human, awaiting_approval) that asks it now. Reports which applications changed. A work-authorization, pay, demographic, legal or essay answer, or any answer the person did not state themselves, is asked of the person through the approval dialog first.",
      inputSchema: rememberShape,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: RememberInput) => ok(await rememberAnswers(server, [args]))),
  );

  server.registerTool(
    "onboarding_questions",
    {
      title: "What setup still needs from the person",
      description:
        "Lists what the profile and campaign still lack for the forms boards typically show, grouped, with a ready message asking it all at once. Call it before asking the person anything, and ask everything in one message.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler(async () => ok(stillMissing(resolvePaths()))),
  );
}
