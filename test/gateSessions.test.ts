import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampGateHold,
  closeAllGateSessions,
  DEFAULT_GATE_HOLD_MS,
  firstAnswer,
  gateSender,
  gateSessionFor,
  listPendingGates,
  MAX_GATE_HOLD_MS,
  MAX_HELD_SESSIONS,
  openGateSession,
  recentGateOutcomes,
  runHoldingGates,
  type GateHooks,
} from "../src/submission/sessions.js";

/**
 * The registry that keeps a run parked at a verification gate between tool
 * calls. The run is a stand-in here: it asks its hand-off for a code exactly
 * where the browser run would, and finishes with whatever it was given.
 */

type Outcome = { status: string; reason: string; code?: string };

const GREENHOUSE = "https://job-boards.greenhouse.io/replica/jobs/4001";
const emailedAt = new Date("2026-11-02T10:00:00Z");

function gatedRun(hooks: GateHooks, attempts = 1): Promise<Outcome> {
  return (async () => {
    let refused: string | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const code = await hooks.gateHandoff({ kind: "code", emailedAt, prompt: "A verification code was sent to alex@example.com.", ...(refused ? { refused } : {}) });
      if (!code) return { status: "aborted", reason: "no code" };
      if (code === "GOODcode1") return { status: "submitted", reason: "accepted", code };
      refused = `attempt ${attempt} refused`;
    }
    return { status: "aborted", reason: "refused" };
  })();
}

afterEach(async () => {
  vi.useRealTimers();
  await closeAllGateSessions();
  // Released runs finish on the next turn; let them so the registry empties.
  await new Promise((resolve) => setImmediate(resolve));
});

describe("holding a run at its verification gate", () => {
  it("returns at the gate and finishes once the code is handed over", async () => {
    const late: Outcome[] = [];
    const first = await runHoldingGates("app_1", { applyUrl: GREENHOUSE }, (hooks) => gatedRun(hooks), (result) => late.push(result));

    expect(first).toMatchObject({
      held: {
        applicationId: "app_1",
        status: "awaiting_code",
        kind: "code",
        emailedAt: emailedAt.toISOString(),
        sender: expect.stringContaining("greenhouse-mail.io"),
        attempts: 0,
      },
    });
    expect(listPendingGates().map((gate) => gate.applicationId)).toEqual(["app_1"]);

    const session = gateSessionFor("app_1")!;
    session.answer("GOODcode1");
    await expect(session.next()).resolves.toMatchObject({ state: "settled", result: { status: "submitted" } });
    // Nobody was waiting on the original call, so the result was handed to the recorder.
    expect(late).toEqual([{ status: "submitted", reason: "accepted", code: "GOODcode1" }]);
    expect(gateSessionFor("app_1")).toBeUndefined();
    expect(recentGateOutcomes()[0]).toMatchObject({ applicationId: "app_1", status: "submitted" });
  });

  it("does not record a run that finished before any gate, since its caller does", async () => {
    const late: Outcome[] = [];
    const first = await runHoldingGates(
      "app_plain",
      { applyUrl: GREENHOUSE },
      async () => ({ status: "submitted", reason: "no gate" }),
      (result) => late.push(result),
    );
    expect(first).toEqual({ result: { status: "submitted", reason: "no gate" } });
    expect(late).toEqual([]);
    expect(gateSessionFor("app_plain")).toBeUndefined();
  });

  it("asks again after a refused code, carrying why it was refused", async () => {
    await runHoldingGates("app_retry", { applyUrl: GREENHOUSE }, (hooks) => gatedRun(hooks, 3), () => undefined);
    const session = gateSessionFor("app_retry")!;
    session.answer("WRONGcode");
    const again = await session.next();
    expect(again).toMatchObject({ state: "awaiting", gate: { attempts: 1, refused: "attempt 1 refused" } });
    session.answer("GOODcode1");
    await expect(session.next()).resolves.toMatchObject({ state: "settled", result: { status: "submitted" } });
  });

  it("refuses an answer while the run is not asking for one", async () => {
    let release!: () => void;
    const blocked = new Promise<Outcome>((resolve) => {
      release = () => resolve({ status: "submitted", reason: "done" });
    });
    const session = openGateSession<Outcome>("app_busy", { applyUrl: GREENHOUSE });
    session.track(blocked);
    expect(() => session.answer("GOODcode1")).toThrow(/not waiting for a code/);
    expect(session.describe().status).toBe("submitting");
    release();
    await session.next();
  });

  it("gives up at the deadline, and a later ask is answered at once with nothing", async () => {
    vi.useFakeTimers();
    const late: Outcome[] = [];
    const first = await runHoldingGates("app_slow", { applyUrl: GREENHOUSE, holdMs: 60_000 }, (hooks) => gatedRun(hooks), (result) => late.push(result));
    expect(first).toMatchObject({ held: { expiresAt: new Date(Date.now() + 60_000).toISOString() } });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(late).toEqual([{ status: "aborted", reason: "no code" }]);
    expect(gateSessionFor("app_slow")).toBeUndefined();
  });

  it("closes the held browser on shutdown", async () => {
    const close = vi.fn(async () => undefined);
    await runHoldingGates(
      "app_shutdown",
      { applyUrl: GREENHOUSE },
      (hooks) => {
        hooks.onBrowserOpen(close);
        return gatedRun(hooks);
      },
      () => undefined,
    );
    await closeAllGateSessions();
    expect(close).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(gateSessionFor("app_shutdown")).toBeUndefined();
  });

  it("clears the gate when another reader answered first", async () => {
    const session = openGateSession<Outcome>("app_inbox", { applyUrl: GREENHOUSE });
    const controller = new AbortController();
    const asked = session.hooks.gateHandoff({ kind: "code", emailedAt, prompt: "code" }, controller.signal);
    expect(session.isAwaiting()).toBe(true);
    controller.abort();
    await expect(asked).resolves.toBeUndefined();
    expect(session.isAwaiting()).toBe(false);
    session.track(Promise.resolve({ status: "submitted", reason: "inbox" }));
    await session.next();
  });

  it("allows one session per application, since a second submit voids the code", async () => {
    await runHoldingGates("app_once", { applyUrl: GREENHOUSE }, (hooks) => gatedRun(hooks), () => undefined);
    expect(() => openGateSession("app_once", { applyUrl: GREENHOUSE })).toThrow(/already held/);
  });

  it("caps how many browsers are held at once", async () => {
    for (let index = 0; index < MAX_HELD_SESSIONS; index += 1) {
      await runHoldingGates(`app_cap_${index}`, { applyUrl: GREENHOUSE }, (hooks) => gatedRun(hooks), () => undefined);
    }
    expect(() => openGateSession("app_cap_extra", { applyUrl: GREENHOUSE })).toThrow(
      expect.objectContaining({ code: "too_many_gates" }),
    );
  });

  it("reports a run that throws after hand-off as failed", async () => {
    await runHoldingGates(
      "app_throws",
      { applyUrl: GREENHOUSE },
      async (hooks) => {
        await hooks.gateHandoff({ kind: "code", emailedAt, prompt: "code" });
        throw new Error("browser crashed");
      },
      () => undefined,
    );
    const session = gateSessionFor("app_throws")!;
    session.answer("GOODcode1");
    await expect(session.next()).rejects.toThrow("browser crashed");
    expect(recentGateOutcomes()[0]).toMatchObject({ applicationId: "app_throws", status: "failed", reason: "browser crashed" });
  });

  it("reports a still-running run when the caller stops waiting", async () => {
    let finish!: () => void;
    const session = openGateSession<Outcome>("app_wait", { applyUrl: GREENHOUSE });
    const late: Outcome[] = [];
    session.track(
      new Promise((resolve) => {
        finish = () => resolve({ status: "submitted", reason: "late" });
      }),
      (result) => late.push(result),
    );
    await expect(session.next(10)).resolves.toEqual({ state: "running" });
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(late).toHaveLength(1);
  });
});

describe("gate helpers", () => {
  it("bounds the hold", () => {
    expect(clampGateHold(undefined)).toBe(DEFAULT_GATE_HOLD_MS);
    expect(clampGateHold(0)).toBe(DEFAULT_GATE_HOLD_MS);
    expect(clampGateHold(10 * 60 * 60_000)).toBe(MAX_GATE_HOLD_MS);
    expect(clampGateHold(5)).toBe(1_000);
  });

  it("names the sender to search for", () => {
    expect(gateSender(GREENHOUSE, "code")).toContain("us.greenhouse-mail.io");
    expect(gateSender("https://acme.wd5.myworkdayjobs.com/External/job/x", "link")).toMatch(/workday\.com.*myworkday\.com/);
    expect(gateSender("not a url", null)).toBe("the employer's application system");
  });

  it("takes the first reader with an answer, and nothing only when all give up", async () => {
    await expect(firstAnswer([new Promise(() => undefined), Promise.resolve("abc123")])).resolves.toBe("abc123");
    await expect(firstAnswer([Promise.resolve(undefined), Promise.reject(new Error("imap reset"))])).resolves.toBeUndefined();
    await expect(firstAnswer([Promise.resolve(null), Promise.resolve("late99")])).resolves.toBe("late99");
    await expect(firstAnswer([])).resolves.toBeUndefined();
  });
});
