import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeCompanies } from "../src/config/companies.js";
import { onboardingQuestions, suggestedPreset } from "../src/config/onboarding.js";
import { PACKAGE_ROOT, PRESETS, presetCampaign, presetCompanies } from "../src/config/presets.js";
import { CampaignSchema, CompanyListSchema } from "../src/domain/campaign.js";
import { dailyApplyText, onboardText } from "../src/harness/prompts.js";

/**
 * load_preset's merge and the packaging that lets an npx install reach the
 * shipped presets. Every company and person here is fictional.
 */

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function tempFile(name: string, value?: unknown): string {
  dir = mkdtempSync(join(tmpdir(), "autoapply-preset-"));
  const path = join(dir, name);
  if (value !== undefined) writeFileSync(path, JSON.stringify(value));
  return path;
}

const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { version: number; companies: Array<Record<string, unknown>> };

describe("mergeCompanies", () => {
  const incoming = [
    { name: "Ejemplo Labs", ats: "greenhouse", board: "ejemplolabs", tier: "A" },
    { name: "Otra Cosa", ats: "lever", board: "otracosa" },
    { name: "otra cosa", ats: "lever", board: "otracosa-dup" },
    { name: "Renamed Board Co", ats: "ashby", board: "mine" },
  ];

  it("adds each company once and counts the rest as already there", () => {
    const path = tempFile("companies.json", { version: 1, companies: [] });
    const result = mergeCompanies(path, incoming);
    expect(result.added).toEqual(["Ejemplo Labs", "Otra Cosa", "Renamed Board Co"]);
    expect(result.alreadyPresent).toBe(1);
    expect(read(path).companies.map((entry) => entry.name)).toEqual(["Ejemplo Labs", "Otra Cosa", "Renamed Board Co"]);

    const again = mergeCompanies(path, incoming);
    expect(again.added).toEqual([]);
    expect(again.alreadyPresent).toBe(incoming.length);
    expect(read(path).companies).toHaveLength(3);
  });

  it("keeps the person's entries as written, an inactive one included", () => {
    const mine = [
      { name: "EJEMPLO LABS", ats: "greenhouse", board: "ejemplo-corrected", query: "madrid" },
      { name: "Otra Cosa", ats: "lever", board: "otracosa", active: false },
      { name: "My Own Name", ats: "ashby", board: "mine" },
    ];
    const path = tempFile("companies.json", { version: 1, companies: mine });
    const result = mergeCompanies(path, incoming);
    expect(result.added).toEqual([]);
    expect(result.alreadyPresent).toBe(4);
    expect(read(path).companies).toEqual(mine);
  });

  it("keeps a backup when it adds to an existing file", () => {
    const path = tempFile("companies.json", { version: 1, companies: [{ name: "Mine", ats: "lever", board: "mine" }] });
    const result = mergeCompanies(path, incoming.slice(0, 1));
    expect(result.backup).toBe(`${path}.bak`);
    expect(read(`${path}.bak`).companies.map((entry) => entry.name)).toEqual(["Mine"]);
    expect(read(path).companies.map((entry) => entry.name)).toEqual(["Mine", "Ejemplo Labs"]);
  });

  it("creates a missing companies.json", () => {
    const path = tempFile("companies.json");
    const result = mergeCompanies(path, incoming.slice(0, 2));
    expect(result.created).toBe(true);
    expect(result.backup).toBeNull();
    expect(CompanyListSchema.parse(read(path)).companies).toHaveLength(2);
  });

  it("refuses to write over a companies file that does not validate", () => {
    const path = tempFile("companies.json", { version: 1, companies: [{ name: "No board" }] });
    const before = readFileSync(path, "utf8");
    expect(() => mergeCompanies(path, incoming)).toThrow(/failed validation/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("shipped presets", () => {
  it("reads the Spain list from the package directory, with no duplicate names", () => {
    const companies = presetCompanies("spain");
    expect(companies.length).toBeGreaterThan(50);
    const names = companies.map((entry) => String(entry.name).toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("points every track at a resume the profile has, and leaves one that already does", () => {
    const profile = { resumes: [{ id: "general", isDefault: false }, { id: "cv", isDefault: true }] };
    const tracks = presetCampaign("spain", profile).tracks as Array<{ resumeId: string }>;
    expect(new Set(tracks.map((track) => track.resumeId))).toEqual(new Set(["cv"]));
    expect(CampaignSchema.safeParse(presetCampaign("spain", profile)).success).toBe(true);

    const keeps = presetCampaign("spain", { resumes: [{ id: "backend" }, { id: "cv", isDefault: true }] });
    expect((keeps.tracks as Array<{ resumeId: string }>).every((track) => track.resumeId === "backend")).toBe(true);
    expect((presetCampaign("spain", null).tracks as Array<{ resumeId: string }>)[0]!.resumeId).toBe("backend");
  });

  it("ships presets/ and examples/ in the npm package and runs init as a bin", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { files: string[]; bin: Record<string, string> };
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "presets", "examples"]));
    for (const preset of Object.values(PRESETS)) {
      for (const file of [preset.campaign, preset.companies]) {
        expect(pkg.files.some((entry) => file === entry || file.startsWith(`${entry}/`))).toBe(true);
        expect(existsSync(join(PACKAGE_ROOT, file))).toBe(true);
      }
    }
    expect(pkg.bin["autoapply-mcp-init"]).toBe("dist/cli/init.js");
    // npm 11 drops a bin whose path starts with "./".
    for (const path of Object.values(pkg.bin)) expect(path.startsWith("./")).toBe(false);
    expect(readFileSync(join(PACKAGE_ROOT, "src", "cli", "init.ts"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});

describe("onboarding gap for companies", () => {
  const empty = { version: 1, companies: [] };

  it("reports no companies as a gap the agent fixes with load_preset, not a question", () => {
    const report = onboardingQuestions({ identity: { location: { country: "ES" } } }, null, { env: {}, companies: empty });
    expect(report.agentFixes).toEqual([
      expect.objectContaining({ field: "companies", gap: "no companies configured", fix: { tool: "load_preset", arguments: { preset: "spain" } } }),
    ]);
    expect(report.complete).toBe(false);
    expect(report.message).not.toMatch(/load_preset|compan/i);
  });

  it("suggests spain from the campaign, and nothing when neither file says where", () => {
    expect(suggestedPreset({ identity: { location: { country: "Spain" } } }, null)).toBe("spain");
    expect(suggestedPreset(null, { locations: { allow: ["remote-europe", "spain"] } })).toBe("spain");
    expect(suggestedPreset({ identity: { location: { country: "CA" } } }, null)).toBe("us-canada");
    expect(suggestedPreset(null, null)).toBeNull();
    const report = onboardingQuestions(null, null, { env: {}, companies: null });
    expect(report.agentFixes[0]!.fix).toEqual({ tool: "load_preset", arguments: {} });
  });

  it("counts only active companies, and checks nothing when the list is not given", () => {
    const inactive = { version: 1, companies: [{ name: "Off", ats: "lever", board: "off", active: false }] };
    expect(onboardingQuestions(null, null, { env: {}, companies: inactive }).agentFixes).toHaveLength(1);
    const on = { version: 1, companies: [{ name: "On", ats: "lever", board: "on" }] };
    expect(onboardingQuestions(null, null, { env: {}, companies: on }).agentFixes).toEqual([]);
    expect(onboardingQuestions(null, null, { env: {} }).agentFixes).toEqual([]);
  });
});

describe("prompts", () => {
  it("tell the agent to load the Spain preset during setup and before a daily run with no companies", () => {
    expect(onboardText()).toMatch(/load_preset with preset spain/);
    expect(onboardText().indexOf("load_preset")).toBeLessThan(onboardText().indexOf("update_campaign with"));
    expect(dailyApplyText()).toMatch(/load_preset first \(preset spain/);
  });
});
