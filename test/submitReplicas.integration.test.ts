import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrowserContextOptions, Route } from "playwright";
import { runApplicationForm } from "../src/submission/browser.js";
import type { DraftAnswer } from "../src/domain/job.js";
import type { SubmissionPacket } from "../src/submission/packet.js";
import { makeCampaign } from "./factories.js";

/**
 * The submit path end to end on each of the three hosted boards: a real
 * browser fills a copy of the board's form, clicks its submit control and
 * reads its confirmation. Every request is answered here, at the board's own
 * hostname, and nothing reaches the network, so no employer receives anything.
 * The forms keep the markup the runner depends on, taken from live pages:
 * Greenhouse's Attach button beside the resume input (GitLab), Lever's
 * question cards and hosted-form submit button (Lodgify), Ashby's field
 * entries and in-page confirmation (Qonto).
 */

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch } }));

type Board = {
  applyUrl: string;
  form: string;
  /** Path that receives the form's POST, answered with `confirmation`; absent when the board confirms in place. */
  postPath?: string;
  confirmation?: string;
  answers: DraftAnswer[];
};

function answer(questionKey: string, label: string, value: string): DraftAnswer {
  return { questionKey, label, answer: value, source: "human", citation: "replica", requiresHuman: false, category: "general", guidance: "" };
}

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;

const BOARDS: Record<string, Board> = {
  greenhouse: {
    applyUrl: "https://job-boards.greenhouse.io/replica/jobs/4001",
    postPath: "/replica/jobs/4001",
    confirmation: page("<h1>Thank you for applying.</h1><p>Your application has been received.</p>"),
    form: page(`
      <form id="application-form" method="post" action="/replica/jobs/4001">
        <label for="first_name">First Name*</label><input id="first_name" name="first_name" type="text" required>
        <label for="last_name">Last Name*</label><input id="last_name" name="last_name" type="text" required>
        <label for="email">Email*</label><input id="email" name="email" type="email" required>
        <div role="group" aria-labelledby="upload-label-resume" class="file-upload">
          <div id="upload-label-resume" class="label upload-label">Resume/CV*</div>
          <button type="button" class="btn btn--pill" onclick="document.getElementById('resume').click()">Attach</button>
          <label class="visually-hidden" for="resume">Attach</label>
          <input id="resume" name="resume" type="file" style="position:absolute;width:1px;height:1px;opacity:0"
            onchange="document.getElementById('resume-name').textContent = this.files[0].name">
          <span id="resume-name"></span>
        </div>
        <label for="question_1">Will you now or in the future require visa sponsorship?*</label>
        <select id="question_1" name="question_1" required><option value="">Select...</option><option>No</option><option>Yes</option></select>
        <button type="submit" class="btn btn--pill">Submit application</button>
      </form>`),
    answers: [
      answer("first_name", "First Name", "Alex"),
      answer("last_name", "Last Name", "Prueba"),
      answer("email", "Email", "alex.prueba@example.com"),
      answer("question_1", "Will you now or in the future require visa sponsorship?", "No"),
    ],
  },
  lever: {
    applyUrl: "https://jobs.lever.co/replica/25d51351/apply",
    postPath: "/replica/25d51351/apply",
    confirmation: page("<h3>Application submitted!</h3><p>Thank you for applying.</p>"),
    form: page(`
      <form id="application-form" method="post" action="/replica/25d51351/apply" enctype="multipart/form-data">
        <ul>
          <li class="application-question resume"><label><div class="application-label">Resume/CV<span class="required">✱</span></div>
            <div class="application-field"><a class="visible-resume-upload"><input type="file" name="resume" id="resume-upload-input"><span>ATTACH RESUME/CV</span></a></div></label></li>
          <li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div>
            <div class="application-field"><input type="text" name="name" required></div></label></li>
          <li class="application-question"><label><div class="application-label">Email<span class="required">✱</span></div>
            <div class="application-field"><input type="email" name="email" required></div></label></li>
          <li class="application-question custom-question"><div class="application-label full-width multiple-choice">
            <div class="text">Will you now or in the future require VISA sponsorship to work in Spain?<span class="required">✱</span></div></div>
            <div class="application-field full-width required-field"><ul data-qa="multiple-choice">
              <li><label><input type="radio" name="cards[73a4d6ff][field2]" value="Yes, I would require visa sponsorship" required><span class="application-answer-alternative">Yes, I would require visa sponsorship</span></label></li>
              <li><label><input type="radio" name="cards[73a4d6ff][field2]" value="No" required><span class="application-answer-alternative">No</span></label></li>
            </ul></div></li>
        </ul>
        <button type="submit" class="postings-btn template-btn-submit" id="btn-submit">Submit application</button>
      </form>`),
    answers: [
      answer("name", "Full name", "Alex Prueba"),
      answer("email", "Email", "alex.prueba@example.com"),
      answer("cards[73a4d6ff][field2]", "Will you now or in the future require VISA sponsorship to work in Spain?", "No"),
    ],
  },
  ashby: {
    applyUrl: "https://jobs.ashbyhq.com/replica/2e3c0519/application",
    // Ashby confirms in place, without navigating.
    form: page(`
      <div class="ashby-application-form-container"><form id="ashby-form" onsubmit="event.preventDefault();
          window.submitted = Object.fromEntries(new FormData(this));
          document.body.innerHTML = '<h2>Thanks for applying</h2><p>Your application was successfully submitted.</p>';">
        <div class="ashby-application-form-field-entry"><label for="_systemfield_name" class="ashby-application-form-question-title">Name*</label>
          <input id="_systemfield_name" name="_systemfield_name" type="text" required></div>
        <div class="ashby-application-form-field-entry"><label for="_systemfield_email" class="ashby-application-form-question-title">Email*</label>
          <input id="_systemfield_email" name="_systemfield_email" type="email" required></div>
        <div class="ashby-application-form-field-entry"><label for="_systemfield_resume" class="ashby-application-form-question-title">Resume*</label>
          <input id="_systemfield_resume" name="_systemfield_resume" type="file"></div>
        <div class="ashby-application-form-field-entry"><label for="lang" class="ashby-application-form-question-title">Which of these languages are you most proficient in: Go, Ruby or Python?*</label>
          <textarea id="lang" name="118c1418" required></textarea></div>
        <button type="submit" class="ashby-application-form-submit-button">Submit Application</button>
      </form></div>`),
    answers: [
      answer("_systemfield_name", "Name", "Alex Prueba"),
      answer("_systemfield_email", "Email", "alex.prueba@example.com"),
      answer("118c1418", "Which of these languages are you most proficient in: Go, Ruby or Python?", "Go"),
    ],
  },
};

let directory: string;
let resumePath: string;
const posts: Array<{ url: string; body: string }> = [];
const unexpected: string[] = [];

/** Answers every request the browser makes; nothing is forwarded. */
async function serve(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const board = Object.values(BOARDS).find((candidate) => new URL(candidate.applyUrl).host === url.host);
  if (board && request.method() === "GET" && `${url.origin}${url.pathname}` === board.applyUrl) {
    return route.fulfill({ contentType: "text/html", body: board.form });
  }
  if (board?.postPath && request.method() === "POST" && url.pathname === board.postPath) {
    posts.push({ url: url.href, body: request.postDataBuffer()?.toString("latin1") ?? "" });
    return route.fulfill({ contentType: "text/html", body: board.confirmation ?? "" });
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
  directory = mkdtempSync(join(tmpdir(), "autoapply-replicas-"));
  resumePath = join(directory, "alex-prueba-cv.pdf");
  writeFileSync(resumePath, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("submitting on the three hosted boards", () => {
  it.each(Object.keys(BOARDS))("fills, submits and confirms on %s", async (name) => {
    const board = BOARDS[name]!;
    const packet: SubmissionPacket = {
      applicationId: `app_replica_${name}`, jobId: `job_replica_${name}`, company: "Replica", jobTitle: "Backend Engineer",
      applyUrl: board.applyUrl, resumeId: "backend", resumePath, coverLetter: "", answers: board.answers,
    };
    posts.length = 0;
    unexpected.length = 0;

    const result = await runApplicationForm(packet, {
      submit: true, artifactsDir: directory, timeoutMs: 20_000,
      policy: { ...makeCampaign().submission, allowedAtsDomains: [new URL(board.applyUrl).host] },
    });

    expect(result, result.reason).toMatchObject({ status: "submitted", unmatchedRequired: [] });
    if (board.postPath) {
      expect(posts).toHaveLength(1);
      // The values the runner filled, in whichever encoding the form posts.
      expect(posts[0]!.body).toMatch(/alex\.prueba(?:@|%40)example\.com/);
      expect(posts[0]!.body).toContain("alex-prueba-cv.pdf");
    }
    expect(unexpected).toEqual([]);
  }, 120_000);
});
