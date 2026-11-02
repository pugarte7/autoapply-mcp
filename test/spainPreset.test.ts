import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStrayKeys } from "../src/config/strayKeys.js";
import { CampaignSchema, CompanyListSchema, type Company } from "../src/domain/campaign.js";
import type { Job } from "../src/domain/job.js";
import { ProfileSchema } from "../src/domain/profile.js";
import { analyzeLocation } from "../src/ranking/location.js";
import { evaluateGates } from "../src/ranking/gates.js";
import { scoreJob } from "../src/ranking/score.js";
import { normalizeForMatch } from "../src/text/html.js";
import {
  assemblePreset,
  boardFromUrl,
  boardNamesCompany,
  boardsLinkedFrom,
  careersPageLinkedFrom,
  probeCompany,
  readSiteSnapshot,
  salaryTier,
  slugGuesses,
  spainPostings,
  summarize,
  type PresetDeps,
  type SiteCompany,
  type SiteRules,
} from "../src/presets/spain.js";
import { DEFAULT_PRESET, initHome, PRESETS } from "../src/cli/init.js";
import { makeJob, makeProfile } from "./factories.js";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
}

const rules: SiteRules = { threshold: 60000, companyFloor: 45000, minRanked: 3, dataAsOf: "2026-11-02" };

function siteCompany(overrides: Partial<SiteCompany> = {}): SiteCompany {
  return {
    name: "Ejemplo Labs",
    levelsSlug: "ejemplo-labs",
    website: "https://www.ejemplolabs.example",
    cities: ["Madrid"],
    engineerMedian: 70000,
    engineerCount: 8,
    ...overrides,
  };
}

function jobAt(location: string, overrides: Partial<Job> = {}): Job {
  const analysis = analyzeLocation([location]);
  return makeJob({
    locationsRaw: [location],
    locationClass: analysis.locationClass,
    country: analysis.country,
    workplaceType: analysis.workplaceType,
    compensation: null,
    ...overrides,
  });
}

describe("reading the salary site's aggregates", () => {
  const data = {
    data_as_of: "2026-11-02",
    threshold: 60000,
    company_floor: 45000,
    min_ranked: 3,
    companies: [
      { name: "Ejemplo Labs", web: "https://www.ejemplolabs.example", levels: "ejemplo-labs", linkedin: null, cities: ["Madrid"] },
      {
        name: "Otra",
        url: "https://www.levels.fyi/companies/otra/salaries",
        web: null,
        levels: "otra",
        linkedin: "https://www.linkedin.com/company/otra",
        cities: [],
      },
    ],
  };
  const tables = {
    "software-engineer": {
      fields: ["c", "n", "median", "p25", "p75"],
      cells: { "|": [[0, 12, 72000, 65000, 80000]], "|5-7": [[1, 4, 99000, null, null]] },
    },
  };

  it("joins each listed company to its all-experience engineer median", () => {
    const snapshot = readSiteSnapshot(data, tables);
    expect(snapshot.rules).toEqual(rules);
    expect(snapshot.companies[0]).toMatchObject({ name: "Ejemplo Labs", levelsSlug: "ejemplo-labs", engineerMedian: 72000, engineerCount: 12 });
    // Only the "|" cell ranks a company; a narrower band is not its median.
    // And its Levels.fyi page is not its website: guessed from, it made "levels" a slug.
    expect(snapshot.companies[1]).toMatchObject({ name: "Otra", website: null, engineerMedian: null, engineerCount: 0 });
  });

  it("reads the tables with per-place lookups and cells that name another cell", () => {
    const shaped = {
      "software-engineer": {
        fields: ["c", "n", "median", "p25", "p75"],
        cells: { "|": "remote|", "remote|": [[0, 12, 72000, 65000, 80000]] },
        places: [{ code: "MD", n: 12, cities: [] }],
      },
      "software-engineer~MD": { whole: [0], cells: {}, summary: {}, years: {} },
    };
    expect(readSiteSnapshot(data, shaped).companies[0]).toMatchObject({ engineerMedian: 72000, engineerCount: 12 });
  });

  it("ranks by the site's own bars", () => {
    expect(salaryTier({ engineerMedian: 72000, engineerCount: 12 }, rules)).toBe("A");
    expect(salaryTier({ engineerMedian: 90000, engineerCount: 1 }, rules)).toBe("B");
    expect(salaryTier({ engineerMedian: 50000, engineerCount: 30 }, rules)).toBe("B");
    expect(salaryTier({ engineerMedian: 40000, engineerCount: 30 }, rules)).toBe("C");
    expect(salaryTier({ engineerMedian: null, engineerCount: 0 }, rules)).toBe("C");
  });
});

describe("reading boards off links", () => {
  it("recognises each hosted board the adapters can fetch", () => {
    expect(boardFromUrl("https://job-boards.greenhouse.io/ejemplo/jobs/123")).toEqual({ ats: "greenhouse", board: "ejemplo", region: "global" });
    expect(boardFromUrl("https://boards.greenhouse.io/embed/job_board/js?for=ejemplo")).toEqual({ ats: "greenhouse", board: "ejemplo", region: "global" });
    expect(boardFromUrl("https://jobs.eu.lever.co/ejemplo/abc")).toEqual({ ats: "lever", board: "ejemplo", region: "eu" });
    expect(boardFromUrl("https://jobs.lever.co/ejemplo")).toEqual({ ats: "lever", board: "ejemplo", region: "global" });
    expect(boardFromUrl("https://jobs.ashbyhq.com/Ejemplo")).toEqual({ ats: "ashby", board: "Ejemplo", region: "global" });
    expect(boardFromUrl("https://ejemplo.wd3.myworkdayjobs.com/es-ES/Ejemplo_Careers/job/1")).toEqual({
      ats: "workday",
      board: "ejemplo/wd3/Ejemplo_Careers",
      region: "global",
    });
    expect(boardFromUrl("https://careers.smartrecruiters.com/Ejemplo")).toEqual({ ats: "smartrecruiters", board: "Ejemplo", region: "global" });
    expect(boardFromUrl("https://apply.workable.com/ejemplo/")).toEqual({ ats: "workable", board: "ejemplo", region: "global" });
    expect(boardFromUrl("https://ejemplo.recruitee.com/o/backend")).toEqual({ ats: "recruitee", board: "ejemplo", region: "global" });
    expect(boardFromUrl("https://apply.workable.com/j/ABC123")).toBeNull();
    expect(boardFromUrl("https://www.recruitee.com/")).toBeNull();
    // A bare language is a locale too; read as the site, it named a board that does not exist.
    expect(boardFromUrl("https://ejemplo.wd3.myworkdayjobs.com/es/Externo")?.board).toBe("ejemplo/wd3/Externo");
  });

  it("returns nothing for links that are not a board", () => {
    expect(boardFromUrl("https://www.workday.com/en-us/company/careers.html")).toBeNull();
    expect(boardFromUrl("https://boards.greenhouse.io/embed/job_board")).toBeNull();
    expect(boardFromUrl("not a url")).toBeNull();
  });

  it("collects every board a page links to, once", () => {
    const html = `<a href="https://jobs.ashbyhq.com/ejemplo?utm=1">Jobs</a>
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=ejemplo&amp;b=x"></script>
      <a href="https://jobs.ashbyhq.com/ejemplo/123">Role</a>
      <a href='https://ejemplo.recruitee.com'>Vacantes</a>`;
    expect(boardsLinkedFrom(html)).toEqual([
      { ats: "ashby", board: "ejemplo", region: "global" },
      { ats: "greenhouse", board: "ejemplo", region: "global" },
      { ats: "recruitee", board: "ejemplo", region: "global" },
    ]);
  });

  it("follows a careers link on the company's own domain only", () => {
    const home = `<a href="https://other.example/careers">x</a>
      <a href="/wp-json/oembed/1.0/embed?url=jobs">y</a>
      <a href="https://careers.ejemplolabs.example/">z</a>`;
    expect(careersPageLinkedFrom(home, "https://www.ejemplolabs.example/")).toBe("https://careers.ejemplolabs.example/");
    // Already on the careers subdomain: its host is no longer a hint.
    expect(careersPageLinkedFrom(`<a href="/about">a</a><a href="/es/trabaja-con-nosotros">b</a>`, "https://careers.ejemplolabs.example/")).toBe(
      "https://careers.ejemplolabs.example/es/trabaja-con-nosotros",
    );
  });

  it("guesses slugs from the Levels.fyi slug and the domain", () => {
    expect(slugGuesses(siteCompany())).toEqual(["ejemplo-labs", "ejemplolabs"]);
    expect(slugGuesses(siteCompany({ levelsSlug: "abb", website: "https://global.abb" }))).toEqual(["abb"]);
    expect(slugGuesses(siteCompany({ levelsSlug: "abacum", website: "https://jobs.ashbyhq.com/abacum" }))).toEqual(["abacum"]);
  });
});

describe("keeping only boards open in Spain", () => {
  it("counts offices in Spain and remote from Spain or Europe, nothing else", () => {
    const jobs = [
      jobAt("Madrid, Spain"),
      jobAt("Remote - Spain", { workplaceType: "remote" }),
      jobAt("Remote, Europe", { workplaceType: "remote" }),
      jobAt("Berlin, Germany"),
      jobAt("San Francisco, CA"),
      jobAt("Remote", { workplaceType: "remote" }),
    ];
    expect(spainPostings(jobs).map((job) => job.locationsRaw[0])).toEqual(["Madrid, Spain", "Remote - Spain", "Remote, Europe"]);
  });

  it("trusts a guessed board only when its postings name the company", () => {
    const company = siteCompany();
    expect(boardNamesCompany([jobAt("Madrid", { descriptionText: "Join Ejemplo Labs in Madrid." })], company)).toBe(true);
    expect(boardNamesCompany([jobAt("Madrid", { descriptionText: "Visit ejemplolabs.example." })], company)).toBe(true);
    expect(boardNamesCompany([jobAt("Madrid", { descriptionText: "Join Ejemplo Labsworth." })], company)).toBe(false);
  });

  function deps(boards: Record<string, Job[]>, overrides: Partial<PresetDeps> = {}): PresetDeps {
    return {
      resolve: async () => [],
      listJobs: async (company: Company) => boards[`${company.ats}/${company.board}`] ?? [],
      ...overrides,
    };
  }

  it("keeps the board the company links to, with its tier, tags and region", async () => {
    const report = await probeCompany(
      siteCompany({ website: "https://jobs.eu.lever.co/ejemplo" }),
      rules,
      deps({ "lever/ejemplo": [jobAt("Barcelona, Spain")] }),
    );
    expect(report.kept).toMatchObject({ name: "Ejemplo Labs", ats: "lever", board: "ejemplo", region: "eu", tier: "A", tags: ["spain", "madrid"] });
    expect(report.candidates[0]).toMatchObject({ source: "website", outcome: "kept", spainPostings: 1 });
  });

  it("narrows a Workday board to Spain, for the probe and for discovery", async () => {
    const seen: Company[] = [];
    const report = await probeCompany(
      siteCompany({ website: "https://ejemplo.wd3.myworkdayjobs.com/Externo" }),
      rules,
      deps({}, { listJobs: async (company) => (seen.push(company), [jobAt("Getafe, Spain")]) }),
    );
    expect(seen[0]?.query).toBe("Spain");
    expect(report.kept).toMatchObject({ ats: "workday", board: "ejemplo/wd3/Externo", query: "Spain" });
  });

  it("reads the board off the company's website and its careers page", async () => {
    const pages: Record<string, string> = {
      "https://www.ejemplolabs.example": `<a href="/careers">Careers</a>`,
      "https://www.ejemplolabs.example/careers": `<a href="https://jobs.ashbyhq.com/ejemplo">Open roles</a>`,
    };
    const report = await probeCompany(
      siteCompany(),
      rules,
      deps({ "ashby/ejemplo": [jobAt("Madrid, Spain")] }, { fetchPage: async (url) => pages[url] ?? null }),
    );
    expect(report.kept).toMatchObject({ ats: "ashby", board: "ejemplo" });
  });

  it("makes boards from a page that links many prove they are the company's", async () => {
    const portfolio = ["uno", "dos", "tres"].map((slug) => `<a href="https://jobs.ashbyhq.com/${slug}">${slug}</a>`).join("");
    const report = await probeCompany(
      siteCompany(),
      rules,
      deps(
        { "ashby/uno": [jobAt("Madrid, Spain", { descriptionText: "Uno is hiring." })] },
        { fetchPage: async () => portfolio },
      ),
    );
    expect(report.kept).toBeNull();
    expect(report.candidates.map((candidate) => [candidate.source, candidate.outcome])).toEqual([
      ["guess", "unconfirmed"],
      ["guess", "no-postings"],
      ["guess", "no-postings"],
    ]);
  });

  it("drops a guessed board that is someone else's or has nothing in Spain", async () => {
    const elsewhere = await probeCompany(
      siteCompany(),
      rules,
      deps(
        { "greenhouse/ejemplolabs": [jobAt("Madrid, Spain", { descriptionText: "A different employer." })] },
        { resolve: async () => [{ ats: "greenhouse", board: "ejemplolabs", url: "https://boards-api.greenhouse.io/v1/boards/ejemplolabs/jobs" }] },
      ),
    );
    expect(elsewhere.kept).toBeNull();
    expect(elsewhere.candidates[0]?.outcome).toBe("unconfirmed");

    const notHere = await probeCompany(
      siteCompany(),
      rules,
      deps(
        { "lever/ejemplolabs": [jobAt("Paris, France", { descriptionText: "Ejemplo Labs is hiring." })] },
        { resolve: async () => [{ ats: "lever", board: "ejemplolabs", url: "https://api.lever.co/v0/postings/ejemplolabs?mode=json&limit=1" }] },
      ),
    );
    expect(notHere.kept).toBeNull();
    expect(notHere.candidates[0]?.outcome).toBe("no-spain-postings");
  });

  it("keeps the board with the most postings in Spain and reports a failing one", async () => {
    const named = { descriptionText: "Ejemplo Labs" };
    const report = await probeCompany(
      siteCompany(),
      rules,
      deps(
        {
          "greenhouse/ejemplolabs": [jobAt("Madrid, Spain", named)],
          "ashby/ejemplolabs": [jobAt("Madrid, Spain", named), jobAt("Valencia, Spain", named)],
        },
        {
          resolve: async () => [
            { ats: "greenhouse", board: "ejemplolabs", url: "g" },
            { ats: "ashby", board: "ejemplolabs", url: "a" },
            { ats: "lever", board: "ejemplolabs", url: "https://api.eu.lever.co/v0/postings/ejemplolabs" },
          ],
          listJobs: async (company) => {
            if (company.ats === "lever") throw new Error("HTTP 500");
            return company.ats === "ashby"
              ? [jobAt("Madrid, Spain", named), jobAt("Valencia, Spain", named)]
              : [jobAt("Madrid, Spain", named)];
          },
        },
      ),
    );
    expect(report.kept).toMatchObject({ ats: "ashby" });
    expect(report.candidates.find((candidate) => candidate.ats === "lever")).toMatchObject({ outcome: "error", region: "eu" });

    const preset = assemblePreset([report, { ...report }]);
    expect(preset.companies).toHaveLength(1);
    expect(summarize([report], preset)).toEqual({
      companiesProbed: 1,
      boardsFound: { greenhouse: 1, ashby: 1 },
      boardsKept: { ashby: 1 },
      companiesKept: 1,
    });
  });
});

describe("the shipped Spain preset", () => {
  const companies = CompanyListSchema.parse(readJson("presets/spain.json")).companies;

  it("validates and names every company exactly once", () => {
    expect(CompanyListSchema.safeParse(readJson("presets/spain.json")).success).toBe(true);
    expect(companies.length).toBeGreaterThan(0);
    const names = companies.map((company) => company.name.toLowerCase());
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    const boards = companies.map((company) => `${company.ats}|${company.region}|${company.board.toLowerCase()}`);
    expect(boards.filter((board, index) => boards.indexOf(board) !== index)).toEqual([]);
  });

  it("points only at boards the source layer fetches, tagged for Spain", () => {
    for (const company of companies) {
      expect(["greenhouse", "lever", "ashby", "workday", "smartrecruiters", "workable", "recruitee"]).toContain(company.ats);
      expect(company.board.startsWith("http")).toBe(false);
      expect(company.tags).toContain("spain");
      if (company.region === "eu") expect(company.ats).toBe("lever");
    }
  });
});

describe("the Spain campaign example", () => {
  const raw = readJson("examples/campaign.spain.example.json");
  const campaign = CampaignSchema.parse(raw);

  it("validates, with no keys the schema would discard", () => {
    expect(CampaignSchema.safeParse(raw).success).toBe(true);
    expect(findStrayKeys(CampaignSchema, raw)).toEqual([]);
  });

  it("targets Spain in euros, with the same submission policy as the US and Canada example", () => {
    expect(campaign.locations.allow).toEqual(["spain", "remote-spain", "remote-europe"]);
    expect(campaign.compensation.currency).toBe("EUR");
    expect(campaign.compensation.floors.ES).toBe(60000);
    const usCanada = CampaignSchema.parse(readJson("examples/campaign.example.json"));
    expect(campaign.submission.maxBatchSize).toBe(usCanada.submission.maxBatchSize);
    expect(campaign.submission.allowedCompanies).toEqual([]);
    // Lever's EU boards apply on their own host, which jobs.lever.co does not cover.
    expect(campaign.submission.allowedAtsDomains).toContain("jobs.eu.lever.co");
    // A fifth of the Spain boards are Workday tenants.
    expect(campaign.submission.allowedAtsDomains).toContain("myworkdayjobs.com");
    expect(campaign.tracks.reduce((sum, track) => sum + track.allocation, 0)).toBeCloseTo(1);
  });

  it("binds every track to a resume the example profile declares", () => {
    const profile = ProfileSchema.parse(readJson("examples/profile.example.json"));
    const ids = new Set(profile.resumes.map((resume) => resume.id));
    for (const track of campaign.tracks) expect(ids.has(track.resumeId)).toBe(true);
  });

  it("writes title phrases the way titles are matched, so accented ones are not dead", () => {
    // Titles are compared after normalizeForMatch, which drops accents:
    // "Ingeniería" becomes "ingenieria", and a phrase written "ingeniería"
    // would never match anything.
    for (const track of campaign.tracks) {
      for (const phrase of [...track.titleIncludes, ...track.titleExcludes]) expect(normalizeForMatch(phrase)).toBe(phrase);
    }
  });

  it("admits a Spanish-titled posting in Madrid and files it under the right track", () => {
    const profile = makeProfile({
      workAuthorization: {
        citizenships: ["ES"],
        authorizedIn: ["ES"],
        noSponsorshipRequiredIn: ["ES"],
        requiresSponsorshipIn: [],
        statement: "Authorized to work in Spain.",
      },
    });
    const backend = jobAt("Madrid, Spain", {
      title: "Desarrollador Backend Sénior",
      descriptionText: "Microservicios en Java y PostgreSQL.",
    });
    expect(evaluateGates(backend, { campaign, profile }).passed).toBe(true);
    expect(scoreJob(backend, campaign, profile).trackId).toBe("backend");

    const mobile = jobAt("Barcelona, Spain", { title: "Senior iOS Engineer", descriptionText: "Swift and SwiftUI." });
    expect(scoreJob(mobile, campaign, profile).trackId).toBe("mobile");

    const lowPay = jobAt("Madrid, Spain", {
      title: "Senior Software Engineer",
      compensation: { min: 40000, max: 50000, currency: "EUR", period: "year", source: "ats-structured", raw: "40-50k" },
    });
    expect(evaluateGates(lowPay, { campaign, profile }).rule).toBe("compensation-below-floor");

    const intern = jobAt("Madrid, Spain", { title: "Becario de Ingeniería de Software" });
    expect(evaluateGates(intern, { campaign, profile }).rule).toBe("title-excluded");
  });
});

describe("init --preset", () => {
  function home() {
    const dir = mkdtempSync(join(tmpdir(), "autoapply-init-"));
    return {
      home: dir,
      profile: join(dir, "profile.json"),
      campaign: join(dir, "campaign.json"),
      companies: join(dir, "companies.json"),
      database: join(dir, "data", "autoapply.sqlite"),
    };
  }

  it("keeps US and Canada as the default", () => {
    expect(DEFAULT_PRESET).toBe("us-canada");
  });

  it("seeds the Spain campaign and company list together", () => {
    const paths = home();
    const result = initHome(paths, "spain");
    expect(result.ok).toBe(true);
    expect(readFileSync(paths.campaign, "utf8")).toBe(readFileSync(PRESETS.spain.campaign, "utf8"));
    expect(readFileSync(paths.companies, "utf8")).toBe(readFileSync(PRESETS.spain.companies, "utf8"));
    expect(readFileSync(paths.profile, "utf8")).toBe(readFileSync("examples/profile.example.json", "utf8"));
    expect(existsSync(join(paths.home, "resumes"))).toBe(true);
  });

  it("never overwrites a file that is already there", () => {
    const paths = home();
    writeFileSync(paths.campaign, "{\"mine\":true}\n");
    const result = initHome(paths, "spain");
    expect(result.ok).toBe(true);
    expect(readFileSync(paths.campaign, "utf8")).toBe("{\"mine\":true}\n");
    expect(result.lines.find((line) => line.includes(paths.campaign))).toContain("left untouched");
    expect(readFileSync(paths.companies, "utf8")).toBe(readFileSync(PRESETS.spain.companies, "utf8"));
  });

  it("fails loudly when a template is missing", () => {
    const paths = home();
    const result = initHome(paths, "spain", mkdtempSync(join(tmpdir(), "autoapply-empty-root-")));
    expect(result.ok).toBe(false);
    expect(result.lines.filter((line) => line.startsWith("FAIL"))).toHaveLength(3);
  });
});
