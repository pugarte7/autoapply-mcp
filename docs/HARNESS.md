# Agent harness: what autoapply borrows from Hermes Agent and Instinct

The goal is an agent that applies for the person and asks as little as
possible. Two agents the maintainer pointed to do this well: Nous Research's
Hermes Agent and Instinct. This page records what each one does to act on its
own, and which of those mechanisms an MCP server can offer. A server cannot
drive the client's loop. It can ship prompts, resources, instructions,
`nextStep` hints in tool results, and memory kept on the server.

Researched 2026-11-02. Hermes Agent is open source and documented, so its
section is specific. Instinct is a closed, invite-only product; what is known
comes from press and third-party reviews, and its section says so.

## Hermes Agent (Nous Research)

MIT-licensed agent runtime in Python, model-agnostic, run from a CLI, a
desktop app or a messaging gateway. Source:
<https://github.com/NousResearch/hermes-agent>, docs:
<https://hermes-agent.nousresearch.com/docs/>.

**Persistent memory.** Two small files in `~/.hermes/memories/`: `MEMORY.md`
(the agent's notes, capped at 2,200 characters) and `USER.md` (the user
profile, 1,375 characters). They are injected into the system prompt once at
session start as a frozen snapshot. The agent writes them with a `memory` tool
(`add`, `patch`, `remove`) when it learns a preference, an environment fact, a
convention or a correction, and skips trivia and anything easy to look up
again. Nothing auto-compacts: the cap forces the agent to consolidate. A
background review after a turn may also save memory or update skills.
Optional write approval queues every write for the user.
<https://hermes-agent.nousresearch.com/docs/user-guide/features/memory>

**Session search.** Every past session is stored in SQLite with FTS5; a
`session_search` tool returns the actual messages, so old context is looked up
rather than kept in the prompt.

**Self-written skills.** Skills are procedural memory in the Agent Skills
format (<https://agentskills.io/specification>): a directory with `SKILL.md`,
frontmatter `name` and `description`, optional `references/`, `scripts/`,
`assets/`. The agent creates and patches them with `skill_manage` after it
worked out a multi-step procedure, hit dead ends and found a path, or was
corrected by the user. Skills load progressively: names and descriptions
always, the body when relevant, reference files on demand. Skills can also be
installed from a GitHub repo (`hermes skills tap add owner/repo`, default path
`skills/`) or a URL.
<https://hermes-agent.nousresearch.com/docs/user-guide/features/skills>

**Scheduled jobs.** A built-in scheduler (`cronjob_manage`, `/cron add "every
monday 9am" "..."`) runs a prompt in a fresh session with attached skills and
delivers the final answer to a chat. Because "a scheduled run has nobody to
answer a prompt", the job prompt must hold everything the agent needs, and
dangerous commands are denied by default in cron runs. A failure streak
triggers a review nudge.
<https://hermes-agent.nousresearch.com/docs/user-guide/features/cron>

**Autonomy settings.** Dangerous shell commands are matched against patterns
and need approval. Modes: `smart` (an auxiliary model approves low-risk
commands and denies clear danger, asks only when unsure), `manual`, `off`
(`--yolo`). "Always" answers become an allowlist, and a hardline blocklist sits
below every mode. Unattended contexts have their own setting, default deny.
<https://hermes-agent.nousresearch.com/docs/user-guide/security>

**When it asks.** A `clarify` tool asks "one or more questions when you need
clarification, feedback, or a decision before proceeding". A run with no chat
gets "[clarify prompt could not be delivered: no chat surface]" back instead of
waiting. A `todo` tool plans tasks of three or more steps and `delegate_task`
spawns subagents whose final summary is all that returns.
<https://hermes-agent.nousresearch.com/docs/reference/tools-reference>

## Instinct (Spear Street Technology)

A consumer personal agent founded in 2025 by Noah Shinn (formerly at Sierra,
co-author of Reflexion), invite-only since August 2026, used over iMessage,
WhatsApp or a phone call, with a web workspace and a Mac app. Official site:
<https://instinct.com>. I found no public documentation of its internals and
no Instinct coding agent or open harness; what follows is reported by third
parties and should be read as such.

- **Proactive.** It starts conversations: "texts you first when something
  needs doing", follows up on dropped threads, reminds about bookings to
  cancel. <https://www.eesel.ai/blog/instinct-ai-review>
- **Acts on its own computer.** A cloud computer with a browser fills forms
  and books things on sites without APIs; it can call businesses for you.
  <https://www.eigent.ai/pl/blog/what-is-instinct-ai-personal-assistant>,
  <https://letsdatascience.com/news/instinct-raises-1-billion-series-c-c9d149f6>
- **Few step-by-step permissions, one hard gate on money.** Reviews describe a
  design that lets it "access and do more without step-by-step permissions";
  purchases use a one-time card whose amount the user approves.
  <https://www.eesel.ai/blog/instinct-ai-review>
- **Memory.** A black-box teardown concluded it uses git-tracked Markdown
  files, daily files, keyword search, and a background process that
  periodically reorganizes what it knows.
  <https://runtimewire.com/article/supermemory-reverse-engineers-instinct-memory-git-markdown-grep>
- **Credentials in a vault**, not in the conversation.

Nothing published says how Instinct decides when to ask the user, so this page
does not claim a rule for it.

## What applies to an MCP server like autoapply

| Mechanism | Hermes / Instinct | In autoapply |
| --- | --- | --- |
| A whole procedure the agent can start with no memory | cron job prompt, skills | MCP prompts `onboard`, `daily_apply`, `resolve_blockers` (`src/harness/prompts.ts`) |
| Portable procedural memory | Agent Skills `SKILL.md` | `skills/autoapply/SKILL.md`, same loop, loadable by Claude Code, Codex, Hermes |
| State injected at session start | frozen `MEMORY.md` snapshot | `autoapply://agenda`: held applications and the exact questions holding them, today's budget, profile gaps |
| Learning from dead ends | memory writes and skill patches after failures | `autoapply://lessons`: per ATS how attempts ended, which questions needed a person, advice naming the tool to use |
| User facts remembered | `USER.md`, Honcho | the profile itself, plus `remember_answer` so an answer typed once fills every later form |
| Asking once, grouped | `clarify` with several questions | every prompt collects person-only questions and asks them in one message at the end |
| Standing permission | allowlist from "always" answers, smart approvals | standing rules the person approves once (`approve_rules`, `list_rules`), per-packet approval as fallback |
| Hard floor below autonomy | hardline blocklist | server guards: no CAPTCHA solving, no invented facts, packet hash approval |
| Unattended runs deny by default | `cron_mode: deny` | a scheduled `daily_apply` submits only what approved rules cover and reports the rest |
| Proactive follow-up | Instinct texts first | out of reach for a server; the digest at the end of `daily_apply` is the nearest thing |
| Secrets in a vault | Instinct vault, Hermes env vars | Keychain or env vars, never profile.json (unchanged) |

Not built, and why:

- **Scheduling.** The server cannot wake an agent up. Hermes users can
  attach the skill to a cron job (`hermes cron create "every day 9am" "Run the
  autoapply daily_apply prompt" --skill autoapply`); Claude Code users can use
  `/schedule` or launchd. The standing-approval work adds `src/cli/daily.ts`.
- **Agent-written memory on the server.** A free-text notes tool would let job
  pages, which are untrusted, write into what the next run reads. The lessons
  are computed from the audit log instead, so they cannot be injected and
  cannot drift from what happened.
- **Corrected answers.** The log records which answer keys
  `set_application_content` changed, not what they were changed from, so
  "answers later corrected" is not counted yet. Recording the previous
  source per changed key in that event would make it a lesson.

## How the lessons are kept small and private

`computeLessons` (`src/harness/lessons.ts`) reads only `events` of type
`submission.*` and the stored applications. It returns counts per ATS, and for
questions only the employer's label with counts and the boards it appeared on,
never the answer. The top 25 questions are kept. There is no new table and no
hook in the submission path: anything the tools already log becomes a lesson
the next read.
