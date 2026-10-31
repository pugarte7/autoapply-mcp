import type { AshbyFormEntry } from "../sources/ashby.js";
import type { GreenhouseQuestion } from "../sources/greenhouse.js";
import { decodeEntitiesOnce } from "../text/html.js";
import type { FormQuestion } from "./answers.js";

/** Converts ATS question payloads into the neutral FormQuestion shape. */

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value.filter((item) => typeof item === "object" && item !== null) as Array<Record<string, unknown>>) : [];
}

/**
 * Chooses the field that actually carries the answer.
 *
 * Greenhouse groups alternatives under one question: "Resume" offers a file
 * input and a textarea, as does "Cover Letter". A resume is satisfied by
 * uploading the PDF, whereas a cover letter is written, so the preferred field
 * type differs by question.
 */
function selectPrimaryField(label: string, fields: Array<Record<string, unknown>>): Record<string, unknown> {
  if (fields.length <= 1) return fields[0] ?? {};
  const typeOf = (field: Record<string, unknown>) => (typeof field.type === "string" ? field.type : "");
  const isResume = /\b(resume|cv)\b/i.test(label);

  if (isResume) {
    const file = fields.find((field) => typeOf(field) === "input_file");
    if (file) return file;
  }
  const order = ["textarea", "input_text", "multi_value_single_select", "multi_value_multi_select", "input_file"];
  for (const wanted of order) {
    const match = fields.find((field) => typeOf(field) === wanted);
    if (match) return match;
  }
  return fields[0] ?? {};
}

/**
 * Greenhouse serves demographic self-identification questions in a different
 * shape from the rest of the application: there is no `fields` array, and the
 * type and choices sit directly on the question as `type` and `answer_options`.
 * Read as an ordinary question that payload looks like a required free-text
 * field with no options, so a race/ethnicity multi-select was classified as an
 * essay and blocked every application carrying one.
 *
 * The options also carry `decline_to_answer`, which names the choice that
 * discloses nothing. That flag is the employer's own marking, so it is more
 * reliable than matching decline wording, and it is preserved on the question.
 */
function demographicShape(
  question: Record<string, unknown>,
): { type: string; options: string[]; declineOption?: string } | null {
  const options = asRecordArray(question.answer_options);
  if (options.length === 0) return null;

  const labels: string[] = [];
  let declineOption: string | undefined;
  for (const option of options) {
    const label = String(option.label ?? "").trim();
    if (label.length === 0) continue;
    labels.push(label);
    if (option.decline_to_answer === true && declineOption === undefined) declineOption = label;
  }
  if (labels.length === 0) return null;

  return {
    type: typeof question.type === "string" ? question.type : "multi_value_single_select",
    options: labels,
    declineOption,
  };
}

export function greenhouseQuestionsToForm(questions: readonly GreenhouseQuestion[]): FormQuestion[] {
  const converted = questions.map((question, index) => {
    const fields = asRecordArray(question.fields);
    const label = typeof question.label === "string" ? question.label : `Question ${index + 1}`;
    const demographic = fields.length === 0 ? demographicShape(question as Record<string, unknown>) : null;
    if (demographic) {
      const id = (question as Record<string, unknown>).id;
      return {
        key: typeof id === "number" || typeof id === "string" ? `question_${id}` : `question_${index}`,
        label,
        required: question.required === true,
        type: demographic.type,
        options: demographic.options,
        ...(demographic.declineOption ? { declineOption: demographic.declineOption } : {}),
      };
    }

    const primary = selectPrimaryField(label, fields);
    const values = asRecordArray(primary.values);
    return {
      key: typeof primary.name === "string" && primary.name.length > 0 ? primary.name : `question_${index}`,
      label,
      required: question.required === true,
      type: typeof primary.type === "string" ? primary.type : "input_text",
      options: values.map((value) => String(value.label ?? "")).filter((label) => label.length > 0),
    };
  });

  const asksLocation = converted.some(
    (question) => /\blocation\b|\bcity\b/i.test(question.label) || /location/i.test(question.key),
  );
  return asksLocation ? converted : [...converted, GREENHOUSE_LOCATION_QUESTION];
}

/** Ashby's field types in the Greenhouse vocabulary the drafter already speaks. */
const ASHBY_TYPES: Record<string, string> = {
  LongText: "textarea",
  File: "input_file",
  ValueSelect: "multi_value_single_select",
  MultiValueSelect: "multi_value_multi_select",
  Boolean: "multi_value_single_select",
};

export function ashbyQuestionsToForm(entries: readonly AshbyFormEntry[]): FormQuestion[] {
  return entries.flatMap((entry) => {
    const field = entry.field ?? {};
    const key = typeof field.path === "string" ? field.path : "";
    if (!key) return [];
    const ashbyType = typeof field.type === "string" ? field.type : "";
    const choices = asRecordArray(field.selectableValues).map((value) => String(value.label ?? "")).filter(Boolean);
    return [{
      key,
      label: typeof field.title === "string" ? field.title : key,
      required: entry.isRequired === true,
      type: ASHBY_TYPES[ashbyType] ?? "input_text",
      // Ashby renders a Boolean as a Yes / No pair and publishes no choices for it.
      options: ashbyType === "Boolean" && choices.length === 0 ? ["Yes", "No"] : choices,
    }];
  });
}

/** The fields every Lever form names the same way, labelled as the page shows them. */
const LEVER_STANDARD_FIELDS: ReadonlyArray<readonly [name: string, label: string, type: string]> = [
  ["resume", "Resume/CV", "input_file"],
  ["name", "Full name", "input_text"],
  ["email", "Email", "input_text"],
  ["phone", "Phone", "input_text"],
  ["location", "Current location", "input_text"],
  ["org", "Current company", "input_text"],
  ["comments", "Additional information", "textarea"],
];

const LEVER_TYPES: Record<string, string> = {
  "multiple-choice": "multi_value_single_select",
  dropdown: "multi_value_single_select",
  "multiple-select": "multi_value_multi_select",
  textarea: "textarea",
};

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag)?.[1];
}

/**
 * A card's title says what a field asks when the field itself does not:
 * Lodgify's "How did you hear about us?" card holds one field reading "We're
 * curious to know!", which no source question would ever match.
 */
function cardLabel(title: string, text: string): string {
  if (!title || text.includes("?")) return text;
  return /[?.!]$/.test(title) ? `${title} ${text}` : `${title}: ${text}`;
}

/**
 * Reads a Lever apply page. Standard fields are found by their input names;
 * custom questions come from each card's `baseTemplate`, a hidden input whose
 * value is the card's JSON definition, keyed `cards[<card>][field<n>]` exactly
 * as the page names the inputs.
 */
export function leverQuestionsToForm(page: string): FormQuestion[] {
  const tags = page.match(/<(?:input|textarea)\b[^>]*>/gi) ?? [];
  const byName = new Map(tags.map((tag) => [attribute(tag, "name") ?? "", tag]));

  const standard: FormQuestion[] = LEVER_STANDARD_FIELDS.flatMap(([name, label, type]) => {
    const tag = byName.get(name);
    return tag ? [{ key: name, label, type, required: /\brequired\b/i.test(tag) }] : [];
  });
  const links: FormQuestion[] = [...byName.keys()].flatMap((name) => {
    const service = /^urls\[(.+)\]$/.exec(name)?.[1];
    return service ? [{ key: name, label: service, type: "input_text", required: /\brequired\b/i.test(byName.get(name) ?? "") }] : [];
  });

  const custom = tags.flatMap((tag) => {
    const card = /^cards\[([^\]]+)\]\[baseTemplate\]$/.exec(attribute(tag, "name") ?? "")?.[1];
    const value = attribute(tag, "value");
    if (!card || !value) return [];
    let template: { text?: unknown; fields?: unknown };
    try {
      template = JSON.parse(decodeEntitiesOnce(value)) as { text?: unknown; fields?: unknown };
    } catch {
      return [];
    }
    const title = String(template.text ?? "").trim().replace(/:$/, "");
    return asRecordArray(template.fields).map((field, index) => ({
      key: `cards[${card}][field${index}]`,
      label: cardLabel(title, String(field.text ?? "").trim()) || `Question ${index + 1}`,
      required: field.required === true,
      type: LEVER_TYPES[String(field.type)] ?? "input_text",
      options: asRecordArray(field.options).map((option) => String(option.text ?? "")).filter(Boolean),
    }));
  });
  return [...standard, ...links, ...custom];
}

/**
 * Greenhouse renders a required "Location (City)" geocoder that its own job
 * board API does not publish: Scale AI's schema lists 13 questions and no
 * location among them, while the live form refuses to submit without one.
 * Nothing drafted an answer for a question nobody knew existed, so boards on
 * the newer form filled completely and then aborted on the one field they had
 * never been told about.
 *
 * Held optional deliberately. Whether the control is on the page is settled by
 * reading the page, and a profile with no location recorded should not have
 * every Greenhouse application blocked by a question added here. Where the
 * board does render it, the page's own required flag still gates submission.
 */
const GREENHOUSE_LOCATION_QUESTION: FormQuestion = {
  key: "location",
  label: "Location (City)",
  required: false,
  type: "input_text",
};

/**
 * Baseline fields common to hosted application forms. Used for boards that do
 * not publish their question schema; the real fields are read from the page
 * during an assisted run.
 */
export function defaultQuestionSet(): FormQuestion[] {
  return [
    { key: "first_name", label: "First Name", required: true, type: "input_text" },
    { key: "last_name", label: "Last Name", required: true, type: "input_text" },
    { key: "email", label: "Email", required: true, type: "input_text" },
    { key: "phone", label: "Phone", required: false, type: "input_text" },
    { key: "resume", label: "Resume/CV", required: true, type: "input_file" },
    { key: "linkedin", label: "LinkedIn Profile", required: false, type: "input_text" },
    { key: "website", label: "Website", required: false, type: "input_text" },
    { key: "location", label: "Current Location", required: false, type: "input_text" },
    {
      key: "work_authorization",
      label: "Are you legally authorized to work in the country of this role?",
      required: false,
      type: "multi_value_single_select",
      options: ["Yes", "No"],
    },
    {
      key: "sponsorship",
      label: "Will you now or in the future require visa sponsorship?",
      required: false,
      type: "multi_value_single_select",
      options: ["Yes", "No"],
    },
  ];
}
