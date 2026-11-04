import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeJsonAtomic } from "./config/configFiles.js";
import { resolvePaths } from "./config/paths.js";
import { userAgent } from "./sources/http.js";
import { isAppError } from "./util/errors.js";
import { logger } from "./util/logger.js";
import { VERSION } from "./version.js";

/**
 * Technical usage data, on by default and anonymous: the onboarding message
 * tells the person, and a no (set_telemetry false) turns it off for good.
 *
 * The author learns which tools run, how long they take and how they fail, so
 * problems people hit can be fixed. Each event names the tool, the outcome, an
 * error code, versions, the operating system and the MCP client. Never the
 * profile, CV, answers, jobs, companies, file paths or anything typed: an error
 * message is only sent for unexpected exceptions, and with paths, addresses,
 * links and numbers removed. Events from one run share a random id that lives
 * only in memory: nothing is stored on the person's machine unless they answer,
 * and then only their answer.
 *
 * Events go to spanishtoptechcompanies.com, the author's site, which drops any
 * field it does not expect and forwards the rest without an IP address.
 */

export const TELEMETRY_URL = "https://spanishtoptechcompanies.com/api/v1/telemetry";

export type TelemetryDecision = { enabled: boolean; decidedAt: string };

/** One run's id: new each time the server starts, never written anywhere. */
const SESSION_ID = randomUUID();

export function telemetryPath(): string {
  return join(resolvePaths().home, "telemetry.json");
}

export function readDecision(): TelemetryDecision | null {
  try {
    const raw = JSON.parse(readFileSync(telemetryPath(), "utf8")) as Partial<TelemetryDecision>;
    if (typeof raw.enabled !== "boolean") return null;
    return { enabled: raw.enabled, decidedAt: String(raw.decidedAt ?? "") };
  } catch {
    return null;
  }
}

/** Records the person's choice, the only thing ever written. */
export function decide(enabled: boolean): TelemetryDecision {
  const decision = { enabled, decidedAt: new Date().toISOString() };
  writeJsonAtomic(telemetryPath(), decision);
  return decision;
}

/** An environment that asked for no tracking wins over the file. */
export function blockedByEnvironment(): boolean {
  const own = (process.env.AUTOAPPLY_TELEMETRY ?? "").trim().toLowerCase();
  const dnt = (process.env.DO_NOT_TRACK ?? "").trim().toLowerCase();
  return ["0", "false", "off", "no"].includes(own) || (dnt !== "" && dnt !== "0" && dnt !== "false");
}

export function telemetryStatus(): { enabled: boolean; decided: boolean; blockedByEnvironment: boolean; path: string } {
  const decision = readDecision();
  const blocked = blockedByEnvironment();
  return { enabled: !blocked && decision?.enabled !== false, decided: decision !== null, blockedByEnvironment: blocked, path: telemetryPath() };
}

type Notes = { error?: unknown; details: Record<string, unknown> };
const current = new AsyncLocalStorage<Notes>();

/** Called by fail(): the error behind a tool's error result. */
export function noteFailure(error: unknown): void {
  const notes = current.getStore();
  if (notes) notes.error = error;
}

/** Counts a tool adds to its event, such as boards fetched and failed. */
export function noteDetails(details: Record<string, unknown>): void {
  const notes = current.getStore();
  if (notes) Object.assign(notes.details, details);
}

const SCRUB: Array<[RegExp, string]> = [
  [/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/(?:[A-Za-z]:)?(?:[\\/][^\s\\/'"`:]+){2,}[\\/]?/g, "[path]"],
  [/(['"`«“]).*?(['"`»”])/g, "[text]"],
  [/\d{3,}/g, "[n]"],
];

/** An unexpected exception's message with anything that could be personal removed. */
export function scrub(message: string): string {
  let out = message;
  for (const [pattern, to] of SCRUB) out = out.replace(pattern, to);
  return out.slice(0, 200);
}

function failure(error: unknown, isError: boolean): { error_code?: string; error_message?: string } {
  if (error === undefined) return isError ? { error_code: "tool_error" } : {};
  // A known failure carries a code: its message can quote the person's own data.
  if (isAppError(error)) return { error_code: error.code };
  if (error instanceof Error) return { error_code: error.name || "Error", error_message: scrub(error.message) };
  return { error_code: "thrown" };
}

export type TelemetryEvent = { event: "autoapply_tool"; session_id: string; properties: Record<string, unknown> };
type Sender = (events: TelemetryEvent[]) => Promise<void>;

const post: Sender = async (events) => {
  await fetch(TELEMETRY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(3_000),
  });
};
let sender: Sender = post;

/** For tests: where events go instead of the network. */
export function setTelemetrySender(next: Sender | null): void {
  sender = next ?? post;
}

function report(server: McpServer, tool: string, startedAt: number, result: unknown, thrown: unknown, notes: Notes): void {
  if (!telemetryStatus().enabled) return;
  const isError = thrown !== undefined || (result as { isError?: boolean } | undefined)?.isError === true;
  const client = server.server.getClientVersion();
  const properties = {
    tool,
    ok: !isError,
    duration_ms: Math.round(performance.now() - startedAt),
    ...failure(thrown ?? notes.error, isError),
    ...notes.details,
    version: VERSION,
    node: process.versions.node,
    os: platform(),
    arch: arch(),
    client: client?.name,
    client_version: client?.version,
  };
  const events: TelemetryEvent[] = [{ event: "autoapply_tool", session_id: SESSION_ID, properties }];
  // Anyone can see exactly what leaves: AUTOAPPLY_LOG_LEVEL=debug prints it on stderr.
  logger.debug("telemetry event", { url: TELEMETRY_URL, events });
  // Counting must never change what a tool returns or slow it down.
  sender(events).catch(() => undefined);
}

type Callback = (...args: unknown[]) => unknown;

/**
 * Wraps every tool registered from here on, so each call is timed and reported
 * once it returns. Nothing is sent once the person said no.
 */
export function instrument(server: McpServer): void {
  const register = server.registerTool.bind(server) as (name: string, config: unknown, callback: Callback) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, callback) =>
    register(name, config, async (...args: unknown[]) => {
      const notes: Notes = { details: {} };
      const startedAt = performance.now();
      let result: unknown;
      let thrown: unknown;
      try {
        result = await current.run(notes, () => callback(...args));
        return result;
      } catch (error) {
        thrown = error ?? new Error("thrown");
        throw error;
      } finally {
        try {
          report(server, name, startedAt, result, thrown, notes);
        } catch {
          // never let counting break a tool
        }
      }
    });
}
