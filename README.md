# autoapply-mcp: AI job application agent for Greenhouse, Lever, Ashby and Workday

[![npm](https://img.shields.io/npm/v/autoapply-mcp.svg)](https://www.npmjs.com/package/autoapply-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22.5+](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg)](https://nodejs.org)
[![Model Context Protocol](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)

**autoapply-mcp** is an open-source [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets an AI agent such as Instinct, Claude Code, Cursor or Codex search for jobs and apply to them for you. It discovers postings on public Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable and Recruitee boards, applies hard eligibility gates, ranks what survives with quotable evidence, and drafts only the answers your profile actually supports. Once you approve an application, your agent sends it with its own browser. Nothing goes out without your approval.

There is nothing to install beyond one line in your MCP client: no browser to download, no mailbox to wire up. The server never opens an employer's site itself.

## Contents

- [Features](#features)
- [Supported job boards](#supported-job-boards)
- [Design rules](#design-rules)
- [Quick start](#quick-start)
- [How an application is sent](#how-an-application-is-sent)
- [Configure](#configure)
- [Typical session](#typical-session)
- [What it deliberately does not do](#what-it-deliberately-does-not-do)
- [Known limitations](#known-limitations)
- [FAQ](#faq)
- [Development](#development)

## Features

| Stage | Behaviour |
|---|---|
| Discover | Fetches Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable and Recruitee employer boards; searches additional sources for unverified leads |
| Gate | Hard-rejects on location, seniority, compensation floor, clearance, citizenship and sponsorship constraints |
| Score | Ranks survivors across seven weighted dimensions, each with the quote that earned it |
| Draft | Builds a match report, loads the employer's real questions, and answers only what verified profile data supports |
| Approve | Binds your approval to a hash of the exact submission content |
| Hand over | Checks every guard, then gives your agent the approved packet to send with its own browser |
| Track | Records submissions, outcomes and an append-only audit log |

Location gates understand the US, the Bay Area, Canada, Spain and Europe, on-site and remote.

## Supported job boards

| Applicant tracking system | Job discovery | Employer questions read in advance |
|---|---|---|
| Greenhouse | Yes | Yes, from the job board API |
| Lever | Yes | Yes, from the apply page |
| Ashby | Yes | Yes, from the hosted job page |
| Workday | Yes | No; your agent adds them from the form |
| SmartRecruiters | Yes | No; your agent adds them from the form |
| Workable | Yes | No; your agent adds them from the form |
| Recruitee | Yes | No; your agent adds them from the form |

Leads also come from Himalayas, Foorilla PRO+ and the portfolio pages of a16z, Sequoia, YC and Built In SF. See [docs/SOURCES.md](docs/SOURCES.md).

## Design rules

1. **Nothing is invented.** Every drafted answer traces to a profile field or a pre-approved answer. Anything else is handed back: to your agent when your profile answers it, to you when only you can.
2. **Sensitive questions always stop.** Work authorization, citizenship, compensation, criminal history, demographics and legal attestations require a human decision by default.
3. **Approval binds to content, and it is yours.** `approve_application` shows you the packet and records your answer with its hash; the model cannot give it for you. Editing anything invalidates it and the packet is not handed over.
4. **Job descriptions are untrusted data.** Text from employers is scanned for prompt-injection patterns, wrapped in an explicit data boundary, and never treated as instructions.
5. **Anti-bot controls are yours.** A CAPTCHA, or a form question asking whether the applicant is a bot or an AI, is handed to you. The agent never solves or answers one.
6. **Destinations are allowlisted.** A packet is only handed over for hosts the campaign explicitly trusts, over HTTPS.

## Quick start

You need Node.js 22.5 or newer. Add the server to your MCP client and you are done.

It works best with [Instinct](https://instinct.com/), or else Claude Code. Cursor, Codex, Hermes and any other MCP client work too.

**Claude Code:**

```bash
claude mcp add autoapply -- npx -y autoapply-mcp
```

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "autoapply": { "command": "npx", "args": ["-y", "autoapply-mcp"] }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.autoapply]
command = "npx"
args = ["-y", "autoapply-mcp"]
```

Then tell your agent to apply for you. It asks for your CV and a few preferences in one message, builds your profile in `~/.autoapply` with `setup_profile` and `update_campaign`, and takes it from there. Clients that list MCP prompts offer `onboard` and `daily_apply` to start those loops with one click.

For salaries in Spain, connect the `tech-pay-spain` server too: Streamable HTTP at `https://spanishtoptechcompanies.com/mcp`, no sign-in.

## How an application is sent

The server finds, ranks, drafts and checks. Your agent does the one thing that needs a browser:

1. `submit_application` (or `submit_batch`, one application at a time) runs every guard: your approval or standing rules, the allowlisted host, the daily limit, the per-company cap and pacing.
2. It returns the packet: the apply URL, the resume file, the cover letter and the value of every field.
3. The agent opens the URL in its own browser, fills the form with exactly those values and presses submit. A question the packet lacks is added with `set_application_content`, which needs your approval again unless standing rules cover it.
4. If the board emails a verification code, the agent reads it with its own mail access, or asks you for it.
5. Once the board confirms, the agent calls `record_submission`.

Agents with a browser: Instinct, Claude Code (Claude in Chrome, or the desktop app's browser), Cursor, the Codex app and Hermes. An agent without one gives you the apply URL and the packet, and records it once you have sent it.

## Configure

Your agent writes the configuration for you. Everything lives in `~/.autoapply` (or `AUTOAPPLY_HOME`): `profile.json`, `campaign.json`, `companies.json`, your resumes and a SQLite database. To write the files yourself instead, run `npm run init` in a checkout: it creates `~/.autoapply` from the shipped examples and never overwrites a file that already exists. Looking for work in Spain? Run `npm run init -- --preset spain`. It seeds a campaign in euros for offices in Spain and remote roles open from Spain or Europe, with tracks titled in English and Spanish, and a company list built from [spanishtoptechcompanies.com](https://spanishtoptechcompanies.com). Without the flag `init` uses `--preset us-canada`, the US and Canada setup it always used. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#spain).

Installed with `npx -y autoapply-mcp`, there is no checkout to run `npm run init` in. The agent loads the same list itself with the `load_preset` tool (`preset: "spain"`, and `campaign: true` to start the campaign from the Spain one when there is none yet); the `onboard` prompt does it for a candidate in Spain. It only adds boards, never touches companies you already listed, and never replaces a campaign. If you prefer files, `npx -y -p autoapply-mcp autoapply-mcp-init --preset spain` seeds the home like `init` does.

### The profile template

`examples/profile.example.json` holds no personal data, compensation or location preferences. It does carry a bank of 169 recurring application questions, each matched to the wordings employers use:

- **Fill in:** `identity`, `workAuthorization`, `compensation`, `preferences`, `resumes`, `skills`, `facts`, `experience` and `education`. Every value in these sections is a placeholder or an example to replace. The `workAuthorization` country lists start empty, which gates out every posting that requires citizenship until you add the ISO codes, such as `CA` or `US`, of the countries you can work in.
- **Pre-answered:** decisions that hold for almost anyone, which you should review once before your first run:
  - "How did you hear about us?" (the company careers page);
  - optional consents (talent pool, future openings, marketing), set to decline;
  - voluntary demographic questions, set to decline.
- **Consents are yours:** the privacy notice and data-processing consent a form requires, a background check and AI evaluation start blank. The agent asks you once in its onboarding message and reuses your answer; nothing is accepted in your name before you say so.
- **Blank:** anything personal. A blank answer means you are asked whenever a form needs it; write it once and it is reused. Legally material questions, such as work authorization, export control, government ties, arbitration and salary, are also set to `allowAutoFill: false`, so a filled-in answer stays a suggestion until you set it to true.
- **Narratives:** the two "why this company" templates stay suggestions until you rewrite them in your own words and set `allowAutoFill` to true. See [docs/BATCH.md](docs/BATCH.md#narrative-templates).

How answers are matched is described in [docs/CONFIGURATION.md](docs/CONFIGURATION.md#answers).

To do it by hand instead:

```bash
mkdir -p ~/.autoapply
cp examples/profile.example.json   ~/.autoapply/profile.json
cp examples/campaign.example.json  ~/.autoapply/campaign.json
cp presets/ai-security-us-canada.json ~/.autoapply/companies.json
# or, for Spain: examples/campaign.spain.example.json and presets/spain.json
```

Then edit them and verify:

```bash
node dist/cli/doctor.js --probe            # from a checkout
npx -y -p autoapply-mcp autoapply-mcp-doctor --probe   # from npm
```

`doctor` validates all three files, checks that your resume files exist and are real PDFs, confirms every track points at a resume variant, warns about settings written in the wrong place, and probes each configured board.

Unknown keys are stripped silently by the schema, so a setting written one level too high reads as configured and behaves as absent. `doctor` reports these as `WARN` and names where the setting belongs:

```
WARN  campaign.json: "maxBatchSize" is ignored; it belongs at "submission.maxBatchSize"
```

`presets/ai-security-us-canada.json` ships 135 company boards that were verified live against the ATS APIs, weighted toward AI, security and infrastructure companies in the US and Canada, alongside large-cap technology employers.

`load_preset` with `spain` downloads the list [spanishtoptechcompanies.com](https://spanishtoptechcompanies.com/api/v1/boards.json) publishes, tiered by that day's salaries, so companies the site adds reach you without a new release. The request carries nothing about you: its User-Agent names the package version, a `run` parameter says whether it is a first setup or a refresh, and the site counts these downloads by version and country, without your IP. `presets/spain.json` is the copy it falls back to when the site cannot be read, and the one `init` copies: 89 boards (37 Greenhouse, 18 Ashby, 13 Lever, 18 Workday and three others) of companies the salary site lists in Spain, each one publishing at least one posting in Spain or remote from Spain or Europe when it was built. `npm run preset:spain` rebuilds it.

Workday is fully supported for discovery, but applying on Workday means an account on that employer's tenant and a multi-step wizard, so expect your agent to need you more there than on a Greenhouse or Ashby posting.

### Additional listing sources

`list_sources` exposes the permanent catalog of 14 ATS, community, aggregator and
portfolio sources. `search_job_sources` searches Himalayas or an authorized
Foorilla PRO+ account; `scan_source_page` extracts employer ATS links from one
a16z, Sequoia, YC or Built In SF page. These results are **unverified leads**, not
jobs that can bypass campaign gates or submission permissions.

SmartRecruiters, Workable public account feeds and Recruitee company XML feeds
work with `add_company_board` and `discover_jobs`. Adding a discovery board never
changes the submission allowlist.

See [docs/SOURCES.md](docs/SOURCES.md) for endpoints, examples, access requirements,
pagination, attribution and limitations. No source requires candidate data for
discovery. Paid accounts are never created automatically.

Nothing in this repository is specific to one candidate. Keep `profile.json`, resumes and the database in `~/.autoapply` and they can never be committed by accident.

Nothing is sent to an employer until you approve it. Listing companies in `submission.allowedCompanies` limits submission to them; left empty, any company that passes the campaign's gates is allowed.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AUTOAPPLY_HOME` | `~/.autoapply` | Root for config and database |
| `AUTOAPPLY_PROFILE` | `$HOME/profile.json` | Candidate profile |
| `AUTOAPPLY_CAMPAIGN` | `$HOME/campaign.json` | Campaign policy |
| `AUTOAPPLY_COMPANIES` | `$HOME/companies.json` | Company board list |
| `AUTOAPPLY_DB` | `$HOME/data/autoapply.sqlite` | SQLite database |
| `AUTOAPPLY_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `AUTOAPPLY_MIN_INTERVAL_MS` | `700` | Minimum delay between requests to one host |
| `AUTOAPPLY_MAX_RESPONSE_MB` | `64` | Response size ceiling |
| `AUTOAPPLY_FOORILLA_API_KEY` | unset | Optional API key for an existing Foorilla PRO+ subscription; never stored in campaign files |
| `AUTOAPPLY_TELEMETRY` | unset | `0` turns technical usage data off; `DO_NOT_TRACK=1` does the same. See [Technical usage data](#technical-usage-data) |

### Technical usage data

On by default, anonymous, and off for good the moment you say no. The agent tells you in its onboarding message; tell it you would rather not and it calls `set_telemetry` with `enabled: false`. Each tool call sends the author: the tool's name, whether it worked, how long it took, an error code, the package version, Node.js, the operating system and your MCP client's name, under a random id that lasts one run and is never stored. `discover_jobs` adds how many boards it read and how many failed, by ATS and error code. Never your profile, CV, answers, the jobs or companies, or anything you type: a known error sends only its code, and an unexpected one its message with paths, addresses, links and numbers removed. Nothing is written to your machine except your answer, if you give one (`~/.autoapply/telemetry.json`). It goes to [spanishtoptechcompanies.com](https://spanishtoptechcompanies.com/en/legal/), which keeps only those fields and forwards them to PostHog in the EU without your IP. `AUTOAPPLY_TELEMETRY=0` or `DO_NOT_TRACK=1` keeps it off. The code is [src/telemetry.ts](src/telemetry.ts).

## Typical session

Single application:

```
discover_jobs                  -> fetch every board, gate, score, store
list_queue                     -> the ranked, de-duplicated shortlist
explain_job        jobId       -> gate result and scoring evidence
prepare_application jobId      -> match report, employer questions, drafted answers
set_application_content        -> your cover letter and any answers only you can give
preview_application            -> the exact packet plus its hash
approve_application  + hash    -> asks you to approve that exact packet
submit_application             -> checks the guards, hands your agent the packet to send
record_submission              -> once the board confirms
record_outcome                 -> track what happened
```

High volume:

```
prepare_batch  {tiers:["A","B"], locationClasses:["bay-area"], minCompensation:250000}
preview_batch                  -> the set, plus grouped blocking questions
approve_batch  + manifestHash + expectedCount   -> asks you to approve the set
submit_batch                   -> the next application allowed now; send it, record it, repeat
list_batches                   -> progress
```

See [docs/TOOLS.md](docs/TOOLS.md) for every tool, [docs/BATCH.md](docs/BATCH.md) for high-volume campaigns and cached personal data, [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the schemas, [docs/RESUMES.md](docs/RESUMES.md) for resume variants and LaTeX builds, and [docs/SAFETY.md](docs/SAFETY.md) for the guarantees and their limits.

## What it deliberately does not do

- No LinkedIn Easy Apply, Indeed or Wellfound automation. Their terms prohibit it and their anti-bot systems are built to stop it. Use their alerts as leads, then apply through the employer's own board.
- No browser of its own. The server never opens, fills or submits an employer's form; your agent does, with the packet you approved.
- No CAPTCHA solving, proxy rotation or fingerprint evasion, and no answering "are you a bot" questions.
- No writing of your resume prose or cover letters. The server supplies structured evidence; your agent writes the words and you approve them.

## Known limitations

- Compensation parsed from description text is a heuristic. Postings that list several geographic pay zones can yield the wrong figure, so those results carry a `compensation-parsed-from-text` flag. Structured ATS pay data is preferred whenever a board publishes it.
- FX rates in `campaign.json` are static. Update them before relying on a cross-currency floor.
- Each posting's questions are read in advance on Greenhouse (its job board API), Ashby (the endpoint its hosted job page uses) and Lever (the question definitions embedded in its apply page). Other boards are drafted against a baseline field set, and your agent adds the rest from the live form, which means approving the packet again unless standing rules cover it.
- `@modelcontextprotocol/sdk` currently pulls a transitive advisory in `@hono/node-server` affecting its static-file server. This server uses the stdio transport only and never serves static files, so the affected code path is not reachable.

## FAQ

### Can an AI agent apply to jobs for me?

Yes. Connect this server to Instinct, Claude Code, Cursor, Codex or another MCP client and the agent finds openings, drafts each application and, once you approve the exact packet, sends it with its own browser, only to the companies in `submission.allowedCompanies` if you list any.

### Is this a LinkedIn Easy Apply bot?

No. It applies through the employer's own applicant tracking system (Greenhouse, Lever, Ashby or Workday), which is where most tech companies take applications anyway. LinkedIn, Indeed and Wellfound alerts are still useful as leads.

### Will it send spam applications?

It is designed not to. Postings that fail your location, seniority, salary or sponsorship gates are not drafted unless you deliberately override the gate, every submission needs your approval, and batches honour the size limits and pacing you configure.

### Where is my personal data stored?

On your machine, in `~/.autoapply`: your profile, resumes and a SQLite database. Discovery needs no candidate data, and packets are only handed over for hosts the campaign allowlists. Nothing about you is sent to the author; the anonymous technical usage data carries none of it (see [Technical usage data](#technical-usage-data)). The AI client you connect sees whatever the tools return to it, as with any MCP server.

### Does it write my cover letter or invent answers?

It invents nothing. The server fills answers only from your profile and pre-approved answers. Your agent writes the cover letter and any essay question from the facts in your profile, cites them and avoids anything the posting asks for that you lack; you read every word in the packet you approve. Work authorization, sponsorship, salary and the other questions only you can answer are gathered into one message to you.

### Does it solve CAPTCHAs?

No. The agent stops at a CAPTCHA and hands you the open page; once you have solved it, it presses submit. In a batch it moves on to the next application meanwhile.

### Does it work for jobs in Europe or Spain?

Yes. Location gates know Spain, Europe and their remote variants alongside the US and Canada, and `npm run init -- --preset spain` (or the `load_preset` tool, from an npx install) sets up a campaign in euros with 89 employers hiring in Spain. For pay in Spain, the `tech-pay-spain` MCP server gives salaries by company from [Spanish Top Tech Companies](https://spanishtoptechcompanies.com).

### Is it free?

Yes, it is open source under the MIT license. You bring your own MCP client and model.

## Development

```bash
npm run typecheck
npm test
npm run coverage
```

Over 1,200 tests cover location classification, compensation parsing, every gate, scoring, the answer policy, resume validation, submission guards, packet hashing, persistence, the ATS adapters, and an end-to-end run through a real in-memory MCP client.

## License

MIT. Forked from [niragmehta/autoapply-mcp](https://github.com/niragmehta/autoapply-mcp).
