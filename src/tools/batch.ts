import { z } from "zod";
import { LocationClassSchema } from "../domain/campaign.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import {
  countSubmittedSince,
  getApplication,
  lastSubmissionAt,
  latestApproval,
  saveApplication,
} from "../db/repositories/applications.js";
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
import { prepareApplicationFor } from "../drafting/prepare.js";
import { autoFillableFields } from "../drafting/personal.js";
import { runApplicationForm } from "../submission/browser.js";
import { mergeDiscoveredQuestions } from "../submission/discoveredQuestions.js";
import { checkSubmissionAllowed, startOfDayIso } from "../submission/guards.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";
import { logger } from "../util/logger.js";
import { personalResolverFor } from "../submission/personalResolver.js";
import { experienceResolverFor } from "../submission/experienceResolver.js";
import { narrativeResolverFor } from "../submission/narrativeResolver.js";
import { isWorkdayUrl } from "../submission/workdayFlow.js";
import { handler, ok } from "./helpers.js";
import { join } from "node:path";
import { recordRunResult } from "../submission/runRecording.js";
import { DEFAULT_GATE_HOLD_MS, runHoldingGates, type GateHooks } from "../submission/sessions.js";
import { awaitingCode, codeDeliveryFor } from "./submission.js";
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


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      const preparedRecords: Array<{ outstanding: Array<{ label: string; category: string; suggested: string; guidance: string }> }> = [];

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
      const questionCounts = new Map<string, { label: string; category: string; suggested: string; guidance: string; count: number }>();
      for (const prepared of preparedRecords) {
        for (const question of prepared.outstanding) {
          const existing = questionCounts.get(question.label);
          if (existing) existing.count += 1;
          else questionCounts.set(question.label, { ...question, count: 1 });
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
        nextStep:
          ready.length === 0
            ? "Every application needs a human decision first. Use preview_batch to see the grouped questions, add answers to profile.answers or profile.personal with autoFill enabled, then run prepare_batch again."
            : `Review with preview_batch, then approve_batch with manifestHash ${manifestHash}.`,
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
        note: "approve_batch authorizes every 'ready' application in this manifest. Items marked needs_human are excluded.",
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
      title: "Submit an approved batch",
      description:
        "Submits approved applications in the batch, re-running all per-application guards and honouring pacing and any configured daily limit. A null submission.dailyLimit disables only the daily ceiling. The campaign's submission.maxBatchSize still caps how many are submitted per run.",
      inputSchema: {
        batchId: z.string().min(1),
        mode: z.enum(["manual", "assisted", "auto"]).default("manual"),
        maxSubmissions: z.number().int().positive().max(200).optional(),
        headless: z.boolean().optional(),
        codeDelivery: z
          .enum(["wait", "handoff"])
          .optional()
          .describe(
            "Auto mode, at an emailed-code or Workday-link gate: 'handoff' parks that application with its browser held (state awaiting_code) and moves on to the next; finish it with provide_verification_code. Same default as submit_application.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    handler(async (args: { batchId: string; mode?: "manual" | "assisted" | "auto"; maxSubmissions?: number; headless?: boolean; codeDelivery?: "wait" | "handoff" }) => {
      const workspace = getWorkspace();
      const batch = getBatch(workspace.db, args.batchId);
      if (!batch) throw new AppError("batch_not_found", `no batch ${args.batchId}`);
      if (batch.status !== "approved" && batch.status !== "submitting") {
        throw new AppError("batch_not_approved", `batch status is "${batch.status}"; approve it before submitting`);
      }

      const mode = args.mode ?? "manual";
      const policy = workspace.campaign.submission;
      const cap = Math.min(
        args.maxSubmissions ?? policy.maxBatchSize,
        policy.maxBatchSize,
        policy.dailyLimit ?? Number.POSITIVE_INFINITY,
      );
      const ready = listBatchItems(workspace.db, batch.id, "ready");

      setBatchStatus(workspace.db, batch.id, "submitting");

      const results: Array<{ applicationId: string; company: string; outcome: string; detail: string }> = [];
      const manualPackets: Array<{ applicationId: string; company: string; title: string; applyUrl: string }> = [];
      const parked: Array<Record<string, unknown>> = [];
      const handoff = mode === "auto" && codeDeliveryFor(args) === "handoff";
      let submitted = 0;

      for (const item of ready) {
        if (submitted >= cap) {
          results.push({ applicationId: item.applicationId, company: "", outcome: "deferred", detail: `cap of ${cap} reached` });
          continue;
        }

        const { application, job, packet, currentHash } = packetFor(item.applicationId);
        const guard = checkSubmissionAllowed({
          application: { ...application, packetHash: currentHash },
          job,
          campaign: workspace.campaign,
          approval: latestApproval(workspace.db, application.id),
          submittedToday: countSubmittedSince(workspace.db, startOfDayIso()),
          companyApplicationCount: applicationCountsByCompany(workspace.db).get(job.companyName.toLowerCase()) ?? 0,
          lastSubmissionAt: lastSubmissionAt(workspace.db),
          requestedMode: mode,
        });

        if (!guard.allowed) {
          if (guard.code === "daily_limit_reached") {
            results.push({ applicationId: item.applicationId, company: job.companyName, outcome: "deferred", detail: guard.reason });
            continue;
          }
          if (guard.code === "pacing" && guard.waitSeconds) {
            await sleep(guard.waitSeconds * 1000);
          } else {
            setBatchItemState(workspace.db, batch.id, item.applicationId, "failed", guard.reason);
            results.push({ applicationId: item.applicationId, company: job.companyName, outcome: "blocked", detail: guard.reason });
            appendEvent(workspace.db, "submission.blocked", application.id, { code: guard.code, batchId: batch.id });
            continue;
          }
        }

        if (mode === "manual") {
          manualPackets.push({
            applicationId: application.id,
            company: job.companyName,
            title: job.title,
            applyUrl: job.applyUrl,
          });
          results.push({ applicationId: application.id, company: job.companyName, outcome: "packet_ready", detail: job.applyUrl });
          continue;
        }

        try {
          const start = (hooks: Partial<GateHooks> = {}) => runApplicationForm(packet, {
            ...hooks,
            submit: mode === "auto",
            headless: mode === "assisted" ? false : args.headless ?? true,
            artifactsDir: workspace.paths.artifacts,
            policy,
            candidateCountry: workspace.profile.identity.location.country,
            answerBank: workspace.profile.answers,
            personalResolver: personalResolverFor(workspace.profile),
            experienceResolver: experienceResolverFor(workspace.profile),
        narrativeResolver: narrativeResolverFor(job, getEvaluation(workspace.db, job.id), workspace.profile, workspace.campaign),
            accountEmail: workspace.profile.identity.email,
            // Workday has no anonymous apply path, so refusing to register a
            // candidate account there is refusing to apply at all.
            allowAccountCreation: mode === "assisted" || isWorkdayUrl(job.applyUrl),
            ...(hooks.gateHandoff ? { codeWaitMs: DEFAULT_GATE_HOLD_MS, codeFilePath: join(workspace.paths.artifacts, `${application.id}.code`) } : {}),
          });
          // A gated application is parked with its browser held, and finishes
          // on its own once provide_verification_code (or the server's mailbox)
          // supplies the code; the batch moves on rather than wait for it.
          const first = handoff
            ? await runHoldingGates(application.id, { applyUrl: job.applyUrl, batchId: batch.id }, start, (late) => {
                recordRunResult(getWorkspace(), { application, job, currentHash, mode, result: late, batchId: batch.id });
                const sent = late.status === "submitted";
                setBatchItemState(getWorkspace().db, batch.id, application.id, sent ? "submitted" : "needs_human", sent ? late.finalUrl : late.reason);
              })
            : { result: await start() };
          if ("held" in first) {
            setBatchItemState(workspace.db, batch.id, application.id, "awaiting_code", first.held.prompt);
            parked.push(awaitingCode(first.held));
            results.push({ applicationId: application.id, company: job.companyName, outcome: "awaiting_code", detail: first.held.prompt });
            // The form was sent, so pacing applies before the next one.
            if (policy.minDelaySeconds > 0) await sleep(policy.minDelaySeconds * 1000);
            continue;
          }
          const run = first.result;

          if (run.status === "submitted") {
            saveApplication(workspace.db, {
              ...application,
              packetHash: currentHash,
              status: "submitted",
              submittedAt: nowIso(),
              submissionMode: mode,
              confirmationRef: run.confirmationText.slice(0, 200),
              artifactPath: run.screenshotPath,
            });
            setBatchItemState(workspace.db, batch.id, item.applicationId, "submitted", run.finalUrl);
            appendEvent(workspace.db, "submission.submitted", application.id, { batchId: batch.id, company: job.companyName });
            submitted += 1;
            results.push({ applicationId: application.id, company: job.companyName, outcome: "submitted", detail: run.finalUrl });
          } else {
            saveApplication(workspace.db, {
              ...application,
              packetHash: currentHash,
              status: "needs_human",
              answers: mergeDiscoveredQuestions(
                application.answers,
                run.unmatchedRequired,
                workspace.profile.answers,
              ),
              notes: `${application.notes}\n[${nowIso()}] ${run.reason}`.trim(),
              artifactPath: run.screenshotPath,
            });
            setBatchItemState(workspace.db, batch.id, item.applicationId, "needs_human", run.reason);
            results.push({ applicationId: application.id, company: job.companyName, outcome: run.status, detail: run.reason });
          }
        } catch (error) {
          const message = toErrorMessage(error);
          // Too many browsers already held at gates: this one has not started,
          // so it stays ready for the next submit_batch.
          if (error instanceof AppError && (error.code === "too_many_gates" || error.code === "gate_pending")) {
            results.push({ applicationId: application.id, company: job.companyName, outcome: "deferred", detail: message });
            continue;
          }
          setBatchItemState(workspace.db, batch.id, item.applicationId, "failed", message);
          results.push({ applicationId: application.id, company: job.companyName, outcome: "failed", detail: message });
        }

        if (policy.minDelaySeconds > 0 && submitted < cap) {
          await sleep(policy.minDelaySeconds * 1000);
        }
      }

      const remaining = listBatchItems(workspace.db, batch.id, "ready").length;
      setBatchStatus(workspace.db, batch.id, remaining === 0 ? "completed" : "approved");
      appendEvent(workspace.db, "batch.submitted", batch.id, { mode, submitted, remaining });

      return ok({
        batchId: batch.id,
        mode,
        submitted,
        remaining,
        results,
        manualPackets: mode === "manual" ? manualPackets : undefined,
        ...(parked.length > 0 ? { awaitingCode: parked } : {}),
        nextStep:
          parked.length > 0
            ? `${parked.length} application(s) are held at a verification gate. For each one in awaitingCode, read the newest email from its sender received after its emailedAt and call provide_verification_code; do not submit them again.`
            : mode === "manual"
            ? "Open each apply URL, submit it, then call record_submission for that application id."
            : remaining > 0
              ? "Approved applications remain. Call submit_batch again when their submission guards allow it."
              : "Batch complete. Track responses with record_outcome.",
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
