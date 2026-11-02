import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ZodType } from "zod";
import { AppError } from "../util/errors.js";

/**
 * Raw reads, merges and writes of profile.json and campaign.json.
 *
 * The setup tools exist for clients that cannot touch files, which makes these
 * the only writers those people have. Three rules follow. A write never
 * destroys the previous file: it is kept as `<file>.bak`, so a bad merge is one
 * rename away from undone. A write is staged and renamed, so a crash cannot
 * leave a truncated profile that stops the server loading at all. And what is
 * written is the person's own file with the patch merged in, not the schema's
 * parsed output, so hand-written keys, ordering and omitted defaults survive.
 */

export function readRawJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AppError("config_invalid_json", `${path} is not valid JSON: ${String(error)}`, { path });
  }
  if (!isPlainObject(parsed)) throw new AppError("config_invalid", `${path} does not hold a JSON object`, { path });
  return parsed;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const staged = `${path}.tmp`;
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(staged, path);
}

/**
 * Where an unfinished config is kept until it validates. A profile built from a
 * CV has no salary or work authorization yet, and writing it to profile.json
 * would stop every other tool loading; keeping it beside the real file lets it
 * grow across several calls instead.
 */
export function draftPathFor(path: string): string {
  return path.endsWith(".json") ? `${path.slice(0, -".json".length)}.draft.json` : `${path}.draft`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The identity of a list entry, so a patch updates the entry it names instead
 * of appending a second copy. Lists whose entries have no identity are
 * replaced whole, which is what a patch to a list of strings means.
 */
function identityOf(entry: unknown): string | null {
  if (!isPlainObject(entry)) return null;
  const text = (field: string) => (typeof entry[field] === "string" ? (entry[field] as string).trim().toLowerCase() : "");
  if (text("id")) return `id:${text("id")}`;
  if (text("key")) return `key:${text("key")}`;
  if (text("company") && text("title")) return `job:${text("company")}|${text("title")}|${text("start")}`;
  if (text("institution")) return `school:${text("institution")}|${text("credential")}`;
  if (text("name")) return `name:${text("name")}`;
  if (text("term")) return `term:${text("term")}`;
  return null;
}

function mergeLists(base: unknown[], patch: unknown[]): unknown[] {
  const ids = patch.map(identityOf);
  if (ids.some((id) => id === null) || base.some((entry) => identityOf(entry) === null)) return patch;
  const merged = [...base];
  patch.forEach((entry, index) => {
    const at = merged.findIndex((existing) => identityOf(existing) === ids[index]);
    if (at < 0) merged.push(entry);
    else merged[at] = mergeConfig(merged[at], entry);
  });
  return merged;
}

/**
 * Deep merge of a patch into a config value. Objects merge key by key, lists of
 * identified entries merge entry by entry, anything else is replaced, and a
 * `null` in the patch removes the key.
 */
export function mergeConfig(base: unknown, patch: unknown): unknown {
  if (Array.isArray(patch)) return Array.isArray(base) ? mergeLists(base, patch) : patch;
  if (!isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (value !== undefined) out[key] = mergeConfig(out[key], value);
  }
  return out;
}

/** Validation issues as short dotted lines, the form an agent can act on. */
export function issuesOf<T>(schema: ZodType<T>, value: unknown): { data: T | null; issues: string[] } {
  const result = schema.safeParse(value);
  if (result.success) return { data: result.data, issues: [] };
  return {
    data: null,
    issues: result.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
  };
}
