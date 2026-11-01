import type { Company } from "../domain/campaign.js";
import type { CompensationRange, Job, WorkplaceType } from "../domain/job.js";
import { decodeEntitiesOnce } from "../text/html.js";
import { AppError } from "../util/errors.js";
import { fetchJson, fetchText } from "./http.js";
import { asString, epochToIso, normalizeJob } from "./normalize.js";
import { leverDescription, type LeverDescription } from "./leverDescription.js";
import type { SourceAdapter } from "./types.js";

/**
 * Lever Postings API (public).
 * https://github.com/lever/postings-api
 *
 * Postings are public; applications go through the Lever-hosted form.
 */

function base(company: Company): string {
  return company.region === "eu" ? "https://api.eu.lever.co/v0/postings" : "https://api.lever.co/v0/postings";
}

type LeverSalary = { min?: unknown; max?: unknown; currency?: unknown; interval?: unknown };
type LeverPosting = LeverDescription & {
  id?: unknown;
  text?: unknown;
  hostedUrl?: unknown;
  applyUrl?: unknown;
  createdAt?: unknown;
  workplaceType?: unknown;
  salaryRange?: LeverSalary;
  categories?: {
    location?: unknown;
    allLocations?: unknown;
    commitment?: unknown;
    team?: unknown;
    department?: unknown;
  };
};

const INTERVAL_MAP: Record<string, CompensationRange["period"]> = {
  "per-year-salary": "year",
  "per-month-salary": "month",
  "per-hour-wage": "hour",
};

function structuredPay(posting: LeverPosting): CompensationRange | null {
  const salary = posting.salaryRange;
  if (!salary) return null;
  const min = typeof salary.min === "number" ? salary.min : null;
  const max = typeof salary.max === "number" ? salary.max : null;
  if (min === null && max === null) return null;
  return {
    min,
    max,
    currency: (asString(salary.currency, "USD") || "USD").toUpperCase().slice(0, 3),
    period: INTERVAL_MAP[asString(salary.interval).toLowerCase()] ?? "year",
    source: "ats-structured",
    raw: `lever salaryRange ${asString(salary.interval)}`,
  };
}

function workplaceType(posting: LeverPosting): WorkplaceType {
  const value = asString(posting.workplaceType).toLowerCase();
  if (value === "remote" || value === "hybrid" || value === "onsite") return value;
  return "unknown";
}

function locations(posting: LeverPosting): string[] {
  const all = Array.isArray(posting.categories?.allLocations)
    ? posting.categories.allLocations.filter((item): item is string => typeof item === "string")
    : [];
  const primary = asString(posting.categories?.location);
  return [...new Set([primary, ...all].filter((value) => value.length > 0))];
}

export const leverAdapter: SourceAdapter = {
  kind: "lever",

  listUrl(company: Company): string {
    return `${base(company)}/${encodeURIComponent(company.board)}?mode=json`;
  },

  boardUrl(company: Company): string {
    const host = company.region === "eu" ? "https://jobs.eu.lever.co" : "https://jobs.lever.co";
    return `${host}/${encodeURIComponent(company.board)}`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const postings = await fetchJson<LeverPosting[]>(this.listUrl(company));
    if (!Array.isArray(postings)) return [];
    return postings.map((posting) => {
      return normalizeJob(
        {
          company,
          externalId: asString(posting.id),
          title: asString(posting.text),
          locations: locations(posting),
          url: asString(posting.hostedUrl),
          applyUrl: asString(posting.applyUrl) || asString(posting.hostedUrl),
          descriptionPlain: leverDescription(posting),
          postedAt: epochToIso(posting.createdAt),
          workplaceType: workplaceType(posting),
          employmentType: asString(posting.categories?.commitment),
          structuredCompensation: structuredPay(posting),
        },
        capturedAt,
      );
    });
  },

  probeUrls(slug: string): string[] {
    return [
      `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json&limit=1`,
      `https://api.eu.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json&limit=1`,
    ];
  },
};

/**
 * One posting's hosted apply page. Lever's postings API publishes no
 * questions, but the page carries each custom question card's definition as
 * JSON, so the form can be drafted before the browser opens.
 */
export async function fetchLeverApplyPage(applyUrl: string): Promise<string> {
  const url = new URL(applyUrl);
  if (!/^jobs(?:\.eu)?\.lever\.co$/i.test(url.hostname)) {
    throw new AppError("unsupported_host", `not a Lever hosted posting: ${url.hostname}`);
  }
  if (!url.pathname.endsWith("/apply")) url.pathname = `${url.pathname.replace(/\/$/, "")}/apply`;
  return fetchText(url.toString());
}

/** A Lever apply page as data: its named inputs, and its custom question cards. */
export type LeverApplyForm = {
  inputs: Array<{ name: string; required: boolean }>;
  cards: Array<{ id: string; title: string; fields: Array<Record<string, unknown>> }>;
};

/** One attribute's value. It must start its own token: `data-name` is not `name`. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match ? (match[1] ?? match[2]) : undefined;
}

/** A `required` attribute of its own, or aria-required="true"; aria-required="false" is not one. */
function isRequired(tag: string): boolean {
  return /\srequired(?=[\s=/>]|$)/i.test(tag) || attribute(tag, "aria-required")?.toLowerCase() === "true";
}

/**
 * Reads a Lever apply page. Custom questions come from each card's
 * `baseTemplate`, a hidden input whose value is the card's JSON definition;
 * every other named input is reported with whether it is required.
 */
export function parseLeverApplyPage(page: string): LeverApplyForm {
  const form: LeverApplyForm = { inputs: [], cards: [] };
  for (const tag of page.match(/<(?:input|textarea)\b[^>]*>/gi) ?? []) {
    const name = attribute(tag, "name");
    if (!name) continue;
    const card = /^cards\[([^\]]+)\]\[baseTemplate\]$/.exec(name)?.[1];
    if (!card) {
      form.inputs.push({ name, required: isRequired(tag) });
      continue;
    }
    try {
      const template = JSON.parse(decodeEntitiesOnce(attribute(tag, "value") ?? "")) as { text?: unknown; fields?: unknown };
      const fields = Array.isArray(template.fields)
        ? template.fields.filter((field): field is Record<string, unknown> => typeof field === "object" && field !== null)
        : [];
      form.cards.push({ id: card, title: String(template.text ?? "").trim().replace(/:$/, ""), fields });
    } catch {
      // A card whose definition is not JSON asks nothing that can be drafted.
    }
  }
  return form;
}

/** The posting's apply form, read before the browser opens. */
export async function fetchLeverApplicationForm(applyUrl: string): Promise<LeverApplyForm> {
  return parseLeverApplyPage(await fetchLeverApplyPage(applyUrl));
}
