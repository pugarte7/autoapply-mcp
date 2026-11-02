import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { saveApplication } from "../db/repositories/applications.js";
import { markItemSubmitted } from "../db/repositories/batches.js";
import { appendEvent } from "../db/repositories/events.js";
import { applicationQuestion, askPerson, packetFor, recordApplicationDecision } from "../submission/approvals.js";
import { submissionGuard } from "../submission/authorise.js";
import { handOff } from "../submission/handoff.js";
import { AppError } from "../util/errors.js";
import { nowIso } from "../util/hash.js";
import { handler, ok } from "./helpers.js";

/**
 * Approval and submission.
 *
 * submit_application is the only way to the content an employer receives, so
 * it re-checks every guard rather than trusting earlier state.
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
        "Runs every submission guard (approval or standing rules, allowlisted host, limits, pacing) and hands you the approved packet: the apply URL, the resume, the cover letter and each field's value. You send it with your own browser and then call record_submission. The server never opens the employer's site itself.",
      inputSchema: { applicationId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: { applicationId: string }) => {
      const { workspace, application, job, packet, currentHash } = packetFor(args.applicationId);
      const guard = submissionGuard(workspace, application, job, currentHash);
      if (!guard.allowed) {
        appendEvent(workspace.db, "submission.blocked", application.id, { code: guard.code });
        throw new AppError(guard.code, guard.reason, {
          applicationId: application.id,
          ...(guard.waitSeconds ? { waitSeconds: guard.waitSeconds } : {}),
        });
      }
      return ok(handOff(workspace, application, job, packet, guard));
    }),
  );

  server.registerTool(
    "record_submission",
    {
      title: "Record a sent application",
      description: "Marks an application as submitted once the board confirmed it, whether you sent it with your browser or the person sent it, so counts, pacing and duplicate checks stay accurate.",
      inputSchema: {
        applicationId: z.string().min(1),
        confirmationRef: z.string().optional().describe("The board's confirmation text or reference."),
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
        submissionMode: "agent",
        confirmationRef: args.confirmationRef ?? null,
        notes: args.notes ?? application.notes,
      });
      appendEvent(workspace.db, "submission.recorded", application.id, { submittedAt });
      markItemSubmitted(workspace.db, application.id);
      return ok({ applicationId: application.id, status: "submitted", submittedAt });
    }),
  );
}
