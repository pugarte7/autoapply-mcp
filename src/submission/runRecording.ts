import type { Workspace } from "../config/load.js";
import { saveApplication } from "../db/repositories/applications.js";
import { appendEvent } from "../db/repositories/events.js";
import type { SubmissionMode } from "../domain/campaign.js";
import type { Application, DraftAnswer, Job } from "../domain/job.js";
import { nowIso } from "../util/hash.js";
import type { BrowserRunResult } from "./browser.js";
import { mergeDiscoveredQuestions } from "./discoveredQuestions.js";

/**
 * Records what a browser run did to an application.
 *
 * Shared by submit_application and by the run it leaves parked at a
 * verification gate: that run finishes after the tool call has returned, and
 * its result has to land in the database exactly as a blocking run's would, or
 * counts, pacing and duplicate checks drift.
 */
export function recordRunResult(
  workspace: Workspace,
  input: {
    application: Application;
    job: Job;
    currentHash: string;
    mode: SubmissionMode;
    result: BrowserRunResult;
    batchId?: string;
    /** Audit fields naming the approval or standing rules that let this run submit. */
    authorisedBy?: Record<string, unknown>;
    /** Counts a submission against the standing rules that authorised it. */
    onSubmitted?: () => void;
  },
): DraftAnswer[] {
  const { application, job, currentHash, mode, result } = input;
  const batch = input.batchId ? { batchId: input.batchId } : {};
  const authorised = input.authorisedBy ?? {};
  if (result.status === "submitted") {
    saveApplication(workspace.db, {
      ...application,
      packetHash: currentHash,
      status: "submitted",
      submittedAt: nowIso(),
      submissionMode: mode,
      confirmationRef: result.confirmationText.slice(0, 200),
      artifactPath: result.screenshotPath,
    });
    appendEvent(workspace.db, "submission.submitted", application.id, {
      mode,
      finalUrl: result.finalUrl,
      company: job.companyName,
      ...batch,
      ...authorised,
    });
    input.onSubmitted?.();
    return application.answers;
  }
  if (result.status === "aborted") {
    const answers = mergeDiscoveredQuestions(application.answers, result.unmatchedRequired, workspace.profile.answers);
    saveApplication(workspace.db, {
      ...application,
      packetHash: currentHash,
      status: "needs_human",
      answers,
      notes: `${application.notes}\n[${nowIso()}] aborted: ${result.reason}`.trim(),
      artifactPath: result.screenshotPath,
    });
    appendEvent(workspace.db, "submission.aborted", application.id, { mode, reason: result.reason, ...batch });
    return answers;
  }
  appendEvent(workspace.db, "submission.prepared", application.id, { mode, finalUrl: result.finalUrl, ...batch });
  return application.answers;
}
