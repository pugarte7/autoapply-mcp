import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getWorkspace, resetWorkspaceCache } from "../src/config/load.js";
import { listEvents } from "../src/db/repositories/events.js";
import { proposeStandingRules, recordRulesApproval } from "../src/submission/approvals.js";
import { runDaily } from "../src/cli/daily.js";
import { makeRulesHome, stubBoard, submittedRun } from "./rulesHome.js";

const runApplicationForm = vi.hoisted(() => vi.fn());
vi.mock("../src/submission/browser.js", async (original) => ({
  ...(await original<typeof import("../src/submission/browser.js")>()),
  runApplicationForm,
}));

/** The unattended daily run against a fictional home and a fake board. */

let home: string;

function setMode(mode: string): void {
  const path = join(home, "campaign.json");
  const campaign = JSON.parse(readFileSync(path, "utf8"));
  campaign.submission.mode = mode;
  writeFileSync(path, JSON.stringify(campaign));
  resetWorkspaceCache();
}

beforeAll(() => {
  home = makeRulesHome("assisted");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  resetWorkspaceCache();
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("daily run", () => {
  it("discovers but prepares and sends nothing without active rules", async () => {
    stubBoard(2, true, true);
    const report = await runDaily({ notify: false });
    expect(report.rules).toEqual([]);
    expect(report.discovery).toContain("postings fetched");
    expect(readFileSync(report.digestPath, "utf8")).toContain("none active, so nothing could be sent");
    expect(runApplicationForm).not.toHaveBeenCalled();
  });

  it("in a dry run, prepares what the rules cover and reports it without sending", async () => {
    // Stands in for the person typing "yes" in their own terminal.
    const { rulesId, hash } = proposeStandingRules({ tiers: ["A", "B"], maxPerDay: 5, maxPerRun: 5 });
    recordRulesApproval(rulesId, hash, "cli");
    setMode("auto");

    stubBoard(2, true, true);
    const report = await runDaily({ dryRun: true, notify: false });
    expect(report.rules[0]).toContain(rulesId);
    expect(report.sent).toEqual([]);
    expect(report.ready).toHaveLength(2);
    expect(report.ready[0].detail).toBe("dry run");
    expect(report.agent).toEqual([
      expect.objectContaining({ title: "Senior Security Engineer, Essays", detail: "Describe a security system you designed and why" }),
    ]);
    expect(report.person).toEqual([
      expect.objectContaining({ label: "Are you legally authorized to work in the United States?", count: 1, companies: ["Acme"] }),
    ]);

    expect(report.digestPath).toMatch(/digests[/\\]\d{4}-\d{2}-\d{2}\.md$/);
    expect(existsSync(report.digestPath)).toBe(true);
    const digest = readFileSync(report.digestPath, "utf8");
    expect(digest).toContain("## Waiting for you");
    expect(digest).toContain("## Waiting for the agent to draft\n\n- Acme: Senior Security Engineer, Essays");
    expect(digest).toContain("Are you legally authorized to work in the United States? [work-authorization], 1 application(s): Acme");
    expect(runApplicationForm).not.toHaveBeenCalled();
    const daily = listEvents(getWorkspace().db, "daily.run", 5);
    expect(JSON.parse(daily[0].payload)).toMatchObject({ dryRun: true, sent: 0, ready: 2 });
  });

  it("sends nothing when the campaign is assisted", async () => {
    setMode("assisted");
    stubBoard(2, true, true);
    const report = await runDaily({ notify: false });
    expect(report.sent).toEqual([]);
    expect(report.ready.map((line) => line.detail)).toEqual(["campaign mode is assisted", "campaign mode is assisted"]);
    expect(runApplicationForm).not.toHaveBeenCalled();
  });

  it("sends the complete, rules-authorised applications in auto mode", async () => {
    setMode("auto");
    runApplicationForm.mockResolvedValue(submittedRun());
    stubBoard(2, true, true);
    const report = await runDaily({ notify: false });
    expect(report.sent.map((line) => line.title).sort()).toEqual([
      "Senior Security Engineer, Detection",
      "Senior Security Engineer, Platform",
    ]);
    expect(report.person).toHaveLength(1);
    expect(runApplicationForm).toHaveBeenCalledTimes(2);
    expect(runApplicationForm.mock.calls[0][1]).toMatchObject({ submit: true, headless: true });
    const sent = listEvents(getWorkspace().db, "submission.submitted", 5);
    for (const event of sent) expect(JSON.parse(event.payload)).toMatchObject({ authorisedBy: "rules" });
  });
});
