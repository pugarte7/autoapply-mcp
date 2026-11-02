import type { Workspace } from "../config/load.js";
import { countSubmittedSince, lastSubmissionAt, latestApproval } from "../db/repositories/applications.js";
import { applicationCountsByCompany, getEvaluation } from "../db/repositories/jobs.js";
import { countRulesUsesSince, listActiveRules, recordRulesUse } from "../db/repositories/rules.js";
import type { Application, Job } from "../domain/job.js";
import { checkSubmissionAllowed, startOfDayIso, type GuardResult } from "./guards.js";
import type { StandingCheck } from "./standingRules.js";

/**
 * Builds the guard input from the database, the same way for every caller:
 * submit_application and submit_batch. Each used to assemble it
 * inline, which is how a new input could reach one path and not another.
 */

export function standingCheckFor(workspace: Workspace, jobId: string, now = new Date()): StandingCheck {
  const since = startOfDayIso(now);
  return {
    evaluation: getEvaluation(workspace.db, jobId),
    rules: listActiveRules(workspace.db, now).map((record) => ({
      id: record.id,
      rules: record.rules,
      usedToday: countRulesUsesSince(workspace.db, record.id, since),
    })),
  };
}

export function submissionGuard(
  workspace: Workspace,
  application: Application,
  job: Job,
  currentHash: string,
): GuardResult {
  return checkSubmissionAllowed({
    application: { ...application, packetHash: currentHash },
    job,
    campaign: workspace.campaign,
    approval: latestApproval(workspace.db, application.id),
    submittedToday: countSubmittedSince(workspace.db, startOfDayIso()),
    companyApplicationCount: applicationCountsByCompany(workspace.db).get(job.companyName.toLowerCase()) ?? 0,
    lastSubmissionAt: lastSubmissionAt(workspace.db),
    standing: standingCheckFor(workspace, job.id),
  });
}

/** Counts a sent application against the rule set that authorised it. */
export function noteRulesUse(workspace: Workspace, applicationId: string, guard: GuardResult): void {
  if (!guard.rulesId) return;
  recordRulesUse(workspace.db, guard.rulesId, applicationId);
}

/** What audit events carry about who authorised a submission. */
export function authorisedBy(guard: GuardResult): { authorisedBy: "rules" | "approval"; rulesId?: string } {
  return guard.rulesId ? { authorisedBy: "rules", rulesId: guard.rulesId } : { authorisedBy: "approval" };
}
