#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolvePaths, type WorkspacePaths } from "../config/paths.js";
import { DEFAULT_PRESET, isPresetName, PACKAGE_ROOT, PRESETS, type PresetName } from "../config/presets.js";
import { toErrorMessage } from "../util/errors.js";

/**
 * Scaffolds a personal configuration directory from the shipped examples.
 *
 * Setting this up by hand means knowing that three files are required, where
 * they live, which example seeds which one, and that the company list comes from
 * a preset rather than an example - four facts that are only written down in the
 * README. Copying them wrongly produces a server that starts and then fails on
 * first use, so the work is done here instead.
 *
 * Existing files are never overwritten. A partially configured home is the
 * normal case for someone adding a second campaign, and silently replacing a
 * profile that took an hour to write would be unforgivable.
 *
 * This is a CLI, so writing to stdout is correct here.
 */

export { DEFAULT_PRESET, isPresetName, PRESETS, type PresetName };

type Seed = { target: string; source: string; label: string };

function copySeed(seed: Seed): { ok: boolean; detail: string } {
  if (!existsSync(seed.source)) {
    return { ok: false, detail: `template missing at ${seed.source}; run "npm run build" from a complete checkout` };
  }
  if (existsSync(seed.target)) {
    return { ok: true, detail: "already present, left untouched" };
  }
  mkdirSync(dirname(seed.target), { recursive: true });
  copyFileSync(seed.source, seed.target);
  return { ok: true, detail: `created from ${seed.label}` };
}

export type InitResult = { ok: boolean; lines: string[] };

/** Seeds a home from one preset. Exported so the copy rules are tested without spawning the CLI. */
export function initHome(paths: WorkspacePaths, preset: PresetName, root: string = PACKAGE_ROOT): InitResult {
  const chosen = PRESETS[preset];
  const seeds: Seed[] = [
    { target: paths.profile, source: join(root, "examples", "profile.example.json"), label: "examples/profile.example.json" },
    { target: paths.campaign, source: join(root, chosen.campaign), label: chosen.campaign },
    { target: paths.companies, source: join(root, chosen.companies), label: chosen.companies },
  ];

  const lines: string[] = [];
  let failed = 0;
  for (const seed of seeds) {
    const result = copySeed(seed);
    if (!result.ok) failed += 1;
    lines.push(`${result.ok ? "OK  " : "FAIL"}  ${seed.target} - ${result.detail}`);
  }

  mkdirSync(join(paths.home, "resumes"), { recursive: true });
  mkdirSync(paths.artifacts, { recursive: true });
  mkdirSync(dirname(paths.database), { recursive: true });
  lines.push(`OK    ${join(paths.home, "resumes")} - ready for your resume PDFs`);
  return { ok: failed === 0, lines };
}

function main(): void {
  const { values } = parseArgs({
    options: { preset: { type: "string", default: DEFAULT_PRESET }, force: { type: "boolean", default: false } },
  });
  if (values.force) {
    console.error("init does not overwrite existing files; remove them by hand if that is really what you want.");
    process.exitCode = 1;
    return;
  }
  if (!isPresetName(values.preset)) {
    console.error(`unknown preset "${values.preset}"; choose one of: ${Object.keys(PRESETS).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const paths = resolvePaths();
  console.log(`autoapply-mcp init\nhome: ${paths.home}\npreset: ${values.preset}\n`);
  const result = initHome(paths, values.preset);
  for (const line of result.lines) console.log(line);
  if (!result.ok) {
    process.exitCode = 1;
    return;
  }

  console.log(
    [
      "",
      "Next, in order:",
      "  1. Edit profile.json - replace the placeholders in identity, workAuthorization,",
      "     compensation, experience, education, skills and facts, then review answers[].",
      "     Every drafted answer must trace back to something in this file.",
      "  2. Put your resume PDFs in resumes/ and point profile.resumes[].path at them.",
      "  3. Edit campaign.json - tracks, locations, compensation floor, submission policy.",
      "     Each track's resumeId must name a variant declared in profile.resumes.",
      "  4. Trim companies.json to the employers you actually want to apply to.",
      "  5. Verify: node dist/cli/doctor.js --probe",
      "",
      "doctor validates all three files, confirms your resumes exist and are real",
      "PDFs, checks every track resolves to a resume, warns about settings written",
      "in the wrong place, and probes each configured board.",
      "",
      "Submission is automatic: an application you have approved is sent by the agent.",
      "Listing companies in submission.allowedCompanies limits that to those companies.",
      ...(values.preset === "spain"
        ? [
            "",
            "Spain preset: set profile.compensation.currency to EUR and list ES (and any other",
            "EU country you may work in) in workAuthorization.authorizedIn. The campaign's",
            "60,000 EUR floor and seniority rules are explained in docs/CONFIGURATION.md.",
          ]
        : []),
    ].join("\n"),
  );
}

// Run only as the CLI, so tests can import initHome without seeding a real home.
// realpath, because a global npm install can reach this file through a symlink.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(toErrorMessage(error));
    process.exitCode = 1;
  }
}
