import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { resetWorkspaceCache } from "../src/config/load.js";
import { loadPresetCompanies } from "../src/config/presets.js";
import { scrub, setTelemetrySender, TELEMETRY_URL, type TelemetryEvent } from "../src/telemetry.js";
import { VERSION } from "../src/version.js";
import { makeCampaign, makeProfile } from "./factories.js";

/**
 * Technical usage data: on by default, anonymous, off for good after a no,
 * never anything about the person, and never in the way of a tool. Every
 * person here is fictional.
 */

let home = "";
let client: Client;
let sent: TelemetryEvent[] = [];
const ENV = ["AUTOAPPLY_TELEMETRY", "DO_NOT_TRACK"] as const;

async function start(): Promise<void> {
  resetWorkspaceCache();
  home = mkdtempSync(join(tmpdir(), "autoapply-telemetry-"));
  process.env.AUTOAPPLY_HOME = home;
  process.env.AUTOAPPLY_LOG_LEVEL = "error";
  for (const name of ["AUTOAPPLY_PROFILE", "AUTOAPPLY_CAMPAIGN", "AUTOAPPLY_COMPANIES", "AUTOAPPLY_DB"]) delete process.env[name];
  writeFileSync(join(home, "profile.json"), JSON.stringify(makeProfile()));
  writeFileSync(join(home, "campaign.json"), JSON.stringify(makeCampaign()));
  writeFileSync(join(home, "companies.json"), JSON.stringify({ version: 1, companies: [] }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.2.3" });
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { isError: result.isError === true, text, json: () => JSON.parse(text) };
}

// The event is sent after the reply; give it a tick.
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(async () => {
  sent = [];
  for (const name of ENV) delete process.env[name];
  setTelemetrySender(async (events) => {
    sent.push(...events);
  });
  await start();
});

afterEach(async () => {
  await client?.close();
  setTelemetrySender(null);
  for (const name of ENV) delete process.env[name];
  process.env.AUTOAPPLY_TELEMETRY = "0"; // as vitest.config.ts sets it for every other test
  resetWorkspaceCache();
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("telemetry", () => {
  it("is on by default, stores nothing, and a no turns it off for good", async () => {
    await call("list_queue");
    await settle();
    expect(sent.map((event) => event.properties.tool)).toEqual(["list_queue"]);
    expect(existsSync(join(home, "telemetry.json"))).toBe(false);
    await call("set_telemetry", { enabled: false });
    await call("list_queue");
    await settle();
    expect(sent.map((event) => event.properties.tool)).toEqual(["list_queue"]);
    expect(JSON.parse(readFileSync(join(home, "telemetry.json"), "utf8"))).toEqual({ enabled: false, decidedAt: expect.any(String) });
  });

  it("tells the person during setup, as a notice they can say no to, until they choose", async () => {
    const before = (await call("onboarding_questions")).json();
    const asked = before.groups.flatMap((group: any) => group.questions);
    expect(asked).toContainEqual(expect.objectContaining({ field: "telemetry", optional: true }));
    expect(before.message).toMatch(/This tool\n- autoapply-mcp sends its author anonymous technical data[^\n]*Say if you would rather it did not/);
    expect(before.complete).toBe(false);
    await call("set_telemetry", { enabled: false });
    const after = (await call("onboarding_questions")).json();
    expect(after.groups.flatMap((group: any) => group.questions).map((entry: any) => entry.field)).not.toContain("telemetry");
  });

  it("reports each tool with technical fields only, under an id that lasts one run", async () => {
    await call("onboarding_questions");
    await call("list_queue");
    await settle();
    expect(sent.map((event) => event.properties.tool)).toEqual(["onboarding_questions", "list_queue"]);
    const [, queue] = sent;
    expect(queue!.event).toBe("autoapply_tool");
    expect(queue!.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(queue!.properties).toMatchObject({
      tool: "list_queue", ok: true, version: VERSION, node: process.versions.node,
      client: "test-client", client_version: "1.2.3",
    });
    expect(Object.keys(queue!.properties).sort()).toEqual(
      ["arch", "client", "client_version", "duration_ms", "node", "ok", "os", "tool", "version"],
    );
    expect(new Set(sent.map((event) => event.session_id)).size).toBe(1);
    expect(existsSync(join(home, "telemetry.json"))).toBe(false);
    const profile = readFileSync(join(home, "profile.json"), "utf8");
    expect(JSON.stringify(sent)).not.toContain(JSON.parse(profile).identity.email);
  });

  it("a known failure carries its code, never its message", async () => {
    const failed = await call("discover_jobs");
    await settle();
    expect(failed.isError).toBe(true);
    const event = sent.find((entry) => entry.properties.tool === "discover_jobs")!;
    expect(event.properties).toMatchObject({ ok: false, error_code: "no_companies" });
    expect(event.properties.error_message).toBeUndefined();
  });

  it("the environment keeps it off whatever was answered", async () => {
    process.env.DO_NOT_TRACK = "1";
    const status = (await call("set_telemetry", { enabled: true })).json();
    await call("list_queue");
    process.env.DO_NOT_TRACK = "";
    process.env.AUTOAPPLY_TELEMETRY = "0";
    await call("list_queue");
    await settle();
    expect(status).toMatchObject({ enabled: false, note: expect.stringMatching(/keeps it off/) });
    expect(sent).toEqual([]);
  });

  it("a sender that fails never reaches the tool", async () => {
    setTelemetrySender(async () => {
      throw new Error("offline");
    });
    const result = await call("list_queue");
    expect(result.isError).toBe(false);
  });

  it("scrubs anything personal from an unexpected error's message", () => {
    expect(scrub("ENOENT: no such file or directory, open '/Users/alex/cv.pdf'")).toBe(
      "ENOENT: no such file or directory, open [text]",
    );
    expect(scrub("cannot read /home/alex/.autoapply/profile.json for alex@example.com at https://x.io/a?b=1 since 2024")).toBe(
      "cannot read [path] for [email] at [url] since [n]",
    );
  });

  it("the posted batch goes to the author's site", () => {
    expect(TELEMETRY_URL).toBe("https://spanishtoptechcompanies.com/api/v1/telemetry");
  });
});

describe("the Spain list download", () => {
  it("says whether it is a new install or a refresh, and nothing else", async () => {
    const asked: string[] = [];
    await loadPresetCompanies("spain", async (url) => {
      asked.push(url);
      return { companies: [] };
    }, undefined, "setup");
    expect(asked).toEqual(["https://spanishtoptechcompanies.com/api/v1/boards.json?run=setup"]);
  });
});
