import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserContextOptions, Route } from "playwright";
import { runApplicationForm } from "../src/submission/browser.js";
import type { DraftAnswer } from "../src/domain/job.js";
import type { SubmissionPacket } from "../src/submission/packet.js";
import { makeCampaign } from "./factories.js";

/**
 * A CAPTCHA handed to the person, in a real browser, on a local copy of a
 * Lever form. Typing the name raises a visible iframe titled "challenge", the
 * way an hCaptcha or reCAPTCHA puzzle appears, and the page removes it after a
 * delay, standing in for the person solving it. Nothing here solves anything:
 * the run only waits, then carries on to submit. Every request is answered
 * locally and nothing reaches the network.
 *
 * The launcher always starts Chromium headless, since CI has no display. The
 * run is told it is headed, which is what decides whether a challenge can be
 * handed over, so the handoff path is the one exercised.
 */

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch } }));

const APPLY_URL = "https://jobs.lever.co/replica/c4a7c4a7/apply";
const POST_PATH = "/replica/c4a7c4a7/apply";
const CHALLENGE_MS = 2_500;

const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

const FORM = html(`
  <form id="application-form" method="post" action="${POST_PATH}" enctype="multipart/form-data">
    <ul>
      <li class="application-question resume"><label><div class="application-label">Resume/CV<span class="required">✱</span></div>
        <div class="application-field"><input type="file" name="resume"></div></label></li>
      <li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div>
        <div class="application-field"><input type="text" name="name" required></div></label></li>
      <li class="application-question"><label><div class="application-label">Email<span class="required">✱</span></div>
        <div class="application-field"><input type="email" name="email" required></div></label></li>
    </ul>
    <button type="submit" class="postings-btn template-btn-submit">Submit application</button>
  </form>
  <script>
    document.querySelector('input[name="name"]').addEventListener('input', () => {
      if (window.challengeRaised) return;
      window.challengeRaised = true;
      const frame = document.createElement('iframe');
      frame.title = 'recaptcha challenge expires in two minutes';
      frame.style.cssText = 'position:fixed;top:40px;left:40px;width:400px;height:520px;border:1px solid #888';
      document.body.appendChild(frame);
      setTimeout(() => frame.remove(), ${CHALLENGE_MS});
    });
  </script>`);
const CONFIRMATION = html("<h3>Application submitted!</h3><p>Thank you for applying.</p>");

function answer(questionKey: string, label: string, value: string): DraftAnswer {
  return { questionKey, label, answer: value, source: "human", citation: "replica", requiresHuman: false, category: "general", guidance: "" };
}

let directory: string;
let resumePath: string;
const posts: string[] = [];
const unexpected: string[] = [];

async function serve(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === "GET" && `${url.origin}${url.pathname}` === APPLY_URL) {
    return route.fulfill({ contentType: "text/html", body: FORM });
  }
  if (request.method() === "POST" && url.host === "jobs.lever.co" && url.pathname === POST_PATH) {
    posts.push(request.postDataBuffer()?.toString("latin1") ?? "");
    return route.fulfill({ contentType: "text/html", body: CONFIRMATION });
  }
  unexpected.push(`${request.method()} ${url.href}`);
  return route.fulfill({ status: 404, body: "" });
}

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
  directory = mkdtempSync(join(tmpdir(), "autoapply-captcha-handoff-"));
  resumePath = join(directory, "alex-prueba-cv.pdf");
  writeFileSync(resumePath, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

beforeEach(() => {
  posts.length = 0;
  unexpected.length = 0;
  launch.mockClear();
});

const packet = (): SubmissionPacket => ({
  applicationId: "app_captcha_handoff", jobId: "job_captcha_handoff", company: "Replica", jobTitle: "Backend Engineer",
  applyUrl: APPLY_URL, resumeId: "backend", resumePath, coverLetter: "",
  answers: [answer("name", "Full name", "Alex Prueba"), answer("email", "Email", "alex.prueba@example.com")],
});
const policy = { ...makeCampaign().submission, allowedAtsDomains: ["jobs.lever.co"] };

describe("handing a CAPTCHA to the person in a real browser", () => {
  it("waits while the challenge is up, then finishes the form and submits it", async () => {
    const notifyPerson = vi.fn();

    const result = await runApplicationForm(packet(), {
      submit: true, headless: false, artifactsDir: directory, timeoutMs: 20_000, policy, notifyPerson,
    });

    expect(result, result.reason).toMatchObject({ status: "submitted", captchaHandedOff: true, captchaDetected: false });
    expect(result.captchaHandoffSeconds).toBeGreaterThanOrEqual(1);
    expect(notifyPerson).toHaveBeenCalledOnce();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("Alex Prueba");
    expect(posts[0]).toMatch(/alex\.prueba(?:@|%40)example\.com/);
    expect(unexpected).toEqual([]);
  }, 120_000);

  it("redoes a headless run headed and hands the challenge over there", async () => {
    const notifyPerson = vi.fn();

    const result = await runApplicationForm(packet(), {
      submit: true, headless: true, canShowBrowser: () => true, artifactsDir: directory, timeoutMs: 20_000, policy, notifyPerson,
    });

    expect(launch.mock.calls.map(([options]) => (options as { headless: boolean }).headless)).toEqual([true, false]);
    expect(result, result.reason).toMatchObject({ status: "submitted", captchaHandedOff: true });
    expect(notifyPerson).toHaveBeenCalledOnce();
    expect(posts).toHaveLength(1);
  }, 120_000);
});
