import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { resetWorkspaceCache } from "../src/config/load.js";
import { ASKS_PERSON, person } from "./person.js";
import { makeRulesHome, stubBoard, submittedRun } from "./rulesHome.js";

const runApplicationForm = vi.hoisted(() => vi.fn());
vi.mock("../src/submission/browser.js", async (original) => ({
  ...(await original<typeof import("../src/submission/browser.js")>()),
  runApplicationForm,
}));

/** Standing rules end to end: the person approves them once, matching packets go out. */

let home: string;
let withDialog: Client;
let withoutDialog: Client;
let personSays = true;
let shown: string[] = [];

async function connect(options?: typeof ASKS_PERSON): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "rules-test", version: "1.0.0" }, options);
  if (options) shown = person(client, () => personSays).shown;
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result.content as Array<{ text: string }>) ?? []).map((entry) => entry.text).join("\n");
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(text);
  } catch {
    // Errors come back as text.
  }
  return { isError: result.isError === true, text, data };
}

const RULES = { tiers: ["A", "B"], maxPerDay: 3, maxPerRun: 2 };

beforeAll(async () => {
  home = makeRulesHome("auto");
  withDialog = await connect(ASKS_PERSON);
  withoutDialog = await connect();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  resetWorkspaceCache();
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("standing rules tools", () => {
  it("need the person: without a dialog the agent gets their terminal command, not an approval", async () => {
    const result = await call(withoutDialog, "approve_rules", RULES);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("person_approval_needed");
    expect(result.text).toMatch(/cli\/approve\.js rules rules_\w+ [0-9a-f]{64}/);
    const listed = await call(withoutDialog, "list_rules");
    expect(listed.data.rules[0].status).toBe("proposed");
  });

  it("record nothing when the person says no", async () => {
    personSays = false;
    const result = await call(withDialog, "approve_rules", RULES);
    personSays = true;
    expect(result.data.approved).toBe(false);
    const listed = await call(withDialog, "list_rules");
    expect(listed.data.rules[0]).toMatchObject({ rulesId: result.data.rulesId, status: "revoked", approvedAt: null });
  });

  it("refuse an unprepared batch while no rules are active", async () => {
    stubBoard(3);
    await call(withDialog, "discover_jobs");
    const prepared = await call(withDialog, "prepare_batch", { tiers: ["A", "B"] });
    expect(prepared.data.readyToApprove).toBe(3);
    const result = await call(withDialog, "submit_batch", { batchId: prepared.data.batchId, mode: "auto" });
    expect(result.text).toContain("batch_not_approved");
  });

  it("send matching packets once approved, within the per-run cap, and audit which rules did it", async () => {
    runApplicationForm.mockResolvedValue(submittedRun());
    const approved = await call(withDialog, "approve_rules", RULES);
    expect(approved.data).toMatchObject({ approvedVia: "dialog" });
    expect(shown.at(-1)).toContain("2 per run");
    expect(shown.at(-1)).toContain("work-authorization");
    const rulesId = String(approved.data.rulesId);

    const batch = (await call(withDialog, "list_batches")).data.batches[0];
    const run = await call(withDialog, "submit_batch", { batchId: batch.batchId, mode: "auto" });
    expect(run.isError).toBe(false);
    expect(run.data.submitted).toBe(2);
    expect(run.data.results.map((entry: { outcome: string }) => entry.outcome)).toContain("deferred");
    expect(runApplicationForm).toHaveBeenCalledTimes(2);

    const events = (await call(withDialog, "audit_log", { type: "submission.submitted" })).data.events;
    expect(events).toHaveLength(2);
    for (const event of events) expect(JSON.parse(event.payload)).toMatchObject({ authorisedBy: "rules", rulesId });

    const listed = (await call(withDialog, "list_rules")).data.rules.find((entry: { rulesId: string }) => entry.rulesId === rulesId);
    expect(listed).toMatchObject({ status: "active", usedToday: 2 });
  });

  it("stop at the rules' daily cap", async () => {
    const batch = (await call(withDialog, "list_batches")).data.batches[0];
    // maxPerDay is 3 and 2 went out: the third goes, and a fourth waits for tomorrow.
    const run = await call(withDialog, "submit_batch", { batchId: batch.batchId, mode: "auto" });
    expect(run.data.submitted).toBe(1);

    stubBoard(4);
    await call(withDialog, "discover_jobs");
    const prepared = await call(withDialog, "prepare_batch", { tiers: ["A", "B"] });
    expect(prepared.data.readyToApprove).toBe(1);
    const capped = await call(withDialog, "submit_batch", { batchId: prepared.data.batchId, mode: "auto" });
    expect(capped.data.submitted).toBe(0);
    expect(capped.data.results[0]).toMatchObject({ outcome: "deferred" });
    expect(capped.data.results[0].detail).toContain("3 a day");
    expect(runApplicationForm).toHaveBeenCalledTimes(3);
  });

  it("end when revoked, with no confirmation", async () => {
    const active = (await call(withoutDialog, "list_rules")).data.rules.find((entry: { status: string }) => entry.status === "active");
    const revoked = await call(withoutDialog, "revoke_rules", { rulesId: active.rulesId });
    expect(revoked.data.status).toBe("revoked");
    expect((await call(withoutDialog, "audit_log", { type: "rules.revoked" })).data.events).toHaveLength(1);

    const batch = (await call(withDialog, "list_batches")).data.batches[0];
    const result = await call(withDialog, "submit_batch", { batchId: batch.batchId, mode: "auto" });
    expect(result.text).toContain("batch_not_approved");
    expect(runApplicationForm).toHaveBeenCalledTimes(3);
  });
});
