import { z } from "zod";
import { LocationClassSchema } from "../domain/campaign.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import { getApplication, saveApplication } from "../db/repositories/applications.js";
import {
  batchSummary,
  computeManifestHash,
  createBatch,
  getBatch,
  latestBatch,
  listBatchItems,
  listBatches,
  setBatchItemState,
  setBatchStatus,
  type BatchItem,
} from "../db/repositories/batches.js";
import { appendEvent } from "../db/repositories/events.js";
import { applicationCountsByCompany, getEvaluation, getJob, listQueue } from "../db/repositories/jobs.js";
import { listActiveRules } from "../db/repositories/rules.js";
import { prepareApplicationFor, type PreparedApplication } from "../drafting/prepare.js";
import { autoFillableFields } from "../drafting/personal.js";
import { answerOwner, type AnswerOwner } from "../drafting/answerOwner.js";
import { submissionGuard } from "../submission/authorise.js";
import { handOff } from "../submission/handoff.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";
import { logger } from "../util/logger.js";
import { handler, ok } from "./helpers.js";
import { askPerson, batchQuestion, checkBatchManifest, packetFor, recordBatchApproval } from "../submission/approvals.js";

/**
 * Batch operations.
 *
 * Running a campaign one job at a time does not scale to a hundred
 * applications, but volume must not erode the approval boundary. The batch
 * tools therefore keep every per-application guard and add one more: approval
 * binds to a manifest hash covering the whole set, so a batch cannot grow or
 * change between review and submission.
 */

const FilterShape = {
  tiers: z.array(z.enum(["A", "B", "C"])).optional().describe("Quality tiers to include. Defaults to A and B."),
  trackIds: z.array(z.string()).optional().describe("Campaign track ids to include."),
  locationClasses: z
    .array(LocationClassSchema)
    .optional(),
  companies: z.array(z.string()).optional(),
  minScore: z.number().optional(),
  minCompensation: z.number().optional().describe("Minimum annualized top-of-range pay in the campaign currency."),
  allowUnknownCompensation: z.boolean().optional().describe("Include postings that publish no pay. Default false."),
  limit: z.number().int().positive().max(300).optional(),
};

type FilterArgs = {
  tiers?: string[];
  trackIds?: string[];
  locationClasses?: string[];
  companies?: string[];
  minScore?: number;
  minCompensation?: number;
  allowUnknownCompensation?: boolean;
  limit?: number;
};


/**
 * The batch's own next step. Blocked applications used to be described as
 * needing "a human decision", which sent the agent to the person with
 * questions it could answer itself; most are essays and profile facts.
 */
function prepareBatchNextStep(
  ready: number,
  questions: ReadonlyArray<{ who: AnswerOwner }>,
  manifestHash: string,
): string {
  const agent = questions.filter((question) => question.who === "agent").length;
  const person = questions.length - agent;
  const unblock = [
    agent > 0
      ? `answer the ${agent} recurring question${agent === 1 ? "" : "s"} marked who=agent yourself from the profile and match report with set_application_content`
      : "",
    person > 0
      ? `ask the person the ${person} marked who=person in one grouped message, and store each standing answer so it is not asked again`
      : "",
  ].filter((step) => step.length > 0);
  const approve = `call approve_batch with manifestHash ${manifestHash}, which asks the person once for the whole set`;
  if (unblock.length === 0) {
    return ready === 0 ? "Nothing is ready yet: see preview_batch for why." : `Check preview_batch, then ${approve}.`;
  }
  const unblockText = `To unblock the rest, ${unblock.join(", and ")}.`;
  return ready === 0
    ? `Nothing is ready yet. ${unblockText} Then run prepare_batch again.`
    : `${unblockText} For the ${ready} ready now, ${approve}.`;
}

export function registerBatchTools(server: McpServer): void {
  server.registerTool(
    "prepare_batch",
    {
      title: "Prepare many applications at once",
      description:
        "Selects queued jobs matching a filter and prepares an application packet for each, using the same drafting and validation as the single-job path. Creates local drafts and a batch manifest; nothing is sent. Applications whose questions still need a human decision are marked needs_human and excluded from batch approval. The campaign's submission.maxBatchSize is a hard ceiling, so a larger limit is silently reduced to it.",
      inputSchema: FilterShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler(async (args: FilterArgs) => {
      const workspace = getWorkspace();
      const tiers = args.tiers ?? ["A", "B"];
      const maxBatchSize = workspace.campaign.submission.maxBatchSize;
      const limit = Math.min(args.limit ?? maxBatchSize, maxBatchSize);

      const queue = listQueue(workspace.db, {
        minScore: args.minScore ?? 0,
        tiers,
        trackIds: args.trackIds,
        locationClasses: args.locationClasses,
        companies: args.companies,
        minCompensation: args.minCompensation,
        allowUnknownCompensation: args.allowUnknownCompensation ?? false,
        fx: workspace.campaign.compensation.fx,
        maxPerCompany: workspace.campaign.submission.maxPerCompany,
        limit,
      });

      if (queue.length === 0) {
        throw new AppError(
          "empty_selection",
          "no queued jobs match that filter. Run discover_jobs, or relax the tier, score or compensation constraints.",
        );
      }

      const batchId = newId("batch");
      const items: BatchItem[] = [];
      const failures: Array<{ jobId: string; error: string }> = [];
      const preparedRecords: Array<Pick<PreparedApplication, "outstanding">> = [];

      for (const entry of queue) {
        try {
          const prepared = await prepareApplicationFor(
            workspace.db,
            entry.job,
            entry.evaluation,
            workspace.profile,
            workspace.campaign,
          );
          preparedRecords.push({ outstanding: prepared.outstanding });
          const blocked = prepared.application.status === "needs_human";
          // Keep each reason whole; truncating the joined string would split a
          // category mid-word and corrupt the grouped counts below.
          const reasons = [
            ...(prepared.resumeCheck.ok ? [] : [`resume: ${prepared.resumeCheck.reason}`]),
            ...prepared.outstanding.map((question) => `${question.category}: ${question.label.slice(0, 70)}`),
          ];
          items.push({
            batchId,
            applicationId: prepared.application.id,
            jobId: entry.job.id,
            packetHash: prepared.application.packetHash,
            state: blocked ? "needs_human" : "ready",
            detail: blocked ? reasons.slice(0, 8).join(" | ") : "",
          });
        } catch (error) {
          failures.push({ jobId: entry.job.id, error: toErrorMessage(error) });
          logger.warn("batch prepare failed", { jobId: entry.job.id, error: toErrorMessage(error) });
        }
      }

      const ready = items.filter((item) => item.state === "ready");
      const manifestHash = computeManifestHash(ready);

      createBatch(
        workspace.db,
        {
          id: batchId,
          createdAt: nowIso(),
          filter: { ...args, tiers },
          manifestHash,
          status: "prepared",
          approvedAt: null,
          note: "",
        },
        items,
      );
      appendEvent(workspace.db, "batch.prepared", batchId, { selected: queue.length, ready: ready.length });

      // Group the outstanding questions so one decision can clear many
      // applications instead of the same question being answered repeatedly.
      const blockedItems = items.filter((item) => item.state === "needs_human");
      const reasonCounts = blockedItems.reduce<Record<string, number>>((acc, item) => {
        for (const part of item.detail.split(" | ")) {
          const key = part.split(":")[0]?.trim() ?? "unknown";
          if (key.length > 0) acc[key] = (acc[key] ?? 0) + 1;
        }
        return acc;
      }, {});

      // The same question text recurs across employers, so listing it once with
      // its suggestion turns many blocked applications into one decision.
      const questionCounts = new Map<
        string,
        { label: string; category: string; who: AnswerOwner; suggested: string; guidance: string; count: number }
      >();
      for (const prepared of preparedRecords) {
        for (const question of prepared.outstanding) {
          const existing = questionCounts.get(question.label);
          if (existing) existing.count += 1;
          else
            questionCounts.set(question.label, {
              label: question.label,
              category: question.category,
              who: question.who,
              suggested: question.suggested,
              guidance: question.guidance,
              count: 1,
            });
        }
      }
      const recurringQuestions = [...questionCounts.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 15);

      return ok({
        batchId,
        selected: queue.length,
        prepared: items.length,
        readyToApprove: ready.length,
        needsHuman: blockedItems.length,
        failures,
        manifestHash,
        blockingReasons: reasonCounts,
        recurringQuestions,
        autoFilledPersonalFields: autoFillableFields(workspace.profile),
        companies: [...new Set(queue.map((entry) => entry.job.companyName))],
        nextStep: prepareBatchNextStep(ready.length, recurringQuestions, manifestHash),
      });
    }),
  );

  server.registerTool(
    "preview_batch",
    {
      title: "Review a prepared batch",
      description:
        "Lists every application in a batch with its company, role, resume variant and readiness, plus the grouped questions blocking the rest. Returns the manifest hash required to approve.",
      inputSchema: {
        batchId: z.string().optional().describe("Defaults to the most recent batch."),
        includeReady: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { batchId?: string; includeReady?: boolean }) => {
      const workspace = getWorkspace();
      const batch = args.batchId ? getBatch(workspace.db, args.batchId) : latestBatch(workspace.db);
      if (!batch) throw new AppError("batch_not_found", "no batch found; run prepare_batch first");

      const items = listBatchItems(workspace.db, batch.id);
      const detail = items.map((item) => {
        const job = getJob(workspace.db, item.jobId);
        const application = getApplication(workspace.db, item.applicationId);
        // Carry each outstanding question with its suggestion, so one review
        // pass has everything needed to answer without reopening each job.
        const outstanding = (application?.answers ?? [])
          .filter((answer) => answer.requiresHuman)
          .map((answer) => ({
            key: answer.questionKey,
            label: answer.label,
            category: answer.category,
            who: answerOwner(answer.label, answer.category),
            suggested: answer.answer,
            guidance: answer.guidance,
          }));
        return {
          applicationId: item.applicationId,
          state: item.state,
          company: job?.companyName ?? "unknown",
          title: job?.title ?? "unknown",
          location: job?.locationClass ?? "unknown",
          compensation: job?.compensation?.raw ?? "not published",
          applyUrl: job?.applyUrl ?? "",
          blockedBy: item.detail,
          outstanding,
        };
      });

      const ready = items.filter((item) => item.state === "ready");
      const currentManifest = computeManifestHash(ready);

      return ok({
        batchId: batch.id,
        status: batch.status,
        createdAt: batch.createdAt,
        filter: batch.filter,
        counts: batchSummary(workspace.db, batch.id),
        manifestHash: currentManifest,
        manifestStale: currentManifest !== batch.manifestHash,
        applications: args.includeReady === false ? detail.filter((item) => item.state !== "ready") : detail,
        note: "approve_batch authorizes every 'ready' application in this manifest. Items marked needs_human are excluded until their outstanding questions are answered: write the ones marked who=agent yourself with set_application_content, and ask the person the who=person ones in one grouped message.",
      });
    }),
  );

  server.registerTool(
    "approve_batch",
    {
      title: "Ask the person to approve every ready application in a batch",
      description:
        "Shows the person the batch's applications and records their answer for each ready one: the decision is theirs, asked through the client's approval dialog, never the model's. Requires the current manifest hash and the exact count being approved, so approval cannot silently cover more applications than were reviewed.",
      inputSchema: {
        batchId: z.string().min(1),
        manifestHash: z.string().min(8).describe("From preview_batch. Binds approval to this exact set of packets."),
        expectedCount: z.number().int().positive().describe("Number of applications you intend to approve."),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: { batchId: string; manifestHash: string; expectedCount: number; note?: string }) => {
      checkBatchManifest(args.batchId, args.manifestHash, args.expectedCount);
      const yes = await askPerson(
        server,
        batchQuestion(args.batchId),
        `--batch ${args.batchId} ${args.manifestHash} ${args.expectedCount}`,
      );
      if (!yes) {
        return ok({
          batchId: args.batchId,
          approved: 0,
          nextStep: "The person did not approve this batch. Ask what to change; nothing was recorded.",
        });
      }
      return ok(recordBatchApproval(args.batchId, args.manifestHash, args.expectedCount, args.note ?? ""));
    }),
  );

  server.registerTool(
    "submit_batch",
    {
      title: "Hand over the next application of an approved batch",
      description:
        "Runs every per-application guard over the batch's ready applications and hands you the first one allowed now, exactly as submit_application does. Send it with your browser, call record_submission, then call submit_batch again for the next. Pass skip with the ids you could not send this time (a CAPTCHA the person has not solved yet, for example).",
      inputSchema: {
        batchId: z.string().min(1),
        skip: z.array(z.string()).optional().describe("Application ids to pass over in this call."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: { batchId: string; skip?: string[] }) => {
      const workspace = getWorkspace();
      const batch = getBatch(workspace.db, args.batchId);
      if (!batch) throw new AppError("batch_not_found", `no batch ${args.batchId}`);
      // A batch nobody approved can still hold applications standing rules
      // cover; each one is checked against them below, and the rest wait.
      const byRulesOnly = batch.status === "prepared" && listActiveRules(workspace.db).length > 0;
      if (batch.status !== "approved" && batch.status !== "submitting" && !byRulesOnly) {
        throw new AppError("batch_not_approved", `batch status is "${batch.status}"; approve it before submitting`);
      }
      const skip = new Set(args.skip ?? []);
      const ready = listBatchItems(workspace.db, batch.id, "ready");
      if (ready.length === 0) {
        setBatchStatus(workspace.db, batch.id, "completed");
        return ok({ batchId: batch.id, remaining: 0, nextStep: "Every application in the batch is done. Track responses with record_outcome." });
      }

      const held: Array<{ applicationId: string; company: string; outcome: string; detail: string; waitSeconds?: number }> = [];
      for (const item of ready) {
        if (skip.has(item.applicationId)) continue;
        const { application, job, packet, currentHash } = packetFor(item.applicationId);
        const guard = submissionGuard(workspace, application, job, currentHash);
        if (guard.allowed) {
          if (batch.status !== "submitting") setBatchStatus(workspace.db, batch.id, "submitting");
          return ok({
            batchId: batch.id,
            remaining: ready.length,
            next: handOff(workspace, application, job, packet, guard, batch.id),
            ...(held.length > 0 ? { held } : {}),
          });
        }
        const waits =
          guard.code === "pacing" || guard.code === "daily_limit_reached" || guard.deferrable ||
          (byRulesOnly && (guard.code === "not_approved" || guard.code === "rules_not_matched"));
        if (!waits) {
          setBatchItemState(workspace.db, batch.id, item.applicationId, "failed", guard.reason);
          appendEvent(workspace.db, "submission.blocked", application.id, { code: guard.code, batchId: batch.id });
        }
        held.push({
          applicationId: item.applicationId,
          company: job.companyName,
          outcome: waits ? "waiting" : "blocked",
          detail: guard.reason,
          ...(guard.waitSeconds ? { waitSeconds: guard.waitSeconds } : {}),
        });
        // Pacing holds every application alike, so the rest need not be checked.
        if (guard.code === "pacing" || guard.code === "daily_limit_reached") break;
      }
      const pacing = held.find((entry) => entry.waitSeconds);
      return ok({
        batchId: batch.id,
        remaining: listBatchItems(workspace.db, batch.id, "ready").length,
        held,
        nextStep: pacing
          ? `Pacing: wait ${pacing.waitSeconds}s, then call submit_batch again.`
          : "Nothing can be sent right now; each entry in held says why.",
      });
    }),
  );

  server.registerTool(
    "list_batches",
    {
      title: "List prepared batches",
      description: "Recent batches with their status and per-state counts.",
      inputSchema: { limit: z.number().int().positive().max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { limit?: number }) => {
      const workspace = getWorkspace();
      return ok({
        batches: listBatches(workspace.db, args.limit ?? 10).map((batch) => ({
          batchId: batch.id,
          status: batch.status,
          createdAt: batch.createdAt,
          approvedAt: batch.approvedAt,
          counts: batchSummary(workspace.db, batch.id),
          filter: batch.filter,
        })),
      });
    }),
  );
}
