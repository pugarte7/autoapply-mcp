import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CompanySchema } from "../domain/campaign.js";
import { fetchJson } from "../sources/http.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { isPlainObject, readRawJson } from "./configFiles.js";

/**
 * The shipped presets, read from the installed package.
 *
 * An `npx -y autoapply-mcp` install has no checkout and no working directory
 * to resolve against, only the package directory npm unpacked. Both src/ (under
 * vitest) and dist/ (once built) sit one level below it, so the root is two
 * levels up from this file either way, and package.json `files` ships presets/
 * and examples/ beside dist/.
 */

const here = dirname(fileURLToPath(import.meta.url));
// dist/config/presets.js (or src/config/presets.ts under test) -> package root
export const PACKAGE_ROOT = resolve(here, "..", "..");

/**
 * A preset is a campaign and the company list it was written for. They are
 * chosen together because they only make sense together: the Spain campaign
 * admits postings in Spain and remote in Europe, in euros, and the US/Canada
 * list has almost none, so mixing them gives a campaign that discovers nothing.
 *
 * us-canada stays the default so `init` with no flag does what it always did.
 * No default is guessed from the profile: init runs before the profile is
 * written, and a guess would be wrong for every person who has not filled it in.
 */
export const PRESETS = {
  "us-canada": {
    campaign: "examples/campaign.example.json",
    companies: "presets/ai-security-us-canada.json",
  },
  spain: {
    campaign: "examples/campaign.spain.example.json",
    companies: "presets/spain.json",
    url: "https://spanishtoptechcompanies.com/api/v1/boards.json",
  },
} as const;
export type PresetName = keyof typeof PRESETS;
export const DEFAULT_PRESET: PresetName = "us-canada";
export const PRESET_NAMES = Object.keys(PRESETS) as [PresetName, ...PresetName[]];

export function isPresetName(value: string): value is PresetName {
  return Object.hasOwn(PRESETS, value);
}

function readShipped(relative: string, root: string): Record<string, unknown> {
  const path = join(root, relative);
  const raw = readRawJson(path);
  if (!raw) throw new AppError("preset_missing", `${relative} is missing from the installed package at ${root}; reinstall autoapply-mcp`);
  return raw;
}

/**
 * The preset's company entries as the file writes them. Each is validated
 * here so a broken shipped list fails before anything is written, but the raw
 * entry is what gets merged, so defaults are not spelled out in the person's file.
 */
export function presetCompanies(preset: PresetName, root: string = PACKAGE_ROOT): Record<string, unknown>[] {
  return listedCompanies(readShipped(PRESETS[preset].companies, root));
}

const COMPANY_KEYS = ["name", "ats", "board", "tier", "tags", "region", "query"];

function listedCompanies(raw: Record<string, unknown>): Record<string, unknown>[] {
  const companies = Array.isArray(raw.companies) ? raw.companies.filter(isPlainObject) : [];
  for (const company of companies) CompanySchema.parse(company);
  // Only the fields companies.json has: a list from the network may carry more.
  return companies.map((company) => Object.fromEntries(COMPANY_KEYS.filter((key) => key in company).map((key) => [key, company[key]])));
}

export type PresetList = {
  companies: Record<string, unknown>[];
  /** The URL the list was read from, or "shipped" for the copy in the package. */
  source: string;
  /** Why the published list was not used, when the preset has one. */
  fallback?: string;
};

/**
 * The preset's companies, from the list its source publishes when it has one.
 *
 * spanishtoptechcompanies.com publishes the Spain list with that day's
 * ranking, so a company the site adds reaches every install without a new
 * release of this package. The copy shipped in the package is the fallback
 * for when the site cannot be read or serves something that is not a list.
 */
export async function loadPresetCompanies(
  preset: PresetName,
  fetchList: (url: string) => Promise<unknown> = (url) =>
    fetchJson<unknown>(url, { timeoutMs: 15_000, retries: 1, allowedHosts: [new URL(url).hostname] }),
  root: string = PACKAGE_ROOT,
): Promise<PresetList> {
  const chosen = PRESETS[preset];
  const url = "url" in chosen ? chosen.url : null;
  let fallback: string | undefined;
  if (url) {
    try {
      const raw = await fetchList(url);
      const companies = isPlainObject(raw) ? listedCompanies(raw) : [];
      if (companies.length > 0) return { companies, source: url };
      fallback = `${url} listed no companies`;
    } catch (error) {
      fallback = `${url} could not be read: ${toErrorMessage(error)}`;
    }
  }
  return { companies: presetCompanies(preset, root), source: "shipped", ...(fallback ? { fallback } : {}) };
}

/**
 * The preset's campaign, with each track pointed at a resume the profile has.
 *
 * The examples name a `backend` resume that almost nobody's profile declares,
 * and a track whose resume does not exist fails the first prepare_application.
 * A track already naming one of the person's resumes is left alone.
 */
export function presetCampaign(
  preset: PresetName,
  profile: Record<string, unknown> | null,
  root: string = PACKAGE_ROOT,
): Record<string, unknown> {
  const campaign = readShipped(PRESETS[preset].campaign, root);
  const resumes = (Array.isArray(profile?.resumes) ? profile.resumes : []).filter(isPlainObject);
  const ids = resumes.map((resume) => resume.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0 || !Array.isArray(campaign.tracks)) return campaign;
  const marked = resumes.find((resume) => resume.isDefault === true && ids.includes(resume.id as string));
  const fallback = (marked?.id as string | undefined) ?? ids[0]!;
  for (const track of campaign.tracks.filter(isPlainObject)) {
    if (typeof track.resumeId !== "string" || !ids.includes(track.resumeId)) track.resumeId = fallback;
  }
  return campaign;
}
