import { execFile } from "node:child_process";
import { z } from "zod";
import { logger } from "../util/logger.js";

/**
 * Handing an interactive CAPTCHA to the person.
 *
 * A challenge used to end the run: the browser closed, the application was
 * marked needs_human, and the person redid every field by hand for the sake of
 * one puzzle. Now a headed run keeps the filled form open, tells the person,
 * and waits for them to clear the challenge themselves, then carries on from
 * where it stopped. Nothing here solves, bypasses or hides from a challenge:
 * the person does it, in the same window, as they would on their own.
 */

export const CAPTCHA_WAIT_DEFAULT_SECONDS = 180;
export const CAPTCHA_WAIT_MAX_SECONDS = 900;
export const CAPTCHA_POLL_MS = 1_000;

/** The tool input, shared by submit_application and submit_batch. */
export const captchaWaitSecondsInput = z
  .number()
  .int()
  .min(0)
  .max(CAPTCHA_WAIT_MAX_SECONDS)
  .optional()
  .describe(
    `When an interactive CAPTCHA appears, how long to keep the filled form open for the person to solve it before giving up (default ${CAPTCHA_WAIT_DEFAULT_SECONDS}). A headless run that meets one is redone in a visible browser once, when a display is available. 0 stops at the challenge.`,
  );

export type CaptchaNotice = { title: string; body: string; url: string };
/** Tells the person a challenge is waiting. Must not throw; a failed notice cannot stop the run. */
export type CaptchaNotifier = (notice: CaptchaNotice) => Promise<void> | void;

type ExecFile = (file: string, args: readonly string[]) => Promise<void>;

const execFileQuietly: ExecFile = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: 5_000 }, () => resolve());
  });

/** AppleScript string literal: quotes and backslashes escaped, newlines flattened. */
function appleScriptString(text: string): string {
  return `"${text.replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * A desktop notification through `osascript` on macOS, and nothing elsewhere.
 * The person may be in another window or away from the screen, and the browser
 * coming to the front is easy to miss on a second display.
 */
export function systemNotifier(platform: NodeJS.Platform = process.platform, run: ExecFile = execFileQuietly): CaptchaNotifier {
  return async (notice) => {
    if (platform !== "darwin") return;
    const script = `display notification ${appleScriptString(notice.body)} with title ${appleScriptString(notice.title)}`;
    await run("osascript", ["-e", script]).catch(() => undefined);
  };
}

type LoggingServer = {
  sendLoggingMessage: (params: { level: "warning"; logger?: string; data: unknown }) => Promise<void>;
};

/**
 * Also tells the agent, through an MCP logging notification, so it can say so
 * in the conversation instead of sitting silent on a long tool call.
 */
export function captchaNotifierFor(server?: LoggingServer, system: CaptchaNotifier = systemNotifier()): CaptchaNotifier {
  return async (notice) => {
    await Promise.resolve(system(notice)).catch(() => undefined);
    if (!server) return;
    await server
      .sendLoggingMessage({ level: "warning", logger: "autoapply", data: { event: "captcha_handoff", ...notice } })
      .catch(() => undefined);
  };
}

/** Clamps the requested wait to the documented range. */
export function captchaWaitMs(seconds: number | undefined): number {
  const requested = seconds ?? CAPTCHA_WAIT_DEFAULT_SECONDS;
  return Math.max(0, Math.min(requested, CAPTCHA_WAIT_MAX_SECONDS)) * 1000;
}

type HandoffPage = {
  bringToFront?: () => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
  url: () => string;
};

export type HandoffOutcome = { cleared: boolean; waitedMs: number };

/**
 * Notifies once, brings the window forward, and polls until `challengePresent`
 * says the challenge is gone or `waitMs` runs out. A page the person closed,
 * or one that can no longer be read, counts as not cleared.
 */
export async function awaitChallengeCleared(
  page: HandoffPage,
  challengePresent: () => Promise<boolean>,
  options: { waitMs: number; notify: CaptchaNotifier; pollMs?: number; now?: () => number; company?: string },
): Promise<HandoffOutcome> {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? CAPTCHA_POLL_MS;
  const started = now();
  const seconds = Math.round(options.waitMs / 1000);
  logger.warn("interactive CAPTCHA handed to the person", { url: page.url(), waitSeconds: seconds });
  await Promise.resolve(
    options.notify({
      title: "autoapply: CAPTCHA needs you",
      body: `${options.company ? `${options.company}: ` : ""}solve the challenge in the open browser window within ${seconds}s; the form is filled and the run will continue.`,
      url: page.url(),
    }),
  ).catch(() => undefined);
  await page.bringToFront?.().catch(() => undefined);
  try {
    while (now() - started < options.waitMs) {
      await page.waitForTimeout(Math.min(pollMs, Math.max(1, options.waitMs - (now() - started))));
      if (!(await challengePresent())) {
        const waitedMs = now() - started;
        logger.info("the person cleared the CAPTCHA", { waitedSeconds: Math.round(waitedMs / 1000) });
        return { cleared: true, waitedMs };
      }
    }
  } catch (error) {
    logger.warn("CAPTCHA handoff ended: the page could not be read", { error: String(error) });
  }
  return { cleared: false, waitedMs: now() - started };
}

/**
 * Whether a display is plausibly there to show a headed browser on. A headed
 * launch with nowhere to draw fails outright, which would turn a clean abort
 * into a crash.
 */
export function displayAvailable(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === "darwin") return true;
  if (platform === "linux") return Boolean(env.DISPLAY);
  return false;
}

/**
 * A headless run cannot show a challenge to anyone, so the one that met one
 * is redone headed, once. Filling is automated and cheap; a second retry
 * would only meet the same wall.
 */
export function retriesHeaded(state: { headless: boolean; challenged: boolean; retried: boolean; display: boolean }): boolean {
  return state.headless && state.challenged && !state.retried && state.display;
}
