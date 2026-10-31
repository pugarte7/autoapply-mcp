import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ashbyQuestionsToForm } from "../src/drafting/questions.js";
import { fetchAshbyApplicationForm } from "../src/sources/ashby.js";

/** Trimmed from Qonto's live "Senior/Staff - Go Backend Engineer" form. */
const QONTO_FORM = {
  data: {
    jobPosting: {
      applicationForm: {
        sections: [
          {
            fieldEntries: [
              { field: { path: "_systemfield_name", title: "Name", type: "String" }, isRequired: true },
              { field: { path: "_systemfield_resume", title: "Resume", type: "File" }, isRequired: true },
              { field: { path: "GitHub", title: "GitHub", type: "String" }, isRequired: false },
            ],
          },
          {
            fieldEntries: [
              {
                field: {
                  path: "118c1418-3030-4d35-bae6-67b2bacb8932",
                  title: "Which of these languages are you most proficient in: Go, Ruby or Python?",
                  type: "LongText",
                },
                isRequired: true,
              },
              {
                field: {
                  path: "316371cc-6f58-4b10-b793-f33fc4ddbd8b",
                  title: "Do you need a visa sponsorship to work in one of our locations?",
                  type: "MultiValueSelect",
                  selectableValues: [
                    { label: "Yes - I need a visa and I would like to relocate", value: "a" },
                    { label: "No - I do not want to relocate", value: "b" },
                  ],
                },
                isRequired: false,
              },
              { field: { path: "consent", title: "I agree", type: "Boolean" }, isRequired: true },
              // A section heading entry carries no field and is skipped.
              {},
            ],
          },
        ],
      },
    },
  },
};

beforeEach(() => vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Ashby application form", () => {
  it("asks Ashby's hosted-page endpoint for the one posting", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(QONTO_FORM)));
    vi.stubGlobal("fetch", fetch);

    const entries = await fetchAshbyApplicationForm("qonto", "2e3c0519");

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body)).variables).toEqual({ organizationHostedJobsPageName: "qonto", jobPostingId: "2e3c0519" });
    expect(entries).toHaveLength(6);
  });

  it("converts every field with its required flag, type and choices", () => {
    const entries = QONTO_FORM.data.jobPosting.applicationForm.sections.flatMap((section) => section.fieldEntries);
    const questions = ashbyQuestionsToForm(entries);

    expect(questions.map((question) => [question.key, question.type, question.required])).toEqual([
      ["_systemfield_name", "input_text", true],
      ["_systemfield_resume", "input_file", true],
      ["GitHub", "input_text", false],
      ["118c1418-3030-4d35-bae6-67b2bacb8932", "textarea", true],
      ["316371cc-6f58-4b10-b793-f33fc4ddbd8b", "multi_value_multi_select", false],
      ["consent", "multi_value_single_select", true],
    ]);
    expect(questions[4]?.options).toEqual([
      "Yes - I need a visa and I would like to relocate",
      "No - I do not want to relocate",
    ]);
    expect(questions[5]?.options).toEqual(["Yes", "No"]);
  });
});
