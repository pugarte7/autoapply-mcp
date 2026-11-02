import type { AtsKind, Campaign, SubmissionMode } from "../domain/campaign.js";
import type { Application, Job } from "../domain/job.js";
import type { ApprovalRecord } from "../db/repositories/applications.js";
import { checkUrlAllowed } from "./allowlist.js";
import { validateResumeFile } from "./resume.js";

/**
 * The approval boundary.
 *
 * Every condition here must hold before anything is sent to an employer. These
 * checks are deliberately conservative: refusing to submit is always recoverable,
 * sending a wrong or unapproved application is not.
 */

/**
 * Boards with discovery but no browser submission. They used to fall back to a
 * packet for the person to send by hand; with that mode gone they are refused
 * outright, before approval is even consulted, so the agent learns at once
 * that the only route is the person applying and recording it. Apple's career
 * site is listed because its walk was never written: without this the run
 * would open a signed-in browser only to stop on the first page.
 */
const BROWSERLESS_ATS: ReadonlySet<AtsKind> = new Set(["smartrecruiters", "workable", "recruitee", "apple"]);

export type GuardInput = {
  application: Application;
  job: Job;
  campaign: Campaign;
  approval: ApprovalRecord | null;
  submittedToday: number;
  /**
   * Applications already sent to, or approved for, this job's company. A draft
   * is not counted, so the ceiling has to hold here as well as at drafting
   * time: otherwise a pile of drafts could all be submitted one by one.
   */
  companyApplicationCount?: number;
  lastSubmissionAt: string | null;
  requestedMode: SubmissionMode;
  now?: Date;
};

export type GuardResult = {
  allowed: boolean;
  code: string;
  reason: string;
  waitSeconds?: number;
};

function deny(code: string, reason: string, waitSeconds?: number): GuardResult {
  return waitSeconds === undefined ? { allowed: false, code, reason } : { allowed: false, code, reason, waitSeconds };
}

export function checkSubmissionAllowed(input: GuardInput): GuardResult {
  const { application, job, campaign, approval, requestedMode } = input;
  const policy = campaign.submission;
  const now = input.now ?? new Date();

  if (application.status === "submitted") {
    return deny("already_submitted", `application was already submitted at ${application.submittedAt}`);
  }

  // Assisted is the lesser mode: a call may ask for it under an auto campaign
  // (the person wants to watch, or press submit), never the other way round.
  const modeRank = { assisted: 0, auto: 1 } as const;
  if (modeRank[requestedMode] > modeRank[policy.mode]) {
    return deny(
      "mode_not_permitted",
      `campaign submission mode is "${policy.mode}"; "${requestedMode}" submission is not permitted`,
    );
  }
  if (BROWSERLESS_ATS.has(job.ats)) {
    return deny(
      "ats_browser_not_supported",
      `${job.ats} postings cannot be submitted by the server; the person can apply at ${job.applyUrl} themselves, then call record_submission so counts and pacing stay right`,
    );
  }

  if (!approval || approval.decision !== "approved") {
    return deny("not_approved", "no recorded human approval for this application");
  }
  if (approval.packetHash !== application.packetHash) {
    return deny(
      "packet_changed",
      "application content changed after approval; re-approve the current packet before submitting",
    );
  }

  const unresolved = application.answers.filter(
    (answer) => answer.requiresHuman && answer.required && answer.answer.trim().length === 0,
  );
  if (unresolved.length > 0) {
    return deny("unresolved_questions", `${unresolved.length} question(s) still need a human answer: ${unresolved
      .map((answer) => answer.label)
      .slice(0, 5)
      .join("; ")}`);
  }

  // An application without its resume is worse than no application at all.
  const resume = validateResumeFile(application.resumePath);
  if (!resume.ok) {
    return deny("resume_unusable", resume.reason);
  }

  const destination = checkUrlAllowed(job.applyUrl, policy);
  if (!destination.allowed) {
    return deny("destination_not_allowed", destination.reason);
  }

  // Excluding a company is a standing instruction not to apply there, but the
  // exclusion list was only ever consulted while gating newly discovered jobs.
  // An application drafted and approved before the exclusion was added stayed
  // perfectly submittable, and submission is the one step that cannot be taken
  // back. Checked here so the list means the same thing at every stage.
  const excluded = campaign.exclusions.companies.find(
    (name) => name.trim().toLowerCase() === job.companyName.trim().toLowerCase(),
  );
  if (excluded) {
    return deny(
      "company_excluded",
      `${job.companyName} is on the campaign exclusion list; withdraw this application or remove the exclusion`,
    );
  }

  // An empty list is no restriction: any company that passed the campaign's
  // gates may be submitted to. Naming companies narrows auto mode to them.
  if (policy.allowedCompanies.length > 0 && requestedMode === "auto") {
    const permitted = policy.allowedCompanies.some(
      (name) => name.toLowerCase() === job.companyName.toLowerCase(),
    );
    if (!permitted) {
      return deny("company_not_allowlisted", `auto submission is limited to allowlisted companies`);
    }
  }

  if (policy.dailyLimit !== null && input.submittedToday >= policy.dailyLimit) {
    return deny("daily_limit_reached", `daily submission limit of ${policy.dailyLimit} reached`);
  }

  // This application's own approval is already counted, so it must be allowed
  // to consume the slot it holds rather than be blocked by it.
  const heldForCompany = (input.companyApplicationCount ?? 0) - (application.status === "approved" ? 1 : 0);
  if (heldForCompany >= policy.maxPerCompany) {
    return deny(
      "company_cap_reached",
      `${job.companyName} already has ${heldForCompany} submitted or approved application${
        heldForCompany === 1 ? "" : "s"
      }, at the campaign ceiling of ${policy.maxPerCompany} per company`,
    );
  }

  if (input.lastSubmissionAt) {
    const elapsed = (now.getTime() - new Date(input.lastSubmissionAt).getTime()) / 1000;
    if (Number.isFinite(elapsed) && elapsed < policy.minDelaySeconds) {
      const wait = Math.ceil(policy.minDelaySeconds - elapsed);
      return deny("pacing", `minimum ${policy.minDelaySeconds}s between submissions; wait ${wait}s`, wait);
    }
  }

  return { allowed: true, code: "ok", reason: "all submission guards passed" };
}

export function startOfDayIso(now = new Date()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}
