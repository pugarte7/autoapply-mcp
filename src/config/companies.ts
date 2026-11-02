import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { CompanyListSchema, CompanySchema, type Company } from "../domain/campaign.js";
import { AppError } from "../util/errors.js";
import { isPlainObject, readRawJson, writeJsonAtomic } from "./configFiles.js";

/**
 * Writes companies.json.
 *
 * Board lists grow as new employers are found, and the file is hand-edited too,
 * so writes preserve whatever is already there and never rewrite unrelated
 * entries. The write is staged through a temporary file and renamed, because a
 * process dying mid-write would otherwise leave the campaign with a truncated
 * board list and no way to discover anything.
 */

/** Strips a byte-order mark, which some Windows editors add and JSON.parse rejects. */
function readText(path: string): string {
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
}

export function readCompanyFile(path: string): Company[] {
  if (!existsSync(path)) return [];
  const parsed = CompanyListSchema.safeParse(JSON.parse(readText(path)));
  if (!parsed.success) {
    throw new AppError("config_invalid", `companies file at ${path} failed validation`, { path });
  }
  return parsed.data.companies;
}

function writeCompanyFile(path: string, companies: Company[]): void {
  const body = `${JSON.stringify({ version: 1, companies }, null, 2)}\n`;
  const staged = `${path}.tmp`;
  // UTF-8 without a BOM: Node writes none by default, and adding one here would
  // make the file unreadable to the loader on the next run.
  writeFileSync(staged, body, "utf8");
  renameSync(staged, path);
}

export type AddBoardResult = {
  action: "added" | "updated";
  company: Company;
  total: number;
};

/**
 * Adds a verified board, or updates the existing entry for that company.
 *
 * Matching is by name, case-insensitively, so re-adding a company corrects its
 * board rather than silently creating a duplicate that would then be fetched
 * twice and surface every posting twice in the queue.
 */
export function upsertCompany(path: string, candidate: unknown): AddBoardResult {
  const company = CompanySchema.parse(candidate);
  const companies = readCompanyFile(path);
  const index = companies.findIndex((entry) => entry.name.toLowerCase() === company.name.toLowerCase());

  const next = [...companies];
  const action: AddBoardResult["action"] = index >= 0 ? "updated" : "added";
  if (index >= 0) next[index] = company;
  else next.push(company);

  writeCompanyFile(path, next);
  return { action, company, total: next.length };
}

export type MergeResult = {
  path: string;
  created: boolean;
  added: string[];
  alreadyPresent: number;
  total: number;
  backup: string | null;
};

const nameKey = (entry: Record<string, unknown>) => `name:${String(entry.name ?? "").trim().toLowerCase()}`;
const boardKey = (entry: Record<string, unknown>) =>
  `board:${String(entry.ats ?? "").toLowerCase()}|${String(entry.board ?? "").trim().toLowerCase()}`;

/**
 * Adds a list of boards to companies.json without touching what is there.
 *
 * Unlike upsertCompany, an entry already present wins: these lists arrive in
 * bulk from a preset, and the person's own entry for a company (a corrected
 * board, a search query, `active: false` to stop fetching it) is a decision a
 * shipped list must not undo. A company counts as present by name,
 * case-insensitively, or by the same board under another name, which would
 * otherwise be fetched twice and surface every posting twice. The person's
 * entries are written back as they were, not as parsed, so their defaults stay
 * unwritten; the previous file is kept as companies.json.bak.
 */
export function mergeCompanies(path: string, incoming: readonly Record<string, unknown>[]): MergeResult {
  const raw = readRawJson(path);
  if (raw && !CompanyListSchema.safeParse(raw).success) {
    throw new AppError("config_invalid", `companies file at ${path} failed validation; fix it before loading a preset`, { path });
  }
  const existing = (Array.isArray(raw?.companies) ? raw.companies : []).filter(isPlainObject);
  const seen = new Set(existing.flatMap((entry) => [nameKey(entry), boardKey(entry)]));
  const added: Record<string, unknown>[] = [];
  for (const entry of incoming) {
    if (seen.has(nameKey(entry)) || seen.has(boardKey(entry))) continue;
    seen.add(nameKey(entry));
    seen.add(boardKey(entry));
    added.push(entry);
  }
  const companies = [...existing, ...added];
  if (!raw || added.length > 0) writeJsonAtomic(path, { ...(raw ?? { version: 1 }), companies });
  return {
    path,
    created: !raw,
    added: added.map((entry) => String(entry.name)),
    alreadyPresent: incoming.length - added.length,
    total: companies.length,
    backup: raw && added.length > 0 ? `${path}.bak` : null,
  };
}
