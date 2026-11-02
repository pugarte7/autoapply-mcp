import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrowserContextOptions, Route } from "playwright";
import { runApplicationForm, type BrowserRunOptions, type BrowserRunResult } from "../src/submission/browser.js";
import { closeAllGateSessions, gateSessionFor, runHoldingGates } from "../src/submission/sessions.js";
import type { DraftAnswer } from "../src/domain/job.js";
import type { SubmissionPacket } from "../src/submission/packet.js";
import { makeCampaign } from "./factories.js";

/**
 * The verification-gate hand-off in a real browser. A copy of a Greenhouse form
 * accepts the application and then raises the emailed-code gate Stripe's form
 * shows, eight one-character boxes and an unlabelled arrow. The run must stop
 * there with the browser held, take the code from whoever answers, and finish;
 * a wrong code must leave the gate open for another try. Every request is
 * answered here and nothing reaches the network.
 */

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch } }));

const APPLY_URL = "https://job-boards.greenhouse.io/replica/jobs/5001";
const GOOD_CODE = "GOODcod1";

const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

const FORM = html(`
  <form id="application-form" method="post" action="/replica/jobs/5001">
    <label for="first_name">First Name*</label><input id="first_name" name="first_name" type="text" required>
    <label for="email">Email*</label><input id="email" name="email" type="email" required>
    <label for="resume">Resume/CV*</label><input id="resume" name="resume" type="file">
    <button type="submit">Submit application</button>
  </form>`);

/** The gate, verbatim in wording from Stripe's form. Only the right code confirms. */
const GATE = html(`
  <main>
    <p>A verification code was sent to alex.prueba@example.com. To submit your application, enter the 8-character code to confirm you're a human.</p>
    <div id="gate">
      <div id="boxes">${Array.from({ length: 8 }, (_, i) => `<input maxlength="1" aria-label="Security code ${i + 1}">`).join("")}</div>
      <button type="button" aria-label="Submit code" onclick="
        const code = Array.from(document.querySelectorAll('#boxes input')).map((box) => box.value).join('');
        window.codesTried = (window.codesTried || []).concat(code);
        if (code === '${GOOD_CODE}') {
          document.body.innerHTML = '<h1>Thank you for applying.</h1><p>Your application has been received.</p>';
        } else {
          document.getElementById('error').textContent = 'Incorrect security code. Please try again.';
        }">&rarr;</button>
    </div>
    <div id="error" role="alert"></div>
  </main>`);

let directory: string;
let resumePath: string;
let posts = 0;
let closed = 0;

async function serve(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === "GET" && `${url.origin}${url.pathname}` === APPLY_URL) {
    return route.fulfill({ contentType: "text/html", body: FORM });
  }
  if (request.method() === "POST" && url.pathname === "/replica/jobs/5001") {
    posts += 1;
    return route.fulfill({ contentType: "text/html", body: GATE });
  }
  return route.fulfill({ status: 404, body: "" });
}

function answer(questionKey: string, label: string, value: string): DraftAnswer {
  return { questionKey, label, answer: value, source: "human", citation: "replica", requiresHuman: false, category: "general", guidance: "" };
}

function packet(id: string): SubmissionPacket {
  return {
    applicationId: id,
    jobId: `job_${id}`,
    company: "Replica",
    jobTitle: "Backend Engineer",
    applyUrl: APPLY_URL,
    resumeId: "backend",
    resumePath,
    coverLetter: "",
    answers: [answer("first_name", "First Name", "Alex"), answer("email", "Email", "alex.prueba@example.com")],
  };
}

function options(extra: Partial<BrowserRunOptions> = {}): BrowserRunOptions {
  return {
    submit: true,
    artifactsDir: directory,
    timeoutMs: 20_000,
    // No mailbox: the agent is the only reader unless a test adds the file.
    verificationInbox: null,
    policy: { ...makeCampaign().submission, allowedAtsDomains: ["job-boards.greenhouse.io"] },
    ...extra,
  };
}

/** Starts a handed-off run, collecting a result that lands after hand-off. */
async function startHeld(id: string, extra: Partial<BrowserRunOptions> = {}, holdMs?: number) {
  const late: BrowserRunResult[] = [];
  const first = await runHoldingGates(
    id,
    { applyUrl: APPLY_URL, ...(holdMs ? { holdMs } : {}) },
    (hooks) => runApplicationForm(packet(id), { ...options(extra), ...hooks }),
    (result) => late.push(result),
  );
  return { first, late };
}

beforeAll(async () => {
  const { chromium } = await vi.importActual<typeof import("playwright")>("playwright");
  launch.mockImplementation(async () => {
    const browser = await chromium.launch({ headless: true });
    return {
      newContext: async (contextOptions?: BrowserContextOptions) => {
        const context = await browser.newContext(contextOptions);
        await context.route("**/*", serve);
        return context;
      },
      close: async () => {
        closed += 1;
        await browser.close();
      },
    };
  });
  directory = mkdtempSync(join(tmpdir(), "autoapply-gate-"));
  resumePath = join(directory, "alex-prueba-cv.pdf");
  writeFileSync(resumePath, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
});

afterEach(async () => {
  await closeAllGateSessions();
  posts = 0;
  closed = 0;
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("handing a verification gate to the agent", () => {
  it("returns awaiting the code with the browser held, then finishes with it", async () => {
    const { first, late } = await startHeld("app_gate_ok");

    expect(first).toMatchObject({
      held: {
        status: "awaiting_code",
        kind: "code",
        prompt: "A verification code was sent to alex.prueba@example.com.",
        sender: expect.stringContaining("greenhouse-mail.io"),
      },
    });
    expect(posts).toBe(1);
    expect(closed).toBe(0);

    const session = gateSessionFor("app_gate_ok")!;
    session.answer(GOOD_CODE);
    const outcome = await session.next();
    expect(outcome).toMatchObject({ state: "settled", result: { status: "submitted", reason: expect.stringContaining("verification code accepted") } });
    expect(late).toHaveLength(1);
    // The form was sent once: the code went to the gate, never through a second submit.
    expect(posts).toBe(1);
    expect(closed).toBe(1);
  }, 120_000);

  it("keeps the gate open after a wrong code and takes the right one", async () => {
    await startHeld("app_gate_wrong");
    const session = gateSessionFor("app_gate_wrong")!;

    session.answer("WRONGco1");
    const retry = await session.next();
    expect(retry).toMatchObject({
      state: "awaiting",
      gate: { attempts: 1, refused: expect.stringContaining("Incorrect security code") },
    });
    expect(closed).toBe(0);

    session.answer(GOOD_CODE);
    await expect(session.next()).resolves.toMatchObject({ state: "settled", result: { status: "submitted" } });
    expect(posts).toBe(1);
  }, 120_000);

  it("closes the browser and records the gate as unanswered at the deadline", async () => {
    const { first, late } = await startHeld("app_gate_timeout", {}, 1_500);
    expect(first).toMatchObject({ held: { status: "awaiting_code" } });

    await vi.waitFor(() => expect(late).toHaveLength(1), { timeout: 20_000, interval: 200 });
    expect(late[0]).toMatchObject({ status: "aborted", reason: expect.stringContaining("no code was supplied before the gate's deadline") });
    expect(closed).toBe(1);
    expect(gateSessionFor("app_gate_timeout")).toBeUndefined();
  }, 120_000);

  it("lets the code file answer first while the gate is handed off", async () => {
    const codeFilePath = join(directory, "app_gate_file.code");
    const { first, late } = await startHeld("app_gate_file", { codeWaitMs: 60_000, codeFilePath });
    expect(first).toMatchObject({ held: { status: "awaiting_code" } });

    writeFileSync(codeFilePath, `${GOOD_CODE}\n`);
    await vi.waitFor(() => expect(late).toHaveLength(1), { timeout: 30_000, interval: 200 });
    expect(late[0]).toMatchObject({ status: "submitted" });
  }, 120_000);

  it("still blocks and gives up in wait mode, as before", async () => {
    const result = await runApplicationForm(packet("app_gate_wait"), options());
    expect(result).toMatchObject({ status: "aborted", reason: expect.stringContaining("re-run with waitForCodeSeconds") });
    expect(closed).toBe(1);
  }, 120_000);
});
