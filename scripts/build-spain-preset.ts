/**
 * Rebuilds presets/spain.json from spanishtoptechcompanies.com's published
 * aggregates. Usage, from a built checkout:
 *
 *   npm run build && node scripts/build-spain-preset.ts
 *   node scripts/build-spain-preset.ts --limit 20 --out /tmp/spain.json
 *   node scripts/build-spain-preset.ts --resume   # continue an interrupted run
 *   node scripts/build-spain-preset.ts --resume --redo "BBVA,Airbus" --reuse-guesses
 *   node scripts/build-spain-preset.ts --site-boards ../spanish-top-tech-companies/data/boards.json
 *
 * --site-boards also writes each kept board into the salary site's
 * data/boards.json, keyed by Levels.fyi slug, which the site publishes at
 * /api/v1/boards.json with that day's tiers and load_preset spain downloads.
 * Companies this run probed are set or removed there; the rest are kept.
 *
 * The rules live in src/presets/spain.ts; this file only wires them to the
 * network through the server's own resolver, adapters and polite HTTP client,
 * so a probe here is exactly the request the server would make. A full run
 * makes several thousand requests across four ATS hosts and takes the better
 * part of an hour at the client's per-host interval; that is the price of not
 * hammering anyone. The report is rewritten after every company so --resume
 * can pick up where a dead run stopped.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Company } from "../dist/domain/campaign.js";

// Before the server's modules read them. Workday reads every posting's detail
// page, so a probe stops at 60 postings rather than the discovery default.
process.env.AUTOAPPLY_MIN_INTERVAL_MS ??= "700";
process.env.AUTOAPPLY_WORKDAY_MAX_POSTINGS ??= "60";
if (Number(process.env.AUTOAPPLY_MIN_INTERVAL_MS) < 500) process.env.AUTOAPPLY_MIN_INTERVAL_MS = "500";

const { fetchJson, fetchText } = await import("../dist/sources/http.js");
const { adapterFor, resolveBoards } = await import("../dist/sources/registry.js");
const { nowIso } = await import("../dist/util/hash.js");
const spain = await import("../dist/presets/spain.js");

const SITE_DATA = "https://raw.githubusercontent.com/pugarte7/spanish-top-tech-companies/main/data";

const { values } = parseArgs({
  options: {
    data: { type: "string", default: `${SITE_DATA}/data.json` },
    tables: { type: "string", default: `${SITE_DATA}/companies.json` },
    out: { type: "string", default: "presets/spain.json" },
    // Outside presets/, which is published to npm.
    report: { type: "string", default: join(tmpdir(), "autoapply-spain-preset-report.json") },
    limit: { type: "string" },
    only: { type: "string" },
    resume: { type: "boolean", default: false },
    // With --resume: probe these companies again instead of keeping their earlier result.
    redo: { type: "string" },
    // The same, one name per line, for names with commas in them ("Aetion, a Datavant Company").
    "redo-file": { type: "string" },
    // With --redo: list the boards the earlier run's guesses found instead of probing every slug again.
    "reuse-guesses": { type: "boolean", default: false },
    "no-websites": { type: "boolean", default: false },
    "site-boards": { type: "string" },
  },
});

async function load(source: string): Promise<unknown> {
  if (/^https:\/\//.test(source)) return fetchJson<unknown>(source, { timeoutMs: 60_000 });
  return JSON.parse(readFileSync(source, "utf8"));
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    return await fetchText(url, { retries: 1, timeoutMs: 12_000, maxBytes: 3 * 1024 * 1024 });
  } catch {
    return null;
  }
}

const snapshot = spain.readSiteSnapshot(await load(values.data), await load(values.tables));
let companies = snapshot.companies;
if (values.only) {
  const wanted = new Set(values.only.split(",").map((name) => name.trim().toLowerCase()));
  companies = companies.filter((company) => wanted.has(company.name.toLowerCase()));
}
if (values.limit) companies = companies.slice(0, Number.parseInt(values.limit, 10));

type Report = { dataAsOf: string; companies: Awaited<ReturnType<typeof spain.probeCompany>>[] };
const previous: Report | null = values.resume && existsSync(values.report) ? JSON.parse(readFileSync(values.report, "utf8")) : null;
const redoNames = [
  ...(values.redo ?? "").split(","),
  ...(values["redo-file"] ? readFileSync(values["redo-file"], "utf8").split("\n") : []),
];
const redo = new Set(redoNames.map((name) => name.trim().toLowerCase()).filter(Boolean));
const reports = (previous?.companies ?? []).filter((report) => !redo.has(report.name.toLowerCase()));
const done = new Set(reports.map((report) => report.name));

// Slugs an earlier version guessed from a website that was itself an ATS link.
const ATS_NAMES = new Set(["greenhouse", "lever", "ashbyhq", "smartrecruiters", "workable", "recruitee", "myworkdayjobs"]);
const earlierGuesses = new Map(
  (previous?.companies ?? []).map((report) => [
    report.name,
    report.candidates
      .filter((candidate) => candidate.source === "guess" && !ATS_NAMES.has(candidate.board.toLowerCase()))
      .map((candidate) => ({
        ats: candidate.ats,
        board: candidate.board,
        url: candidate.region === "eu" ? "https://api.eu.lever.co/v0/postings/" : "",
      })),
  ]),
);

const capturedAt = nowIso();
const deps = {
  resolve: async (name: string, extra: readonly string[]) =>
    values["reuse-guesses"] && redo.has(name.toLowerCase()) && earlierGuesses.has(name)
      ? (earlierGuesses.get(name) ?? [])
      : resolveBoards(name, extra),
  listJobs: (company: Company) => adapterFor(company.ats).listJobs(company, capturedAt),
  ...(values["no-websites"] ? {} : { fetchPage }),
};

let index = 0;
for (const company of companies) {
  index += 1;
  if (done.has(company.name)) continue;
  const report = await spain.probeCompany(company, snapshot.rules, deps);
  reports.push(report);
  writeFileSync(values.report, `${JSON.stringify({ dataAsOf: snapshot.rules.dataAsOf, companies: reports }, null, 2)}\n`);
  const kept = report.kept ? `kept ${report.kept.ats}/${report.kept.board}` : "none";
  process.stderr.write(`[${index}/${companies.length}] ${company.name}: ${report.candidates.length} board(s), ${kept}\n`);
}

const preset = spain.assemblePreset(reports);
writeFileSync(values.out, `${JSON.stringify(preset, null, 2)}\n`);
if (values["site-boards"]) {
  const path = values["site-boards"];
  const boards: Record<string, Record<string, string>> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const slugOf = new Map(snapshot.companies.map((company) => [company.name, company.levelsSlug]));
  const kept = new Map(preset.companies.map((entry) => [entry.name, entry]));
  for (const report of reports) {
    const slug = slugOf.get(report.name);
    if (!slug) continue;
    const entry = kept.get(report.name);
    if (!entry) {
      delete boards[slug];
      continue;
    }
    boards[slug] = { ats: entry.ats, board: entry.board, ...(entry.region ? { region: entry.region } : {}), ...(entry.query ? { query: entry.query } : {}) };
  }
  // One company per line, sorted by slug, so the site's diff shows what changed.
  const lines = Object.keys(boards)
    .sort()
    .map((slug) => `  ${JSON.stringify(slug)}: ${JSON.stringify(boards[slug])}`);
  writeFileSync(path, `{\n${lines.join(",\n")}\n}\n`);
}
console.log(JSON.stringify({ dataAsOf: snapshot.rules.dataAsOf, out: values.out, ...spain.summarize(reports, preset) }, null, 2));
