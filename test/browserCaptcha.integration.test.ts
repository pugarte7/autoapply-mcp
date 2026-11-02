import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLECT_FIELDS, runApplicationForm } from "../src/submission/browser.js";
import type { FieldDescriptor } from "../src/submission/formFields.js";
import type { SubmissionPacket } from "../src/submission/packet.js";
import { makeCampaign } from "./factories.js";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch } }));

type Trigger = "upload" | "fill" | "screenshot" | "submit-inspection" | "never" | "submit-click";
type LocatorDouble = {
  first(): LocatorDouble;
  nth(index: number): LocatorDouble;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  fill(value: string): Promise<void>;
  setInputFiles(path: string): Promise<void>;
  click(): Promise<void>;
  innerText(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  waitFor(): Promise<void>;
};

/**
 * `clearAfterPolls` is how many handoff polls the person takes to clear the
 * challenge; absent, it never clears. Each launch gets a fresh page, as a real
 * relaunch would, while the events run on across launches.
 */
function browserDouble(trigger: Trigger, clearAfterPolls?: number) {
  let challengeVisible = false;
  let polls = 0;
  let raised = false;
  let events: string[] = [];
  // Once per page: a person who cleared the challenge is not shown it again.
  const raise = () => {
    if (raised) return;
    raised = true;
    challengeVisible = true;
  };
  const fields: FieldDescriptor[] = [
    { selectorIndex: 0, label: "Full name", type: "text", name: "name", required: true },
    { selectorIndex: 1, label: "Email", type: "email", name: "email", required: true },
  ];
  const locator = (selector: string, index?: number): LocatorDouble => {
    const challenge = selector === 'iframe[title*="challenge" i]' ||
      (selector.includes("hcaptcha") && selector.includes("frame=challenge"));
    const total = challenge ? 2 : selector === 'input[type="file"]' ||
      selector === "body" || selector.startsWith("[data-autoapply-idx=") ||
      selector === 'button[type="submit"]' ? 1 : 0;
    return {
      first: () => locator(selector, 0),
      nth: (position) => locator(selector, position),
      count: async () => index === undefined ? total : Number(index < total),
      isVisible: async () => challenge ? index === 1 && challengeVisible : total > 0,
      isEnabled: async () => true,
      fill: async () => {
        events = [...events, "fill"];
        if (trigger === "fill") raise();
      },
      setInputFiles: async () => {
        events = [...events, "upload"];
        if (trigger === "upload") raise();
      },
      click: async () => {
        events = [...events, "submit"];
        if (trigger === "submit-click") raise();
      },
      innerText: async () => events.includes("submit") ? "Your application has been submitted." : "Submit your application",
      getAttribute: async (name) => {
        if (trigger === "submit-inspection" && name === "aria-disabled") raise();
        return null;
      },
      waitFor: async () => undefined,
    };
  };
  const page = {
    goto: vi.fn(async () => undefined),
    url: () => "https://jobs.lever.co/captcha-regression/example/apply",
    waitForLoadState: async () => undefined,
    waitForTimeout: async (ms: number) => {
      if (!challengeVisible) return;
      polls += 1;
      if (clearAfterPolls !== undefined && polls >= clearAfterPolls) challengeVisible = false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
    },
    bringToFront: vi.fn(async () => undefined),
    locator,
    evaluate: async (script: unknown) => script === COLLECT_FIELDS ? fields : [],
    screenshot: vi.fn(async (options: { path: string }) => {
      if (trigger === "screenshot" && options.path.includes("-prepared-")) raise();
    }),
    on: vi.fn(),
    off: vi.fn(),
  };
  const close = vi.fn(async () => undefined);
  const newPage = async () => {
    challengeVisible = false;
    raised = false;
    polls = 0;
    return page;
  };
  launch.mockResolvedValue({ newContext: async () => ({ newPage }), close });
  return { page, close, get events() { return [...events]; } };
}

let fixtures: Array<{ directory: string; resumePath: string }> = [];

function packetFixture(): { packet: SubmissionPacket; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "autoapply-captcha-regression-"));
  const resumePath = join(directory, "resume.pdf");
  writeFileSync(resumePath, "%PDF-1.4\nLocal synthetic CAPTCHA regression fixture\n");
  fixtures = [...fixtures, { directory, resumePath }];
  return {
    directory,
    packet: {
      applicationId: "app_captcha_regression", jobId: "job_captcha_regression",
      company: "Example", jobTitle: "Software Engineer",
      applyUrl: "https://jobs.lever.co/captcha-regression/example/apply",
      resumeId: "test", resumePath, coverLetter: "",
      answers: [
        { questionKey: "name", label: "Full name", answer: "Test Candidate", source: "profile",
          citation: "test fixture", requiresHuman: false, required: true, category: "contact", guidance: "" },
        { questionKey: "email", label: "Email", answer: "candidate@example.test", source: "profile",
          citation: "test fixture", requiresHuman: false, required: true, category: "contact", guidance: "" },
      ],
    },
  };
}

afterEach(() => {
  for (const fixture of fixtures) {
    rmSync(fixture.resumePath);
    rmdirSync(fixture.directory);
  }
  fixtures = [];
  launch.mockReset();
});

const policy = { ...makeCampaign().submission, allowedAtsDomains: ["jobs.lever.co"] };
/** A headless run with no screen to hand the challenge to: it aborts, as every run used to. */
const noDisplay = { headless: true, canShowBrowser: () => false, notifyPerson: () => undefined };

describe("late interactive CAPTCHA guards", () => {
  it.each(["upload", "fill", "screenshot"] as const)(
    "does not report prepared when a later challenge iframe becomes visible after %s",
    async (trigger) => {
      const fake = browserDouble(trigger);
      const { packet, directory } = packetFixture();

      const result = await runApplicationForm(packet, {
        submit: false, artifactsDir: directory, ...noDisplay,
        policy: { ...makeCampaign().submission, allowedAtsDomains: ["jobs.lever.co"] },
      });

      expect(result.status).toBe("aborted");
      expect(result.captchaDetected).toBe(true);
      expect(result.reason).toMatch(/human|captcha/i);
      expect(result.screenshotPath).toContain("-captcha-");
      expect(fake.events).not.toContain("submit");
      expect(fake.close).toHaveBeenCalledOnce();
    },
  );

  it("stops before clicking submit when the challenge appears during submit-control inspection", async () => {
    const fake = browserDouble("submit-inspection");
    const { packet, directory } = packetFixture();

    const result = await runApplicationForm(packet, {
      submit: true, artifactsDir: directory, ...noDisplay,
      policy: { ...makeCampaign().submission, allowedAtsDomains: ["jobs.lever.co"] },
    });

    expect(result.status).toBe("aborted");
    expect(result.captchaDetected).toBe(true);
    expect(fake.events).not.toContain("submit");
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("still prepares an ordinary form with only hidden challenge frames", async () => {
    const fake = browserDouble("never");
    const { packet, directory } = packetFixture();

    const result = await runApplicationForm(packet, {
      submit: false, artifactsDir: directory, ...noDisplay,
      policy: { ...makeCampaign().submission, allowedAtsDomains: ["jobs.lever.co"] },
    });

    expect(result.status).toBe("prepared");
    expect(result.captchaDetected).toBe(false);
    expect(result.unmatchedRequired).toEqual([]);
    expect(fake.events).toEqual(["upload", "fill", "fill"]);
  });
});

describe("handing a CAPTCHA to the person", () => {
  it.each(["upload", "fill", "screenshot"] as const)(
    "keeps a headed run going once the person clears a challenge raised after %s",
    async (trigger) => {
      const fake = browserDouble(trigger, 3);
      const { packet, directory } = packetFixture();
      const notifyPerson = vi.fn();

      const result = await runApplicationForm(packet, {
        submit: false, artifactsDir: directory, policy, headless: false, notifyPerson,
      });

      expect(result.status, result.reason).toBe("prepared");
      expect(result.captchaHandedOff).toBe(true);
      expect(result.captchaHandoffSeconds).toBeGreaterThanOrEqual(0);
      expect(result.captchaDetected).toBe(false);
      expect(notifyPerson).toHaveBeenCalledOnce();
      expect(fake.page.bringToFront).toHaveBeenCalledOnce();
      expect(fake.events.filter((event) => event === "fill")).toHaveLength(2);
      expect(fake.close).toHaveBeenCalledOnce();
    },
  );

  it("clicks submit after the person clears a challenge raised just before the click", async () => {
    const fake = browserDouble("submit-inspection", 2);
    const { packet, directory } = packetFixture();
    const notifyPerson = vi.fn();

    const result = await runApplicationForm(packet, {
      submit: true, artifactsDir: directory, policy, headless: false, notifyPerson,
    });

    expect(result.status, result.reason).toBe("submitted");
    expect(result.captchaHandedOff).toBe(true);
    expect(fake.events.filter((event) => event === "submit")).toHaveLength(1);
    expect(notifyPerson).toHaveBeenCalledOnce();
  });

  it("aborts with the screenshot when the person does not clear it in time", async () => {
    const fake = browserDouble("fill");
    const { packet, directory } = packetFixture();

    const result = await runApplicationForm(packet, {
      submit: true, artifactsDir: directory, policy, headless: false, captchaWaitSeconds: 1, notifyPerson: vi.fn(),
    });

    expect(result.status).toBe("aborted");
    expect(result.captchaDetected).toBe(true);
    expect(result.captchaHandedOff).toBe(true);
    expect(result.reason).toMatch(/not cleared within 1s/);
    expect(result.screenshotPath).toContain("-captcha-");
    expect(fake.events).not.toContain("submit");
    expect(launch).toHaveBeenCalledOnce();
  });

  it("aborts at once with a zero wait, as before the handoff existed", async () => {
    browserDouble("fill");
    const { packet, directory } = packetFixture();
    const notifyPerson = vi.fn();

    const result = await runApplicationForm(packet, {
      submit: false, artifactsDir: directory, policy, headless: false, captchaWaitSeconds: 0, notifyPerson,
    });

    expect(result).toMatchObject({ status: "aborted", captchaDetected: true });
    expect(result.captchaHandedOff).toBeUndefined();
    expect(notifyPerson).not.toHaveBeenCalled();
  });

  it("redoes a headless run headed, once, and hands the challenge over there", async () => {
    const fake = browserDouble("upload", 2);
    const { packet, directory } = packetFixture();
    const notifyPerson = vi.fn();

    const result = await runApplicationForm(packet, {
      submit: true, artifactsDir: directory, policy, headless: true, canShowBrowser: () => true, notifyPerson,
    });

    expect(launch.mock.calls.map(([options]) => (options as { headless: boolean }).headless)).toEqual([true, false]);
    expect(result.status, result.reason).toBe("submitted");
    expect(result.captchaHandedOff).toBe(true);
    expect(notifyPerson).toHaveBeenCalledOnce();
    expect(fake.events.filter((event) => event === "submit")).toHaveLength(1);
    expect(fake.close).toHaveBeenCalledTimes(2);
  });

  it("does not retry headed a second time when the headed run also gives up", async () => {
    browserDouble("upload");
    const { packet, directory } = packetFixture();

    const result = await runApplicationForm(packet, {
      submit: true, artifactsDir: directory, policy, headless: true, canShowBrowser: () => true,
      captchaWaitSeconds: 1, notifyPerson: vi.fn(),
    });

    expect(launch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "aborted", captchaDetected: true, captchaHandedOff: true });
  });

  it("never refills headed after a challenge raised by the submit click, which could send it twice", async () => {
    const fake = browserDouble("submit-click");
    const { packet, directory } = packetFixture();

    const result = await runApplicationForm(packet, {
      submit: true, artifactsDir: directory, policy, headless: true, canShowBrowser: () => true, notifyPerson: vi.fn(),
    });

    expect(launch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "aborted", captchaDetected: true, submitClicked: true });
    expect(fake.events.filter((event) => event === "submit")).toHaveLength(1);
  });

  it("keeps a headless run's abort when there is no display to show a browser on", async () => {
    browserDouble("upload", 2);
    const { packet, directory } = packetFixture();
    const notifyPerson = vi.fn();

    const result = await runApplicationForm(packet, { submit: true, artifactsDir: directory, policy, ...noDisplay, notifyPerson });

    expect(launch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "aborted", captchaDetected: true });
    expect(notifyPerson).not.toHaveBeenCalled();
  });
});
