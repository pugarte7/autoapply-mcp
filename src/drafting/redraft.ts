import type { Campaign } from "../domain/campaign.js";
import type { Application, DraftAnswer } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import type { Db } from "../db/database.js";
import { listApplications, saveApplication } from "../db/repositories/applications.js";
import { appendEvent } from "../db/repositories/events.js";
import { getJob } from "../db/repositories/jobs.js";
import { computePacketHash } from "../submission/packet.js";
import { validateResumeFile } from "../submission/resume.js";
import { draftAnswers } from "./answers.js";

/**
 * Applies a newly remembered answer to the applications still being put
 * together, so a question answered once stops being asked at every company.
 *
 * Only questions still open are touched - blank, or waiting for a person - and
 * only when the drafting engine itself now answers them from one of the
 * remembered entries. An answer already given for one application, by the
 * person or the agent, stays. Re-running the whole of prepare would fetch every form
 * again and throw those answers away.
 *
 * The stored question keeps no option list, so it is re-drafted as a control
 * of unknown type: free-text-only rules do not apply and the value is the
 * stored answer itself, which the fill matches against the live options.
 */

const OPEN_STATUSES = new Set<Application["status"]>(["drafted", "needs_human", "awaiting_approval"]);

export type RedraftedApplication = {
  applicationId: string;
  company: string;
  jobTitle: string;
  status: Application["status"];
  answered: string[];
};

function isOpen(answer: DraftAnswer): boolean {
  if (answer.source === "human" || answer.source === "agent") return false;
  return answer.requiresHuman || answer.answer.trim().length === 0;
}

/** Recomputes status and hash after answers change. Shared with set_application_content. */
export function withAnswers(application: Application, answers: DraftAnswer[], job: { companyName: string; title: string; applyUrl: string }): Application {
  const stillMissing = answers.some(
    (answer) => answer.requiresHuman && answer.required && answer.answer.trim().length === 0,
  );
  const updated: Application = {
    ...application,
    answers,
    approvedAt: null,
    status: stillMissing ? "needs_human" : "awaiting_approval",
  };
  updated.packetHash = computePacketHash({
    jobId: updated.jobId,
    company: job.companyName,
    jobTitle: job.title,
    applyUrl: job.applyUrl,
    resumeId: updated.resumeId,
    resumePath: updated.resumePath,
    coverLetter: updated.coverLetter,
    answers: updated.answers,
  });
  return updated;
}

export function redraftOpenApplications(
  db: Db,
  profile: Profile,
  campaign: Campaign,
  keys: readonly string[],
): RedraftedApplication[] {
  const citations = new Set(keys.map((key) => `profile.answers.${key}`));
  const changed: RedraftedApplication[] = [];
  for (const application of listApplications(db, undefined, 1000)) {
    if (!OPEN_STATUSES.has(application.status)) continue;
    const job = getJob(db, application.jobId);
    if (!job) continue;
    const context = { company: job.companyName, role: job.title, location: job.locationsRaw[0] ?? "", topics: [] };
    const answered: string[] = [];
    const answers = application.answers.map((answer) => {
      if (!isOpen(answer)) return answer;
      const [drafted] = draftAnswers(
        [{ key: answer.questionKey, label: answer.label, required: answer.required, type: "unknown" }],
        profile,
        campaign,
        context,
      ).answers;
      if (!drafted || drafted.requiresHuman || drafted.answer.trim().length === 0) return answer;
      if (!citations.has(drafted.citation)) return answer;
      answered.push(answer.label);
      return { ...answer, answer: drafted.answer, source: drafted.source, citation: drafted.citation, requiresHuman: false, guidance: "" };
    });
    if (answered.length === 0) continue;
    const updated = withAnswers(application, answers, job);
    // An unusable resume holds the application whatever its answers say.
    if (!validateResumeFile(application.resumePath).ok) updated.status = "needs_human";
    saveApplication(db, updated);
    appendEvent(db, "application.redrafted", updated.id, { answered, status: updated.status });
    changed.push({ applicationId: updated.id, company: job.companyName, jobTitle: job.title, status: updated.status, answered });
  }
  return changed;
}
