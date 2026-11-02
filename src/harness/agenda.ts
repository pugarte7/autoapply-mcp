import type { Workspace } from "../config/load.js";
import { countSubmittedSince, listApplications } from "../db/repositories/applications.js";
import { getJob } from "../db/repositories/jobs.js";
import type { Profile } from "../domain/profile.js";
import { startOfDayIso } from "../submission/guards.js";
import { nowIso } from "../util/hash.js";

/**
 * What needs doing, for an agent deciding its next move: applications held
 * for a person and the exact questions holding them, today's remaining budget,
 * and profile fields whose absence will turn into a question on every form.
 * campaign_status reports progress toward the target; this is the to-do list.
 *
 * Harnesses like Hermes Agent inject memory into the prompt at session start so
 * the agent begins knowing where it left off. An MCP server cannot write into
 * the client's prompt, but it can serve the same snapshot as a resource the
 * daily prompt tells the agent to read first.
 */

export type ProfileGap = { field: string; why: string };

export type Agenda = {
  generatedAt: string;
  submissionMode: string;
  submittedToday: number;
  dailyLimit: number | null;
  applications: Record<string, number>;
  needsHuman: Array<{
    applicationId: string;
    company: string;
    title: string;
    ats: string;
    blocking: string[];
    lastNote: string;
  }>;
  profileGaps: ProfileGap[];
  verificationInbox: boolean;
};

/**
 * Fields the schema lets through empty but that forms ask for constantly. Each
 * one missing turns into the same question on every application, so it is
 * cheaper to ask once at the start.
 */
export function profileGaps(profile: Profile, verificationInbox: boolean): ProfileGap[] {
  const gaps: ProfileGap[] = [];
  const add = (missing: boolean, field: string, why: string) => {
    if (missing) gaps.push({ field, why });
  };
  add(!profile.identity.phone.trim(), "identity.phone", "almost every form requires a phone number");
  add(!profile.identity.location.country.trim(), "identity.location.country", "location gates and country questions need it");
  add(!profile.identity.links.linkedin, "identity.links.linkedin", "most boards ask for a LinkedIn URL");
  add(!profile.preferences.noticePeriod.trim(), "preferences.noticePeriod", "start-date and notice questions block without it");
  add(profile.experience.length === 0, "experience", "employment history questions and Workday's experience step need it");
  add(profile.education.length === 0, "education", "education questions and Workday's education step need it");
  add(profile.facts.length === 0, "facts", "cover letters and essays may only use profile facts");
  add(!verificationInbox, "verification mailbox", "Greenhouse and Workday email a code at submit; without a connected mailbox the person passes codes by hand");
  return gaps;
}

export function buildAgenda(workspace: Workspace, verificationInbox: boolean): Agenda {
  const applications: Record<string, number> = {};
  for (const row of workspace.db.prepare("SELECT status, COUNT(*) AS n FROM applications GROUP BY status").all() as Array<{
    status: string;
    n: number;
  }>) {
    applications[String(row.status)] = Number(row.n);
  }

  const needsHuman = listApplications(workspace.db, "needs_human", 50).map((application) => {
    const job = getJob(workspace.db, application.jobId);
    const blocking = application.answers
      .filter((answer) => answer.requiresHuman && answer.required && !answer.notApplicable && !answer.answer.trim())
      .map((answer) => answer.label);
    const notes = application.notes.trim().split("\n");
    return {
      applicationId: application.id,
      company: job?.companyName ?? "",
      title: job?.title ?? "",
      ats: job?.ats ?? "",
      blocking,
      lastNote: (notes[notes.length - 1] ?? "").slice(0, 300),
    };
  });

  return {
    generatedAt: nowIso(),
    submissionMode: workspace.campaign.submission.mode,
    submittedToday: countSubmittedSince(workspace.db, startOfDayIso()),
    dailyLimit: workspace.campaign.submission.dailyLimit,
    applications,
    needsHuman,
    profileGaps: profileGaps(workspace.profile, verificationInbox),
    verificationInbox,
  };
}
