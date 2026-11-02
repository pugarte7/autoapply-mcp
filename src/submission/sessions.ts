/**
 * Verification gates held open across tool calls.
 *
 * Greenhouse emails a one-time code and Workday a verification link, each bound
 * to the submit that requested it. Blocking submit_application until the code
 * turns up only works when the server can read the mailbox itself. An agent
 * that reads mail through its own connector cannot help while its tool call is
 * stuck inside that wait, so the run is instead kept alive here, in the
 * long-lived server process, with its browser parked at the gate. The tool
 * returns at once, the agent fetches the code, and provide_verification_code
 * hands it to the waiting run.
 *
 * The run itself never changes shape: it asks a GateHandoff for the code at the
 * same point it used to poll for one, and finishes exactly as before. This
 * module only decides who answers that question and when the wait gives up.
 */
import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";

export type GateKind = "code" | "link";

/** What a run held at a gate needs answered. */
export type GateRequest = {
  kind: GateKind;
  /**
   * When the board was asked to send the email. Anything older belongs to an
   * earlier attempt and is already void.
   */
  emailedAt: Date;
  /** The board's own wording, such as "A verification code was sent to ...". */
  prompt: string;
  /** Workday tenant the link must belong to. */
  tenant?: string;
  /** Why the previous answer was not accepted, when this is a retry. */
  refused?: string;
};

/**
 * Resolves with the code or link, or undefined once nobody will supply one:
 * the deadline passed, the session was released, or `signal` aborted because
 * another reader got there first.
 */
export type GateHandoff = (request: GateRequest, signal?: AbortSignal) => Promise<string | undefined>;

/** What a run takes from a session: where to ask, and how to be shut down. */
export type GateHooks = {
  gateHandoff: GateHandoff;
  onBrowserOpen: (close: () => Promise<void>) => void;
};

/** A held gate as the agent sees it. */
export type PendingGate = {
  applicationId: string;
  status: "awaiting_code" | "submitting";
  kind: GateKind | null;
  applyUrl: string;
  batchId?: string;
  emailedAt: string | null;
  expiresAt: string | null;
  prompt: string;
  /** Where the email comes from, for whoever searches the mailbox. */
  sender: string;
  /** Answers already handed to the board for this gate. */
  attempts: number;
  refused?: string;
};

/** The minimum a finished run reports, for list_pending_gates. */
type RunOutcome = { status: string; reason: string };

/**
 * Fifteen minutes covers a slow relay and a person fetching the code by hand.
 * Greenhouse codes have been seen to stay good for about that long, and every
 * held session is a live Chromium, so the hold is capped well short of forever.
 */
export const DEFAULT_GATE_HOLD_MS = 15 * 60_000;
export const MAX_GATE_HOLD_MS = 30 * 60_000;
const MIN_GATE_HOLD_MS = 1_000;

/**
 * Each held session keeps a browser open. A batch that parks every gated
 * application would otherwise open one per item; past this the next run is
 * refused before it starts rather than abandoned at its gate.
 */
export const MAX_HELD_SESSIONS = 6;

/** Finished handed-off runs kept for list_pending_gates. */
const RECENT_LIMIT = 20;

export function clampGateHold(ms: number | undefined): number {
  const value = Number.isFinite(ms) && (ms ?? 0) > 0 ? (ms as number) : DEFAULT_GATE_HOLD_MS;
  return Math.min(MAX_GATE_HOLD_MS, Math.max(MIN_GATE_HOLD_MS, value));
}

/**
 * Where the verification email comes from, so the agent searches for the right
 * message rather than the newest email of any kind. Greenhouse sends from
 * greenhouse-mail.io (no-reply@us.greenhouse-mail.io), Workday from the
 * tenant's address on workday.com or myworkday.com.
 */
export function gateSender(applyUrl: string, kind: GateKind | null): string {
  let host = "";
  try {
    host = new URL(applyUrl).hostname.toLowerCase();
  } catch {
    // An unparseable URL just gets the generic hint.
  }
  if (kind === "link" || /(?:^|\.)(?:myworkdayjobs|myworkdaysite|myworkday|workday)\.com$/.test(host)) {
    return "Workday: an address on *.workday.com or *.myworkday.com, usually named after the employer";
  }
  if (/greenhouse\.io$/.test(host)) return "Greenhouse: no-reply@us.greenhouse-mail.io (any address on greenhouse-mail.io)";
  if (/lever\.co$/.test(host)) return "Lever: an address on lever.co or hire.lever.co";
  if (/ashbyhq\.com$/.test(host)) return "Ashby: an address on ashbyhq.com";
  return "the employer's application system";
}

type OpenGate = { request: GateRequest; resolve: (value: string | undefined) => void };
type Waiter = () => boolean;

export type SessionState<Result> =
  | { state: "awaiting"; gate: PendingGate }
  | { state: "settled"; result: Result }
  | { state: "running" };

export class GateSession<Result extends RunOutcome> {
  private open: OpenGate | null = null;
  private settled: { ok: true; value: Result } | { ok: false; error: unknown } | null = null;
  private readonly waiters = new Set<Waiter>();
  private expiresAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closeBrowser: (() => Promise<void>) | undefined;
  /** Set once nobody will answer again: expired, released or shut down. */
  private released = false;
  private lastRequest: GateRequest | null = null;
  private answers = 0;
  /** Set once a caller has been told the run is waiting, so its result arrives late. */
  private handedOff = false;
  private onLate: ((result: Result) => void) | undefined;

  readonly applicationId: string;
  readonly applyUrl: string;
  readonly batchId: string | undefined;
  private readonly holdMs: number;
  private readonly onEnd: (session: GateSession<Result>, outcome: RunOutcome | null) => void;

  constructor(
    applicationId: string,
    applyUrl: string,
    batchId: string | undefined,
    holdMs: number,
    onEnd: (session: GateSession<Result>, outcome: RunOutcome | null) => void,
  ) {
    this.applicationId = applicationId;
    this.applyUrl = applyUrl;
    this.batchId = batchId;
    this.holdMs = holdMs;
    this.onEnd = onEnd;
  }

  readonly hooks: GateHooks = {
    gateHandoff: (request, signal) => this.await(request, signal),
    onBrowserOpen: (close) => {
      this.closeBrowser = close;
    },
  };

  private await(request: GateRequest, signal?: AbortSignal): Promise<string | undefined> {
    if (this.released || signal?.aborted) return Promise.resolve(undefined);
    // One deadline for the whole gate: a refused code does not buy more time,
    // because the email it came from does not get any younger.
    if (this.expiresAt === null) {
      this.expiresAt = Date.now() + this.holdMs;
      this.timer = setTimeout(() => this.expire(), this.holdMs);
      this.timer.unref?.();
    } else if (Date.now() >= this.expiresAt) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const gate: OpenGate = {
        request,
        resolve: (value) => {
          if (this.open === gate) this.open = null;
          resolve(value);
        },
      };
      this.open = gate;
      this.lastRequest = request;
      signal?.addEventListener("abort", () => gate.resolve(undefined), { once: true });
      this.notify();
    });
  }

  /** Runs the form under this session, reporting a result that lands after hand-off. */
  track(run: Promise<Result>, onLate?: (result: Result) => void): void {
    this.onLate = onLate;
    run.then(
      (value) => this.finish({ ok: true, value }),
      (error: unknown) => this.finish({ ok: false, error }),
    );
  }

  private finish(outcome: { ok: true; value: Result } | { ok: false; error: unknown }): void {
    this.settled = outcome;
    clearTimeout(this.timer);
    this.released = true;
    this.open?.resolve(undefined);
    if (this.handedOff) {
      if (outcome.ok) {
        try {
          this.onLate?.(outcome.value);
        } catch (error) {
          logger.error("recording a held submission failed", { applicationId: this.applicationId, detail: String(error) });
        }
      } else {
        logger.error("held submission failed", { applicationId: this.applicationId, detail: String(outcome.error) });
      }
    }
    this.onEnd(
      this,
      this.handedOff
        ? outcome.ok
          ? { status: outcome.value.status, reason: outcome.value.reason }
          : { status: "failed", reason: String((outcome.error as Error)?.message ?? outcome.error) }
        : null,
    );
    this.notify();
  }

  private expire(): void {
    logger.info("verification gate expired", { applicationId: this.applicationId });
    this.released = true;
    this.open?.resolve(undefined);
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) if (waiter()) this.waiters.delete(waiter);
  }

  /** The gate as it stands, or null while nothing is being asked. */
  describe(): PendingGate {
    const request = this.open?.request ?? this.lastRequest;
    return {
      applicationId: this.applicationId,
      status: this.open ? "awaiting_code" : "submitting",
      kind: request?.kind ?? null,
      applyUrl: this.applyUrl,
      ...(this.batchId ? { batchId: this.batchId } : {}),
      emailedAt: request?.emailedAt.toISOString() ?? null,
      expiresAt: this.expiresAt === null ? null : new Date(this.expiresAt).toISOString(),
      prompt: request?.prompt ?? "",
      sender: gateSender(this.applyUrl, request?.kind ?? null),
      attempts: this.answers,
      ...(this.open?.request.refused ? { refused: this.open.request.refused } : {}),
    };
  }

  isAwaiting(): boolean {
    return this.open !== null;
  }

  /** The tenant a supplied link has to belong to. */
  tenant(): string | undefined {
    return this.open?.request.tenant;
  }

  /** Hands the waiting run its code or link. */
  answer(value: string): void {
    if (!this.open) {
      throw new AppError(
        "gate_not_waiting",
        `${this.applicationId} is not waiting for a code right now; it is still submitting. Call list_pending_gates to see where it stands.`,
      );
    }
    this.answers += 1;
    this.open.resolve(value);
  }

  /** Gives up on the gate: the run finishes as if no code ever came. */
  release(): void {
    this.released = true;
    this.open?.resolve(undefined);
  }

  /**
   * Waits until the run asks for a code or finishes, whichever is first.
   * With `timeoutMs`, gives up waiting (the run carries on) and reports it as
   * still running.
   */
  next(timeoutMs?: number): Promise<SessionState<Result>> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check: Waiter = () => {
        if (this.settled) {
          clearTimeout(timer);
          if (this.settled.ok) resolve({ state: "settled", result: this.settled.value });
          else reject(this.settled.error);
          return true;
        }
        if (this.open) {
          clearTimeout(timer);
          this.handedOff = true;
          resolve({ state: "awaiting", gate: this.describe() });
          return true;
        }
        return false;
      };
      if (check()) return;
      this.waiters.add(check);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.waiters.delete(check);
          // Whoever stops watching has been told the run is still going, so
          // its result has to be recorded when it lands.
          this.handedOff = true;
          resolve({ state: "running" });
        }, timeoutMs);
      }
    });
  }

  /** Releases the gate and closes the browser, for shutdown. */
  async close(): Promise<void> {
    this.release();
    clearTimeout(this.timer);
    await this.closeBrowser?.().catch(() => undefined);
  }
}

const sessions = new Map<string, GateSession<RunOutcome>>();
const recent: Array<{ applicationId: string; finishedAt: string } & RunOutcome> = [];

/**
 * Opens a session for one application. Only one may exist per application:
 * a second submit would email a fresh code and void the one being waited for.
 */
export function openGateSession<Result extends RunOutcome>(
  applicationId: string,
  options: { applyUrl: string; batchId?: string; holdMs?: number },
): GateSession<Result> {
  if (sessions.has(applicationId)) {
    throw new AppError(
      "gate_pending",
      `${applicationId} is already held at a verification gate. Call provide_verification_code with the emailed code; submitting again would email a new code and void the one already sent.`,
    );
  }
  if (sessions.size >= MAX_HELD_SESSIONS) {
    throw new AppError(
      "too_many_gates",
      `${sessions.size} applications are already held at verification gates, each with a browser open. Provide their codes with provide_verification_code (see list_pending_gates) before starting another.`,
    );
  }
  const session = new GateSession<Result>(
    applicationId,
    options.applyUrl,
    options.batchId,
    clampGateHold(options.holdMs),
    (ended, outcome) => {
      if (sessions.get(applicationId) === (ended as unknown as GateSession<RunOutcome>)) sessions.delete(applicationId);
      if (outcome) {
        recent.unshift({ applicationId, finishedAt: new Date().toISOString(), ...outcome });
        recent.splice(RECENT_LIMIT);
      }
    },
  );
  sessions.set(applicationId, session as unknown as GateSession<RunOutcome>);
  return session;
}

export function gateSessionFor(applicationId: string): GateSession<RunOutcome> | undefined {
  return sessions.get(applicationId);
}

export function listPendingGates(): PendingGate[] {
  return [...sessions.values()].map((session) => session.describe());
}

/** Runs that finished after their tool call had already returned. */
export function recentGateOutcomes(): ReadonlyArray<{ applicationId: string; finishedAt: string } & RunOutcome> {
  return recent;
}

/** Closes every held browser. Called when the server shuts down. */
export async function closeAllGateSessions(): Promise<void> {
  const held = [...sessions.values()];
  await Promise.all(held.map((session) => session.close()));
}

/**
 * Runs a form under a fresh session and returns as soon as it either finishes
 * or stops at a gate. A result that lands after that point goes to `onLate`,
 * which records it, because no tool call is waiting to.
 */
export async function runHoldingGates<Result extends RunOutcome>(
  applicationId: string,
  options: { applyUrl: string; batchId?: string; holdMs?: number },
  run: (hooks: GateHooks) => Promise<Result>,
  onLate: (result: Result) => void,
): Promise<{ held: PendingGate } | { result: Result }> {
  const session = openGateSession<Result>(applicationId, options);
  let started: Promise<Result>;
  try {
    started = run(session.hooks);
  } catch (error) {
    started = Promise.reject(error);
  }
  session.track(started, onLate);
  const state = await session.next();
  if (state.state === "awaiting") return { held: state.gate };
  if (state.state === "settled") return { result: state.result };
  throw new AppError("gate_state", "the run neither finished nor stopped at a gate");
}

/**
 * The first reader to come back with an answer wins; undefined only once every
 * reader has given up. A reader that fails counts as giving up, so a dropped
 * mailbox connection cannot end a wait the agent might still answer.
 */
export function firstAnswer(readers: ReadonlyArray<Promise<string | null | undefined>>): Promise<string | undefined> {
  return new Promise((resolve) => {
    let pending = readers.length;
    if (pending === 0) resolve(undefined);
    const settle = (value: string | null | undefined) => {
      if (value) resolve(value);
      else if (--pending === 0) resolve(undefined);
    };
    for (const reader of readers) reader.then(settle, () => settle(undefined));
  });
}
