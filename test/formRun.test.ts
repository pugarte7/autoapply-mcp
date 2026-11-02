import { describe, expect, it } from "vitest";
import {
  abortedNextStep,
  codeWaitSeconds,
  DEFAULT_CODE_WAIT_SECONDS,
  fieldsToAnswer,
  mayCreateAccount,
} from "../src/tools/formRun.js";
import type { DraftAnswer } from "../src/domain/job.js";

const inbox = {
  host: "imap.example.com",
  port: 993,
  user: "codes@example.com",
  password: "not-a-real-app-password",
  mailboxes: ["INBOX"],
};

describe("codeWaitSeconds", () => {
  it("waits five minutes by default when a verification inbox can read the code", () => {
    expect(DEFAULT_CODE_WAIT_SECONDS).toBe(300);
    expect(codeWaitSeconds(undefined, inbox)).toBe(300);
  });

  it("does not wait by default when nothing can supply a code", () => {
    expect(codeWaitSeconds(undefined, null)).toBe(0);
  });

  it("keeps an explicit value, zero included", () => {
    expect(codeWaitSeconds(0, inbox)).toBe(0);
    expect(codeWaitSeconds(45, null)).toBe(45);
  });
});

describe("mayCreateAccount", () => {
  const greenhouse = "https://job-boards.greenhouse.io/example/jobs/1";
  const workday = "https://example.wd5.myworkdayjobs.com/en-US/careers/job/Madrid/Engineer_R1";

  it("registers in auto mode on any board once ATS credentials are set", () => {
    expect(mayCreateAccount("auto", greenhouse, true)).toBe(true);
  });

  it("does not register in auto mode off Workday without credentials", () => {
    expect(mayCreateAccount("auto", greenhouse, false)).toBe(false);
  });

  it("keeps assisted mode and Workday as before", () => {
    expect(mayCreateAccount("assisted", greenhouse, false)).toBe(true);
    expect(mayCreateAccount("auto", workday, false)).toBe(true);
  });
});

function blank(label: string, category: string, overrides: Partial<DraftAnswer> = {}): DraftAnswer {
  return {
    questionKey: `k_${label.length}`,
    label,
    answer: "",
    source: "blocked",
    citation: "",
    requiresHuman: true,
    required: true,
    category,
    guidance: "",
    ...overrides,
  };
}

describe("aborted next step", () => {
  const retry = "run submit_application again";

  it("names the fields the agent can answer and asks it to re-run", () => {
    const fields = fieldsToAnswer([
      blank("Which databases have you run in production?", "employer-specific"),
      blank("What is your expected salary?", "compensation"),
      blank("Optional note", "general", { required: false }),
      blank("Answered", "general", { answer: "yes" }),
    ]);
    expect(fields.map((field) => field.who)).toEqual(["agent", "person"]);
    const step = abortedNextStep({ reason: "unmatched", captchaDetected: false }, fields, retry);
    expect(step).toContain('"Which databases have you run in production?"');
    expect(step).toContain("Answer these yourself");
    expect(step).toContain('Only the person can answer "What is your expected salary?"');
    expect(step).toContain(retry);
  });

  it("hands a CAPTCHA to the person and never to a solver", () => {
    const step = abortedNextStep({ reason: "captcha", captchaDetected: true }, [], retry);
    expect(step).toContain("Never try to solve it");
    expect(step).toContain("ask the person");
  });

  it("falls back to the reason when no field is missing", () => {
    const step = abortedNextStep({ reason: "verification code never arrived", captchaDetected: false }, [], retry);
    expect(step).toContain("verification code never arrived");
  });
});
