import { join } from "node:path";
import { z } from "zod";
import type { Workspace } from "../config/load.js";
import type { SubmissionMode } from "../domain/campaign.js";
import { getEvaluation } from "../db/repositories/jobs.js";
import type { DraftAnswer, Job } from "../domain/job.js";
import { answerOwner, type AnswerOwner } from "../drafting/answerOwner.js";
import type { BrowserRunOptions } from "../submission/browser.js";
import { hasAtsCredentials } from "../submission/credentials.js";
import { experienceResolverFor } from "../submission/experienceResolver.js";
import { narrativeResolverFor } from "../submission/narrativeResolver.js";
import { personalResolverFor } from "../submission/personalResolver.js";
import { readVerificationInboxConfig, type VerificationInboxConfig } from "../submission/verificationInbox.js";
import { isWorkdayUrl } from "../submission/workdayFlow.js";

/**
 * The browser-run options submit_application and submit_batch share.
 *
 * They were written out twice and drifted: the batch copy never passed a code
 * wait or a code file, so every batch run stopped dead at the first Greenhouse
 * or Workday verification gate even with a mailbox configured to read it.
 * Building them in one place keeps the two paths from disagreeing again.
 */

export type RunMode = SubmissionMode;

/**
 * Long enough for a forwarded code to land and be read, short enough that a
 * code that is never coming does not hold a batch for half an hour. Five
 * minutes covers the slowest Greenhouse delivery seen so far.
 */
export const DEFAULT_CODE_WAIT_SECONDS = 300;

export const waitForCodeSecondsInput = z
  .number()
  .int()
  .min(0)
  .max(1800)
  .optional()
  .describe(
    `Hold the browser at a verification gate for this long while the code is read from the verification inbox or written to <artifacts>/<applicationId>.code. A code cannot be carried between runs, so this is the only way an automated submission clears the gate. With a verification inbox configured, it also bounds the wait for the link Workday emails to verify a candidate account. Defaults to ${DEFAULT_CODE_WAIT_SECONDS} when a verification inbox is configured, otherwise 0.`,
  );

/**
 * How long a run holds a verification gate open. An explicit value wins. With
 * no value, a configured mailbox means the run can clear the gate by itself,
 * so it waits; without one nothing would supply the code unprompted, and a
 * silent five-minute hang would only look like a stuck tool.
 */
export function codeWaitSeconds(
  requested: number | undefined,
  inbox: VerificationInboxConfig | null = readVerificationInboxConfig(),
): number {
  if (requested !== undefined) return requested;
  return inbox ? DEFAULT_CODE_WAIT_SECONDS : 0;
}

/**
 * Whether a run may register a candidate account on the employer's tenant.
 *
 * Assisted mode has a person at the window. Workday has no anonymous apply
 * path, so refusing there is refusing to apply. Auto mode on any other board
 * registers too once the person has supplied ATS credentials: setting them is
 * the deliberate choice this used to wait for, and stopping at a sign-up wall
 * then only hands the person a form the server could have finished.
 */
export function mayCreateAccount(mode: RunMode, applyUrl: string, credentials: boolean = hasAtsCredentials()): boolean {
  if (mode === "assisted" || isWorkdayUrl(applyUrl)) return true;
  return mode === "auto" && credentials;
}

export function formRunOptions(
  workspace: Workspace,
  job: Job,
  applicationId: string,
  run: {
    mode: RunMode;
    headless?: boolean;
    keepOpenMs: number;
    verificationCode?: string;
    waitForCodeSeconds?: number;
  },
): BrowserRunOptions {
  const { profile, campaign } = workspace;
  return {
    submit: run.mode === "auto",
    headless: run.mode === "assisted" ? false : run.headless ?? true,
    artifactsDir: workspace.paths.artifacts,
    policy: campaign.submission,
    candidateCountry: profile.identity.location.country,
    answerBank: profile.answers,
    personalResolver: personalResolverFor(profile),
    experienceResolver: experienceResolverFor(profile),
    narrativeResolver: narrativeResolverFor(job, getEvaluation(workspace.db, job.id), profile, campaign),
    accountEmail: profile.identity.email,
    relocationTargets: profile.preferences.relocationTargets,
    allowAccountCreation: mayCreateAccount(run.mode, job.applyUrl),
    keepOpenMs: run.keepOpenMs,
    verificationCode: run.verificationCode,
    codeWaitMs: codeWaitSeconds(run.waitForCodeSeconds) * 1000,
    // One file per application, so codes for two gated applications in the
    // same batch can never be read by the wrong form.
    codeFilePath: join(workspace.paths.artifacts, `${applicationId}.code`),
  };
}

export type FieldToAnswer = { questionKey: string; label: string; who: AnswerOwner };

/** Required fields an aborted run left blank, each with who can answer it. */
export function fieldsToAnswer(answers: readonly DraftAnswer[]): FieldToAnswer[] {
  return answers
    .filter((answer) => answer.requiresHuman && answer.required && answer.answer.trim().length === 0)
    .map((answer) => ({
      questionKey: answer.questionKey,
      label: answer.label,
      who: answerOwner(answer.label, answer.category),
    }));
}

/**
 * What the agent does after a run stopped short of submitting.
 *
 * "This application needs a human" was the whole message, so an agent handed
 * every abort to the person - including the common case of a live form asking
 * for something the CV answers. Naming the fields, and which of them the
 * agent can answer itself, turns most aborts into answer-and-retry.
 */
export function abortedNextStep(
  result: { reason: string; captchaDetected: boolean },
  fields: readonly FieldToAnswer[],
  retry: string,
): string {
  if (result.captchaDetected) {
    return `A CAPTCHA appeared. Never try to solve it: ask the person to complete it, then ${retry}.`;
  }
  const mine = fields.filter((field) => field.who === "agent");
  const theirs = fields.filter((field) => field.who === "person");
  const steps: string[] = [];
  if (mine.length > 0) {
    steps.push(
      `Answer these yourself from the profile and CV with set_application_content (questionKey in fieldsToAnswer): ${quoteLabels(mine)}. ` +
        "Write only what the profile supports.",
    );
  }
  if (theirs.length > 0) {
    steps.push(
      `Only the person can answer ${quoteLabels(theirs)}. Put them in your one grouped message to the person with every other pending application's questions.`,
    );
  }
  if (steps.length === 0) {
    return `Stopped: ${result.reason}. If the profile or a verification code you can read resolves it, fix that and ${retry}; otherwise include it in your one grouped message to the person.`;
  }
  steps.push(`Editing the packet voids its approval: have it approved again (standing rules cover it if it still matches), then ${retry}.`);
  return steps.join(" ");
}

function quoteLabels(fields: readonly FieldToAnswer[]): string {
  return fields.map((field) => `"${field.label.slice(0, 80)}"`).join(", ");
}
