import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ASKS_PERSON, person } from "./person.js";
import { createServer } from "../src/server.js";
import { getWorkspace, resetWorkspaceCache } from "../src/config/load.js";
import { saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import { runApplicationForm, type BrowserRunResult } from "../src/submission/browser.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

/**
 * submit_batch never passed a code wait or a code file to the browser run, so
 * every batch stopped at the first Greenhouse or Workday verification gate,
 * even with a mailbox configured to read the code. These drive the real tool
 * through an MCP client with the browser mocked and look at what it was given.
 */

const submitted: BrowserRunResult = {
  status: "submitted", reason: "test receipt", filledFields: [], unmatchedRequired: [], unusedAnswers: [],
  screenshotPath: null, finalUrl: "https://job-boards.greenhouse.io/testcorp/confirmation",
  confirmationText: "Your application was received", captchaDetected: false,
};

vi.mock("../src/submission/browser.js", () => ({ runApplicationForm: vi.fn() }));

let home: string;
let client: Client;
let jobCounter = 0;
const campaign = makeCampaign({
  submission: { mode: "auto", dailyLimit: null, maxPerCompany: 50, minDelaySeconds: 0, allowedCompanies: ["Test Corp"] },
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  const content = response.content;
  if (!Array.isArray(content)) throw new Error("Expected MCP text content");
  const text = content.find((item) => item.type === "text");
  if (!text || typeof text.text !== "string") throw new Error("Missing MCP text result");
  return JSON.parse(text.text);
}

/** Stores `count` fresh accepted jobs and returns an approved batch over them. */
async function approvedBatch(count: number): Promise<string> {
  const { db } = getWorkspace();
  const now = new Date().toISOString();
  const jobs = Array.from({ length: count }, () => {
    jobCounter += 1;
    return makeJob({
      id: `gate_${jobCounter}`, fingerprint: `gate_${jobCounter}`, title: `Senior Security Engineer ${jobCounter}`,
      externalId: String(jobCounter + 100), applyUrl: `https://job-boards.greenhouse.io/testcorp/jobs/${jobCounter + 100}`,
    });
  });
  upsertJobs(db, jobs);
  for (const job of jobs) {
    saveEvaluation(db, { jobId: job.id, decision: "accept", gate: { passed: true, rule: null, reason: "", evidence: "" },
      trackId: "ai-security", score: 90, tier: "A", components: [], flags: [], evaluatedAt: now });
  }
  const prepared = await call("prepare_batch", { tiers: ["A"], limit: count });
  const preview = await call("preview_batch", { batchId: prepared.batchId });
  await call("approve_batch", { batchId: prepared.batchId, manifestHash: preview.manifestHash, expectedCount: prepared.readyToApprove });
  return prepared.batchId;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "autoapply-batch-gate-"));
  vi.stubEnv("AUTOAPPLY_HOME", home);
  vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0");
  vi.stubEnv("AUTOAPPLY_LOG_LEVEL", "error");
  for (const key of ["AUTOAPPLY_PROFILE", "AUTOAPPLY_CAMPAIGN", "AUTOAPPLY_COMPANIES", "AUTOAPPLY_DB", "AUTOAPPLY_ATS_PASSWORD"]) {
    vi.stubEnv(key, undefined);
  }
  writeFileSync(join(home, "profile.json"), JSON.stringify(makeProfile()));
  writeFileSync(join(home, "campaign.json"), JSON.stringify(campaign));
  writeFileSync(join(home, "companies.json"), JSON.stringify({ version: 1, companies: [] }));
  resetWorkspaceCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    questions: [
      { label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text" }] },
      { label: "Email", required: true, fields: [{ name: "email", type: "input_text" }] },
    ],
    compliance: [],
  }), { headers: { "content-type": "application/json" } })));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "batch-gate-test", version: "1.0.0" }, ASKS_PERSON);
  person(client);
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
});

beforeEach(() => {
  vi.mocked(runApplicationForm).mockReset();
  vi.mocked(runApplicationForm).mockResolvedValue(submitted);
  vi.stubEnv("AUTOAPPLY_OTP_IMAP_USER", undefined);
  vi.stubEnv("AUTOAPPLY_OTP_IMAP_PASSWORD", undefined);
});

afterAll(async () => {
  await client?.close();
  resetWorkspaceCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

it("waits five minutes at a code gate when a verification inbox is configured, with a code file per application", async () => {
  vi.stubEnv("AUTOAPPLY_OTP_IMAP_USER", "codes@example.com");
  vi.stubEnv("AUTOAPPLY_OTP_IMAP_PASSWORD", "not-a-real-app-password");
  const batchId = await approvedBatch(2);
  const result = await call("submit_batch", { batchId, mode: "auto" });
  expect(result.submitted).toBe(2);

  const calls = vi.mocked(runApplicationForm).mock.calls;
  expect(calls).toHaveLength(2);
  const paths = calls.map(([packet, options]) => {
    expect(options.codeWaitMs).toBe(300_000);
    expect(options.codeFilePath).toBe(join(getWorkspace().paths.artifacts, `${packet.applicationId}.code`));
    return options.codeFilePath;
  });
  expect(new Set(paths).size).toBe(2);
});

it("honours an explicit waitForCodeSeconds, and with nothing to read a code holds the gate for the agent", async () => {
  const explicit = await approvedBatch(1);
  await call("submit_batch", { batchId: explicit, mode: "auto", waitForCodeSeconds: 90 });
  expect(vi.mocked(runApplicationForm).mock.calls[0]?.[1].codeWaitMs).toBe(90_000);

  vi.mocked(runApplicationForm).mockClear();
  const unattended = await approvedBatch(1);
  await call("submit_batch", { batchId: unattended, mode: "auto" });
  // No mailbox and no wait asked for: the gate is handed to the agent, held
  // for provide_verification_code rather than abandoned at once.
  const held = vi.mocked(runApplicationForm).mock.calls[0]?.[1];
  expect(held?.codeWaitMs).toBe(900_000);
  expect(held?.gateHandoff).toBeTypeOf("function");
});

it("tells the agent which fields of an aborted run it can answer itself", async () => {
  vi.mocked(runApplicationForm).mockResolvedValue({
    ...submitted,
    status: "aborted",
    reason: "required fields unmatched",
    unmatchedRequired: ["Which programming languages do you use every day?", "Will you require visa sponsorship?"],
  });
  const batchId = await approvedBatch(1);
  const result = await call("submit_batch", { batchId, mode: "auto" });
  const [item] = result.results;
  expect(item.outcome).toBe("aborted");
  expect(item.fieldsToAnswer).toEqual([
    expect.objectContaining({ label: "Which programming languages do you use every day?", who: "agent" }),
    expect.objectContaining({ label: "Will you require visa sponsorship?", who: "person" }),
  ]);
  expect(item.nextStep).toContain("Answer these yourself");
  expect(item.nextStep).toContain("submit_application");
  expect(result.nextStep).toContain("who=agent");
});
