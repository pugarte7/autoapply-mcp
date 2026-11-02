import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWorkspace } from "../config/load.js";
import { readVerificationInboxConfig } from "../submission/verificationInbox.js";
import { toErrorMessage } from "../util/errors.js";
import { buildAgenda } from "./agenda.js";
import { computeLessons } from "./lessons.js";
import {
  AGENDA_URI,
  LESSONS_URI,
  PROMPTS,
  dailyApplyText,
  onboardText,
  resolveBlockersText,
} from "./prompts.js";

/**
 * Agent-facing surface beyond tools: the loops as prompts, and the state an
 * agent needs at the start of each loop as resources. See docs/HARNESS.md for
 * why these and not others.
 */

function userMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

function spec(name: string) {
  const found = PROMPTS.find((prompt) => prompt.name === name);
  if (!found) throw new Error(`unknown prompt ${name}`);
  return { title: found.title, description: found.description };
}

/**
 * A resource read before onboarding has no profile to load. Saying so, with
 * the prompt that fixes it, beats an error the agent may retry forever.
 */
function json(uri: URL, build: () => unknown) {
  let body: unknown;
  try {
    body = build();
  } catch (error) {
    body = { ready: false, error: toErrorMessage(error), next: "Run the onboard prompt to create the profile and campaign." };
  }
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
}

export function registerHarness(server: McpServer): void {
  server.registerPrompt(
    "onboard",
    {
      ...spec("onboard"),
      argsSchema: {
        cvPath: z.string().optional().describe("Path to the person's CV, if already known"),
        language: z.string().optional().describe("Language to write to the person in"),
      },
    },
    (args) => userMessage(onboardText(args)),
  );

  server.registerPrompt(
    "daily_apply",
    {
      ...spec("daily_apply"),
      argsSchema: {
        maxApplications: z.string().optional().describe("Most applications to submit in this run"),
        focus: z.string().optional().describe("A track, role or region to favour today"),
      },
    },
    (args) => userMessage(dailyApplyText(args)),
  );

  server.registerPrompt(
    "resolve_blockers",
    {
      ...spec("resolve_blockers"),
      argsSchema: { applicationId: z.string().optional().describe("Only this application") },
    },
    (args) => userMessage(resolveBlockersText(args)),
  );

  server.registerResource(
    "agenda",
    AGENDA_URI,
    {
      title: "What needs doing",
      description:
        "Applications held for a person and the questions holding them, today's submission budget, and profile fields whose absence will block forms.",
      mimeType: "application/json",
    },
    (uri) => json(uri, () => buildAgenda(getWorkspace(), readVerificationInboxConfig() !== null)),
  );

  server.registerResource(
    "lessons",
    LESSONS_URI,
    {
      title: "Lessons from past runs",
      description:
        "Per ATS, how submission attempts ended (CAPTCHA, verification code, unfilled field, refused), the employer questions that most often needed a person, and what to do about each.",
      mimeType: "application/json",
    },
    (uri) => json(uri, () => computeLessons(getWorkspace().db, { verificationInboxConfigured: readVerificationInboxConfig() !== null })),
  );
}
