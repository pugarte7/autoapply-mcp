import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CampaignSchema, SubmissionPolicySchema, type Campaign } from "../domain/campaign.js";
import { ProfileSchema, type ApprovedAnswer, type Profile, type StoredAnswer } from "../domain/profile.js";
import { classifyQuestion, isBlockedCategory } from "../drafting/blockedQuestions.js";
import { AppError } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";
import { draftPathFor, isPlainObject, issuesOf, readRawJson, writeJsonAtomic } from "./configFiles.js";
import type { WorkspacePaths } from "./paths.js";

/**
 * Standing decisions an agent may propose but only the person may make.
 *
 * Most of the profile is fact: a CV says where someone worked and what they
 * know, and an agent copying it in is doing clerical work. A few fields are
 * different. They decide what is said on every future application without
 * anyone looking: answering work-authorization questions unreviewed, telling
 * employers a salary figure, auto-filling a demographic or legal answer, or
 * letting the server submit on its own. Those are the person's to grant.
 *
 * So a write is split. Everything else lands at once, and each of these fields
 * is written at its safe value - the previous one, or the default - while the
 * requested value waits for the person's yes, asked through the client's
 * dialog or through `approve.js --setup <id>` in their own terminal. The text
 * they are shown is rendered here from the change itself, never from anything
 * the agent wrote, so it cannot be dressed up as something milder.
 */

export type StandingChange = {
  file: "profile" | "campaign";
  /** Path into the file; a list entry is addressed as `answers[key=<key>]`. */
  pointer: string[];
  /** What the person is asked to make standing. */
  value: unknown;
  /** What is written until they say yes. */
  safe: unknown;
  summary: string;
};

export type PendingChange = {
  id: string;
  createdAt: string;
  changes: Array<Omit<StandingChange, "safe">>;
  /** Answer keys to re-draft open applications with once applied. */
  redraftKeys: string[];
};

const ENTRY = /^(\w+)\[(\w+)=(.*)\]$/;

function step(container: unknown, segment: string, create: boolean): { parent: unknown[] | Record<string, unknown>; key: string | number } | null {
  const entry = ENTRY.exec(segment);
  if (entry) {
    const [, list, field, id] = entry as unknown as [string, string, string, string];
    if (!isPlainObject(container)) return null;
    if (!Array.isArray(container[list])) {
      if (!create) return null;
      container[list] = [];
    }
    const items = container[list] as unknown[];
    const at = items.findIndex((item) => isPlainObject(item) && item[field] === id);
    return { parent: items, key: at < 0 ? items.length : at };
  }
  if (!isPlainObject(container)) return null;
  return { parent: container, key: segment };
}

export function getPointer(root: unknown, pointer: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of pointer) {
    const at = step(current, segment, false);
    if (!at) return undefined;
    current = (at.parent as Record<string | number, unknown>)[at.key];
  }
  return current;
}

/** Sets a value by pointer, creating what is missing; `undefined` removes it. */
export function setPointer(root: Record<string, unknown>, pointer: readonly string[], value: unknown): void {
  let current: unknown = root;
  pointer.forEach((segment, index) => {
    const at = step(current, segment, true);
    if (!at) throw new AppError("config_invalid", `cannot write ${pointer.join(".")}: ${segment} is not an object`);
    const parent = at.parent as Record<string | number, unknown>;
    if (index === pointer.length - 1) {
      if (value !== undefined) parent[at.key] = structuredClone(value);
      else if (Array.isArray(at.parent) && typeof at.key === "number") at.parent.splice(at.key, 1);
      else delete parent[at.key];
      return;
    }
    if (parent[at.key] === undefined) parent[at.key] = {};
    current = parent[at.key];
  });
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function defaultBlockedCategories(): string[] {
  return SubmissionPolicySchema.parse({}).blockedQuestionCategories;
}

/** True when an answer to this question is one the campaign keeps for a person. */
export function isSensitiveQuestion(texts: readonly string[], blocked: readonly string[]): boolean {
  return texts.some((text) => isBlockedCategory(classifyQuestion(text), blocked));
}

function list(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

/** The fields of an answer that decide what is sent and where. */
function answerTerms(entry: ApprovedAnswer | undefined) {
  return entry && { answer: entry.answer, alternatives: entry.alternatives, patterns: entry.patterns, allowAutoFill: entry.allowAutoFill, whenNoDecline: entry.whenNoDecline };
}

const SENSITIVE_PERSONAL: ReadonlyArray<[string[], (personal: Profile["personal"]) => StoredAnswer]> = [
  [["personal", "dateOfBirth"], (p) => p.dateOfBirth],
  ...(["gender", "pronouns", "raceEthnicity", "hispanicLatino", "veteranStatus", "disabilityStatus", "sexualOrientation", "transgenderIdentity"] as const).map(
    (field): [string[], (personal: Profile["personal"]) => StoredAnswer] => [["personal", "demographics", field], (p) => p.demographics[field]],
  ),
];

/**
 * The standing decisions in a profile change. `inferredAnswers` are answer keys
 * the person did not state themselves, which need their yes whatever the
 * question is about.
 */
export function profileStandingChanges(
  before: Profile | null,
  after: Profile,
  blocked: readonly string[],
  inferredAnswers: ReadonlySet<string> = new Set(),
): StandingChange[] {
  const changes: StandingChange[] = [];
  const auth = after.workAuthorization;
  const wasReviewed = before?.workAuthorization.alwaysReviewManually ?? true;
  const facts = `citizenships ${list(auth.citizenships)}; authorized in ${list(auth.authorizedIn)}; no sponsorship needed in ${list(auth.noSponsorshipRequiredIn)}; sponsorship needed in ${list(auth.requiresSponsorshipIn)}; statement "${auth.statement}"`;
  if (!auth.alwaysReviewManually && wasReviewed) {
    changes.push({
      file: "profile",
      pointer: ["workAuthorization", "alwaysReviewManually"],
      value: false,
      safe: true,
      summary: `Answer work-authorization, sponsorship and citizenship questions without asking you each time, from: ${facts}.`,
    });
  } else if (!auth.alwaysReviewManually && before) {
    // Already answered unreviewed, so a change to the facts changes what every
    // employer is told from now on.
    for (const field of ["citizenships", "authorizedIn", "noSponsorshipRequiredIn", "requiresSponsorshipIn", "statement"] as const) {
      if (same(auth[field], before.workAuthorization[field])) continue;
      changes.push({
        file: "profile",
        pointer: ["workAuthorization", field],
        value: auth[field],
        safe: before.workAuthorization[field],
        summary: `Change workAuthorization.${field}, which is answered without asking you, to ${JSON.stringify(auth[field])}.`,
      });
    }
  }

  const pay = after.compensation;
  const policyBefore = before?.compensation.disclosurePolicy ?? "decline";
  if (pay.disclosurePolicy !== "decline" && pay.disclosurePolicy !== policyBefore) {
    changes.push({
      file: "profile",
      pointer: ["compensation", "disclosurePolicy"],
      value: pay.disclosurePolicy,
      safe: policyBefore,
      summary: `Tell employers your pay expectation (${pay.disclosurePolicy}) when a form asks: target ${pay.targetTotal} ${pay.currency}, minimum ${pay.minimumTotal} ${pay.currency}${pay.rangeStatement ? `, stated as "${pay.rangeStatement}"` : ""}.`,
    });
  } else if (pay.disclosurePolicy !== "decline" && before && pay.rangeStatement !== before.compensation.rangeStatement) {
    changes.push({
      file: "profile",
      pointer: ["compensation", "rangeStatement"],
      value: pay.rangeStatement,
      safe: before.compensation.rangeStatement,
      summary: `Change the pay expectation given to employers to "${pay.rangeStatement ?? ""}".`,
    });
  }

  for (const entry of after.answers) {
    if (!entry.allowAutoFill || entry.answer.trim().length === 0) continue;
    const inferred = inferredAnswers.has(entry.key);
    if (!inferred && !isSensitiveQuestion([entry.label, ...entry.patterns], blocked)) continue;
    const previous = before?.answers.find((existing) => existing.key === entry.key);
    if (!inferred && same(answerTerms(previous), answerTerms(entry))) continue;
    const category = classifyQuestion(entry.label);
    changes.push({
      file: "profile",
      pointer: [`answers[key=${entry.key}]`],
      value: entry,
      safe: previous ?? { ...entry, allowAutoFill: false },
      summary: `Answer "${entry.label}" with "${entry.answer}"${entry.alternatives.length > 0 ? ` (or ${entry.alternatives.join(" / ")})` : ""} on every application without asking you${
        inferred ? "; you did not state this answer yourself" : `; it is a ${category} question`
      }.`,
    });
  }

  for (const [pointer, read] of SENSITIVE_PERSONAL) {
    const now = read(after.personal);
    if (!now.autoFill || now.value.trim().length === 0) continue;
    const was = before ? read(before.personal) : undefined;
    if (was && was.autoFill && was.value === now.value && was.whenNoDecline === now.whenNoDecline) continue;
    changes.push({
      file: "profile",
      pointer,
      value: now,
      safe: was ?? { ...now, autoFill: false },
      summary: `Fill ${pointer.slice(1).join(".")} with "${now.value}" on every form that asks, without asking you.`,
    });
  }
  return changes;
}

const MODE_RANK: Record<Campaign["submission"]["mode"], number> = { manual: 0, assisted: 1, auto: 2 };

export function campaignStandingChanges(before: Campaign | null, after: Campaign): StandingChange[] {
  const changes: StandingChange[] = [];
  const modeBefore = before?.submission.mode ?? "manual";
  if (MODE_RANK[after.submission.mode] > MODE_RANK[modeBefore]) {
    changes.push({
      file: "campaign",
      pointer: ["submission", "mode"],
      value: after.submission.mode,
      safe: modeBefore,
      summary:
        after.submission.mode === "auto"
          ? "Let the server submit applications on allowlisted boards on its own once they are approved (submission.mode auto)."
          : "Let the server fill application forms in the browser for you to review and confirm (submission.mode assisted).",
    });
  }
  const blockedBefore = before?.submission.blockedQuestionCategories ?? defaultBlockedCategories();
  const removed = blockedBefore.filter((category) => !after.submission.blockedQuestionCategories.includes(category));
  if (removed.length > 0) {
    changes.push({
      file: "campaign",
      pointer: ["submission", "blockedQuestionCategories"],
      value: after.submission.blockedQuestionCategories,
      safe: [...after.submission.blockedQuestionCategories, ...removed],
      summary: `Stop always asking you about these kinds of question: ${removed.join(", ")}. A stored answer would then be used for them.`,
    });
  }
  return changes;
}

/** Writes every change at its safe value, so nothing standing lands before the person agrees. */
export function applySafe(raw: Record<string, unknown>, changes: readonly StandingChange[]): Record<string, unknown> {
  const out = structuredClone(raw);
  for (const change of changes) setPointer(out, change.pointer, change.safe);
  return out;
}

export function describeChanges(changes: ReadonlyArray<Pick<StandingChange, "summary">>): string {
  return `Make these standing decisions? They apply to every future application without asking you again.\n\n${changes
    .map((change, index) => `${index + 1}. ${change.summary}`)
    .join("\n")}`;
}

function pendingDir(paths: WorkspacePaths): string {
  return join(paths.home, "pending");
}

function pendingFile(paths: WorkspacePaths, id: string): string {
  if (!/^chg_[A-Za-z0-9_-]+$/.test(id)) throw new AppError("pending_not_found", `no pending change ${id}`);
  return join(pendingDir(paths), `${id}.json`);
}

export function stagePending(paths: WorkspacePaths, changes: readonly StandingChange[], redraftKeys: readonly string[] = []): PendingChange {
  const pending: PendingChange = {
    id: newId("chg"),
    createdAt: nowIso(),
    changes: changes.map(({ file, pointer, value, summary }) => ({ file, pointer, value, summary })),
    redraftKeys: [...redraftKeys],
  };
  mkdirSync(pendingDir(paths), { recursive: true });
  writeFileSync(pendingFile(paths, pending.id), `${JSON.stringify(pending, null, 2)}\n`, "utf8");
  return pending;
}

export function loadPending(paths: WorkspacePaths, id: string): PendingChange {
  const path = pendingFile(paths, id);
  if (!existsSync(path)) throw new AppError("pending_not_found", `no pending change ${id}; it was applied, declined or never staged`);
  return JSON.parse(readFileSync(path, "utf8")) as PendingChange;
}

export function dropPending(paths: WorkspacePaths, id: string): void {
  rmSync(pendingFile(paths, id), { force: true });
}

/**
 * The person said yes: writes the requested values into the files as they are
 * now, not as they were when staged, so edits made in between survive. A file
 * that is still only a draft takes the change in its draft.
 */
export function applyPending(paths: WorkspacePaths, pending: PendingChange): string[] {
  const written: string[] = [];
  for (const file of ["profile", "campaign"] as const) {
    const changes = pending.changes.filter((change) => change.file === file);
    if (changes.length === 0) continue;
    const real = file === "profile" ? paths.profile : paths.campaign;
    const target = existsSync(real) ? real : draftPathFor(real);
    const raw = readRawJson(target) ?? { version: 1 };
    for (const change of changes) setPointer(raw, change.pointer, change.value);
    if (target === real) {
      const { issues } = issuesOf<unknown>(file === "profile" ? ProfileSchema : CampaignSchema, raw);
      if (issues.length > 0) throw new AppError("config_invalid", `the confirmed change would make ${real} invalid:\n  - ${issues.join("\n  - ")}`);
    }
    writeJsonAtomic(target, raw);
    written.push(target);
  }
  dropPending(paths, pending.id);
  return written;
}
