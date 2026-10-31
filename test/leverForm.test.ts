import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leverQuestionsToForm } from "../src/drafting/questions.js";
import { fetchLeverApplyPage } from "../src/sources/lever.js";

function card(id: string, template: Record<string, unknown>): string {
  const value = JSON.stringify({ id, ...template }).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<input type="hidden" value="${value}" name="cards[${id}][baseTemplate]">`;
}

/** Trimmed from Lodgify's live "Senior Backend Engineer" apply page. */
const LODGIFY_PAGE = `
<form>
  <input type="file" name="resume" id="resume-upload-input">
  <input type="text" name="name" required="required">
  <input type="email" name="email" required="required">
  <input type="text" name="phone">
  <input type="text" name="org">
  <input type="text" name="urls[LinkedIn]">
  <input type="text" name="urls[GitHub]">
  ${card("02843f29", {
    text: "English language: ",
    fields: [{ type: "multiple-choice", text: "What is your level of English?", required: true, options: [{ text: "Native/Near Native" }, { text: "Basic" }] }],
  })}
  ${card("73a4d6ff", {
    text: "Location:",
    fields: [
      { type: "text", text: "What country are you based in?", required: true },
      { type: "multiple-choice", text: "Will you now or in the future require VISA sponsorship to work in Spain?", required: true, options: [{ text: "Yes, I would require visa sponsorship" }, { text: "No" }] },
    ],
  })}
  ${card("7a73604a", { text: "Compensation: ", fields: [{ type: "textarea", text: "What are your annual gross salary expectations for this role?", required: true }] })}
  ${card("34edd210", {
    text: "How did you hear about us?",
    fields: [{ type: "multiple-select", text: "We're curious to know!", required: true, options: [{ text: "Lodgify Careers Page" }, { text: "LinkedIn" }] }],
  })}
</form>`;

beforeEach(() => vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Lever application form", () => {
  it("reads the standard fields by input name and each custom card field by its own input name", () => {
    const questions = leverQuestionsToForm(LODGIFY_PAGE);

    expect(questions.map((question) => [question.key, question.type, question.required])).toEqual([
      ["resume", "input_file", false],
      ["name", "input_text", true],
      ["email", "input_text", true],
      ["phone", "input_text", false],
      ["org", "input_text", false],
      ["urls[LinkedIn]", "input_text", false],
      ["urls[GitHub]", "input_text", false],
      ["cards[02843f29][field0]", "multi_value_single_select", true],
      ["cards[73a4d6ff][field0]", "input_text", true],
      ["cards[73a4d6ff][field1]", "multi_value_single_select", true],
      ["cards[7a73604a][field0]", "textarea", true],
      ["cards[34edd210][field0]", "multi_value_multi_select", true],
    ]);
    expect(questions[9]?.options).toEqual(["Yes, I would require visa sponsorship", "No"]);
  });

  it("borrows the card's title when a field does not say what it asks", () => {
    const labels = leverQuestionsToForm(LODGIFY_PAGE).map((question) => question.label);
    expect(labels).toContain("How did you hear about us? We're curious to know!");
    expect(labels).toContain("What is your level of English?");
  });

  it("fetches the apply page of a hosted Lever posting and nothing else", async () => {
    const fetch = vi.fn(async () => new Response(LODGIFY_PAGE));
    vi.stubGlobal("fetch", fetch);

    await fetchLeverApplyPage("https://jobs.lever.co/lodgify/25d51351");
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://jobs.lever.co/lodgify/25d51351/apply");

    await expect(fetchLeverApplyPage("https://careers.example.com/jobs/1")).rejects.toThrow(/not a Lever hosted posting/);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
