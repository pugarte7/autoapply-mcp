# Tool reference

All tools return JSON text. Failures return a structured message beginning with a stable error code in brackets, for example `[not_approved] no recorded human approval for this application`.

## Setup

These let an agent set everything up from inside the conversation, so a client with no file access (Claude Desktop without a filesystem server, ChatGPT) never sends the person off to edit JSON. Each write is validated, the previous file is kept as `<file>.bak`, the write is staged and renamed, and the server reloads its configuration afterwards.

A few fields turn a sensitive question into a standing answer: `workAuthorization.alwaysReviewManually: false`, a `compensation.disclosurePolicy` other than `decline`, an auto-filled answer in a blocked category (work authorization, pay, demographics, legal, essays...), an auto-filled demographic or date of birth, and removing a category from `blockedQuestionCategories`. Those are written at their safe value and asked of the person through the approval dialog. A client with no dialog gets back `standing.state: "pending"` and a command for the person to run in their own terminal, `node dist/cli/approve.js --setup <changeId>`. The agent cannot make them standing itself. The text the person sees is rendered by the server from the change.

### `onboarding_questions`
What the profile and campaign still lack for the forms boards typically show, grouped (about you, CV, work authorization, pay, where and how, roles, common form questions, blank answer-bank entries, verification mailbox), with a `message` that asks all of it at once. Call it before asking the person anything. Gaps the agent closes itself, such as no companies configured, are listed under `agentFixes` with the tool to call and left out of the message.

### `setup_profile`
Creates or updates profile.json from what the agent extracted from the CV and the person's messages. Takes any of `identity`, `personal`, `experience`, `education`, `skills` (with optional `since`), `facts`, `languages`, `preferences`, `workAuthorization`, `compensation`, `resumes`, `answers`, `narratives`, and `statedByPerson`.

The patch is deep-merged: objects key by key, lists entry by entry when entries have an identity (`id`, `key`, `name`, `term`, company and title, institution), other lists replaced, `null` removes a key. A resume `path` must exist and be a real PDF or DOCX. A profile that does not validate yet and has no profile.json is kept as `profile.draft.json`, and the reply lists what is missing; an existing profile.json is never replaced by an invalid one. Answers in the patch count as inferred unless `statedByPerson` is true.

### `update_campaign`
Same pattern for campaign.json: `name`, `targetApplications`, `tracks`, `locations`, `compensation` (floors, fx), `seniority`, `exclusions`, `submission` (limits, allowlists, blocked categories) and `freshnessDays`. Boards are added with `add_company_board`.

### `load_preset`
Adds a company list to companies.json: `preset` is `spain` (employers hiring in Spain or remote from Spain or Europe, downloaded from https://spanishtoptechcompanies.com/api/v1/boards.json with that day's tiers, or `presets/spain.json` when the site cannot be read) or `us-canada` (`presets/ai-security-us-canada.json`). A company already listed, matched by name case-insensitively or by the same board under another name, is kept exactly as written, `active: false` included; companies.json is created if missing, kept as `.bak` otherwise, and the workspace reloads. With `campaign: true` and neither campaign.json nor campaign.draft.json present, the preset's campaign is written through the same validated path as `update_campaign`, with each track pointed at the profile's default resume; an existing campaign is never replaced. Reports `added`, `alreadyPresent`, `total` and `source` (the URL, or `shipped`), plus `fallback` with the reason when the site was not used. Boards are discovery sources only and grant no submission permission, so nothing is asked of the person. The files are read from the installed package, so this works from `npx -y autoapply-mcp`.

`onboarding_questions` reports an empty company list under `agentFixes` with `load_preset` as the fix, naming `spain` when the profile's country is Spain or the campaign allows `spain` or `remote-spain`.

### `remember_answer`
Stores a standing answer in `profile.answers` and fills it into every open application (`drafted`, `needs_human`, `awaiting_approval`) whose question the drafting engine now answers from it. Reports `updatedApplications` with the questions each one gained.

| Input | Type |
|---|---|
| `label` | `string`, the question as the form words it |
| `answer` | `string` |
| `statedByPerson` | `boolean`, true only for the person's own words |
| `key` | `string?`, defaults to the bank entry the question already matches (so a shipped blank entry is filled in), or a new key |
| `patterns` | `string[]?`, defaults to the label lowercased |
| `alternatives` | `string[]?` |
| `allowAutoFill` | `boolean?`, default true |
| `skip`, `note` | optional |

A question in a blocked category, or any answer with `statedByPerson: false`, is confirmed by the person first. Answers already given on one application are never overwritten.

## Discovery and ranking

### `list_sources`
Returns the permanent catalog of employer adapters, public aggregate APIs and
lead pages, including readiness, credential requirements, attribution and
submission limitations. No input; no credentials are revealed.

### `search_job_sources`
Fetches one bounded page of **unverified leads**, without saving employer jobs or applications.

| Input | Type | Notes |
|---|---|---|
| `source` | `"himalayas" \| "foorilla"` | Foorilla requires an existing PRO+ API key |
| `query` | `string` | Required, 1-300 characters |
| `country` | `string?` | Himalayas only, e.g. `US` |
| `location` | `string?` | Foorilla only, e.g. `San Francisco` |
| `company` | `string?` | Himalayas company slug or Foorilla company text |
| `limit` | `number?` | 1-100, default 20 |
| `page` | `number?` | Positive integer, default 1 |

Results include provenance, original salary units, location restrictions,
attribution and pagination. Truncated pages return the same `nextPage` and a
larger `nextPageLimit`; see [SOURCES.md](SOURCES.md). Descriptions are untrusted.
Follow an employer ATS link and verify it before creating a campaign job.

### `scan_source_page`
Reads one public page and returns recognized, unverified employer ATS board links.

| Input | Type | Notes |
|---|---|---|
| `source` | `"a16z" \| "sequoia" \| "yc" \| "builtinsf"` | Required |
| `url` | `string?` | Optional page on the selected source's HTTPS origin |
| `limit` | `number?` | 1-100 board links, default 30 |

Does not visit employer links, save boards or authorize submission. Client-rendered
pages may need manual follow-up; empty/truncated results are not exhaustive.

### `add_company_board`
Verifies a real employer board and optionally saves it to discovery configuration.
Supports `greenhouse`, `lever`, `ashby`, `workday`, `smartrecruiters`, `workable`
and `recruitee`. Requires `name`, `ats`, and `board`; optional `query`, `region`,
`tier`, `tags` and `save` (default true). `save:false` verifies without saving.
Neither saving a board nor installing an adapter grants submission permission.

### `discover_jobs`
Fetches every configured board, normalizes postings, applies gates, scores survivors and stores results. Read-only with respect to employers.

| Input | Type | Notes |
|---|---|---|
| `companies` | `string[]?` | Restrict to named companies; defaults to all active boards |
| `includeIssues` | `boolean?` | Include per-board fetch failures (default true) |

Returns counts of postings fetched, new versus refreshed, and an evaluation summary with the top gate rejection reasons. A board that fails never aborts the run.

### `resolve_company_board`
Probes Greenhouse, Lever and Ashby for a company's public board slug. Board tokens are not published centrally, so verify rather than guess.

| Input | Type |
|---|---|
| `companyName` | `string` |
| `extraSlugs` | `string[]?` |

### `list_queue`
The ranked, de-duplicated shortlist. Roles already applied to are excluded by role fingerprint, so the same posting on a second board does not reappear.

| Input | Type |
|---|---|
| `minScore` | `number?` (defaults to the tier C threshold) |
| `tiers` | `("A"\|"B"\|"C")[]?` |
| `trackId` | `string?` |
| `limit` | `number?` (max 200) |

### `explain_job`
Full gate result and score breakdown with quoted evidence, plus the posting text wrapped as untrusted data.

| Input | Type |
|---|---|
| `jobId` | `string` |
| `includeDescription` | `boolean?` |

### `campaign_status`
Progress toward target, pipeline counts by status, tier distribution, top rejection reasons, queue depth, and track allocation (intended share versus what is actually queued).

## Drafting

### `prepare_application`
Builds the match report, loads the employer's application questions, drafts only the answers verified profile data supports, and selects the resume variant for the matched track. Creates a local draft; nothing is sent.

| Input | Type | Notes |
|---|---|---|
| `jobId` | `string` | |
| `force` | `boolean?` | Prepare even if the job failed the gates |
| `resumeId` | `string?` | A `profile.resumes` id to use instead of the matched track's variant, e.g. the security variant for a security role the classifier filed under a general software track |

Returns the application id, status, packet hash, the match report, the questions still open (`questionsNeedingHuman`), and the answers that were auto-filled with their citations.

Each open question carries `who`. `"agent"` means the profile or CV can answer it and the agent writes the answer itself: essays and other free text with no authorised narrative are blocked as agent-draftable, with guidance to write from the match report's `relevantFacts`, cite the fact ids and never claim anything in `claimsToAvoid`. `"person"` means only the candidate can answer: work authorization, sponsorship, citizenship, clearance, criminal history, compensation, demographics, veteran and disability status, and attestations that claim something about them, when no standing answer covers them. Neither kind is auto-filled; both are recorded with `set_application_content` and shown to the person in the packet they approve.

Status will be `needs_human` while a required question is open, otherwise `awaiting_approval`.

### `set_application_content`
Records a cover letter and answers to questions the policy engine would not fill: the ones the agent wrote (`who: "agent"`) and the ones the person gave (`who: "person"`). Invalidates any prior approval, because approval is bound to content. Answers given here are recorded with `source: "agent"`: the agent calls this tool, so only the person's own dialog or terminal can make an answer theirs.

| Input | Type |
|---|---|
| `applicationId` | `string` |
| `coverLetter` | `string?` |
| `answers` | `{ questionKey?, label?, required?, answer, remember?, statedByPerson? }[]?` |
| `notes` | `string?` |

An answer with `label` instead of `questionKey` adds a question the live form asks that the packet lacks (every Workday question, for instance), or answers the existing question with that label; `required` says whether the form marks it required (default true). An answer to such a question carries to the next posting at the same employer.

`remember: true` on an answer does what `remember_answer` does for that question, so it is not asked again at the next company. The reply then carries `remembered`.

### `preview_application`
Renders the exact submission packet - every field, its value, and where the value came from - plus the packet hash to approve. Unresolved required answers are listed explicitly.

## Approval and submission

### `approve_application`
Asks the person, not the model, to approve the exact packet, and records their answer. The client shows them the packet in its approval dialog (MCP elicitation). A client without one gets `person_approval_needed` and the command the person runs in their own terminal: `node dist/cli/approve.js <applicationId> <packetHash>`, which shows the packet and records an approval only on a typed "yes" and refuses to run without a terminal. A `"rejected"` decision needs no confirmation.

| Input | Type | Notes |
|---|---|---|
| `applicationId` | `string` | |
| `packetHash` | `string` | Must match current content exactly |
| `decision` | `"approved" \| "rejected"` | Defaults to approved |
| `note` | `string?` | |

A mismatched hash fails with `packet_hash_mismatch`, before the person is asked. If they say no, nothing is recorded and the result's `decision` is `"declined"`.

### `approve_rules`
Proposes standing rules and asks the person to approve them once, through the same dialog. Afterwards an application with no approval of its own can be submitted when an active rule set covers it. Without a dialog the person runs `node dist/cli/approve.js rules <rulesId> <rulesHash>` in their own terminal. A declined proposal is revoked so it cannot be approved later. See [SAFETY.md](SAFETY.md#standing-rules).

| Input | Type | Notes |
|---|---|---|
| `tiers` | `("A"\|"B"\|"C")[]` | Defaults to A and B |
| `minScore` | `number?` | |
| `companies` | `string[]?` | Empty means any company whose posting passed the campaign gates |
| `excludeCompanies` | `string[]?` | |
| `tracks` | `string[]?` | Campaign track ids; empty means every track |
| `atsKinds` | `string[]?` | e.g. `["greenhouse","ashby"]`; empty means every board |
| `maxPerDay` | `number` | Submissions these rules may authorise per day |
| `allowAgentDraftedText` | `boolean` | Cover letters and essays the agent wrote from profile facts. Default false |
| `expiresAt` | `string?` | ISO date; defaults to 30 days, at most 90 |

### `list_rules`
Every rule set with its status (`proposed`, `active`, `expired`, `revoked`), how it was approved (`dialog` or `cli`) and how many submissions it authorised today.

### `revoke_rules`
Ends a rule set at once. Needs no confirmation.

### `submit_application`
Runs every guard and hands the agent the approved packet. The server never opens the employer's site: the agent sends the packet with its own browser.

| Input | Type | Notes |
|---|---|---|
| `applicationId` | `string` | |

Requires your approval of the current packet (or standing rules that cover it), no unresolved required question, a readable resume, an allowlisted HTTPS destination, a company not excluded and, when `submission.allowedCompanies` lists companies, one of them, room under the daily limit and the per-company cap, and the pacing delay since the last submission (a refusal then carries `waitSeconds`).

Returns `applyUrl`, `resumePath`, `coverLetter`, `fields` (each `label`, `value`, `required`), `authorisedBy` (`approval` or `rules`) and a `nextStep` the agent follows:

- open `applyUrl`, fill every field with exactly its value, attach the resume, paste the cover letter where the form has a place for it;
- a question the packet lacks is added with `set_application_content` by its `label`, which voids the approval unless standing rules cover the new packet; a question only the person can answer goes to them;
- a CAPTCHA, or a question asking whether the applicant is a bot or an AI, is handed to the person, never solved or answered;
- an emailed verification code is read with the agent's own mail access, or asked of the person;
- once the board confirms, `record_submission`.

A packet handed over twice counts once against standing rules.

### `record_submission`
Marks an application submitted once the board confirmed it, whether the agent sent it or the person did, keeping counts, pacing and duplicate checks accurate. Takes `applicationId`, `confirmationRef` (the board's confirmation text) and `notes`. A batch item for the application becomes `submitted`.

## Batch operations

### `prepare_batch`
Prepares many applications at once from a queue filter, using the same drafting and validation as the single path. See [BATCH.md](BATCH.md).

| Input | Type |
|---|---|
| `tiers` | `("A"\|"B"\|"C")[]?` — defaults to A and B |
| `trackIds` | `string[]?` |
| `locationClasses` | `string[]?` |
| `companies` | `string[]?` |
| `minScore` | `number?` |
| `minCompensation` | `number?` — annualized top-of-range, campaign currency |
| `allowUnknownCompensation` | `boolean?` — default false |
| `limit` | `number?` — default 50, max 300 |

Returns the batch id, ready versus needs-human counts, `blockingReasons` grouped by category, `recurringQuestions` listing the exact repeated question text with `who`, suggestions and guidance, the auto-filled personal fields, and the manifest hash.

### `preview_batch`
Every application in the batch with company, role, compensation, readiness and what is blocking it, including each application's `outstanding` questions with `who`, their suggestions and guidance. Returns the current manifest hash and whether the stored one is stale.

### `approve_batch`
Asks the person to approve every ready application, listed by company and title, and records an approval for each on their yes. Requires `batchId`, `manifestHash` and `expectedCount`; a mismatch in either fails with `manifest_mismatch` or `count_mismatch` before anyone is asked. Without an approval dialog in the client, the person runs `node dist/cli/approve.js --batch <batchId> <manifestHash> <count>`.

### `submit_batch`
Hands over the next application of the batch that every guard allows now, exactly as `submit_application` does. The agent sends it, calls `record_submission`, and calls `submit_batch` again for the next. `submission.dailyLimit: null` removes the daily ceiling, not the per-company, approval or destination checks. A batch nobody approved is accepted while standing rules are active: the applications they cover are handed over and the rest wait.

| Input | Type |
|---|---|
| `batchId` | `string` |
| `skip` | `string[]?` — application ids to pass over in this call, such as one waiting on a CAPTCHA the person has not solved yet |

Returns `next` (the packet, as from `submit_application`), `remaining`, and `held` for applications that could not be handed over, each with `outcome` (`waiting` for pacing, a daily cap or rules that do not cover it; `blocked` otherwise) and `detail`. Under pacing, `nextStep` says how many seconds to wait.

### `list_batches`
Recent batches with status and per-state counts.

## Tracking

### `record_outcome`
Appends an outcome: `acknowledged`, `recruiter_screen`, `interview`, `offer`, `rejected`, `ghosted`, `withdrawn`.

### `list_applications`
Applications with status, target role and outcome history. Optional `status` and `limit` filters.

### `audit_log`
Recent recorded events with redacted payloads. Event types include `discovery.run`, `application.prepared`, `application.updated`, `application.redrafted`, `application.approval`, `submission.handed_off`, `submission.blocked`, `submission.recorded` and `outcome.recorded`.

### `reload_config`
Re-reads all three configuration files so edits apply without restarting the server.
