import { describe, expect, it, vi } from "vitest";
import { workdayVerificationLinkReader } from "../src/submission/browser.js";
import { fetchVerificationLink, type VerificationInboxConfig } from "../src/submission/verificationInbox.js";
import { suppliedLinkProblem } from "../src/submission/verificationLinks.js";
import { awaitingCode, codeDeliveryFor, gateAnswer } from "../src/tools/submission.js";
import type { GateHandoff } from "../src/submission/sessions.js";

/**
 * The checks around a hand-off: what an agent may pass back, which way a run
 * defaults, and how the Workday link reader races the agent against the inbox.
 */

const config: VerificationInboxConfig = {
  host: "imap.example.com",
  port: 993,
  user: "codes@example.com",
  password: "secret",
  mailboxes: ["INBOX"],
};
const applyUrl = "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Remote/Engineer_R1";

describe("what the agent may hand back", () => {
  it("takes a code's letters and digits, spaces dropped", () => {
    expect(gateAnswer("code", undefined, { code: " dkgq L1KS " })).toBe("dkgqL1KS");
  });

  it("refuses something that is not a code, so a typo never reaches the board", () => {
    expect(() => gateAnswer("code", undefined, { code: "12-34-56" })).toThrow(/does not look like a one-time code/);
    expect(() => gateAnswer("code", undefined, { link: "https://acme.wd5.myworkdayjobs.com/x" })).toThrow(/pass it as code/);
  });

  it("opens only an https link on Workday's own hosts, for this tenant", () => {
    const link = "https://acme.wd5.myworkdayjobs.com/External/activate/t1";
    expect(gateAnswer("link", "acme", { link })).toBe(link);
    expect(() => gateAnswer("link", "acme", { link: "http://acme.wd5.myworkdayjobs.com/activate/t1" })).toThrow(/https link/);
    expect(() => gateAnswer("link", "acme", { link: "https://myworkdayjobs.com.evil.example/activate" })).toThrow(/https link/);
    expect(() => gateAnswer("link", "acme", { link: "https://other.wd5.myworkdayjobs.com/External/activate/t1" })).toThrow(
      /tenant "other"/,
    );
    expect(() => gateAnswer("link", "acme", { code: "dkgqL1KS" })).toThrow(/pass it as link/);
  });

  it("refuses footer and image links the email also carries", () => {
    expect(suppliedLinkProblem("https://www.myworkday.com/privacy-policy")).toMatch(/footer/);
    expect(suppliedLinkProblem("https://acme.wd5.myworkdayjobs.com/static/logo.png")).toMatch(/footer/);
    expect(suppliedLinkProblem("https://acme.wd5.myworkdayjobs.com/External/activate/t1", "acme")).toBeNull();
  });
});

describe("choosing how a gate is answered", () => {
  it("hands off when nothing else could answer", () => {
    vi.stubEnv("AUTOAPPLY_OTP_IMAP_USER", "");
    vi.stubEnv("AUTOAPPLY_OTP_IMAP_PASSWORD", "");
    try {
      expect(codeDeliveryFor({})).toBe("handoff");
      expect(codeDeliveryFor({ waitForCodeSeconds: 300 })).toBe("wait");
      expect(codeDeliveryFor({ codeDelivery: "wait" })).toBe("wait");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps waiting on a configured mailbox unless told otherwise", () => {
    vi.stubEnv("AUTOAPPLY_OTP_IMAP_USER", "codes@example.com");
    vi.stubEnv("AUTOAPPLY_OTP_IMAP_PASSWORD", "app-password");
    try {
      expect(codeDeliveryFor({})).toBe("wait");
      expect(codeDeliveryFor({ codeDelivery: "handoff" })).toBe("handoff");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("tells the agent where to look and not to submit again", () => {
    const told = awaitingCode({
      applicationId: "app_1",
      status: "awaiting_code",
      kind: "link",
      applyUrl,
      emailedAt: "2026-11-02T10:00:00.000Z",
      expiresAt: "2026-11-02T10:15:00.000Z",
      prompt: "Workday emailed a link",
      sender: "Workday: an address on *.workday.com or *.myworkday.com",
      attempts: 0,
    });
    expect(told.nextStep).toContain("received after 2026-11-02T10:00:00.000Z");
    expect(told.nextStep).toContain("account verification link");
    expect(told.nextStep).toContain("Do not call submit_application again");
  });
});

describe("the Workday link reader when handed off", () => {
  it("asks the agent for the link even with no mailbox", async () => {
    const asked: unknown[] = [];
    const handoff: GateHandoff = async (request) => {
      asked.push(request);
      return "https://acme.wd5.myworkdayjobs.com/External/activate/agent";
    };
    const reader = workdayVerificationLinkReader({ codeWaitMs: 0, verificationInbox: null, gateHandoff: handoff }, applyUrl);
    const since = new Date();
    await expect(reader?.(since)).resolves.toBe("https://acme.wd5.myworkdayjobs.com/External/activate/agent");
    expect(asked).toEqual([expect.objectContaining({ kind: "link", emailedAt: since, tenant: "acme" })]);
  });

  it("takes the mailbox's link when it comes first, and stops asking the agent", async () => {
    let signal: AbortSignal | undefined;
    const handoff: GateHandoff = (_request, abort) => {
      signal = abort;
      return new Promise((resolve) => abort?.addEventListener("abort", () => resolve(undefined)));
    };
    const reader = workdayVerificationLinkReader(
      { codeWaitMs: 60_000, verificationInbox: config, gateHandoff: handoff },
      applyUrl,
      async () => "https://acme.wd5.myworkdayjobs.com/External/activate/inbox",
    );
    await expect(reader?.(new Date())).resolves.toBe("https://acme.wd5.myworkdayjobs.com/External/activate/inbox");
    expect(signal?.aborted).toBe(true);
  });

  it("returns nothing when neither answers", async () => {
    const reader = workdayVerificationLinkReader({ codeWaitMs: 0, verificationInbox: null, gateHandoff: async () => undefined }, applyUrl);
    await expect(reader?.(new Date())).resolves.toBeNull();
  });
});

describe("the mailbox link wait", () => {
  it("stops polling once aborted", async () => {
    const controller = new AbortController();
    let reads = 0;
    const waiting = fetchVerificationLink(
      config,
      { since: new Date(), timeoutMs: 60_000, pollMs: 10_000, signal: controller.signal },
      async () => {
        reads += 1;
        return [];
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(waiting).resolves.toBeNull();
    expect(reads).toBe(1);
  });
});
