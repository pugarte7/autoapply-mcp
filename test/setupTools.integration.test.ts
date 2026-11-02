import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ASKS_PERSON, person } from "./person.js";
import { createServer } from "../src/server.js";
import { getWorkspace, resetWorkspaceCache } from "../src/config/load.js";
import { resolvePaths } from "../src/config/paths.js";
import { applyPending, loadPending } from "../src/config/standing.js";
import { getApplication, saveApplication } from "../src/db/repositories/applications.js";
import { upsertJobs } from "../src/db/repositories/jobs.js";
import type { Application, DraftAnswer } from "../src/domain/job.js";
import { fixtureResumePath, makeCampaign, makeJob, makeProfile } from "./factories.js";

/**
 * The setup tools through a real MCP client, against a temporary
 * AUTOAPPLY_HOME. Every person is fictional.
 */

let home = "";
let client: Client;

type Started = { shown: string[] };

async function start(options: { dialog?: boolean; answer?: () => boolean; files?: { profile?: unknown; campaign?: unknown } } = {}): Promise<Started> {
  resetWorkspaceCache();
  home = mkdtempSync(join(tmpdir(), "autoapply-setup-"));
  process.env.AUTOAPPLY_HOME = home;
  process.env.AUTOAPPLY_LOG_LEVEL = "error";
  for (const name of ["AUTOAPPLY_PROFILE", "AUTOAPPLY_CAMPAIGN", "AUTOAPPLY_COMPANIES", "AUTOAPPLY_DB"]) delete process.env[name];
  writeFileSync(join(home, "companies.json"), JSON.stringify({ version: 1, companies: [] }));
  if (options.files?.profile) writeFileSync(join(home, "profile.json"), JSON.stringify(options.files.profile));
  if (options.files?.campaign) writeFileSync(join(home, "campaign.json"), JSON.stringify(options.files.campaign));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" }, options.dialog === false ? {} : ASKS_PERSON);
  const shown = options.dialog === false ? [] : person(client, options.answer).shown;
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
  return { shown };
}

afterEach(async () => {
  await client?.close();
  resetWorkspaceCache();
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result.content as Array<{ text: string }>) ?? []).map((entry) => entry.text).join("\n");
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, any> };
}

function readJson(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(home, name), "utf8")) as Record<string, any>;
}

const fromCv = {
  identity: {
    fullName: "Casey Example",
    email: "casey@example.com",
    phone: "+34 600 000 000",
    location: { city: "Madrid", region: "Madrid", country: "Spain" },
  },
  experience: [{ company: "Initech", title: "Backend Engineer", start: "2019-04", end: "present" }],
  skills: [{ name: "Python", level: "expert", since: 2017 }],
  languages: [{ name: "Spanish", level: "native" }],
  resumes: [{ id: "cv", label: "CV", path: fixtureResumePath(), isDefault: true }],
};

const fromMessage = {
  workAuthorization: { citizenships: ["Spain"], authorizedIn: ["ES"], statement: "Spanish citizen, authorized to work in the EU." },
  compensation: { currency: "EUR", targetTotal: 70000, minimumTotal: 55000 },
};

describe("setup_profile", () => {
  it("keeps an incomplete profile as a draft and lists what is missing, then writes it once complete", async () => {
    await start();

    const first = (await call("setup_profile", fromCv)).json();
    expect(first.saved).toBe("draft");
    expect(existsSync(join(home, "profile.json"))).toBe(false);
    expect(first.validationIssues.join(" ")).toMatch(/workAuthorization/);
    const fields = first.stillMissing.groups.flatMap((group: any) => group.questions.map((question: any) => question.field));
    expect(fields).toContain("workAuthorization.citizenships");
    expect(fields).toContain("compensation");
    expect(first.stillMissing.message).toMatch(/one go/);

    const second = (await call("setup_profile", fromMessage)).json();
    expect(second.saved).toBe("file");
    expect(existsSync(join(home, "profile.draft.json"))).toBe(false);
    const written = readJson("profile.json");
    expect(written.identity.fullName).toBe("Casey Example");
    expect(written.skills[0].since).toBe(2017);
    expect(written.languages[0]).toEqual({ name: "Spanish", level: "native" });
  });

  it("merges a patch, keeps a backup and refuses to make a working profile invalid", async () => {
    await start({ files: { profile: makeProfile() } });

    const merged = (await call("setup_profile", { skills: [{ name: "Python", since: "2016-09" }, { name: "Rust" }] })).json();
    expect(merged.saved).toBe("file");
    const written = readJson("profile.json");
    expect(written.skills.find((skill: any) => skill.name === "Python")).toMatchObject({ level: "strong", since: "2016-09" });
    expect(written.skills.some((skill: any) => skill.name === "Rust")).toBe(true);
    expect(existsSync(join(home, "profile.json.bak"))).toBe(true);

    const broken = await call("setup_profile", { identity: { email: "not-an-email" } });
    expect(broken.isError).toBe(true);
    expect(readJson("profile.json").identity.email).toBe("alex@example.com");
  });

  it("refuses a resume that is missing or not a PDF or DOCX", async () => {
    await start({ files: { profile: makeProfile() } });
    const text = join(home, "cv.txt");
    writeFileSync(text, "plain text resume");

    const missing = await call("setup_profile", { resumes: [{ id: "cv", label: "CV", path: join(home, "nope.pdf") }] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/resume_invalid/);
    const plain = await call("setup_profile", { resumes: [{ id: "cv", label: "CV", path: text }] });
    expect(plain.text).toMatch(/not a PDF or DOCX/);
  });

  it("turns work-authorization review off only when the person says yes", async () => {
    const { shown } = await start({ files: { profile: makeProfile() } });

    const result = (await call("setup_profile", { workAuthorization: { alwaysReviewManually: false } })).json();
    expect(result.standing.state).toBe("applied");
    expect(shown[0]).toMatch(/work-authorization/);
    expect(shown[0]).toMatch(/authorized in CA/);
    expect(readJson("profile.json").workAuthorization.alwaysReviewManually).toBe(false);
  });

  it("keeps the safe value when the person says no", async () => {
    await start({ files: { profile: makeProfile() }, answer: () => false });

    const result = (await call("setup_profile", {
      compensation: { disclosurePolicy: "exact" },
      preferences: { noticePeriod: "Two weeks" },
    })).json();
    expect(result.standing.state).toBe("declined");
    const written = readJson("profile.json");
    expect(written.compensation.disclosurePolicy).toBe("decline");
    expect(written.preferences.noticePeriod).toBe("Two weeks");
  });

  it("stages the change for the terminal when the client has no dialog", async () => {
    await start({ dialog: false, files: { profile: makeProfile() } });

    const result = (await call("setup_profile", { workAuthorization: { alwaysReviewManually: false } })).json();
    expect(result.standing.state).toBe("pending");
    expect(result.standing.nextStep).toMatch(/approve\.js --setup chg_/);
    expect(readJson("profile.json").workAuthorization.alwaysReviewManually).toBe(true);

    // What approve.js --setup does after the person types "yes".
    const paths = resolvePaths();
    applyPending(paths, loadPending(paths, result.standing.id));
    expect(readJson("profile.json").workAuthorization.alwaysReviewManually).toBe(false);
    expect(readdirSync(join(home, "pending"))).toHaveLength(0);
  });

  it("asks before auto-filling a demographic answer", async () => {
    const { shown } = await start({ files: { profile: makeProfile() }, answer: () => false });

    await call("setup_profile", { personal: { demographics: { gender: { value: "Decline to self-identify", autoFill: true } } } });
    expect(shown).toHaveLength(1);
    expect(readJson("profile.json").personal.demographics.gender.autoFill).toBe(false);
  });
});

describe("update_campaign", () => {
  it("creates the campaign and asks before raising the submission mode", async () => {
    const { shown } = await start({ files: { profile: makeProfile() }, answer: () => false });
    const campaign = JSON.parse(JSON.stringify(makeCampaign())) as Record<string, any>;
    delete campaign.submission;

    const result = (await call("update_campaign", { ...campaign, submission: { mode: "auto", dailyLimit: 10 } })).json();
    expect(result.saved).toBe("file");
    expect(shown[0]).toMatch(/submit applications/);
    const written = readJson("campaign.json");
    expect(written.submission).toEqual({ mode: "manual", dailyLimit: 10 });
    expect(result.workspace.loaded).toBe(true);
  });

  it("removes a blocked question category once the person confirms", async () => {
    const { shown } = await start({ files: { profile: makeProfile(), campaign: makeCampaign() } });
    const categories = makeCampaign().submission.blockedQuestionCategories.filter((category) => category !== "reference");

    const result = (await call("update_campaign", { submission: { blockedQuestionCategories: categories } })).json();
    expect(result.standing.state).toBe("applied");
    expect(shown[0]).toMatch(/reference/);
    expect(readJson("campaign.json").submission.blockedQuestionCategories).not.toContain("reference");
  });
});

function draft(questionKey: string, label: string, overrides: Partial<DraftAnswer> = {}): DraftAnswer {
  return { questionKey, label, answer: "", source: "blocked", citation: "", requiresHuman: true, required: true, category: "general", guidance: "", ...overrides };
}

function seedApplication(id: string, company: string, answers: DraftAnswer[]): void {
  const { db } = getWorkspace();
  const job = makeJob({ id: `job_${id}`, fingerprint: `fp_${id}`, companyName: company, externalId: id });
  upsertJobs(db, [job]);
  const application: Application = {
    id,
    jobId: job.id,
    status: "needs_human",
    resumeId: "general",
    resumePath: fixtureResumePath(),
    packetHash: "",
    coverLetter: "",
    answers,
    blockedQuestions: answers.map((answer) => answer.label),
    createdAt: new Date().toISOString(),
    approvedAt: null,
    submittedAt: null,
    submissionMode: null,
    confirmationRef: null,
    artifactPath: null,
    notes: "",
  };
  saveApplication(db, application);
}

const PRONUNCIATION = "How do you pronounce your name?";
const SALARY = "What are your salary expectations?";

describe("remember_answer", () => {
  it("stores the answer and fills it into every open application that asks it", async () => {
    const profile = makeProfile({
      answers: [{ key: "name-pronunciation", label: "Name pronunciation", patterns: ["pronounce your name"], answer: "", allowAutoFill: true }],
    });
    const { shown } = await start({ files: { profile, campaign: makeCampaign() } });
    seedApplication("app_one", "Globex", [draft("q1", PRONUNCIATION)]);
    seedApplication("app_two", "Initrode", [draft("q9", `${PRONUNCIATION} (phonetic)`), draft("q10", "Anything else?", { required: false })]);

    const result = (await call("remember_answer", { label: PRONUNCIATION, answer: "KAY-see", statedByPerson: true })).json();
    expect(shown).toHaveLength(0);
    expect(result.remembered[0]).toMatchObject({ key: "name-pronunciation", matchedExisting: true });
    expect(result.updatedApplications.map((entry: any) => entry.applicationId).sort()).toEqual(["app_one", "app_two"]);

    const bank = readJson("profile.json").answers;
    expect(bank.filter((entry: any) => entry.key === "name-pronunciation")).toHaveLength(1);
    expect(bank.find((entry: any) => entry.key === "name-pronunciation").answer).toBe("KAY-see");
    const one = getApplication(getWorkspace().db, "app_one")!;
    expect(one.status).toBe("awaiting_approval");
    expect(one.answers[0]).toMatchObject({ answer: "KAY-see", requiresHuman: false, citation: "profile.answers.name-pronunciation" });
  });

  it("asks the person before making a pay answer standing", async () => {
    const { shown } = await start({ files: { profile: makeProfile(), campaign: makeCampaign() }, answer: () => false });
    seedApplication("app_pay", "Globex", [draft("pay", SALARY, { category: "compensation" })]);

    const result = (await call("remember_answer", { label: SALARY, answer: "70,000 EUR", statedByPerson: true })).json();
    expect(shown[0]).toMatch(/compensation question/);
    expect(result.standing.state).toBe("declined");
    const stored = readJson("profile.json").answers.find((entry: any) => entry.answer === "70,000 EUR");
    expect(stored.allowAutoFill).toBe(false);
    expect(result.updatedApplications).toHaveLength(0);
  });

  it("asks the person about any answer they did not state themselves", async () => {
    const { shown } = await start({ files: { profile: makeProfile(), campaign: makeCampaign() } });
    seedApplication("app_one", "Globex", [draft("q1", PRONUNCIATION)]);

    const result = (await call("remember_answer", { label: PRONUNCIATION, answer: "KAY-see", statedByPerson: false })).json();
    expect(shown[0]).toMatch(/you did not state this answer yourself/);
    expect(result.standing.state).toBe("applied");
    expect(result.updatedApplications).toHaveLength(1);
  });
});

describe("set_application_content", () => {
  it("records the agent's answers as the agent's and can remember them for the rest", async () => {
    await start({ files: { profile: makeProfile(), campaign: makeCampaign() } });
    seedApplication("app_one", "Globex", [draft("q1", PRONUNCIATION)]);
    seedApplication("app_two", "Initrode", [draft("q2", PRONUNCIATION)]);

    const result = (await call("set_application_content", {
      applicationId: "app_one",
      answers: [{ questionKey: "q1", answer: "KAY-see", remember: true, statedByPerson: true }],
    })).json();
    const { db } = getWorkspace();
    expect(getApplication(db, "app_one")!.answers[0]).toMatchObject({ answer: "KAY-see", source: "agent" });
    expect(result.remembered.updatedApplications.map((entry: any) => entry.applicationId)).toEqual(["app_two"]);
    expect(getApplication(db, "app_two")!.answers[0]).toMatchObject({ answer: "KAY-see", source: "approved-answer" });
  });
});

describe("onboarding_questions", () => {
  it("asks everything an empty setup lacks in one grouped message", async () => {
    await start();
    const report = (await call("onboarding_questions")).json();
    expect(report.complete).toBe(false);
    expect(report.groups.map((group: any) => group.title)).toEqual(
      expect.arrayContaining(["About you", "Your CV", "Work authorization", "Pay", "What you are looking for"]),
    );
    expect(report.message).toMatch(/About you\n- Your full name/);
  });

  it("asks when each undated skill was first used and lists blank answer-bank questions", async () => {
    const profile = makeProfile({
      answers: [{ key: "start", label: "Earliest start date", patterns: ["start date"], answer: "", allowAutoFill: true }],
    });
    await start({ files: { profile, campaign: makeCampaign() } });
    const report = (await call("onboarding_questions")).json();
    expect(report.message).toMatch(/Since which year have you used each of these professionally: Python, Open Policy Agent/);
    expect(report.message).toMatch(/Earliest start date/);
  });
});
