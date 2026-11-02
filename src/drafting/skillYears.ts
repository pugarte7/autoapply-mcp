import type { Profile, Skill } from "../domain/profile.js";

/**
 * "How many years of experience do you have with Python?"
 *
 * Boards ask this per technology, and the dated experience list cannot answer
 * it: a job's dates say nothing about which tools were used in it. A skill's
 * `since` can, so the answer is arithmetic on a date the person gave.
 *
 * Matching is deliberately exact. The subject the question names, once the
 * words that only qualify how experience is counted are removed, must be the
 * skill's name or one of its aliases and nothing more. "Python and Django",
 * "backend Python" or "Go or Rust" are left to a person: a number of years
 * stated against a subject the profile does not date is a claim nobody made.
 */

export type SkillYearsResolution = { answer: string; citation: string };

/** Words that say how experience is counted without changing what it is in. */
const QUALIFIERS = "(?:(?:professional|hands-on|hands on|commercial|industry|working|work|relevant|practical|real-world|production)\\s+)*";
const NUMBER_ASKED = "(?:how many|number of|total)\\s+years?\\s+(?:of\\s+)?";
const TRAILER = "(?:\\s+(?:do you have|have you got|have you had|do you possess))?";
const WITH = "(?:with|in|using|working with|of)";
const THRESHOLD_LEAD =
  "(?:(?:do|have|did)\\s+you\\s+(?:have|got|possess)\\s+)?(?:at least|over|more than|greater than|a minimum of|minimum(?: of)?)?\\s*";
const THRESHOLD_YEARS = "(\\d{1,2})\\s*(?:\\+|or more|plus)?\\s+years?\\s+(?:of\\s+)?";

/** "how many years of experience do you have with X", "years of experience in X". */
const COUNT_WITH = new RegExp(`^(?:${NUMBER_ASKED}|years? of\\s+)${QUALIFIERS}experience${TRAILER}\\s+${WITH}\\s+(.+?)${TRAILER}$`);
/** "how many years of X experience do you have", "years of X experience". */
const COUNT_OF = new RegExp(`^(?:${NUMBER_ASKED}|years? of\\s+)${QUALIFIERS}(.+?)\\s+experience${TRAILER}$`);
/** "do you have 3+ years of experience with X". */
const THRESHOLD_WITH = new RegExp(`^${THRESHOLD_LEAD}${THRESHOLD_YEARS}${QUALIFIERS}experience\\s+${WITH}\\s+(.+)$`);
/** "do you have 3+ years of X experience". */
const THRESHOLD_OF = new RegExp(`^${THRESHOLD_LEAD}${THRESHOLD_YEARS}${QUALIFIERS}(.+?)\\s+experience$`);
const STRICT = /^(?:(?:do|have|did)\s+you\s+(?:have|got|possess)\s+)?(?:over|more than|greater than)\b/;

/**
 * Lowercased with the form's decoration removed but the characters that make
 * a technology's name kept: C, C++ and C# are three different answers.
 */
export function skillText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\(required\)|\(optional\)|\*/g, " ")
    .replace(/[^a-z0-9+#./\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.?:]+$/, "");
}

type Asked = { subject: string; threshold: number | null; strict: boolean };

function askedFor(label: string): Asked | null {
  const text = skillText(label);
  const threshold = THRESHOLD_WITH.exec(text) ?? THRESHOLD_OF.exec(text);
  if (threshold?.[1] && threshold[2]) {
    return { subject: threshold[2], threshold: Number(threshold[1]), strict: STRICT.test(text) };
  }
  const count = COUNT_WITH.exec(text) ?? COUNT_OF.exec(text);
  if (count?.[1]) return { subject: count[1], threshold: null, strict: false };
  return null;
}

function namesOf(skill: Skill): string[] {
  return [skill.name, ...skill.aliases].map(skillText).filter((name) => name.length > 0);
}

/**
 * Years since `since`, never rounded up. A bare year is counted from its last
 * day, because the person may have started in December; claiming the extra
 * months would state experience they may not have.
 */
export function yearsSince(since: number | string, now: Date = new Date()): number {
  const [year, month] =
    typeof since === "number" ? [since, 12] : (since.split("-").map(Number) as [number, number]);
  const months = (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - month);
  return Math.max(0, Math.floor(months / 12));
}

export function resolveSkillYears(label: string, profile: Profile, now: Date = new Date()): SkillYearsResolution | null {
  const asked = askedFor(label);
  if (!asked) return null;
  const subject = asked.subject.replace(/^the\s+/, "").trim();
  const index = profile.skills.findIndex((skill) => skill.since !== undefined && namesOf(skill).includes(subject));
  const skill = profile.skills[index];
  if (!skill || skill.since === undefined) return null;
  const held = yearsSince(skill.since, now);
  const citation = `skills[${index}].since`;
  if (asked.threshold === null) return { answer: String(held), citation };
  const clears = asked.strict ? held > asked.threshold : held >= asked.threshold;
  return { answer: clears ? "Yes" : "No", citation };
}
