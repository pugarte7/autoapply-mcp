import { z } from "zod";
import { SUBMISSION_MODES, type SubmissionMode } from "../domain/campaign.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  countSubmittedSince,
  lastSubmissionAt,
  latestApproval,
  saveApplication,
} from "../db/repositories/applications.js";
import { appendEvent } from "../db/repositories/events.js";
import { applicationCountsByCompany } from "../db/repositories/jobs.js";
import { applicationQuestion, askPerson, packetFor, recordApplicationDecision } from "../submission/approvals.js";
import { runApplicationForm } from "../submission/browser.js";
import { mergeDiscoveredQuestions } from "../submission/discoveredQuestions.js";
import { checkSubmissionAllowed, startOfDayIso } from "../submission/guards.js";
import { AppError } from "../util/errors.js";
import { nowIso } from "../util/hash.js";
import { abortedNextStep, fieldsToAnswer, formRunOptions, waitForCodeSecondsInput, type FieldToAnswer } from "./formRun.js";
import { handler, ok } from "./helpers.js";

/**
 * Approval and submission.
 *
 * These are the only tools that can cause an employer-visible action, so each
 * one re-checks the guards rather than trusting earlier state.
 */

export function registerSubmissionTools(server: McpServer): void {
  server.registerTool(
    "approve_application",
    {
      title: "Ask the person to approve an application",
      description:
        "Shows the person the exact packet and records their answer: the decision is theirs, asked through the client's approval dialog, never the model's. The supplied packetHash must match the current content exactly; any later edit invalidates the approval. Rejecting needs no confirmation.",
      inputSchema: {
        applicationId: z.string().min(1),
        packetHash: z.string().min(8).describe("Hash shown by preview_application, proving the approved content."),
        decision: z.enum(["approved", "rejected"]).default("approved"),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: { applicationId: string; packetHash: string; decision?: "approved" | "rejected"; note?: string }) => {
      const decision = args.decision ?? "approved";
      const { packet, currentHash } = packetFor(args.applicationId);
      if (args.packetHash !== currentHash) {
        throw new AppError(
          "packet_hash_mismatch",
          `supplied hash does not match current content (current: ${currentHash}). Re-run preview_application and approve the current packet.`,
        );
      }
      if (decision === "approved") {
        const yes = await askPerson(server, applicationQuestion(packet, currentHash), `${args.applicationId} ${currentHash}`);
        if (!yes) {
          return ok({
            applicationId: args.applicationId,
            decision: "declined",
            nextStep: "The person did not approve this packet. Ask what to change; nothing was recorded.",
          });
        }
      }
      return ok(recordApplicationDecision(args.applicationId, currentHash, decision, args.note ?? ""));
    }),
  );

  server.registerTool(
    "submit_application",
    {
      title: "Submit an approved application",
      description:
        "Runs every submission guard, then acts according to mode. 'auto' (the default) fills the hosted form and clicks submit. 'assisted' fills it in a visible browser and leaves it for the person to submit; use it only when they ask to watch or press submit themselves. Boards without browser submission fail with ats_browser_not_supported: the person applies at the URL and you call record_submission.",
      inputSchema: {
        applicationId: z.string().min(1),
        mode: z.enum(SUBMISSION_MODES).default("auto"),
        headless: z.boolean().optional().describe("Run the browser headless. Ignored in assisted mode."),
        keepOpenSeconds: z
          .number()
          .int()
          .min(0)
          .max(1800)
          .optional()
          .describe("Assisted mode: how long to leave the filled form open for review."),
        verificationCode: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The one-time code the board emailed after a previous attempt hit its verification gate. Each attempt emails a new code, so use the most recent one.",
          ),
        waitForCodeSeconds: waitForCodeSecondsInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handler(async (args: { applicationId: string; mode?: SubmissionMode; headless?: boolean; keepOpenSeconds?: number; verificationCode?: string; waitForCodeSeconds?: number }) => {
      const { workspace, application, job, packet, currentHash } = packetFor(args.applicationId);
      const mode = args.mode ?? "auto";
      const approval = latestApproval(workspace.db, application.id);

      const guard = checkSubmissionAllowed({
        application: { ...application, packetHash: currentHash },
        job,
        campaign: workspace.campaign,
        approval,
        submittedToday: countSubmittedSince(workspace.db, startOfDayIso()),
        companyApplicationCount: applicationCountsByCompany(workspace.db).get(job.companyName.toLowerCase()) ?? 0,
        lastSubmissionAt: lastSubmissionAt(workspace.db),
        requestedMode: mode,
      });

      if (!guard.allowed) {
        appendEvent(workspace.db, "submission.blocked", application.id, { code: guard.code, mode });
        throw new AppError(guard.code, guard.reason, { applicationId: application.id, mode });
      }

      const result = await runApplicationForm(
        packet,
        formRunOptions(workspace, job, application.id, {
          mode,
          headless: args.headless,
          keepOpenMs: mode === "assisted" ? (args.keepOpenSeconds ?? 240) * 1000 : 0,
          verificationCode: args.verificationCode,
          waitForCodeSeconds: args.waitForCodeSeconds,
        }),
      );

      let unanswered: FieldToAnswer[] = [];
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
        });
      } else if (result.status === "aborted") {
        const answers = mergeDiscoveredQuestions(application.answers, result.unmatchedRequired, workspace.profile.answers);
        unanswered = fieldsToAnswer(answers);
        saveApplication(workspace.db, {
          ...application,
          packetHash: currentHash,
          status: "needs_human",
          answers,
          notes: `${application.notes}\n[${nowIso()}] aborted: ${result.reason}`.trim(),
          artifactPath: result.screenshotPath,
        });
        appendEvent(workspace.db, "submission.aborted", application.id, { mode, reason: result.reason });
      } else {
        appendEvent(workspace.db, "submission.prepared", application.id, { mode, finalUrl: result.finalUrl });
      }

      return ok({
        applicationId: application.id,
        mode,
        result,
        fieldsToAnswer: result.status === "aborted" ? unanswered : undefined,
        nextStep:
          result.status === "submitted"
            ? "Submitted. Track the outcome with record_outcome."
            : result.status === "prepared"
              ? "Form filled in the open window for the person to check and send. Once they have, call record_submission."
              : abortedNextStep(result, unanswered, "run submit_application again"),
      });
    }),
  );

  server.registerTool(
    "record_submission",
    {
      title: "Record a submission sent by hand",
      description: "Marks an application as submitted after the person sent it themselves (for example on a board without browser submission), so counts, pacing and duplicate checks stay accurate.",
      inputSchema: {
        applicationId: z.string().min(1),
        confirmationRef: z.string().optional(),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    handler(async (args: { applicationId: string; confirmationRef?: string; notes?: string }) => {
      const { workspace, application, currentHash } = packetFor(args.applicationId);
      if (application.status === "submitted") {
        throw new AppError("already_submitted", `already recorded as submitted at ${application.submittedAt}`);
      }
      const submittedAt = nowIso();
      saveApplication(workspace.db, {
        ...application,
        packetHash: currentHash,
        status: "submitted",
        submittedAt,
        submissionMode: "manual",
        confirmationRef: args.confirmationRef ?? null,
        notes: args.notes ?? application.notes,
      });
      appendEvent(workspace.db, "submission.recorded", application.id, { submittedAt });
      return ok({ applicationId: application.id, status: "submitted", submittedAt });
    }),
  );
}
