import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  countSubmittedSince,
  lastSubmissionAt,
  latestApproval,
  saveApplication,
} from "../db/repositories/applications.js";
import { appendEvent } from "../db/repositories/events.js";
import { applicationCountsByCompany, getEvaluation } from "../db/repositories/jobs.js";
import { applicationQuestion, askPerson, packetFor, recordApplicationDecision } from "../submission/approvals.js";
import { runApplicationForm, type BrowserRunOptions, type BrowserRunResult } from "../submission/browser.js";
import { getWorkspace } from "../config/load.js";
import { recordRunResult } from "../submission/runRecording.js";
import {
  DEFAULT_GATE_HOLD_MS,
  gateSessionFor,
  listPendingGates,
  recentGateOutcomes,
  runHoldingGates,
  type PendingGate,
} from "../submission/sessions.js";
import { readVerificationInboxConfig } from "../submission/verificationInbox.js";
import { suppliedLinkProblem } from "../submission/verificationLinks.js";
import { checkSubmissionAllowed, startOfDayIso } from "../submission/guards.js";
import { renderPacketPreview } from "../submission/packet.js";
import { AppError } from "../util/errors.js";
import { personalResolverFor } from "../submission/personalResolver.js";
import { experienceResolverFor } from "../submission/experienceResolver.js";
import { narrativeResolverFor } from "../submission/narrativeResolver.js";
import { isWorkdayUrl } from "../submission/workdayFlow.js";
import { nowIso } from "../util/hash.js";
import { handler, ok, okText } from "./helpers.js";

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
        "Runs every submission guard, then acts according to mode. 'manual' returns the packet for a person to submit. 'assisted' fills the hosted form in a visible browser and leaves it for a person to submit. 'auto' fills and clicks submit, and is only available when the campaign and company allowlists permit it.",
      inputSchema: {
        applicationId: z.string().min(1),
        mode: z.enum(["manual", "assisted", "auto"]).default("manual"),
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
        waitForCodeSeconds: z
          .number()
          .int()
          .min(0)
          .max(1800)
          .optional()
          .describe(
            "Hold the browser at a verification gate for this long while waiting for the code to be written to <artifacts>/<applicationId>.code. A code cannot be carried between runs, so this is the only way an automated submission clears the gate. With a verification inbox configured, it also bounds the wait for the link Workday emails to verify a candidate account. With codeDelivery 'handoff' it is how long the gate is held for provide_verification_code (default 900).",
          ),
        codeDelivery: z
          .enum(["wait", "handoff"])
          .optional()
          .describe(
            "What to do at an emailed-code or Workday-link gate in auto mode. 'wait' blocks this call while the server reads the code file and its own mailbox. 'handoff' returns status awaiting_code at once with the browser held at the gate, so you can read the email yourself and call provide_verification_code. Defaults to 'handoff' when no inbox is configured and no waitForCodeSeconds is given, else 'wait'.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handler(async (args: { applicationId: string; mode?: "manual" | "assisted" | "auto"; headless?: boolean; keepOpenSeconds?: number; verificationCode?: string; waitForCodeSeconds?: number; codeDelivery?: "wait" | "handoff" }) => {
      const { workspace, application, job, packet, currentHash } = packetFor(args.applicationId);
      const mode = args.mode ?? "manual";
      refuseWhileGateHeld(application.id);
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

      if (mode === "manual") {
        appendEvent(workspace.db, "submission.manual_packet", application.id, { applyUrl: job.applyUrl });
        return okText(
          [
            "Submission guards passed. This packet is ready for you to submit by hand.",
            "",
            `Apply URL: ${job.applyUrl}`,
            "",
            renderPacketPreview(packet),
            "",
            "After submitting, call record_submission with the confirmation reference.",
          ].join("\n"),
        );
      }

      const handoff = mode === "auto" && codeDeliveryFor(args) === "handoff";
      const holdSeconds = handoff ? args.waitForCodeSeconds || DEFAULT_GATE_HOLD_MS / 1000 : args.waitForCodeSeconds ?? 0;
      const formOptions: BrowserRunOptions = {
        submit: mode === "auto",
        headless: mode === "assisted" ? false : args.headless ?? true,
        artifactsDir: workspace.paths.artifacts,
        policy: workspace.campaign.submission,
        candidateCountry: workspace.profile.identity.location.country,
        answerBank: workspace.profile.answers,
        personalResolver: personalResolverFor(workspace.profile),
        experienceResolver: experienceResolverFor(workspace.profile),
        narrativeResolver: narrativeResolverFor(job, getEvaluation(workspace.db, job.id), workspace.profile, workspace.campaign),
        accountEmail: workspace.profile.identity.email,
        relocationTargets: workspace.profile.preferences.relocationTargets,
        // Registering on an employer's tenant is a bigger step than filling a
        // public form, so it is only done when a person is watching the window.
        // Workday is the exception: it has no anonymous apply path at all, so
        // refusing to register there is refusing to apply.
        allowAccountCreation: mode === "assisted" || isWorkdayUrl(job.applyUrl),
        keepOpenMs: mode === "assisted" ? (args.keepOpenSeconds ?? 240) * 1000 : 0,
        verificationCode: args.verificationCode,
        codeWaitMs: holdSeconds * 1000,
        codeFilePath: join(workspace.paths.artifacts, `${application.id}.code`),
      };
      const settle = (result: BrowserRunResult) => {
        recordRunResult(getWorkspace(), { application, job, currentHash, mode, result });
        return { applicationId: application.id, mode, result, nextStep: nextStepAfterRun(result) };
      };

      if (handoff) {
        const first = await runHoldingGates(
          application.id,
          { applyUrl: job.applyUrl, holdMs: holdSeconds * 1000 },
          (hooks) => runApplicationForm(packet, { ...formOptions, ...hooks }),
          (late) => void settle(late),
        );
        if ("held" in first) return ok(awaitingCode(first.held));
        return ok(settle(first.result));
      }
      return ok(settle(await runApplicationForm(packet, formOptions)));
    }),
  );

  server.registerTool(
    "provide_verification_code",
    {
      title: "Hand a held submission its emailed code or link",
      description:
        "Finishes a submit_application or submit_batch run that is held at a verification gate (status awaiting_code). Pass the one-time code from the newest email from the sender list_pending_gates names, received after emailedAt, or for Workday the verification link from that email. The held browser types it, clicks the gate's own control and waits for the board's confirmation, then records the outcome exactly as submit_application does. A refused code keeps the gate open for another try when the board allows it. Never call submit_application again for a held application: a new submit emails a new code and voids this one.",
      inputSchema: {
        applicationId: z.string().min(1),
        code: z.string().min(1).max(64).optional().describe("The one-time code from the email."),
        link: z.string().min(1).max(4096).optional().describe("Workday only: the account verification link from the email."),
        cancel: z.boolean().optional().describe("Give up on this gate: the run ends as if no code came and the application needs a human."),
        waitForOutcomeSeconds: z
          .number()
          .int()
          .min(5)
          .max(900)
          .optional()
          .describe("How long to wait for the board's answer before returning status submitting (default 300). The run carries on and records itself either way."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handler(async (args: { applicationId: string; code?: string; link?: string; cancel?: boolean; waitForOutcomeSeconds?: number }) => {
      const session = gateSessionFor(args.applicationId);
      if (!session) {
        throw new AppError(
          "no_pending_gate",
          `${args.applicationId} is not held at a verification gate. It may have finished already (see list_pending_gates and list_applications), or its gate expired and the browser was closed; a code cannot be carried into a new run.`,
        );
      }
      if (args.cancel) {
        session.release();
      } else if (!session.isAwaiting()) {
        throw new AppError(
          "gate_not_waiting",
          `${args.applicationId} is still checking the last answer or still submitting, not asking for a code. Call list_pending_gates and try again when it shows awaiting_code.`,
        );
      } else {
        session.answer(gateAnswer(session.describe().kind, session.tenant(), args));
      }
      const state = await session.next((args.waitForOutcomeSeconds ?? 300) * 1000);
      if (state.state === "awaiting") return ok(awaitingCode(state.gate));
      if (state.state === "running") {
        return ok({
          applicationId: args.applicationId,
          status: "submitting",
          nextStep:
            "The board has not answered yet. The run carries on and records its own outcome; check list_pending_gates in a minute. Do not submit again.",
        });
      }
      const result = state.result as BrowserRunResult;
      return ok({ applicationId: args.applicationId, status: result.status, result, nextStep: nextStepAfterRun(result) });
    }),
  );

  server.registerTool(
    "list_pending_gates",
    {
      title: "List submissions held at a verification gate",
      description:
        "Applications whose browser is held open at an emailed-code or Workday-link gate, with when the email was sent, who sends it and when the hold expires; and held runs that finished after their tool call returned, such as when the server's own mailbox supplied the code.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler(async () => {
      const pending = listPendingGates();
      return ok({
        pending,
        finished: recentGateOutcomes(),
        nextStep: pending.some((gate) => gate.status === "awaiting_code")
          ? "For each awaiting_code entry, read the newest email from its sender received after emailedAt and call provide_verification_code. Without mailbox access, ask the person once for the code."
          : "Nothing is waiting for a code.",
      });
    }),
  );

  server.registerTool(
    "record_submission",
    {
      title: "Record a manual submission",
      description: "Marks an application as submitted after a person sent it, so counts, pacing and duplicate checks stay accurate.",
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

function nextStepAfterRun(result: BrowserRunResult): string {
  return result.status === "submitted"
    ? "Submitted. Track the outcome with record_outcome."
    : result.status === "prepared"
      ? "Form filled. Review the open window or the screenshot, submit, then call record_submission."
      : "Blocked. Resolve the reason above; this application needs a human.";
}

/**
 * Handing the gate off is the default only when nothing else could answer it:
 * with a mailbox configured, or a wait asked for, the blocking wait is what
 * the caller set up and it keeps working as it always has.
 */
export function codeDeliveryFor(args: { codeDelivery?: "wait" | "handoff"; waitForCodeSeconds?: number }): "wait" | "handoff" {
  if (args.codeDelivery) return args.codeDelivery;
  return readVerificationInboxConfig() || args.waitForCodeSeconds !== undefined ? "wait" : "handoff";
}

/** A second submit would email a new code and void the one being waited for. */
export function refuseWhileGateHeld(applicationId: string): void {
  const held = gateSessionFor(applicationId);
  if (!held) return;
  throw new AppError(
    "gate_pending",
    `${applicationId} is held at a verification gate (${held.describe().status}). Call provide_verification_code with the emailed ${held.describe().kind ?? "code"}; submitting again would email a new one and void it.`,
  );
}

/** What the agent is told when a run stops at a gate it has to answer. */
export function awaitingCode(gate: PendingGate): Record<string, unknown> {
  const what = gate.kind === "link" ? "the account verification link in it" : "the one-time code in it";
  const pass = gate.kind === "link" ? "link" : "code";
  const retry = gate.refused
    ? `The board did not accept the last answer (${gate.refused}). Check it came from the newest email, then try once more. `
    : "";
  return {
    applicationId: gate.applicationId,
    status: "awaiting_code",
    kind: gate.kind,
    prompt: gate.prompt,
    emailedAt: gate.emailedAt,
    sender: gate.sender,
    expiresAt: gate.expiresAt,
    attempts: gate.attempts,
    ...(gate.batchId ? { batchId: gate.batchId } : {}),
    ...(gate.refused ? { refused: gate.refused } : {}),
    nextStep:
      `${retry}Read the newest email from ${gate.sender} received after ${gate.emailedAt}, take ${what}, and call ` +
      `provide_verification_code with applicationId and ${pass}. Use your own access to the candidate's mailbox if you ` +
      `have it (a Gmail connector, for example); if you do not, ask the person once for it. The browser holds the form ` +
      `until ${gate.expiresAt}. Do not call submit_application again: a new submit emails a new ${pass} and voids this one.`,
  };
}

/** Checks what the agent read out of the email before the held page sees it. */
export function gateAnswer(
  kind: "code" | "link" | null,
  tenant: string | undefined,
  args: { code?: string; link?: string },
): string {
  if (kind === "link") {
    if (!args.link) throw new AppError("link_required", "this gate is waiting for Workday's verification link; pass it as link");
    const problem = suppliedLinkProblem(args.link, tenant);
    if (problem) throw new AppError("link_refused", `the link was not opened: ${problem}. The gate is still held.`);
    return args.link.trim();
  }
  const code = (args.code ?? "").replace(/\s+/g, "");
  if (!code) throw new AppError("code_required", "this gate is waiting for the emailed one-time code; pass it as code");
  if (!/^[A-Za-z0-9]{4,12}$/.test(code)) {
    throw new AppError(
      "code_malformed",
      "that does not look like a one-time code: pass only its 4 to 12 letters and digits, without hyphens. The gate is still held.",
    );
  }
  return code;
}
