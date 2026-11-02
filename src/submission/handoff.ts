import type { Workspace } from "../config/load.js";
import { appendEvent } from "../db/repositories/events.js";
import type { Application, Job } from "../domain/job.js";
import { authorisedBy, noteRulesUse } from "./authorise.js";
import type { GuardResult } from "./guards.js";
import type { SubmissionPacket } from "./packet.js";

/**
 * The server never touches an employer's site. Once every guard passes it
 * hands the agent the approved packet, and the agent sends it with its own
 * browser: Claude in Chrome, Cursor's browser, the Codex app, Hermes.
 */

export type SubmissionPlan = {
  applicationId: string;
  company: string;
  jobTitle: string;
  applyUrl: string;
  resumePath: string;
  coverLetter: string;
  fields: Array<{ label: string; value: string; required: boolean }>;
  authorisedBy: "rules" | "approval";
  rulesId?: string;
  nextStep: string;
};

export const SUBMIT_STEPS =
  "Open applyUrl in your browser and fill the form with exactly these values: each field by its label, the resume " +
  "from resumePath, the cover letter where the form has a place for it. Leave out anything the form does not ask. " +
  "If the form asks something not listed here, answer it from the profile with set_application_content (by label), " +
  "or ask the person if only they can answer it; that changes the packet, so it needs approval again unless " +
  "standing rules cover it. A CAPTCHA or a question asking whether you are a bot or an AI is the person's: stop and " +
  "hand them the open page, never solve or answer it. If the board emails a code, read it from the mailbox if you " +
  "have access to it, otherwise ask the person. Press submit, and once the board confirms, call record_submission " +
  "with the confirmation text.";

export function handOff(
  workspace: Workspace,
  application: Application,
  job: Job,
  packet: SubmissionPacket,
  guard: GuardResult,
  batchId?: string,
): SubmissionPlan {
  noteRulesUse(workspace, application.id, guard);
  appendEvent(workspace.db, "submission.handed_off", application.id, {
    company: job.companyName,
    ...(batchId ? { batchId } : {}),
    ...authorisedBy(guard),
  });
  return {
    applicationId: application.id,
    company: packet.company,
    jobTitle: packet.jobTitle,
    applyUrl: packet.applyUrl,
    resumePath: packet.resumePath,
    coverLetter: packet.coverLetter,
    fields: packet.answers
      .filter((answer) => answer.answer.trim().length > 0)
      .map((answer) => ({ label: answer.label, value: answer.answer, required: answer.required })),
    ...authorisedBy(guard),
    nextStep: SUBMIT_STEPS,
  };
}
