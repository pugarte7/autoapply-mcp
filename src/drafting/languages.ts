import type { Language, LanguageLevel, Profile } from "../domain/profile.js";
import { normalizeLabel } from "../submission/formFields.js";

/**
 * Language questions, answered from `profile.languages`.
 *
 * "What is your level of English?", "Spanish proficiency", "Are you fluent in
 * German?" and "Do you speak Catalan?" all ask for one recorded fact: the level
 * the person gave for that language. What the form wants back differs - a CEFR
 * code, a word such as "Fluent" or "Professional working proficiency", a Yes or
 * No - so the level is translated to whichever the form offers, and anything
 * that does not translate cleanly goes to a person.
 *
 * Only a language the person listed is answered. An unlisted one is not taken
 * as "does not speak it": a CV's language section is often incomplete, and a
 * "No" to "Do you speak French?" can lose an interview the person would have
 * had.
 */

export type LanguageResolution = { answer: string; citation: string };

const RANK: Record<LanguageLevel, number> = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6, native: 7 };

/** How a level is described in words, most specific first. */
const WORDS: Record<LanguageLevel, readonly string[]> = {
  native: ["native", "mother tongue", "first language", "bilingual"],
  C2: ["c2", "proficient", "mastery", "near native", "fluent"],
  C1: ["c1", "advanced", "fluent", "full professional"],
  B2: ["b2", "upper intermediate", "professional working"],
  B1: ["b1", "intermediate", "limited working"],
  A2: ["a2", "elementary", "pre intermediate"],
  A1: ["a1", "beginner"],
};

/**
 * When no option describes the level itself, a higher level may honestly take
 * the option for the one just below it: a native speaker is fluent. Never the
 * other way.
 */
const FALLBACK: Record<LanguageLevel, readonly LanguageLevel[]> = {
  native: ["native", "C2", "C1"],
  C2: ["C2", "C1"],
  C1: ["C1"],
  B2: ["B2"],
  B1: ["B1"],
  A2: ["A2"],
  A1: ["A1"],
};

const FREE_TEXT: Record<LanguageLevel, string> = {
  native: "Native",
  C2: "C2 (proficient)",
  C1: "C1 (advanced)",
  B2: "B2 (upper intermediate)",
  B1: "B1 (intermediate)",
  A2: "A2 (elementary)",
  A1: "A1 (beginner)",
};

/** Names checked so a question about two languages is never answered for one. */
const COMMON_LANGUAGES = [
  "english", "spanish", "castilian", "catalan", "basque", "galician", "french", "german", "italian", "portuguese",
  "dutch", "polish", "swedish", "danish", "norwegian", "finnish", "russian", "ukrainian", "arabic", "hebrew",
  "turkish", "greek", "chinese", "mandarin", "cantonese", "japanese", "korean", "hindi", "romanian", "czech",
];

const LEVEL_ASKED = /\b(level|proficiency|cefr|command|knowledge)\b/;
const FLUENT_ASKED = /\b(fluent|fluently|fluency)\b/;
const SPEAK_ASKED = /\b(speak|speaker|spoken)\b/;
/** A question about learning, teaching or using a language is not about the candidate's level. */
const NOT_LEVEL = /\b(willing|learn|learning|teach|translate|interpret|prefer|preferred language|interview)\b/;

function hasWord(text: string, word: string): boolean {
  return new RegExp(`(?:^|\\s)${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(text);
}

function namesOf(language: Language): string[] {
  return [language.name, ...language.aliases].map(normalizeLabel).filter((name) => name.length > 0);
}

/** The one listed language the label names, or null when it names none or several. */
function languageAsked(label: string, profile: Profile): { language: Language; index: number } | null {
  const listed = profile.languages
    .map((language, index) => ({ language, index }))
    .filter(({ language }) => namesOf(language).some((name) => hasWord(label, name)));
  if (listed.length !== 1) return null;
  const only = listed[0]!;
  const own = new Set(namesOf(only.language));
  if (COMMON_LANGUAGES.some((name) => !own.has(name) && hasWord(label, name))) return null;
  return only;
}

function optionFor(level: LanguageLevel, options: readonly string[]): string | null {
  const normalized = options.map((option) => ({ option, text: normalizeLabel(option) }));
  for (const tier of FALLBACK[level]) {
    for (const word of WORDS[tier]) {
      const exact = normalized.filter(({ text }) => text === word);
      const containing = exact.length > 0 ? exact : normalized.filter(({ text }) => hasWord(text, word));
      if (containing.length === 1) return containing[0]!.option;
    }
  }
  return null;
}

function yesNo(value: boolean | null, options: readonly string[]): string | null {
  if (value === null) return null;
  const wanted = value ? "yes" : "no";
  if (options.length === 0) return value ? "Yes" : "No";
  return options.find((option) => normalizeLabel(option) === wanted) ?? null;
}

export function resolveLanguage(label: string, profile: Profile, options: readonly string[] = []): LanguageResolution | null {
  if (profile.languages.length === 0) return null;
  const text = normalizeLabel(label);
  if (NOT_LEVEL.test(text)) return null;
  const asked = languageAsked(text, profile);
  if (!asked) return null;
  const { language, index } = asked;
  const rank = RANK[language.level];
  const citation = `languages[${index}].level`;

  // "Are you fluent in German?" is a Yes/No question about C1 and above. A B2
  // speaker is neither clearly fluent nor clearly not, so that one is asked.
  if (FLUENT_ASKED.test(text) && /^(are|is|do|can|would)\b/.test(text)) {
    const answer = yesNo(rank >= RANK.C1 ? true : rank <= RANK.B1 ? false : null, options);
    return answer ? { answer, citation } : null;
  }
  if (SPEAK_ASKED.test(text) && /^(do|can|are|is)\b/.test(text) && !LEVEL_ASKED.test(text)) {
    const answer = yesNo(rank >= RANK.B2 ? true : rank <= RANK.A2 ? false : null, options);
    return answer ? { answer, citation } : null;
  }
  if (!LEVEL_ASKED.test(text) && !FLUENT_ASKED.test(text) && !SPEAK_ASKED.test(text)) return null;
  if (options.length === 0) return { answer: FREE_TEXT[language.level], citation };
  const option = optionFor(language.level, options);
  return option ? { answer: option, citation } : null;
}
