import type { Workspace } from "../config/load.js";
import { saveApplication } from "../db/repositories/applications.js";
import { appendEvent } from "../db/repositories/events.js";
import type { Application, Job } from "../domain/job.js";
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
    mode: "assisted" | "auto";
    result: BrowserRunResult;
    batchId?: string;
  },
): void {
  const { application, job, currentHash, mode, result } = input;
  const batch = input.batchId ? { batchId: input.batchId } : {};
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
    });
  } else if (result.status === "aborted") {
    saveApplication(workspace.db, {
      ...application,
      packetHash: currentHash,
      status: "needs_human",
      answers: mergeDiscoveredQuestions(application.answers, result.unmatchedRequired, workspace.profile.answers),
      notes: `${application.notes}\n[${nowIso()}] aborted: ${result.reason}`.trim(),
      artifactPath: result.screenshotPath,
    });
    appendEvent(workspace.db, "submission.aborted", application.id, { mode, reason: result.reason, ...batch });
  } else {
    appendEvent(workspace.db, "submission.prepared", application.id, { mode, finalUrl: result.finalUrl, ...batch });
  }
}
