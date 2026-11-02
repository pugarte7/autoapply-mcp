import { describe, expect, it, vi } from "vitest";
import {
  awaitChallengeCleared,
  captchaNotifierFor,
  captchaWaitMs,
  displayAvailable,
  retriesHeaded,
  systemNotifier,
} from "../src/submission/captchaHandoff.js";

/** A page on a simulated clock whose challenge goes away after `clearAfter` polls, or never. */
function handoffPage(clearAfter = Number.POSITIVE_INFINITY) {
  let clock = 0;
  let polls = 0;
  const page = {
    url: () => "https://jobs.lever.co/replica/1/apply",
    bringToFront: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async (ms: number) => {
      clock += ms;
      polls += 1;
    }),
  };
  return { page, now: () => clock, present: async () => polls < clearAfter, get polls() { return polls; } };
}

describe("waiting for the person to clear a challenge", () => {
  it("returns as soon as the challenge is gone, polling every second", async () => {
    const fake = handoffPage(4);
    const notify = vi.fn();

    const outcome = await awaitChallengeCleared(fake.page, fake.present, { waitMs: 180_000, notify, now: fake.now, company: "Replica" });

    expect(outcome).toEqual({ cleared: true, waitedMs: 4_000 });
    expect(fake.page.waitForTimeout).toHaveBeenCalledWith(1_000);
    expect(fake.polls).toBe(4);
  });

  it("notifies once and brings the window forward, however long the wait", async () => {
    const fake = handoffPage(30);
    const notify = vi.fn();

    await awaitChallengeCleared(fake.page, fake.present, { waitMs: 180_000, notify, now: fake.now, company: "Replica" });

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatchObject({ url: "https://jobs.lever.co/replica/1/apply" });
    expect(notify.mock.calls[0]![0].body).toMatch(/Replica.*180s/);
    expect(fake.page.bringToFront).toHaveBeenCalledOnce();
  });

  it("gives up at the deadline when the challenge stays", async () => {
    const fake = handoffPage();

    const outcome = await awaitChallengeCleared(fake.page, fake.present, { waitMs: 5_000, notify: vi.fn(), now: fake.now });

    expect(outcome).toEqual({ cleared: false, waitedMs: 5_000 });
    expect(fake.polls).toBe(5);
  });

  it("counts a window the person closed as not cleared", async () => {
    const fake = handoffPage();
    fake.page.waitForTimeout.mockRejectedValueOnce(new Error("Target page, context or browser has been closed"));

    const outcome = await awaitChallengeCleared(fake.page, fake.present, { waitMs: 5_000, notify: vi.fn(), now: fake.now });

    expect(outcome.cleared).toBe(false);
  });

  it("keeps waiting when the notification itself fails", async () => {
    const fake = handoffPage(2);
    const notify = vi.fn(async () => { throw new Error("no notification centre"); });

    const outcome = await awaitChallengeCleared(fake.page, fake.present, { waitMs: 10_000, notify, now: fake.now });

    expect(outcome.cleared).toBe(true);
  });
});

describe("telling the person", () => {
  it("posts a macOS notification through osascript, with quotes escaped", async () => {
    const run = vi.fn(async () => undefined);

    await systemNotifier("darwin", run)({ title: "autoapply", body: 'Solve "it" now', url: "https://example.com" });

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("osascript", [
      "-e",
      'display notification "Solve \\"it\\" now" with title "autoapply"',
    ]);
  });

  it("does nothing off macOS", async () => {
    const run = vi.fn(async () => undefined);

    await systemNotifier("linux", run)({ title: "t", body: "b", url: "u" });

    expect(run).not.toHaveBeenCalled();
  });

  it("also sends the agent an MCP logging notification when a server is reachable", async () => {
    const system = vi.fn();
    const server = { sendLoggingMessage: vi.fn(async () => undefined) };
    const notice = { title: "t", body: "b", url: "https://jobs.lever.co/x" };

    await captchaNotifierFor(server, system)(notice);

    expect(system).toHaveBeenCalledWith(notice);
    expect(server.sendLoggingMessage).toHaveBeenCalledWith({
      level: "warning",
      logger: "autoapply",
      data: { event: "captcha_handoff", ...notice },
    });
  });

  it("survives a client that is no longer connected", async () => {
    const server = { sendLoggingMessage: vi.fn(async () => { throw new Error("Not connected"); }) };

    await expect(captchaNotifierFor(server, vi.fn())({ title: "t", body: "b", url: "u" })).resolves.toBeUndefined();
  });
});

describe("the headless-to-headed retry", () => {
  it("retries a headless run that met a challenge, once, when a display is there", () => {
    expect(retriesHeaded({ headless: true, challenged: true, retried: false, display: true })).toBe(true);
    expect(retriesHeaded({ headless: true, challenged: true, retried: true, display: true })).toBe(false);
    expect(retriesHeaded({ headless: true, challenged: true, retried: false, display: false })).toBe(false);
    expect(retriesHeaded({ headless: true, challenged: false, retried: false, display: true })).toBe(false);
    expect(retriesHeaded({ headless: false, challenged: true, retried: false, display: true })).toBe(false);
  });

  it("treats macOS, or Linux with DISPLAY set, as able to show a browser", () => {
    expect(displayAvailable("darwin", {})).toBe(true);
    expect(displayAvailable("linux", { DISPLAY: ":0" })).toBe(true);
    expect(displayAvailable("linux", {})).toBe(false);
    expect(displayAvailable("win32", { DISPLAY: ":0" })).toBe(false);
  });
});

describe("captchaWaitMs", () => {
  it("defaults to three minutes and caps at fifteen", () => {
    expect(captchaWaitMs(undefined)).toBe(180_000);
    expect(captchaWaitMs(0)).toBe(0);
    expect(captchaWaitMs(60)).toBe(60_000);
    expect(captchaWaitMs(5_000)).toBe(900_000);
  });
});
