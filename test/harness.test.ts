import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { getWorkspace, resetWorkspaceCache } from "../src/config/load.js";
import { openDatabase, type Db } from "../src/db/database.js";
import { upsertJobs } from "../src/db/repositories/jobs.js";
import { saveApplication } from "../src/db/repositories/applications.js";
import { appendEvent } from "../src/db/repositories/events.js";
import type { Application, DraftAnswer } from "../src/domain/job.js";
import { classifyAbort, computeLessons, questionKey } from "../src/harness/lessons.js";
import { profileGaps } from "../src/harness/agenda.js";
import { dailyApplyText, onboardText, resolveBlockersText } from "../src/harness/prompts.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

function answer(label: string, overrides: Partial<DraftAnswer> = {}): DraftAnswer {
  return {
    questionKey: questionKey(label),
    label,
    answer: "",
    source: "blocked",
    citation: "",
    requiresHuman: true,
    required: true,
    category: "general",
    guidance: "",
    ...overrides,
  };
}

function application(id: string, jobId: string, overrides: Partial<Application> = {}): Application {
  return {
    id,
    jobId,
    status: "needs_human",
    resumeId: "general",
    resumePath: "/tmp/resume.pdf",
    packetHash: "",
    coverLetter: "",
    answers: [],
    blockedQuestions: [],
    createdAt: new Date().toISOString(),
    approvedAt: null,
    submittedAt: null,
    submissionMode: null,
    confirmationRef: null,
    artifactPath: null,
    notes: "",
    ...overrides,
  };
}

/** Two boards, four attempts that ended four different ways. */
function seed(db: Db): void {
  upsertJobs(db, [
    makeJob({ id: "job_gh1", fingerprint: "fp1", externalId: "1" }),
    makeJob({ id: "job_gh2", fingerprint: "fp2", externalId: "2" }),
    makeJob({ id: "job_wd1", fingerprint: "fp3", externalId: "3", ats: "workday", companyName: "Day Corp" }),
  ]);
  const sponsorship = "Will you require visa sponsorship? *";
  saveApplication(db, application("app_1", "job_gh1", { answers: [answer(sponsorship)], notes: "[t] aborted: anti-bot challenge detected" }));
  saveApplication(db, application("app_2", "job_gh2", { answers: [answer("will you require  visa sponsorship?")] }));
  saveApplication(
    db,
    application("app_3", "job_wd1", {
      status: "submitted",
      answers: [
        answer("Desired salary", { answer: "Prefer to discuss", source: "human", requiresHuman: true }),
        answer("Optional nickname", { required: false }),
      ],
    }),
  );
  appendEvent(db, "submission.aborted", "app_1", { mode: "auto", reason: "anti-bot challenge detected; this application must be completed by a human" });
  appendEvent(db, "submission.aborted", "app_2", { mode: "auto", reason: "Greenhouse sent a verification code to the candidate's email. Every field is filled." });
  appendEvent(db, "submission.blocked", "app_2", { code: "DAILY_LIMIT" });
  appendEvent(db, "submission.submitted", "app_3", { mode: "auto" });
}

describe("lessons", () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(":memory:");
    seed(db);
  });

  it("sorts abort reasons into the kinds an agent handles differently", () => {
    expect(classifyAbort("anti-bot challenge activated after submit")).toBe("captcha");
    expect(classifyAbort("verification code was entered but the submission was not confirmed")).toBe("verification");
    expect(classifyAbort("required field(s) could not be filled: Phone")).toBe("unfilled");
    expect(classifyAbort("the employer refused the submission")).toBe("refused");
    expect(classifyAbort("no submit control found on the page")).toBe("other");
  });

  it("counts outcomes per ATS from the audit log", () => {
    const lessons = computeLessons(db);
    const greenhouse = lessons.boards.find((entry) => entry.ats === "greenhouse");
    const workday = lessons.boards.find((entry) => entry.ats === "workday");
    expect(greenhouse).toMatchObject({ attempts: 3, outcomes: { captcha: 1, verification: 1, guard: 1, submitted: 0 } });
    expect(workday).toMatchObject({ attempts: 1, outcomes: { submitted: 1 } });
  });

  it("merges the same question across applications and keeps no answers", () => {
    const lessons = computeLessons(db);
    const sponsorship = lessons.questions.find((question) => question.label.startsWith("Will you require"));
    expect(sponsorship).toMatchObject({ blockingNow: 2, answeredByPerson: 0, ats: ["greenhouse"] });
    expect(lessons.questions.find((question) => question.label === "Desired salary")).toMatchObject({ answeredByPerson: 1 });
    // A blank optional field never blocks, so it is not a lesson.
    expect(lessons.questions.some((question) => question.label === "Optional nickname")).toBe(false);
    expect(JSON.stringify(lessons)).not.toContain("Prefer to discuss");
  });

  it("turns counts into advice that names a tool", () => {
    const withoutInbox = computeLessons(db).advice.join("\n");
    expect(withoutInbox).toContain("CAPTCHA");
    expect(withoutInbox).toContain("provide_verification_code");
    expect(withoutInbox).toContain("remember_answer");
    const withInbox = computeLessons(db, { verificationInboxConfigured: true }).advice.join("\n");
    expect(withInbox).not.toContain("provide_verification_code");
  });
});

describe("profile gaps", () => {
  it("lists only what is missing", () => {
    const complete = makeProfile({ preferences: { noticePeriod: "1 month" } });
    const gaps = profileGaps(complete, true).map((gap) => gap.field);
    expect(gaps).not.toContain("identity.phone");
    expect(gaps).not.toContain("preferences.noticePeriod");
    expect(gaps).not.toContain("verification mailbox");
    expect(profileGaps(complete, false).map((gap) => gap.field)).toContain("verification mailbox");
  });
});

describe("prompt texts", () => {
  it("onboard asks for everything in one message with the mailbox wording", () => {
    const text = onboardText();
    expect(text).toContain("ONE message");
    expect(text).toContain(
      "We need an email address to receive the verification codes some boards send. You can connect it to me and I do everything automatically, or you pass me the codes by hand.",
    );
    for (const tool of ["setup_profile", "update_campaign", "remember_answer", "list_rules", "approve_rules"]) {
      expect(text).toContain(tool);
    }
    expect(text).not.toMatch(/app password|manual mode/i);
  });

  it("never offers a menu of modes", () => {
    for (const text of [onboardText(), dailyApplyText(), resolveBlockersText()]) {
      expect(text).not.toMatch(/manual mode|choose a mode|which mode/i);
    }
    expect(dailyApplyText()).toContain("do not offer a choice of modes");
  });

  it("fills arguments in and ignores blank ones", () => {
    expect(onboardText({ cvPath: "/cv/alex.pdf", language: "Spanish" })).toContain("/cv/alex.pdf");
    expect(onboardText({ cvPath: "  " })).toContain("Their CV (a file path or pasted text)");
    expect(dailyApplyText({ maxApplications: "7", focus: "Madrid" })).toMatch(/Madrid[\s\S]*up to 7/);
    expect(resolveBlockersText({ applicationId: "app_42" })).toContain("application app_42 only");
  });
});

describe("harness over MCP", () => {
  let client: Client;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "autoapply-harness-"));
    writeFileSync(join(home, "profile.json"), JSON.stringify(makeProfile()));
    writeFileSync(join(home, "campaign.json"), JSON.stringify(makeCampaign()));
    writeFileSync(
      join(home, "companies.json"),
      JSON.stringify({ version: 1, companies: [{ name: "Test Corp", ats: "greenhouse", board: "testcorp", tier: "B" }] }),
    );
    process.env.AUTOAPPLY_HOME = home;
    process.env.AUTOAPPLY_LOG_LEVEL = "error";
    for (const key of ["AUTOAPPLY_PROFILE", "AUTOAPPLY_CAMPAIGN", "AUTOAPPLY_COMPANIES", "AUTOAPPLY_DB"]) delete process.env[key];
    resetWorkspaceCache();
    seed(getWorkspace().db);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "harness-test", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    resetWorkspaceCache();
  });

  it("registers the three prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(["daily_apply", "onboard", "resolve_blockers"]);
    const daily = prompts.find((prompt) => prompt.name === "daily_apply");
    expect(daily?.arguments?.map((arg) => arg.name).sort()).toEqual(["focus", "maxApplications"]);
  });

  it("renders a prompt with its arguments", async () => {
    const result = await client.getPrompt({ name: "daily_apply", arguments: { maxApplications: "3" } });
    const message = result.messages[0];
    expect(message?.role).toBe("user");
    expect(message?.content.type === "text" ? message.content.text : "").toContain("up to 3");
    const onboard = await client.getPrompt({ name: "onboard", arguments: {} });
    expect(onboard.messages[0]?.content.type).toBe("text");
  });

  it("serves the agenda and lessons as resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual(["autoapply://agenda", "autoapply://lessons"]);

    const agenda = JSON.parse(String((await client.readResource({ uri: "autoapply://agenda" })).contents[0]?.text));
    expect(agenda.needsHuman.map((entry: { applicationId: string }) => entry.applicationId).sort()).toEqual(["app_1", "app_2"]);
    expect(agenda.needsHuman.find((entry: { applicationId: string }) => entry.applicationId === "app_1").lastNote).toContain("anti-bot");

    const lessons = JSON.parse(String((await client.readResource({ uri: "autoapply://lessons" })).contents[0]?.text));
    expect(lessons.boards.length).toBe(2);
  });
});

describe("resources before onboarding", () => {
  it("say what to run instead of failing", async () => {
    process.env.AUTOAPPLY_HOME = mkdtempSync(join(tmpdir(), "autoapply-empty-"));
    resetWorkspaceCache();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "harness-empty", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
    const body = JSON.parse(String((await client.readResource({ uri: "autoapply://agenda" })).contents[0]?.text));
    expect(body).toMatchObject({ ready: false });
    expect(body.next).toContain("onboard");
    await client.close();
    resetWorkspaceCache();
  });
});

/**
 * The Agent Skills format (agentskills.io/specification), which Claude Code,
 * Codex and Hermes Agent all read. Parsed by hand for the flat subset the file
 * uses, so anything fancier fails the test instead of slipping past a loader.
 */
describe("skills/autoapply/SKILL.md", () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "autoapply", "SKILL.md");
  const raw = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);

  function frontmatter(block: string): Record<string, string | Record<string, string>> {
    const out: Record<string, string | Record<string, string>> = {};
    let nested: Record<string, string> | null = null;
    for (const line of block.split("\n")) {
      const child = /^ {2}([a-z][a-z0-9_-]*): (.+)$/.exec(line);
      if (child && nested) {
        nested[child[1]!] = child[2]!.replace(/^"(.*)"$/, "$1");
        continue;
      }
      const top = /^([a-z][a-z0-9_-]*):(?: (.+))?$/.exec(line);
      if (!top) throw new Error(`unparsed frontmatter line: ${line}`);
      if (top[2] === undefined) {
        nested = {};
        out[top[1]!] = nested;
      } else {
        nested = null;
        out[top[1]!] = top[2];
      }
    }
    return out;
  }

  it("has frontmatter and a body", () => {
    expect(match).not.toBeNull();
  });

  it("follows the Agent Skills field rules", () => {
    const fields = frontmatter(match![1]!);
    const allowed = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
    expect(Object.keys(fields).filter((key) => !allowed.includes(key))).toEqual([]);

    const name = fields.name as string;
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toBe(basename(dirname(path)));

    const description = fields.description as string;
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect((fields.compatibility as string).length).toBeLessThanOrEqual(500);
    for (const value of Object.values(fields.metadata as Record<string, string>)) expect(typeof value).toBe("string");
  });

  it("stays short enough to load whole and keeps the mailbox wording", () => {
    const body = match![2]!;
    expect(body.split("\n").length).toBeLessThan(500);
    expect(body).toContain("You can connect it to me and I do everything");
    expect(body).toMatch(/## When to Use[\s\S]*## Procedure[\s\S]*## Pitfalls[\s\S]*## Verification/);
  });
});
