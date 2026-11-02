#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getWorkspace, type Workspace } from "../config/load.js";
import { getApplication, listApplications } from "../db/repositories/applications.js";
import { computeManifestHash, createBatch, type BatchItem } from "../db/repositories/batches.js";
import { appendEvent } from "../db/repositories/events.js";
import { getEvaluation, getJob, listQueue } from "../db/repositories/jobs.js";
import { listActiveRules, type StandingRulesRecord } from "../db/repositories/rules.js";
import type { Application, Job } from "../domain/job.js";
import { createServer } from "../server.js";
import { packetFor } from "../submission/approvals.js";
import { submissionGuard } from "../submission/authorise.js";
import { jobMismatch, waitingOn } from "../submission/standingRules.js";
import { newId, nowIso } from "../util/hash.js";
import { toErrorMessage } from "../util/errors.js";

/**
 * The unattended daily run, for launchd or cron:
 *
 *   node dist/cli/daily.js [--dry-run] [--no-notify] [--max-prepare <n>]
 *
 * No model is involved. It discovers jobs, prepares applications for queued
 * jobs the active standing rules cover, sends the ones that are complete and
 * rules-authorised in auto mode, and writes a digest of what was sent and what
 * waits for the agent or the person.
 *
 * It drives the server's own tools through an in-process client, so it runs
 * exactly the guards an agent's calls run. That client offers no approval
 * dialog, so nothing in this run can approve anything: an application goes
 * out only when rules the person already approved cover it.
 */

export type DailyOptions = { dryRun?: boolean; notify?: boolean; maxPrepare?: number; now?: Date };

type Line = { company: string; title: string; detail: string };

export type DailyReport = {
  date: string;
  rules: string[];
  discovery: string;
  sent: Line[];
  ready: Line[];
  agent: Line[];
  person: Array<{ label: string; category: string; count: number; companies: string[] }>;
  gates: Line[];
  held: Line[];
  failures: Line[];
  digestPath: string;
};

const GATE = /anti-bot|captcha|challenge|verification|one-time code|\bcode\b/i;

function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // No capabilities: no elicitation, so no tool can ask for or record an approval.
  const client = new Client({ name: "autoapply-daily", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result.content as Array<{ text?: string }>) ?? []).map((entry) => entry.text ?? "").join("\n");
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { ok: result.isError !== true, data, text };
}

function coveredBy(rules: readonly StandingRulesRecord[], workspace: Workspace, job: Job): boolean {
  const evaluation = getEvaluation(workspace.db, job.id);
  return rules.some((record) => jobMismatch(record.rules, job, evaluation) === null);
}

/** Queued jobs, best first, that at least one rule set covers. */
function candidateJobs(workspace: Workspace, rules: readonly StandingRulesRecord[], limit: number): Job[] {
  const seen = new Map<string, Job>();
  for (const record of rules) {
    const queue = listQueue(workspace.db, {
      tiers: record.rules.tiers,
      minScore: record.rules.minScore ?? 0,
      trackIds: record.rules.tracks,
      companies: record.rules.companies,
      maxPerCompany: workspace.campaign.submission.maxPerCompany,
      limit,
    });
    for (const { job } of queue) {
      if (seen.size >= limit) break;
      if (!seen.has(job.id) && coveredBy([record], workspace, job)) seen.set(job.id, job);
    }
  }
  return [...seen.values()];
}

function lineFor(job: Job, detail: string): Line {
  return { company: job.companyName, title: job.title, detail };
}

/** The run sends in auto mode; an assisted campaign only gets the report. */
function runMode(workspace: Workspace): "assisted" | "auto" {
  return workspace.campaign.submission.mode === "assisted" ? "assisted" : "auto";
}

/** Sorts one application into what the digest reports about it. */
function classify(workspace: Workspace, application: Application, job: Job, report: DailyReport, ready: Application[]): void {
  const waiting = waitingOn(application, workspace.campaign);
  if (waiting.person.length > 0 || waiting.agent.length > 0) {
    if (waiting.agent.length > 0) report.agent.push(lineFor(job, waiting.agent.map((answer) => answer.label).join("; ")));
    for (const answer of waiting.person) {
      const entry = report.person.find((item) => item.label === answer.label);
      if (!entry) report.person.push({ label: answer.label, category: answer.category, count: 1, companies: [job.companyName] });
      else {
        entry.count += 1;
        if (!entry.companies.includes(job.companyName)) entry.companies.push(job.companyName);
      }
    }
    return;
  }
  const guard = submissionGuard(workspace, application, job, packetFor(application.id).currentHash, runMode(workspace));
  if (!(guard.allowed || guard.deferrable || guard.code === "pacing" || guard.code === "daily_limit_reached")) {
    report.held.push(lineFor(job, `${guard.code}: ${guard.reason}`));
    return;
  }
  // needs_human with nothing left to answer means an earlier run stopped at
  // the form: a CAPTCHA, a code or a field it could not fill. Sending it again
  // every morning would meet the same wall.
  if (application.status === "needs_human") {
    const last = application.notes.trim().split("\n").at(-1) ?? "";
    (GATE.test(last) ? report.gates : report.held).push(lineFor(job, last || "stopped in an earlier run"));
    return;
  }
  ready.push(application);
}

function section(title: string, lines: readonly Line[], empty: string): string[] {
  return [
    `## ${title}`,
    "",
    ...(lines.length === 0 ? [empty] : lines.map((line) => `- ${line.company}: ${line.title}${line.detail ? ` (${line.detail})` : ""}`)),
    "",
  ];
}

export function renderDigest(report: DailyReport): string {
  const person = [...report.person].sort((a, b) => b.count - a.count);
  return [
    `# autoapply daily, ${report.date}`,
    "",
    `Rules: ${report.rules.length > 0 ? report.rules.join(", ") : "none active, so nothing could be sent"}`,
    `Discovery: ${report.discovery}`,
    "",
    ...section("Sent", report.sent, "Nothing was sent."),
    ...section("Ready, not sent this run", report.ready, "None."),
    ...section("Waiting for the agent to draft", report.agent, "None."),
    "## Waiting for you",
    "",
    ...(person.length === 0
      ? ["None."]
      : [
          "Record a standing answer in profile.answers and every application asking it clears at once.",
          "",
          ...person.map((item) => `- ${item.label} [${item.category}], ${item.count} application(s): ${item.companies.join(", ")}`),
        ]),
    "",
    ...section("CAPTCHA and code gates", report.gates, "None."),
    ...section("Held back", report.held, "None."),
    ...section("Failures", report.failures, "None."),
  ].join("\n");
}

function notify(report: DailyReport): void {
  if (process.platform !== "darwin") return;
  const waiting = report.person.reduce((sum, item) => sum + item.count, 0);
  const message = `Sent ${report.sent.length}, ready ${report.ready.length}, for the agent ${report.agent.length}, for you ${waiting}, gates ${report.gates.length}`;
  const script = `display notification ${JSON.stringify(message)} with title "autoapply daily"`;
  execFile("osascript", ["-e", script], () => undefined);
}

export async function runDaily(options: DailyOptions = {}): Promise<DailyReport> {
  const now = options.now ?? new Date();
  const workspace = getWorkspace();
  const rules = listActiveRules(workspace.db, now);
  const report: DailyReport = {
    date: localDate(now),
    rules: rules.map((record) => `${record.id} (until ${record.expiresAt})`),
    discovery: "",
    sent: [],
    ready: [],
    agent: [],
    person: [],
    gates: [],
    held: [],
    failures: [],
    digestPath: join(workspace.paths.artifacts, "digests", `${localDate(now)}.md`),
  };

  const client = await connect();
  try {
    const discovered = await call(client, "discover_jobs", { includeIssues: false });
    report.discovery = discovered.ok
      ? `${discovered.data?.postingsFetched ?? 0} postings fetched, ${discovered.data?.newPostings ?? 0} new`
      : `failed: ${discovered.text}`;

    if (rules.length > 0) {
      const maxPrepare = options.maxPrepare ?? 20;
      for (const job of candidateJobs(workspace, rules, maxPrepare)) {
        const prepared = await call(client, "prepare_application", { jobId: job.id });
        if (!prepared.ok) report.failures.push(lineFor(job, `prepare: ${prepared.text}`));
      }

      // Drafts from earlier days are re-checked too, since the agent or the
      // person may have finished them since. They are not prepared again: that
      // would drop what the agent wrote into them.
      const ready: Application[] = [];
      const open = [...listApplications(workspace.db, "awaiting_approval", 500), ...listApplications(workspace.db, "needs_human", 500)];
      for (const application of open) {
        const job = getJob(workspace.db, application.jobId);
        if (job && coveredBy(rules, workspace, job)) classify(workspace, application, job, report, ready);
      }

      const sendable = !options.dryRun && runMode(workspace) === "auto";
      if (!sendable || ready.length === 0) {
        const why = options.dryRun ? "dry run" : `campaign mode is ${workspace.campaign.submission.mode}`;
        for (const application of ready) report.ready.push(lineFor(getJob(workspace.db, application.jobId)!, why));
      } else {
        await submit(client, workspace, ready, report);
      }
    }
  } finally {
    await client.close();
  }

  appendEvent(workspace.db, "daily.run", "campaign", {
    dryRun: options.dryRun === true,
    sent: report.sent.length,
    ready: report.ready.length,
    gates: report.gates.length,
  });
  mkdirSync(join(workspace.paths.artifacts, "digests"), { recursive: true });
  writeFileSync(report.digestPath, renderDigest(report));
  if (options.notify !== false) notify(report);
  return report;
}

/** Sends the ready set through submit_batch, which re-runs every guard on each one. */
async function submit(client: Client, workspace: Workspace, ready: readonly Application[], report: DailyReport): Promise<void> {
  const batchId = newId("batch");
  const items: BatchItem[] = ready.map((application) => ({
    batchId,
    applicationId: application.id,
    jobId: application.jobId,
    packetHash: application.packetHash,
    state: "ready",
    detail: "",
  }));
  createBatch(
    workspace.db,
    { id: batchId, createdAt: nowIso(), filter: { daily: true }, manifestHash: computeManifestHash(items), status: "prepared", approvedAt: null, note: "daily run" },
    items,
  );
  const run = await call(client, "submit_batch", { batchId, mode: "auto", headless: true });
  if (!run.ok) {
    report.failures.push({ company: "", title: "submit_batch", detail: run.text });
    return;
  }
  for (const result of run.data?.results ?? []) {
    const application = getApplication(workspace.db, String(result.applicationId));
    const job = application ? getJob(workspace.db, application.jobId) : null;
    const line = job ? lineFor(job, String(result.detail ?? "")) : { company: String(result.company ?? ""), title: "", detail: String(result.detail ?? "") };
    if (result.outcome === "submitted") report.sent.push({ ...line, detail: "" });
    else if (result.outcome === "deferred" || result.outcome === "awaiting_approval") report.ready.push(line);
    else if (GATE.test(line.detail)) report.gates.push(line);
    else if (result.outcome === "failed") report.failures.push(line);
    else report.held.push(line);
  }
}

function parseArgs(argv: string[]): DailyOptions {
  const options: DailyOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-notify") options.notify = false;
    else if (arg === "--max-prepare") options.maxPrepare = Number(argv[(index += 1)]);
    else throw new Error(`unknown argument ${arg}\nusage: daily.js [--dry-run] [--no-notify] [--max-prepare <n>]`);
  }
  if (options.maxPrepare !== undefined && !(options.maxPrepare > 0)) throw new Error("--max-prepare needs a positive number");
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => runDaily(parseArgs(process.argv.slice(2))))
    .then(
      (report) => {
        // This is a CLI, so writing to stdout is correct here.
        console.log(report.digestPath);
        process.exit(0);
      },
      (error: unknown) => {
        console.error(toErrorMessage(error));
        process.exit(1);
      },
    );
}
