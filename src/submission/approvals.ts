import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import { getApplication, recordApproval, saveApplication } from "../db/repositories/applications.js";
import {
  computeManifestHash,
  getBatch,
  listBatchItems,
  setBatchItemState,
  setBatchStatus,
} from "../db/repositories/batches.js";
import { appendEvent } from "../db/repositories/events.js";
import { getJob } from "../db/repositories/jobs.js";
import { getRules, markRulesApproved, proposeRules, type ApprovedVia } from "../db/repositories/rules.js";
import { AppError } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";
import { computePacketHash, renderPacketPreview, type SubmissionPacket } from "./packet.js";
import { normalizeRules, rulesHash, rulesSummary } from "./standingRules.js";

/**
 * The approval boundary's human half.
 *
 * A packet hash proves what is approved, not who approved it: the model reads
 * the hash from preview_application and could hand it straight back. So an
 * approval is asked of the person directly, through the client's elicitation
 * dialog, or through `approve.js` in their own terminal when the client has no
 * such dialog. The model relays the request; it never answers it.
 */

const APPROVE_CLI = fileURLToPath(new URL("../cli/approve.js", import.meta.url));
const PREVIEW_LIMIT = 6000;

export function packetFor(applicationId: string) {
  const workspace = getWorkspace();
  const application = getApplication(workspace.db, applicationId);
  if (!application) throw new AppError("application_not_found", `no application ${applicationId}`);
  const job = getJob(workspace.db, application.jobId);
  if (!job) throw new AppError("job_not_found", `job ${application.jobId} is missing`);
  const packet: SubmissionPacket = {
    applicationId: application.id,
    jobId: application.jobId,
    company: job.companyName,
    jobTitle: job.title,
    applyUrl: job.applyUrl,
    resumeId: application.resumeId,
    resumePath: application.resumePath,
    coverLetter: application.coverLetter,
    answers: application.answers,
  };
  return { workspace, application, job, packet, currentHash: computePacketHash(packet) };
}

/** What the person is shown before saying yes to one application. */
export function applicationQuestion(packet: SubmissionPacket, packetHash: string): string {
  const preview = renderPacketPreview(packet);
  const shown = preview.length > PREVIEW_LIMIT ? `${preview.slice(0, PREVIEW_LIMIT)}\n[...]` : preview;
  return `Send this application to ${packet.company}?\n\n${shown}\n\nPacket ${packetHash}`;
}

/** What the person is shown before saying yes to a batch. */
export function batchQuestion(batchId: string): string {
  const workspace = getWorkspace();
  const ready = listBatchItems(workspace.db, batchId, "ready");
  const lines = ready.map((item) => {
    const { packet } = packetFor(item.applicationId);
    return `- ${packet.company}: ${packet.jobTitle}`;
  });
  return `Send these ${ready.length} application(s)?\n\n${lines.join("\n")}\n\nManifest ${computeManifestHash(ready)}`;
}

/**
 * Asks the person, not the model. Without elicitation in the client, the
 * request is refused with the command the person can run themselves.
 */
export async function askPerson(server: McpServer, question: string, cliArgs: string): Promise<boolean> {
  if (!server.server.getClientCapabilities()?.elicitation) {
    throw new AppError(
      "person_approval_needed",
      "This client cannot ask the person directly. Ask them to run this in their own terminal, " +
        `where they will see the packet and confirm it: node ${APPROVE_CLI} ${cliArgs}`,
    );
  }
  const answer = await server.server.elicitInput({
    message: question,
    requestedSchema: {
      type: "object",
      properties: {
        approve: { type: "boolean", title: "Approve", description: "Send exactly what is shown above." },
      },
      required: ["approve"],
    },
  });
  return answer.action === "accept" && answer.content?.approve === true;
}

/** Records a decision on one application's current packet. */
export function recordApplicationDecision(
  applicationId: string,
  packetHash: string,
  decision: "approved" | "rejected",
  note: string,
) {
  const { workspace, application, currentHash } = packetFor(applicationId);
  if (packetHash !== currentHash) {
    throw new AppError(
      "packet_hash_mismatch",
      `supplied hash does not match current content (current: ${currentHash}). Re-run preview_application and approve the current packet.`,
    );
  }
  recordApproval(workspace.db, { id: newId("apr"), applicationId: application.id, packetHash: currentHash, decision, note });
  const status = decision === "approved" ? ("approved" as const) : ("skipped" as const);
  saveApplication(workspace.db, {
    ...application,
    packetHash: currentHash,
    status,
    approvedAt: decision === "approved" ? nowIso() : null,
  });
  appendEvent(workspace.db, "application.approval", application.id, { decision, packetHash: currentHash });
  return {
    applicationId: application.id,
    decision,
    status,
    packetHash: currentHash,
    nextStep: decision === "approved" ? "Call submit_application." : "No further action; application skipped.",
  };
}

/** Checks a batch's manifest and count against what is ready now, before anyone is asked. */
export function checkBatchManifest(batchId: string, manifestHash: string, expectedCount: number): void {
  const workspace = getWorkspace();
  if (!getBatch(workspace.db, batchId)) throw new AppError("batch_not_found", `no batch ${batchId}`);
  const ready = listBatchItems(workspace.db, batchId, "ready");
  const currentManifest = computeManifestHash(ready);
  if (manifestHash !== currentManifest) {
    throw new AppError(
      "manifest_mismatch",
      `manifest hash does not match the current batch contents (current: ${currentManifest}). Re-run preview_batch and approve the current manifest.`,
    );
  }
  if (expectedCount !== ready.length) {
    throw new AppError(
      "count_mismatch",
      `batch contains ${ready.length} ready application(s) but expectedCount was ${expectedCount}. Confirm the real number before approving.`,
    );
  }
}

/** Records the person's approval of every ready application in a batch. */
export function recordBatchApproval(batchId: string, manifestHash: string, expectedCount: number, note: string) {
  checkBatchManifest(batchId, manifestHash, expectedCount);
  const workspace = getWorkspace();
  let approved = 0;
  for (const item of listBatchItems(workspace.db, batchId, "ready")) {
    const { application, currentHash } = packetFor(item.applicationId);
    if (currentHash !== item.packetHash) {
      setBatchItemState(workspace.db, batchId, item.applicationId, "needs_human", "content changed after preparation");
      continue;
    }
    recordApproval(workspace.db, {
      id: newId("apr"),
      applicationId: application.id,
      packetHash: currentHash,
      decision: "approved",
      note: note || `batch ${batchId}`,
    });
    saveApplication(workspace.db, { ...application, packetHash: currentHash, status: "approved", approvedAt: nowIso() });
    approved += 1;
  }
  setBatchStatus(workspace.db, batchId, "approved", nowIso(), note);
  appendEvent(workspace.db, "batch.approved", batchId, { approved });
  return {
    batchId,
    approved,
    nextStep: `Run submit_batch for ${batchId}. Submission respects the campaign mode, daily limit and pacing.`,
  };
}

/**
 * Stores a rule set as proposed. A proposal authorises nothing: it exists so
 * the person's own terminal can show the very rules the agent asked for, and
 * the hash ties their yes to that content.
 */
export function proposeStandingRules(input: unknown) {
  const workspace = getWorkspace();
  const rules = normalizeRules(input);
  const hash = rulesHash(rules);
  const rulesId = newId("rules");
  proposeRules(workspace.db, rulesId, rules, hash);
  appendEvent(workspace.db, "rules.proposed", rulesId, { hash });
  return { rulesId, hash, rules };
}

/** The proposal as the person sees it, refused if it is not the one previewed. */
export function rulesQuestion(rulesId: string, hash: string): string {
  const workspace = getWorkspace();
  const record = getRules(workspace.db, rulesId);
  if (!record) throw new AppError("rules_not_found", `no standing rules ${rulesId}`);
  if (record.hash !== hash || rulesHash(record.rules) !== hash) {
    throw new AppError("rules_hash_mismatch", `rules ${rulesId} do not match hash ${hash} (current: ${record.hash})`);
  }
  if (record.approvedAt) throw new AppError("rules_already_approved", `rules ${rulesId} were approved at ${record.approvedAt}`);
  if (record.revokedAt) throw new AppError("rules_revoked", `rules ${rulesId} were revoked at ${record.revokedAt}`);
  if (new Date(record.expiresAt).getTime() <= Date.now()) throw new AppError("rules_expired", `rules ${rulesId} expired at ${record.expiresAt}`);
  return rulesSummary(record.rules, rulesId, hash, workspace.campaign);
}

/** Records the person's yes. Only the dialog and approve.js call this. */
export function recordRulesApproval(rulesId: string, hash: string, via: ApprovedVia) {
  rulesQuestion(rulesId, hash);
  const workspace = getWorkspace();
  markRulesApproved(workspace.db, rulesId, via);
  appendEvent(workspace.db, "rules.approved", rulesId, { hash, via });
  const record = getRules(workspace.db, rulesId)!;
  return {
    rulesId,
    approvedAt: record.approvedAt,
    approvedVia: via,
    expiresAt: record.expiresAt,
    nextStep: "Applications that match these rules can now be submitted without asking again. revoke_rules ends them.",
  };
}
