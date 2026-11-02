# Configuration

Three files drive everything. The server itself contains no personal data or campaign policy, which is what makes it reusable.

The permanent source catalog is code-backed and available through `list_sources`.
It does not add employers or grant submission permission. New employer ATS
kinds `smartrecruiters`, `workable` and `recruitee` can be used in `companies.json`
after board verification. See [SOURCES.md](SOURCES.md) for the discovery/lead
boundary and optional `AUTOAPPLY_FOORILLA_API_KEY` environment variable; never
store API keys in configuration JSON.

Scaffold them from the shipped examples:

```bash
npm run init                      # writes to ~/.autoapply, US and Canada preset
npm run init -- --preset spain    # Spain: campaign in EUR and the Spain company list
AUTOAPPLY_HOME=/path npm run init # or anywhere else
```

`--preset` picks the campaign and the company list together, because each only makes sense with the other. `us-canada` (the default, `examples/campaign.example.json` with `presets/ai-security-us-canada.json`) and `spain` (`examples/campaign.spain.example.json` with `presets/spain.json`, see [Spain](#spain)) are the two. There is no guessing from the profile: `init` runs before the profile is filled in, so the default stays explicit.

`init` never overwrites an existing file, so re-running it after adding one config fills in only what is missing.

Installed from npm, the same command is `npx -y -p autoapply-mcp autoapply-mcp-init --preset spain`. An agent with no shell does it through MCP instead: `load_preset` (`spain` or `us-canada`) merges the preset's boards into `companies.json`, keeping every board already there, and with `campaign: true` writes the preset's campaign when none exists yet. `setup_profile` and `update_campaign` then fill in the rest.

Validate with:

```bash
AUTOAPPLY_HOME=/path/to/config node dist/cli/doctor.js --probe
# or, installed from npm:
AUTOAPPLY_HOME=/path/to/config npx -y -p autoapply-mcp autoapply-mcp-doctor --probe
```

## A key written in the wrong place does nothing

The schemas strip keys they do not define rather than rejecting the file, so a misplaced setting parses cleanly and then has no effect — the file says one thing and the campaign does another. `doctor` reports these:

```
WARN  campaign.json: "maxBatchSize" is ignored; it belongs at "submission.maxBatchSize"
WARN  profile.json: "answers[4].citation" is not a known setting and is ignored
```

Treat every `WARN` as a real defect. The commonest cases are submission policy written at the top level of `campaign.json` instead of under `submission`, and extra bookkeeping fields on an `answers` entry — the only fields an answer accepts are `key`, `label`, `patterns`, `answer`, `alternatives`, `allowAutoFill`, `skip` and `note`.

## profile.json

Your verified truth. Every drafted answer must trace back to something here.

An agent can write this file for you with `setup_profile` and `remember_answer`, and campaign.json with `update_campaign` (see [TOOLS.md](TOOLS.md#setup)). Each write keeps the previous file as `profile.json.bak`. Until a new profile validates it is kept as `profile.draft.json`.

### identity
Name, headline, email, phone, location and links. Contact form fields are filled from these.

### workAuthorization

```json
{
  "citizenships": ["Canada"],
  "authorizedIn": ["CA"],
  "requiresSponsorshipIn": ["US"],
  "statement": "Authorized to work in Canada. US roles require employer support for work authorization.",
  "alwaysReviewManually": true
}
```

`authorizedIn` and `requiresSponsorshipIn` are ISO country codes and drive gating: a posting saying "must be authorized to work in Canada, no sponsorship" passes for a Canadian citizen applying to a Canadian role, and fails for the same wording on a US role.

Keep `alwaysReviewManually` true unless counsel has reviewed your exact wording.

The shipped template leaves all three country lists empty. Until you fill them in, every posting that states a citizenship or clearance requirement is gated out, and every country scores as needing employer support.

### compensation
Your targets, plus a `disclosurePolicy` of `decline`, `range` or `exact`. Compensation questions are a blocked category by default regardless. Ranking and drafting do not read these numbers. The floor that gates postings is [`compensation` in campaign.json](#compensation-1). The template's values of `1` are placeholders.

### preferences
Relocation, workplace and notice-period preferences. `roleSearchNotes` preserves
the candidate's role-selection guidance, such as openness to non-security roles
and exclusion of frontend work. It is guidance, not an ATS answer or permission
to invent experience. Enforce explicit title exclusions separately with
`campaign.exclusions.titlePatterns`; notes alone do not change the hard gates.

### resumes
At least one variant. Bind variants to campaign tracks:

```json
{ "id": "ai-security", "label": "AI Security", "path": "/abs/path/resume.pdf", "tracks": ["ai-security"], "isDefault": true }
```

`path` must point at the real file that gets uploaded. `doctor` fails if it is missing.

### skills
Name, aliases and a level of `expert`, `strong`, `working` or `familiar`. Levels weight the stack-alignment score; aliases are what make matching work (`OPA` for `Open Policy Agent`).

`since` is when you first used the skill professionally, as a year (`2018`) or `"YYYY-MM"`. It answers "How many years of experience do you have with X?" and "Do you have 5+ years of X experience?", but only when the subject the question names is exactly the skill's name or an alias: "Python and Django" or "backend Python" still come to you. A bare year is counted from the end of that year, so the figure is never more than you have; give the month for an exact count.

```json
{ "name": "Kubernetes", "aliases": ["k8s"], "level": "strong", "since": "2020-03" }
```

### languages
Each language you speak and its level: `A1` to `C2` on the CEFR scale, or `native`, with optional `aliases` ("Castilian" for Spanish).

```json
"languages": [{ "name": "Spanish", "level": "native" }, { "name": "English", "level": "C1" }]
```

Level questions get the option that states your level (the CEFR code, or a word such as "Advanced" or "Fluent"; a native speaker may take "Fluent" when no option says native). "Are you fluent in X?" is Yes from C1 and No up to B1; "Do you speak X?" is Yes from B2 and No at A1 and A2; the levels in between come to you. A language you did not list is never answered "No".

### experience
Your work history, as the CV states it. Besides the employment-history block, it answers "Have you previously worked for X?" and "Have you ever been employed by this company?" when `personal.previousEmployment` is not set: Yes when an entry names that employer, No otherwise. Questions about subsidiaries, affiliates or relatives still come to you.

### facts
Your achievement database. Each fact is a statement, optional metrics and tags. Match reports rank these by relevance so an agent writes from your real accomplishments rather than inventing them.

### answers
Pre-approved answers to recurring questions:

```json
{
  "key": "source",
  "label": "How did you hear about us?",
  "patterns": ["how did you hear", "how did you find"],
  "answer": "Friend",
  "alternatives": ["Friend", "Referral", "Company careers page", "LinkedIn"],
  "allowAutoFill": true
}
```

`patterns` are case-insensitive substrings matched against the employer's question label, and the **longest** matching pattern wins, so a specific entry overrides a general one. They are plain substrings, not regular expressions: `record(?:ing)?` matches nothing, because no employer writes that. Write the literal words the form uses. Set `allowAutoFill` to false for anything you want to review each time; the answer is still offered as a suggestion and `note` is shown as guidance.

`alternatives` is an ordered preference list for questions rendered as a fixed set of choices. The first entry the employer actually offers is used; if none are offered, the question is handed back rather than submitted with an unlisted value. See [BATCH.md](BATCH.md).

`skip: true` records a deliberate decision to leave an optional field blank.

`whenNoDecline` applies to a declined self-identification answer (gender, race, Hispanic or Latino, and so on), on a bank entry or on a `personal.demographics` field. Every decline wording the form offers is still tried first. The stored value is selected only when the question is required and offers no way to decline, such as a gender list of just "Male" and "Female". Without it, such a form stops for you.

The shipped template carries 169 entries, each with a `note` explaining it:

- An entry with an answer is a standing decision.
- A blank `answer` means you are asked every time a form needs it. An application only waits on a question when that question is required.
- Filling in a blank entry whose `allowAutoFill` is already true makes it automatic from then on.
- Entries with `allowAutoFill: false` stay suggestions even when filled in.
- For work authorization, sponsorship and citizenship questions, `workAuthorization.alwaysReviewManually` must also be false before an answer is sent unreviewed.

Your name, contact details, links, current employer, school and city need no entry, because they are answered from `identity`, `experience` and `education`. A blank entry matching those questions would take precedence and ask you instead.

## campaign.json

Your policy: what qualifies, how it ranks, how far automation may go.

### tracks
A track is a role family with its own title patterns, keywords and resume variant. Jobs are scored against every track and keep the best fit.

```json
{
  "id": "ai-security",
  "allocation": 0.4,
  "titleIncludes": ["ai security", "security engineer"],
  "titleExcludes": ["sales"],
  "keywords": [{ "term": "guardrail", "weight": 3, "aliases": ["guardrails"] }],
  "resumeId": "ai-security"
}
```

`allocation` is reported by `campaign_status` as intended versus actual mix. It does not restrict what gets queued; it tells you when your pipeline is drifting.

Keyword weights run 0 to 10. Coverage saturates rather than requiring a full sweep, so a track with 20 keywords is not handicapped against one with 8.

### locations

```json
{ "allow": ["bay-area", "canada", "remote-canada"], "workplaceTypes": ["onsite", "hybrid", "remote", "unknown"] }
```

Location classes: `bay-area`, `us-other`, `canada`, `remote-us`, `remote-canada`, `remote-global`, `spain`, `remote-spain`, `europe`, `remote-europe`, `other`, `unknown`.

`remote-europe` is a Europe-wide scope (Europe, EMEA, EU). A remote posting tied to one other country, such as "Remote - Germany", is `europe`, because it asks the candidate to live there. A campaign for someone in Spain would usually allow `["spain", "remote-spain", "remote-europe"]`.

Classification handles ambiguous city names: `Richmond, BC` is Canada, `Richmond, CA` is the Bay Area, `Newark, NJ` is neither. A posting listing several offices keeps the strongest match.

A remote posting with a named office (`Toronto, ON (Remote)`) classifies by that office; one with only a country scope (`Remote - US`) classifies as a remote scope.

### compensation

```json
{
  "currency": "USD",
  "floors": { "US": 200000, "CA": 200000 },
  "fx": { "USD": 1, "CAD": 0.73 },
  "allowUnknown": true,
  "rejectBelowFloor": true
}
```

Floors are per ISO country code in the campaign currency; `"*"` sets a default. FX rates read as "one unit of this currency equals N units of the campaign currency" and are static - update them deliberately.

The **top** of a published range is compared against the floor. `allowUnknown` keeps postings that publish nothing, which is most of them; those score lower and carry a `compensation-unverified` flag.

### seniority and exclusions
`seniority.allow` and `seniority.reject` work against a level detected from the title (`intern`, `new-grad`, `junior`, `senior`, `staff`, `principal`, `manager`, `director`, `executive`, `unspecified`). Keep `unspecified` in `allow` or you will discard many legitimate postings.

Single-word exclusion patterns match on word boundaries, so `sales` does not exclude `Salesforce`.

### scoring

| Dimension | Default weight | Meaning |
|---|---|---|
| `roleAlignment` | 25 | Title match against the track |
| `domainAlignment` | 25 | Weighted keyword coverage, with evidence |
| `stackAlignment` | 15 | Overlap with your skills, weighted by level |
| `seniority` | 10 | Detected level fit |
| `compensation` | 10 | Published pay against the floor |
| `workAuthorization` | 10 | Whether you can work there without employer action |
| `freshness` | 5 | Posting age |

Thresholds set the tiers. Calibrate them against your own pool: run `discover_jobs`, then read the tier distribution in `campaign_status` and adjust so tier A is a shortlist rather than a category.

### submission

```json
{
  "allowedAtsDomains": ["job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "myworkdayjobs.com"],
  "allowedCompanies": [],
  "dailyLimit": 15,
  "maxBatchSize": 15,
  "maxPerCompany": 3,
  "minDelaySeconds": 90
}
```

`allowedAtsDomains` lists the hosts an approved application may be sent to; the default covers Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable and Recruitee. The agent sends each application with its own browser, so there is no submission mode: a `mode` key left from an older version is ignored, and `doctor` warns about it.

`allowedCompanies` narrows submission: when it lists companies, only those are handed over; empty, any company that passes the campaign's gates may be submitted to. `blockedQuestionCategories` defaults to the full sensitive set; removing an entry is a deliberate, consequential choice.

`dailyLimit` accepts a positive integer or `null`. Set `"dailyLimit": null` to
disable the daily submission ceiling; omitting it retains the default of 25.
Zero, negative numbers, and strings such as `"unlimited"` are invalid. JSON
cannot represent `Infinity`, so use `null`, not a very large placeholder number.
Unlimited daily mode does not disable pacing, per-company or per-batch limits,
destination restrictions, duplicate checks, or approval requirements.
`campaign_status` reports `dailyLimit: null` in this mode.

After upgrading server code to support this setting, restart existing MCP
connections so they load the new schema. Once the new code is running,
`reload_config` applies configuration-only changes without another restart.

`allowedCompanies` restricts submission to the companies it names. Empty, the default, means no company restriction: any employer that passes the other guards can be submitted to. A non-empty list limits submissions to those companies (matched by name, case-insensitively) and refuses the rest with `company_not_allowlisted`, which is how to keep your agent inside a set of employers you chose. `exclusions.companies` blocks a company outright.

`maxBatchSize` caps how many applications a single `prepare_batch` or `submit_batch` run may touch, even when a caller passes a larger explicit limit. It defaults to 15, a day's work under one approval. Pacing (`minDelaySeconds`) is what spaces submissions out against ATS rate limits, and `dailyLimit` and `maxPerCompany` still bound the volume. `maxPerCompany` caps how many live applications may exist for one employer, since several reject the excess outright.

## companies.json

```json
{
  "version": 1,
  "companies": [
    { "name": "Anthropic", "ats": "greenhouse", "board": "anthropic", "tier": "A", "tags": ["ai"], "active": true, "region": "global" }
  ]
}
```

`ats` is `greenhouse`, `lever`, `ashby` or `workday` (also `smartrecruiters`, `workable` and `recruitee`, and the career sites below). `board` is the public board slug, which is rarely the company name - use `resolve_company_board` to find it. For Workday there is no single slug: `board` is the `tenant/datacenter/site` triple read off the employer's career-site URL, e.g. `nvidia/wd5/NVIDIAExternalCareerSite`, and it cannot be guessed, so record it with `add_company_board`. `tier` influences scoring when compensation is unpublished. `region` is `eu` for EU-hosted Lever and Ashby instances. `query` is a server-side search filter, worth setting on large Workday tenants that publish thousands of unrelated postings.

`name` is an identity, not a label. Boards are matched on it case-insensitively, and `submission.maxPerCompany` is keyed by it, so two spellings of one employer become two boards with two separate ceilings.

Start from `presets/ai-security-us-canada.json`, which contains 135 boards verified live against the ATS APIs, or from `presets/spain.json` for jobs in Spain (see [Spain](#spain)). `npm run init` copies the one its `--preset` names. It is a starting point, not a fixed list: this file is your own selection, so add and remove boards freely. Boards found during a campaign land in your copy, not in the repository, so contribute anything worth sharing back to the preset.

## Spain

`npm run init -- --preset spain` seeds a campaign for software jobs in Spain and the companies that pay engineers there, taken from [spanishtoptechcompanies.com](https://spanishtoptechcompanies.com). Both files are a starting point to edit, like the US and Canada ones.

**Companies.** `presets/spain.json` holds 89 of the employers the salary site lists (only those it could verify, by a website or a LinkedIn page) whose board publishes at least one posting in Spain or remote from Spain or Europe, by the same location classifier the gates use. Most are Greenhouse, Lever or Ashby. The rest are Workday, SmartRecruiters, Workable and Recruitee boards the company's own website links to, since those cannot be guessed; the server cannot submit to the last three, so the person applies there and records it with `record_submission`. Workday entries carry `query: "Spain"`, because those tenants publish thousands of roles worldwide and each one costs a detail request. `tier` follows the site's ranking: `A` when the company's median software-engineer base reaches the site's 60,000 EUR listing bar over at least three salaries, `B` when it reaches the bar on fewer or sits between 45,000 EUR (the floor the site counts companies from) and the bar, `C` below that or with no engineer salaries. Every entry is tagged `spain` plus up to three of its Spanish cities, and Lever boards hosted in the EU carry `region: "eu"`. Boards found by guessing a slug are kept only when the postings name the company, since a slug like `seat` can belong to anyone. Many Spanish employers hire through their own careers site, a Workday tenant their homepage does not link, or an ATS this server does not fetch, so 266 of the 355 are not in the file; add them with `resolve_company_board` and `add_company_board`.

Rebuild it with `npm run preset:spain`. The script reads the site's published aggregates from its repository (never the individual salaries), reads each company's website and one careers page for board links, then probes Greenhouse, Lever (global and EU) and Ashby with the server's own resolver, adapters and per-host throttle. A board linked from a page that links more than two is treated as a guess. A full run of the 355 listed companies takes about an hour and a half; `--resume` continues an interrupted one, `--redo` with `--reuse-guesses` probes named companies again without re-guessing their slugs, and `--limit`/`--only` restrict it.

**Campaign.** `examples/campaign.spain.example.json`:

- `locations.allow` is `["spain", "remote-spain", "remote-europe"]`: an office in Spain, or remote from Spain or anywhere in Europe. `europe` (an office or a remote role tied to another European country) is left out; add it if you would move.
- `compensation` is in EUR with `floors` of 60,000 for `ES` and for `*` (remote roles whose country is unknown). That is the salary site's listing bar, and just under the median base of every software engineer it has in Spain (62,000 EUR over 3,289 salaries; by experience 48,000 at two to four years, 61,000 at five to seven, 71,000 at eight to eleven). Only a published range whose top is under the floor rejects a posting; most Spanish postings publish none and are kept. Lower it toward 50,000 if you are earlier in your career, raise it if you are senior. `fx` rates are static, one unit in EUR.
- Seven tracks: backend and general software, frontend, full-stack, data, ML and AI, DevOps/platform/SRE, mobile. Title phrases are in English and Spanish (`ingeniero de software`, `desarrolladora frontend`, `cientifico de datos`). Write them without accents: titles are compared after accents are stripped, so a phrase written `ingeniería` never matches. Exclusion patterns are compared with accents kept, which is why both `prácticas` and `practicas` are listed.
- Every track uses the example profile's single resume (`backend`). Point each at its own variant if you have more than one CV.
- `seniority` keeps the defaults, which reject `junior` titles. If you are a junior engineer, move `junior` from `reject` to `allow` and lower the floor; `Becario`/`prácticas` internships stay excluded by title either way.
- `submission.allowedAtsDomains` adds `jobs.eu.lever.co`, where EU-hosted Lever boards take applications. A fifth of the Spain boards are Workday (Airbus, BBVA, Repsol and others), where the agent's browser needs an account on each employer's tenant. The rest of `submission` matches the US and Canada example: an empty `allowedCompanies`, so any company that passes the gates may be submitted to.

**Profile.** The same `examples/profile.example.json` serves Spain; its US-specific questions are blank and simply asked if a form shows them. Set `compensation.currency` to `EUR`, and list `ES` (and every other EU or EEA country if you are an EU citizen, who may work in all of them without a permit) in `workAuthorization.authorizedIn` and `noSponsorshipRequiredIn`. The privacy and data-processing consents a form requires, in English or Spanish (`tratamiento de mis datos personales`, `política de privacidad`), match the `acknowledgement` entry, which starts blank: you are asked once whether they may be accepted for you. Optional consents (`bolsa de talento`, future openings, marketing) match `optional-consent` and are declined.

## Career sites: Google, Meta, Amazon and Apple

Four employers run their own career sites rather than a shared ATS, and each
needs a signed-in account to apply. They are boards like any other in
`companies.json`, with these `ats` values and `board` formats:

| `ats` | `board` | Example |
|---|---|---|
| `google` | Search location, optionally `;` and Google's levels | `United States;MID,ADVANCED` |
| `meta` | Any fixed label; `query` carries the search | `metacareers` |
| `amazon` | Country code | `USA` |
| `apple` | Apple's location slug | `united-states-USA` |

Set `query` on each (for example `security engineer`) and add the site's domain
to `campaign.json` `allowedAtsDomains` (`google.com`, `metacareers.com`,
`amazon.jobs`, `jobs.apple.com`).

**Signing in.** The server never signs in, creates an account or answers a
challenge on these sites. Applying needs the agent's browser signed in as you;
an agent should ask before registering an account in your name. Apple is
discovery only.

| Variable | Default | Meaning |
|---|---|---|
| `AUTOAPPLY_CAREERS_MAX_PAGES` | `10` | Google search pages read per board. |
| `AUTOAPPLY_CAREERS_MAX_POSTINGS` | `500` | Amazon postings read per board. |
| `AUTOAPPLY_META_SEARCH_DOC_ID` | built in | Meta's persisted search query id, for when Meta rotates it. |
