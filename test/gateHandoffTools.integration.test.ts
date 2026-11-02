import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrowserContextOptions, Route } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ASKS_PERSON, person } from "./person.js";
import { createServer } from "../src/server.js";
import { resetWorkspaceCache } from "../src/config/load.js";
import { closeAllGateSessions } from "../src/submission/sessions.js";
import { fixtureResumePath } from "./factories.js";

/**
 * The hand-off through a real MCP client: submit_application returns
 * awaiting_code with the browser held at a replica Greenhouse gate,
 * provide_verification_code finishes it and the application is recorded as
 * submitted; submit_batch parks each gated application and moves on. The
 * candidate is fictional and every page is served here.
 */

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch } }));

const GOOD_CODE = "GOODcod1";
const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

const form = (path: string) =>
  html(`
  <form id="application-form" method="post" action="${path}">
    <label for="first_name">First Name*</label><input id="first_name" name="first_name" type="text" required>
    <label for="email">Email*</label><input id="email" name="email" type="email" required>
    <label for="resume">Resume/CV*</label><input id="resume" name="resume" type="file">
    <button type="submit">Submit application</button>
  </form>`);

const GATE = html(`
  <p>A verification code was sent to alex@example.com. To submit your application, enter the 8-character code to confirm you're a human.</p>
  <div id="boxes">${Array.from({ length: 8 }, (_, i) => `<input maxlength="1" aria-label="Security code ${i + 1}">`).join("")}</div>
  <button type="button" aria-label="Submit code" onclick="
    const code = Array.from(document.querySelectorAll('#boxes input')).map((box) => box.value).join('');
    if (code === '${GOOD_CODE}') document.body.innerHTML = '<h1>Thank you for applying.</h1><p>Your application has been received.</p>';
    else document.getElementById('error').textContent = 'Incorrect security code. Please try again.';
  ">&rarr;</button>
  <div id="error" role="alert"></div>`);

let posts = 0;

async function serve(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const job = url.host === "job-boards.greenhouse.io" && /^\/acme\/jobs\/\d+$/.test(url.pathname);
  if (job && request.method() === "GET") return route.fulfill({ contentType: "text/html", body: form(url.pathname) });
  if (job && request.method() === "POST") {
    posts += 1;
    return route.fulfill({ contentType: "text/html", body: GATE });
  }
  return route.fulfill({ status: 404, body: "" });
}

const profile = {
  version: 1,
  identity: {
    fullName: "Alex Candidate",
    email: "alex@example.com",
    phone: "555-0100",
    location: { city: "Vancouver", region: "BC", country: "Canada" },
    links: {},
  },
  personal: {
    demographics: {
      gender: { value: "Decline to self-identify", autoFill: true },
      veteranStatus: { value: "I am not a protected veteran", autoFill: true },
    },
  },
  workAuthorization: {
    citizenships: ["Canada"],
    authorizedIn: ["CA"],
    requiresSponsorshipIn: ["US"],
    statement: "Canadian citizen; US roles require employer support for work authorization.",
    alwaysReviewManually: true,
  },
  compensation: { currency: "USD", targetTotal: 300000, minimumTotal: 200000, disclosurePolicy: "decline" },
  resumes: [{ id: "sec", label: "Security", path: fixtureResumePath(), tracks: ["sec"], isDefault: true }],
  skills: [{ name: "Python", level: "strong", tags: [] }],
  facts: [{ id: "f1", statement: "Built security guardrails with policy engines.", tags: ["security", "policy"] }],
  answers: [
    { key: "source", label: "How did you hear about us?", patterns: ["how did you hear"], answer: "Careers page", allowAutoFill: true },
  ],
};

const campaign = {
  version: 1,
  name: "gate-campaign",
  targetApplications: 100,
  tracks: [
    {
      id: "sec",
      label: "Security",
      allocation: 1,
      titleIncludes: ["security engineer"],
      keywords: [
        { term: "security", weight: 3 },
        { term: "policy", weight: 2 },
        { term: "python", weight: 1 },
      ],
      resumeId: "sec",
    },
  ],
  locations: { allow: ["bay-area"], workplaceTypes: ["onsite", "hybrid", "remote", "unknown"] },
  compensation: { currency: "USD", floors: { US: 200000 }, fx: { USD: 1 }, allowUnknown: true, rejectBelowFloor: true },
  scoring: { thresholds: { tierA: 80, tierB: 70, tierC: 60 } },
  submission: { mode: "auto", dailyLimit: 20, minDelaySeconds: 0, maxPerCompany: 10 },
};

const companies = { version: 1, companies: [{ name: "Acme", ats: "greenhouse", board: "acme", tier: "A" }] };

function makeJob(id: number, title: string, payMax: number) {
  return {
    id,
    title,
    first_published: new Date().toISOString(),
    absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    content: "Build security tooling with policy enforcement in Python.",
    location: { name: "San Francisco, CA" },
    pay_input_ranges: [{ min_cents: 20000000, max_cents: payMax, currency_type: "USD", title: "SF" }],
  };
}

const listPayload = {
  jobs: [
    makeJob(1, "Senior Security Engineer, Detection", 30000000),
    makeJob(2, "Senior Security Engineer, Platform", 28000000),
    makeJob(3, "Senior Security Engineer, Identity", 21000000),
  ],
};

const detailPayload = {
  questions: [
    { label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text" }] },
    { label: "Email", required: true, fields: [{ name: "email", type: "input_text" }] },
    { label: "How did you hear about us?", required: false, fields: [{ name: "hear", type: "input_text" }] },
  ],
  compliance: [],
};

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.toString();
      const body = /\/jobs\/\d+/.test(href) ? detailPayload : listPayload;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

let home: string;
let client: Client;

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const content = (result.content as Array<{ type: string; text: string }>) ?? [];
  return { isError: result.isError === true, text: content.map((entry) => entry.text).join("\n") };
}

const parse = (text: string) => JSON.parse(text) as Record<string, any>;

beforeAll(async () => {
  const { chromium } = await vi.importActual<typeof import("playwright")>("playwright");
  launch.mockImplementation(async () => {
    const browser = await chromium.launch({ headless: true });
    return {
      newContext: async (options?: BrowserContextOptions) => {
        const context = await browser.newContext(options);
        await context.route("**/*", serve);
        return context;
      },
      close: () => browser.close(),
    };
  });

  home = mkdtempSync(join(tmpdir(), "autoapply-gate-tools-"));
  writeFileSync(join(home, "profile.json"), JSON.stringify(profile));
  writeFileSync(join(home, "campaign.json"), JSON.stringify(campaign));
  writeFileSync(join(home, "companies.json"), JSON.stringify(companies));
  process.env.AUTOAPPLY_HOME = home;
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  process.env.AUTOAPPLY_LOG_LEVEL = "error";
  for (const key of ["AUTOAPPLY_PROFILE", "AUTOAPPLY_CAMPAIGN", "AUTOAPPLY_COMPANIES", "AUTOAPPLY_DB", "AUTOAPPLY_OTP_IMAP_USER", "AUTOAPPLY_OTP_IMAP_PASSWORD"]) {
    delete process.env[key];
  }
  resetWorkspaceCache();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "gate-test", version: "1.0.0" }, ASKS_PERSON);
  person(client);
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await closeAllGateSessions();
  resetWorkspaceCache();
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("verification gate tools", () => {
  it("says plainly when nothing is held", async () => {
    const missing = await callTool("provide_verification_code", { applicationId: "app_nothing", code: GOOD_CODE });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("is not held at a verification gate");
    expect(parse((await callTool("list_pending_gates")).text)).toMatchObject({ pending: [], finished: [] });
  });

  it("hands the gate to the agent and finishes the submission with its code", async () => {
    stubFetch();
    await callTool("discover_jobs");
    const queue = parse((await callTool("list_queue")).text);
    const job = (queue.jobs as Array<Record<string, string>>).find((entry) => entry.title.endsWith("Identity"))!;
    const prepared = parse((await callTool("prepare_application", { jobId: job.jobId })).text);
    const applicationId = String(prepared.applicationId);
    const preview = (await callTool("preview_application", { applicationId })).text;
    const packetHash = /Packet hash: (\w+)/.exec(preview)?.[1] ?? String(prepared.packetHash);
    expect(parse((await callTool("approve_application", { applicationId, packetHash })).text).status).toBe("approved");

    // No mailbox and no wait asked for, so the gate is handed off by default.
    const held = parse((await callTool("submit_application", { applicationId, mode: "auto" })).text);
    expect(held).toMatchObject({
      applicationId,
      status: "awaiting_code",
      kind: "code",
      sender: expect.stringContaining("greenhouse-mail.io"),
      nextStep: expect.stringContaining("provide_verification_code"),
    });
    expect(held.nextStep).toContain("ask the person once");
    expect(Date.parse(held.emailedAt)).not.toBeNaN();
    expect(posts).toBe(1);

    const pending = parse((await callTool("list_pending_gates")).text);
    expect(pending.pending).toEqual([expect.objectContaining({ applicationId, status: "awaiting_code" })]);

    // A second submit would void the code; it is refused before anything runs.
    const again = await callTool("submit_application", { applicationId, mode: "auto" });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("held at a verification gate");

    const malformed = await callTool("provide_verification_code", { applicationId, code: "GOOD-cod-1!" });
    expect(malformed.isError).toBe(true);
    expect(malformed.text).toContain("does not look like a one-time code");

    const wrong = parse((await callTool("provide_verification_code", { applicationId, code: "WRONGco1" })).text);
    expect(wrong).toMatchObject({ status: "awaiting_code", refused: expect.stringContaining("Incorrect security code") });

    const done = parse((await callTool("provide_verification_code", { applicationId, code: GOOD_CODE })).text);
    expect(done).toMatchObject({ applicationId, status: "submitted", nextStep: expect.stringContaining("record_outcome") });
    expect(posts).toBe(1);

    const applications = parse((await callTool("list_applications")).text).applications as Array<Record<string, unknown>>;
    expect(applications.find((entry) => entry.applicationId === applicationId)).toMatchObject({
      status: "submitted",
    });
    expect(parse((await callTool("list_pending_gates")).text).pending).toEqual([]);
  }, 300_000);

  it("parks each gated application in a batch and carries on", async () => {
    stubFetch();
    posts = 0;
    const prepared = parse((await callTool("prepare_batch", { tiers: ["A", "B"], minCompensation: 250000 })).text);
    expect(prepared.readyToApprove).toBe(2);
    const batchId = String(prepared.batchId);
    const manifestHash = String(parse((await callTool("preview_batch", { batchId })).text).manifestHash);
    expect(parse((await callTool("approve_batch", { batchId, manifestHash, expectedCount: 2 })).text).approved).toBe(2);

    const submitted = parse((await callTool("submit_batch", { batchId, mode: "auto" })).text);
    expect(submitted.submitted).toBe(0);
    expect(submitted.awaitingCode).toHaveLength(2);
    expect(submitted.results.map((entry: Record<string, string>) => entry.outcome)).toEqual(["awaiting_code", "awaiting_code"]);
    expect(submitted.nextStep).toContain("provide_verification_code");
    expect(posts).toBe(2);

    const parkedStates = parse((await callTool("preview_batch", { batchId })).text).applications.map(
      (entry: Record<string, string>) => entry.state,
    );
    expect(parkedStates).toEqual(["awaiting_code", "awaiting_code"]);

    for (const gate of submitted.awaitingCode as Array<Record<string, string>>) {
      const done = parse((await callTool("provide_verification_code", { applicationId: gate.applicationId, code: GOOD_CODE })).text);
      expect(done.status).toBe("submitted");
    }
    const finalStates = parse((await callTool("preview_batch", { batchId })).text).applications.map(
      (entry: Record<string, string>) => entry.state,
    );
    expect(finalStates).toEqual(["submitted", "submitted"]);
  }, 300_000);
});
