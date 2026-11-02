import { describe, expect, it } from "vitest";
import { draftAnswers, type FormQuestion } from "../src/drafting/answers.js";
import type { Profile } from "../src/domain/profile.js";
import { makeCampaign, makeProfile } from "./factories.js";

const genericPermission = {
  key: "us-work-authorization-now",
  label: "Currently authorized to work in the United States",
  patterns: ["authorized to work"],
  answer: "Yes",
  allowAutoFill: true,
};

const qualifiedQuestions = [
  "Are you authorized to work in the United States for any employer?",
  "Are you currently authorized to work for all employers in the United States on a full-time basis?",
  "Are you authorized to work for any U.S. employer?",
  "Are you authorized to work for any US employer?",
  "Are you currently eligible to work in this country and authorized to work for Navan on an ongoing indefinite basis?",
  "Are you authorized to work in the United States without any restrictions?",
  "Do you have unrestricted authorization to work in the United States?",
  "Are you authorized to work in the United States on a permanent basis?",
] as const;

function profileWithPermissions(answers: Profile["answers"]): Profile {
  const base = makeProfile();
  return { ...base, answers, workAuthorization: { ...base.workAuthorization, alwaysReviewManually: false } };
}

function question(label: string): FormQuestion {
  return { key: "authorization", label, required: true, type: "input_text" };
}

describe("work authorization scope", () => {
  it.each(qualifiedQuestions)("does not expand a generic approval when drafting: %s", (label) => {
    const profile = profileWithPermissions([genericPermission]);

    const { answers } = draftAnswers([question(label)], profile, makeCampaign());

    expect(answers[0]?.requiresHuman).toBe(true);
    expect(answers[0]?.answer).not.toBe("Yes");
    expect(answers[0]?.guidance).toContain("explicit matching decision");
  });

  it("does not confuse a permanent job with permanent authorization", () => {
    const label = "Are you authorized to work in the United States in a permanent role?";

    const { answers } = draftAnswers([question(label)], profileWithPermissions([genericPermission]), makeCampaign());

    expect(answers[0]?.answer).toBe("Yes");
    expect(answers[0]?.requiresHuman).toBe(false);
  });

});
