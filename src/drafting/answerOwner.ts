import { classifyQuestion } from "./blockedQuestions.js";

/**
 * Who has to answer a question the policy engine left open.
 *
 * Most open questions are not decisions at all. "Tell us about a project you
 * are proud of", "How many years of Go?", "Which office would you work from?"
 * all have answers in the profile and the CV, and sending each of them to the
 * person turned one application into a dozen messages. The agent can write
 * those itself from the match report and record them with
 * set_application_content; the person still sees every one at approval.
 *
 * What only the person can answer is a statement with legal or personal
 * weight that nothing on file already states: their right to work, a visa,
 * citizenship, clearance, criminal history, pay, and the voluntary
 * self-identification questions, and every attestation or consent: a privacy
 * notice or data-processing consent is the person's to give, so it reaches
 * the agent only once they have said yes in the answer bank, and a question
 * that gets here has no such yes.
 *
 * This only routes the question. It never makes an answer acceptable: the
 * truthfulness checks run on whatever is recorded, whoever wrote it.
 */
export type AnswerOwner = "agent" | "person";

export const PERSON_ONLY_CATEGORIES: ReadonlySet<string> = new Set([
  "work-authorization",
  "sponsorship",
  "citizenship",
  "clearance",
  "criminal-history",
  "compensation",
  "demographic",
  "veteran",
  "disability",
  "legal-attestation",
]);

/**
 * Any mention of pay. The compensation category wants a qualifier beside the
 * word and misses plurals - "What are your salary expectations?" classifies
 * as general - which is harmless for drafting, where general is blocked too,
 * but here it would hand a salary figure to the agent to make up.
 */
const MENTIONS_PAY = /\b(?:salar(?:y|ies)|compensation|remuneration|wages?|pay (?:range|expectations?|requirements?))\b/i;

/**
 * The stored category comes first, and the label is classified again because
 * questions read off a live form are stored as "employer-specific" whatever
 * they ask: a discovered "Do you require visa sponsorship?" must still go to
 * the person.
 */
export function answerOwner(label: string, category: string): AnswerOwner {
  if (MENTIONS_PAY.test(label)) return "person";
  const categories = [category, classifyQuestion(label)];
  return categories.some((entry) => PERSON_ONLY_CATEGORIES.has(entry)) ? "person" : "agent";
}

/** Shown on an essay the engine will not fill, so the agent writes it rather than asking. */
export const AGENT_DRAFT_REASON = "agent-draftable: no authorised narrative covers this free-text question";

export const AGENT_DRAFT_GUIDANCE =
  "Write this answer yourself from the match report's relevantFacts and matchedKeywords: say which fact ids it rests on, " +
  "never claim anything listed in claimsToAvoid, and invent nothing the profile does not state. Record it with " +
  "set_application_content. The person reads it at approval, so do not ask them to write it. The one exception: " +
  "where the question or the employer asks for writing without AI assistance, leave it for the person.";
