# Tool reference

All tools return JSON text. Failures return a structured message beginning with a stable error code in brackets, for example `[not_approved] no recorded human approval for this application`.

## Setup

These let an agent set everything up from inside the conversation, so a client with no file access (Claude Desktop without a filesystem server, ChatGPT) never sends the person off to edit JSON. Each write is validated, the previous file is kept as `<file>.bak`, the write is staged and renamed, and the server reloads its configuration afterwards.

A few fields turn a sensitive question into a standing answer: `workAuthorization.alwaysReviewManually: false`, a `compensation.disclosurePolicy` other than `decline`, an auto-filled answer in a blocked category (work authorization, pay, demographics, legal, essays...), an auto-filled demographic or date of birth, a higher `submission.mode`, and removing a category from `blockedQuestionCategories`. Those are written at their safe value and asked of the person through the approval dialog. A client with no dialog gets back `standing.state: "pending"` and a command for the person to run in their own terminal, `node dist/cli/approve.js --setup <changeId>`. The agent cannot make them standing itself. The text the person sees is rendered by the server from the change.

### `onboarding_questions`
What the profile and campaign still lack for the forms boards typically show, grouped (about you, CV, work authorization, pay, where and how, roles, common form questions, blank answer-bank entries, verification mailbox), with a `message` that asks all of it at once. Call it before asking the person anything.

### `setup_profile`
Creates or updates profile.json from what the agent extracted from the CV and the person's messages. Takes any of `identity`, `personal`, `experience`, `education`, `skills` (with optional `since`), `facts`, `languages`, `preferences`, `workAuthorization`, `compensation`, `resumes`, `answers`, `narratives`, and `statedByPerson`.

The patch is deep-merged: objects key by key, lists entry by entry when entries have an identity (`id`, `key`, `name`, `term`, company and title, institution), other lists replaced, `null` removes a key. A resume `path` must exist and be a real PDF or DOCX. A profile that does not validate yet and has no profile.json is kept as `profile.draft.json`, and the reply lists what is missing; an existing profile.json is never replaced by an invalid one. Answers in the patch count as inferred unless `statedByPerson` is true.

### `update_campaign`
Same pattern for campaign.json: `name`, `targetApplications`, `tracks`, `locations`, `compensation` (floors, fx), `seniority`, `exclusions`, `submission` (mode, limits, allowlists, blocked categories) and `freshnessDays`. Boards are added with `add_company_board`.

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
| `answers` | `{ questionKey, answer, remember?, statedByPerson? }[]?` |
| `notes` | `string?` |

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

### `submit_application`
Runs every guard, then acts according to mode.

| Input | Type | Notes |
|---|---|---|
| `applicationId` | `string` | |
| `mode` | `"auto" \| "assisted"` | Defaults to `auto`; cannot exceed the campaign's configured mode |
| `headless` | `boolean?` | Ignored in assisted mode |
| `keepOpenSeconds` | `number?` | Assisted mode: how long to leave the filled form open (at most 1800) |
| `verificationCode` | `string?` | The one-time code the board emailed after a previous attempt hit its gate; each attempt emails a new one |
| `waitForCodeSeconds` | `number?` | Hold the browser at a verification gate for this long (at most 1800) while the code is read from `<artifacts>/<applicationId>.code` or the configured mailbox; also bounds the wait for Workday's account-verification link. Defaults to 300 with a verification mailbox configured, otherwise 0 |

- `auto` (the default) fills and clicks submit. Requires campaign mode `auto`, every required field fillable, no unresolved questions and, when `submission.allowedCompanies` lists companies, one of them. With ATS credentials available it registers a candidate account where a board demands one, on any ATS.
- `assisted` fills the hosted form in a visible browser, screenshots it, and leaves it open for you to review and submit. If your submission reaches the board's confirmation page during the hold, the run returns at once and records it as submitted with that page as evidence; otherwise it returns `prepared` and you call `record_submission` yourself. Agents use it only when the person asks to watch or to submit themselves.

A run that stops short returns `fieldsToAnswer`: each required field it could not fill, with its `questionKey` and `who`. The `nextStep` names the fields the agent can answer from the profile, to record with `set_application_content` and run again, and the ones to put in the single grouped message to the person. A CAPTCHA is handed to the person, never solved.

Greenhouse and Workday gate submission behind an emailed code or link that only
lives as long as the attempt that requested it. Link a mailbox before the first
submission (`AUTOAPPLY_OTP_IMAP_USER` and `AUTOAPPLY_OTP_IMAP_PASSWORD`, see
[CONFIGURATION.md](CONFIGURATION.md#verification-codes-environment-only)) and runs
wait 300 seconds at the gate by default, reading the code themselves. Without a
mailbox, pass `waitForCodeSeconds` and have the code written to
`<artifacts>/<applicationId>.code` while the run waits.

SmartRecruiters, Workable, Recruitee and Apple are discovery-only integrations.
Submitting to them fails with `ats_browser_not_supported`; the person applies at
the posting's URL themselves and the agent then calls `record_submission`.

### `record_submission`
Marks an application submitted after the person sent it themselves (a board without browser submission, or an assisted run they finished), keeping counts, pacing and duplicate checks accurate.

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
Submits the approved set in `auto` (default) or `assisted` mode, re-running all
guards per application and honouring pacing and any configured daily limit.
`submission.dailyLimit: null` removes the daily ceiling, not per-batch,
per-company, approval or destination checks.

| Input | Type |
|---|---|
| `batchId` | `string` |
| `mode` | `"auto" \| "assisted"`, default `auto` |
| `maxSubmissions` | `number?` — defaults to `submission.maxBatchSize` (15); always capped by that setting |
| `headless` | `boolean?` |
| `waitForCodeSeconds` | `number?` — as for `submit_application`: 300 by default with a verification mailbox, otherwise 0. Each application polls its own `<artifacts>/<applicationId>.code` |

Each application that stops short carries `fieldsToAnswer` and its own `nextStep`; answer the `who: "agent"` fields and resubmit it with `submit_application`. Account registration follows the same rule as `submit_application`.

### `list_batches`
Recent batches with status and per-state counts.

## Tracking

### `record_outcome`
Appends an outcome: `acknowledged`, `recruiter_screen`, `interview`, `offer`, `rejected`, `ghosted`, `withdrawn`.

### `list_applications`
Applications with status, target role and outcome history. Optional `status` and `limit` filters.

### `audit_log`
Recent recorded events with redacted payloads. Event types include `discovery.run`, `application.prepared`, `application.updated`, `application.redrafted`, `application.approval`, `submission.prepared`, `submission.submitted`, `submission.aborted`, `submission.blocked`, `submission.recorded` and `outcome.recorded`.

### `reload_config`
Re-reads all three configuration files so edits apply without restarting the server.
