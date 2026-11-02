# autoapply-mcp: AI job application agent for Greenhouse, Lever, Ashby and Workday

[![npm](https://img.shields.io/npm/v/autoapply-mcp.svg)](https://www.npmjs.com/package/autoapply-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22.5+](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg)](https://nodejs.org)
[![Model Context Protocol](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)

**autoapply-mcp** is an open-source [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets an AI agent such as Claude, Cursor or Codex search for jobs and apply to them for you. It discovers postings on public Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable and Recruitee boards, applies hard eligibility gates, ranks what survives with quotable evidence, drafts only the answers your profile actually supports, and fills the employer's real application form. Nothing is submitted without a recorded human approval.

It is built for high-volume job search **without** becoming a spam bot. Discovery, ranking and form-filling are automated. Judgement, truthfulness and consent are not.

## Contents

- [Features](#features)
- [Supported job boards](#supported-job-boards)
- [Design rules](#design-rules)
- [Quick start](#quick-start)
- [Configure](#configure)
- [Use with Claude, Cursor, Codex and other MCP clients](#use-with-claude-cursor-codex-and-other-mcp-clients)
- [Typical session](#typical-session)
- [Submission modes](#submission-modes)
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
| Approve | Binds a human approval to a hash of the exact submission content |
| Submit | Fills and submits approved applications by itself, or fills them for you to submit (assisted) |
| Track | Records submissions, outcomes and an append-only audit log |

Location gates understand the US, the Bay Area, Canada, Spain and Europe, on-site and remote.

## Supported job boards

| Applicant tracking system | Job discovery | Employer questions read in advance | Browser form filling and submission |
|---|---|---|---|
| Greenhouse | Yes | Yes, from the job board API | Assisted and auto |
| Lever | Yes | Yes, from the apply page | Assisted and auto |
| Ashby | Yes | Yes, from the hosted job page | Assisted and auto |
| Workday | Yes | Read during the assisted run | Assisted and auto, through a candidate account on each employer's tenant |
| SmartRecruiters | Yes | No | Not yet; you apply at the URL and the agent records it |
| Workable | Yes | No | Not yet; you apply at the URL and the agent records it |
| Recruitee | Yes | No | Not yet; you apply at the URL and the agent records it |

Leads also come from Himalayas, Foorilla PRO+ and the portfolio pages of a16z, Sequoia, YC and Built In SF. See [Additional listing sources](#additional-listing-sources).

## Design rules

1. **Nothing is invented.** Every drafted answer traces to a profile field or a pre-approved answer. Anything else is handed back: to your agent when your profile answers it, to you when only you can.
2. **Sensitive questions always stop.** Work authorization, citizenship, compensation, criminal history, demographics and legal attestations require a human decision by default.
3. **Approval binds to content, and it is yours.** `approve_application` shows you the packet and records your answer with its hash; the model cannot give it for you. Editing anything invalidates it and submission is refused.
4. **Job descriptions are untrusted data.** Text from employers is scanned for prompt-injection patterns, wrapped in an explicit data boundary, and never treated as instructions.
5. **Anti-bot controls are respected.** A detected CAPTCHA is handed to you in the open browser with the form filled, and the run continues once you solve it. There is no automated solving, evading or fingerprint spoofing.
6. **Destinations are allowlisted.** Submissions only go to hosts the campaign explicitly trusts, over HTTPS.

## Quick start

Requirements:

- Node.js 22.5 or newer (uses the built-in `node:sqlite`, so there is no native build step)
- Playwright, only if you want assisted or automatic form filling, installed next to autoapply-mcp (`npm install -g playwright` for the npm install, `npm install playwright` in a checkout), then `npx playwright install chromium`

From npm:

```bash
npm install -g autoapply-mcp
node "$(npm root -g)/autoapply-mcp/dist/cli/init.js"            # creates ~/.autoapply from the examples
node "$(npm root -g)/autoapply-mcp/dist/cli/doctor.js" --probe  # validates your config and probes every board
```

From source:

```bash
git clone https://github.com/pugarte7/autoapply-mcp.git
cd autoapply-mcp
npm install
npm run build
npm test
npm run init               # creates ~/.autoapply from the examples
npm run doctor -- --probe  # validates your config and probes every board
```

Then fill in your profile ([Configure](#configure)) and [register the server with your MCP client](#use-with-claude-cursor-codex-and-other-mcp-clients).

## Configure

Personal data lives outside the repository, so a checkout can be published as-is. The default home is `~/.autoapply`:

```bash
npm run init
```

`init` creates `~/.autoapply` from the shipped examples, adds `resumes/`, `data/` and `artifacts/`, and prints the editing order. It never overwrites a file that already exists, so it is safe to re-run.

Looking for work in Spain? Run `npm run init -- --preset spain` instead. It seeds a campaign in euros for offices in Spain and remote roles open from Spain or Europe, with tracks titled in English and Spanish, and a company list built from [spanishtoptechcompanies.com](https://spanishtoptechcompanies.com). Without the flag `init` uses `--preset us-canada`, the US and Canada setup it always used. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#spain).

Installed with `npx -y autoapply-mcp`, there is no checkout to run `npm run init` in. The agent loads the same list itself with the `load_preset` tool (`preset: "spain"`, and `campaign: true` to start the campaign from the Spain one when there is none yet); the `onboard` prompt does it for a candidate in Spain. It only adds boards, never touches companies you already listed, and never replaces a campaign. If you prefer files, `npx -y -p autoapply-mcp autoapply-mcp-init --preset spain` seeds the home like `init` does.

### The profile template

`examples/profile.example.json` holds no personal data, compensation or location preferences. It does carry a bank of 170 recurring application questions, each matched to the wordings employers use:

- **Fill in:** `identity`, `workAuthorization`, `compensation`, `preferences`, `resumes`, `skills`, `facts`, `experience` and `education`. Every value in these sections is a placeholder or an example to replace. The `workAuthorization` country lists start empty, which gates out every posting that requires citizenship until you add the ISO codes, such as `CA` or `US`, of the countries you can work in.
- **Pre-answered:** decisions that hold for almost anyone, which you should review once before your first run:
  - "How did you hear about us?" (the company careers page);
  - privacy, data-processing and background-check consents;
  - voluntary demographic questions, set to decline.
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
node dist/cli/doctor.js --probe
```

`doctor` validates all three files, checks that your resume files exist and are real PDFs, confirms every track points at a resume variant, warns about settings written in the wrong place, and probes each configured board.

Unknown keys are stripped silently by the schema, so a setting written one level too high reads as configured and behaves as absent. `doctor` reports these as `WARN` and names where the setting belongs:

```
WARN  campaign.json: "maxBatchSize" is ignored; it belongs at "submission.maxBatchSize"
```

`presets/ai-security-us-canada.json` ships 135 company boards that were verified live against the ATS APIs, weighted toward AI, security and infrastructure companies in the US and Canada, alongside large-cap technology employers.

`presets/spain.json` ships 89 boards (37 Greenhouse, 18 Ashby, 13 Lever, 18 Workday and three others) of companies the salary site lists in Spain, each one publishing at least one posting in Spain or remote from Spain or Europe when it was built. `npm run preset:spain` rebuilds it.

Seven of the US and Canada boards are Workday boards. Workday is fully supported for discovery, but applying to one means creating an account on that employer's tenant and walking a multi-step wizard, so expect those to need more hand-holding than a Greenhouse or Ashby posting.

### Additional listing sources

`list_sources` exposes the permanent catalog of 14 ATS, community, aggregator and
portfolio sources. `search_job_sources` searches Himalayas or an authorized
Foorilla PRO+ account; `scan_source_page` extracts employer ATS links from one
a16z, Sequoia, YC or Built In SF page. These results are **unverified leads**, not
jobs that can bypass campaign gates or submission permissions.

SmartRecruiters, Workable public account feeds and Recruitee company XML feeds
work with `add_company_board` and `discover_jobs`. These three ATSs support
discovery only: submitting to them fails with `ats_browser_not_supported` until a
browser integration exists, so you apply at the posting's URL yourself and the
agent records it with `record_submission`. Adding a discovery board never
changes the submission allowlist.

See [docs/SOURCES.md](docs/SOURCES.md) for endpoints, examples, access requirements,
pagination, attribution and limitations. No source requires candidate data for
discovery. Paid accounts are never created automatically.

Nothing in this repository is specific to one candidate. Keep `profile.json`, resumes and the database in `~/.autoapply` and they can never be committed by accident.

Nothing is sent to an employer until you approve it. Once you have, the agent submits by itself: `submission.mode` defaults to `auto`. Listing companies in `submission.allowedCompanies` limits automatic submission to them; left empty, any company that passes the campaign's gates is allowed.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AUTOAPPLY_HOME` | `~/.autoapply` | Root for config, database and artifacts |
| `AUTOAPPLY_PROFILE` | `$HOME/profile.json` | Candidate profile |
| `AUTOAPPLY_CAMPAIGN` | `$HOME/campaign.json` | Campaign policy |
| `AUTOAPPLY_COMPANIES` | `$HOME/companies.json` | Company board list |
| `AUTOAPPLY_DB` | `$HOME/data/autoapply.sqlite` | SQLite database |
| `AUTOAPPLY_ARTIFACTS` | `$HOME/artifacts` | Screenshots and submission evidence |
| `AUTOAPPLY_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `AUTOAPPLY_MIN_INTERVAL_MS` | `700` | Minimum delay between requests to one host |
| `AUTOAPPLY_MAX_RESPONSE_MB` | `64` | Response size ceiling |
| `AUTOAPPLY_FOORILLA_API_KEY` | unset | Optional API key for an existing Foorilla PRO+ subscription; never stored in campaign files |
| `AUTOAPPLY_OTP_IMAP_USER` | unset | Mailbox that receives forwarded verification mail; switches on reading Greenhouse codes and Workday links |
| `AUTOAPPLY_OTP_IMAP_PASSWORD` | unset | App password for that mailbox; never stored in campaign files |
| `AUTOAPPLY_ATS_PASSWORD` | unset | Password for the candidate accounts the server registers: always on Workday, and on any other board in `auto` mode once set |

### Verification codes

Some boards email a code (Greenhouse) or a link (Workday) before they accept an application, and it has to be typed in while the form is still open. The agent needs an email address that receives them, and there are two ways:

- **Connect it to the agent.** An agent with its own mail access (a Gmail connector, for example) reads the code itself: the run returns `awaiting_code` with the browser held at the gate, and the agent calls `provide_verification_code`. Or connect the mailbox to the server over IMAP (`AUTOAPPLY_OTP_IMAP_USER` and `AUTOAPPLY_OTP_IMAP_PASSWORD`), and runs wait up to 300 seconds and read the code themselves.
- **Pass the codes on by hand.** The agent asks you for the code when one arrives; the form waits for it.

`doctor` reports whether an IMAP mailbox is configured. Setup details, such as forwarding filters and app passwords, are in [docs/CONFIGURATION.md](docs/CONFIGURATION.md#verification-codes-environment-only).

## Use with Claude, Cursor, Codex and other MCP clients

The server speaks stdio, so it works with any MCP client that runs local servers. All logs go to stderr, so stdout stays clean for the protocol. `AUTOAPPLY_HOME` can be omitted if you use the default `~/.autoapply`.

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "autoapply": {
      "command": "npx",
      "args": ["-y", "autoapply-mcp"],
      "env": { "AUTOAPPLY_HOME": "/absolute/path/to/your/.autoapply" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add --env AUTOAPPLY_HOME=/absolute/path/to/your/.autoapply autoapply -- npx -y autoapply-mcp
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.autoapply]
command = "npx"
args = ["-y", "autoapply-mcp"]
env = { AUTOAPPLY_HOME = "/absolute/path/to/your/.autoapply" }
```

Running from a source checkout instead, replace `npx -y autoapply-mcp` with `node /absolute/path/to/autoapply-mcp/dist/index.js`.

For salaries in Spain, connect the `tech-pay-spain` server too: Streamable HTTP at `https://spanishtoptechcompanies.com/mcp`, no sign-in. Its [skill](https://github.com/pugarte7/spanish-top-tech-companies/tree/website/skills/tech-pay-spain) tells agents to apply through this server.

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
submit_application             -> fills the form and submits it
record_outcome                 -> track what happened
```

High volume:

```
prepare_batch  {tiers:["A","B"], locationClasses:["bay-area"], minCompensation:250000}
preview_batch                  -> the set, plus grouped blocking questions
approve_batch  + manifestHash + expectedCount   -> asks you to approve the set
submit_batch                   -> submits the set, honouring limits and pacing
list_batches                   -> progress
```

See [docs/TOOLS.md](docs/TOOLS.md) for every tool, [docs/BATCH.md](docs/BATCH.md) for high-volume campaigns and cached personal data, [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the schemas, [docs/RESUMES.md](docs/RESUMES.md) for resume variants and LaTeX builds, and [docs/SAFETY.md](docs/SAFETY.md) for the guarantees and their limits.

## Submission modes

| Mode | Behaviour | Use it when |
|---|---|---|
| `auto` (default) | Server fills the hosted form and clicks submit | Always, unless you want to watch |
| `assisted` | Server fills the form in a visible browser and leaves it open for you to review and submit | You want to see the form or press submit yourself |

Both modes need your approval first. `auto` also needs every required field to be fillable and no blocked question left unanswered, and, when `submission.allowedCompanies` lists companies, the company to be one of them. Boards without browser submission (SmartRecruiters, Workable, Recruitee, Apple) are refused with `ats_browser_not_supported`: apply at the URL yourself, then `record_submission` keeps the counts right. Older campaign files that say `"manual"` load as `auto`, and `doctor` warns.

## What it deliberately does not do

- No LinkedIn Easy Apply, Indeed or Wellfound automation. Their terms prohibit it and their anti-bot systems are built to stop it. Use their alerts as leads, then apply through the employer's own board.
- No assumption that discovery support grants browser submission support. New ATS integrations stay discovery-only until their browser flow exists, and Workday's account-based flow can still require human intervention.
- No CAPTCHA solving, proxy rotation or fingerprint evasion.
- No writing of your resume prose or cover letters. The server supplies structured evidence; your agent writes the words and you approve them.

## Known limitations

- Compensation parsed from description text is a heuristic. Postings that list several geographic pay zones can yield the wrong figure, so those results carry a `compensation-parsed-from-text` flag. Structured ATS pay data is preferred whenever a board publishes it.
- FX rates in `campaign.json` are static. Update them before relying on a cross-currency floor.
- Each posting's questions are read before the browser opens: Greenhouse from its job board API, Ashby from the endpoint its hosted job page uses, and Lever from the question definitions embedded in its apply page. Other boards are drafted against a baseline field set and the real form is read during an assisted run.
- `@modelcontextprotocol/sdk` currently pulls a transitive advisory in `@hono/node-server` affecting its static-file server. This server uses the stdio transport only and never serves static files, so the affected code path is not reachable.

## FAQ

### Can an AI agent apply to jobs for me?

Yes. Connect this server to Claude, Cursor, Codex or another MCP client and the agent can find openings, fill the application and, once you approve the exact packet, submit it. In `assisted` mode it fills the form and you click submit; in `auto` mode it submits by itself, under the approval you gave, and only to the companies in `submission.allowedCompanies` if you list any.

### Is this a LinkedIn Easy Apply bot?

No. It applies through the employer's own applicant tracking system (Greenhouse, Lever, Ashby or Workday), which is where most tech companies take applications anyway. LinkedIn, Indeed and Wellfound alerts are still useful as leads.

### Will it send spam applications?

It is designed not to. Postings that fail your location, seniority, salary or sponsorship gates are not drafted unless you deliberately override the gate, every submission needs your approval, and batches honour the size limits and pacing you configure.

### Where is my personal data stored?

On your machine, in `~/.autoapply`: your profile, resumes and a SQLite database. Discovery needs no candidate data, and submissions only go to hosts the campaign allowlists. The AI client you connect sees whatever the tools return to it, as with any MCP server.

### Does it write my cover letter or invent answers?

It invents nothing. The server fills answers only from your profile and pre-approved answers. Your agent writes the cover letter and any essay question from the facts in your profile, cites them and avoids anything the posting asks for that you lack; you read every word in the packet you approve. Work authorization, sponsorship, salary and the other questions only you can answer are gathered into one message to you.

### Does it solve CAPTCHAs?

No. A detected CAPTCHA is shown to you in the filled browser window, with a notification, and the run carries on once you have solved it. If you don't within `captchaWaitSeconds` (three minutes by default), the application is handed back to you.

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

Over 2,000 tests cover location classification, compensation parsing, every gate, scoring, the answer policy, resume validation, submission guards, packet hashing, persistence, the ATS adapters, form fills and submissions against local replicas of Greenhouse, Lever and Ashby in a real Chromium, and an end-to-end run through a real in-memory MCP client.

## License

MIT. Forked from [niragmehta/autoapply-mcp](https://github.com/niragmehta/autoapply-mcp).
