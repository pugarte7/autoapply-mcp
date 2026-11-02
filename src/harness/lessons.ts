import type { Db } from "../db/database.js";
import { jsonOrDefault } from "../db/database.js";
import type { DraftAnswer } from "../domain/job.js";
import { nowIso } from "../util/hash.js";

/**
 * What past runs taught, derived from the audit log and stored applications.
 *
 * Hermes Agent improves across sessions by writing memory and skills after it
 * hits a dead end. A client connected to this server may have no memory of its
 * own, so the server keeps the equivalent: per ATS, how attempts ended; and
 * which employer questions held applications for a person. Nothing new is
 * recorded for this. Every number is recomputed from rows the tools already
 * write, so it can never drift from what happened, and it needs no hook in the
 * submission path.
 *
 * Only aggregates and employer question labels leave here. A label is the
 * employer's text ("Do you require sponsorship?"), never the candidate's
 * answer, so the resource carries no personal data the profile does not
 * already hold.
 */

export type AttemptOutcome = "submitted" | "captcha" | "verification" | "unfilled" | "refused" | "guard" | "other";

export type BoardLesson = {
  ats: string;
  attempts: number;
  outcomes: Record<AttemptOutcome, number>;
};

export type QuestionLesson = {
  label: string;
  ats: string[];
  /** Applications this question is holding right now. */
  blockingNow: number;
  /** Applications where a person typed the answer by hand. */
  answeredByPerson: number;
};

export type Lessons = {
  generatedAt: string;
  boards: BoardLesson[];
  questions: QuestionLesson[];
  advice: string[];
};

const MAX_QUESTIONS = 25;

/**
 * Sorts an aborted run's reason into the few kinds an agent acts on
 * differently. The reasons are the fixed strings `runApplicationForm` returns;
 * the order matters, since a verification message can also mention fields.
 */
export function classifyAbort(reason: string): AttemptOutcome {
  const text = reason.toLowerCase();
  if (/anti-bot|captcha|challenge/.test(text)) return "captcha";
  if (/verification|one-time code|security code/.test(text)) return "verification";
  if (/refused/.test(text)) return "refused";
  if (/could not be filled|does not state|would not stay|reported empty|required field/.test(text)) return "unfilled";
  return "other";
}

/** Folds case, spacing and the trailing asterisk boards use for "required". */
export function questionKey(label: string): string {
  return label.replace(/\*+\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function emptyOutcomes(): Record<AttemptOutcome, number> {
  return { submitted: 0, captcha: 0, verification: 0, unfilled: 0, refused: 0, guard: 0, other: 0 };
}

export function computeLessons(db: Db, options: { verificationInboxConfigured?: boolean } = {}): Lessons {
  const atsByApplication = new Map<string, string>();
  const appRows = db
    .prepare("SELECT a.id AS id, a.answers_json AS answers, j.ats AS ats FROM applications a JOIN jobs j ON j.id = a.job_id")
    .all() as Array<{ id: string; answers: string; ats: string }>;
  for (const row of appRows) atsByApplication.set(String(row.id), String(row.ats));

  const boards = new Map<string, BoardLesson>();
  const board = (ats: string): BoardLesson => {
    let entry = boards.get(ats);
    if (!entry) {
      entry = { ats, attempts: 0, outcomes: emptyOutcomes() };
      boards.set(ats, entry);
    }
    return entry;
  };

  const events = db
    .prepare(
      "SELECT type, subject, payload FROM events WHERE type IN ('submission.submitted','submission.aborted','submission.blocked') ORDER BY id",
    )
    .all() as Array<{ type: string; subject: string; payload: string }>;
  for (const event of events) {
    const ats = atsByApplication.get(String(event.subject));
    if (!ats) continue;
    const entry = board(ats);
    entry.attempts += 1;
    if (event.type === "submission.submitted") entry.outcomes.submitted += 1;
    else if (event.type === "submission.blocked") entry.outcomes.guard += 1;
    else {
      const payload = jsonOrDefault<{ reason?: unknown }>(event.payload, {});
      entry.outcomes[classifyAbort(String(payload.reason ?? ""))] += 1;
    }
  }

  const questions = new Map<string, QuestionLesson & { atsSet: Set<string> }>();
  for (const row of appRows) {
    const answers = jsonOrDefault<DraftAnswer[]>(row.answers, []);
    for (const answer of answers) {
      const blank = answer.answer.trim().length === 0;
      const blocking = answer.requiresHuman && answer.required !== false && blank && !answer.notApplicable;
      const byPerson = answer.source === "human" && !blank;
      if (!blocking && !byPerson) continue;
      const key = questionKey(answer.label);
      if (!key) continue;
      let entry = questions.get(key);
      if (!entry) {
        entry = { label: answer.label.trim(), ats: [], atsSet: new Set(), blockingNow: 0, answeredByPerson: 0 };
        questions.set(key, entry);
      }
      entry.atsSet.add(String(row.ats));
      if (blocking) entry.blockingNow += 1;
      if (byPerson) entry.answeredByPerson += 1;
    }
  }

  const questionList = [...questions.values()]
    .map(({ atsSet, ...rest }) => ({ ...rest, ats: [...atsSet].sort() }))
    .sort((a, b) => b.blockingNow + b.answeredByPerson - (a.blockingNow + a.answeredByPerson) || a.label.localeCompare(b.label))
    .slice(0, MAX_QUESTIONS);
  const boardList = [...boards.values()].sort((a, b) => b.attempts - a.attempts || a.ats.localeCompare(b.ats));

  return {
    generatedAt: nowIso(),
    boards: boardList,
    questions: questionList,
    advice: adviceFor(boardList, questionList, options.verificationInboxConfigured ?? false),
  };
}

/**
 * Turns the counts into the next move. Each line names a tool, because a
 * lesson the agent cannot act on is one it will read and ignore.
 */
function adviceFor(boards: BoardLesson[], questions: QuestionLesson[], inboxConfigured: boolean): string[] {
  const advice: string[] = [];
  for (const entry of boards) {
    if (entry.outcomes.captcha > 0) {
      advice.push(
        `${entry.ats}: ${entry.outcomes.captcha} of ${entry.attempts} attempts met a CAPTCHA. Hand those to the person in assisted mode with the window open; never try to solve one.`,
      );
    }
    if (entry.outcomes.verification > 0 && !inboxConfigured) {
      advice.push(
        `${entry.ats}: ${entry.outcomes.verification} attempts stopped at an emailed verification code. Ask the person once to connect a mailbox, or pass codes with provide_verification_code while the form is held open.`,
      );
    }
    if (entry.outcomes.unfilled > 0) {
      advice.push(
        `${entry.ats}: ${entry.outcomes.unfilled} attempts left a required field unfilled. Run resolve_blockers before retrying.`,
      );
    }
  }
  for (const question of questions) {
    if (question.answeredByPerson >= 2) {
      advice.push(
        `"${question.label}" was answered by hand ${question.answeredByPerson} times. Store it with remember_answer so it fills itself.`,
      );
    } else if (question.blockingNow >= 2) {
      advice.push(
        `"${question.label}" holds ${question.blockingNow} applications. Ask the person once, then remember_answer and set_application_content on each.`,
      );
    }
  }
  return advice;
}
