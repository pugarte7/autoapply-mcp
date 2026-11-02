import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CompanySchema } from "../domain/campaign.js";
import { AppError } from "../util/errors.js";
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
  const raw = readShipped(PRESETS[preset].companies, root);
  const companies = Array.isArray(raw.companies) ? raw.companies.filter(isPlainObject) : [];
  for (const company of companies) CompanySchema.parse(company);
  return companies;
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
