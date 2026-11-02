import { describe, expect, it } from "vitest";
import { draftAnswers, type FormQuestion } from "../src/drafting/answers.js";
import { AGENT_DRAFT_REASON, answerOwner } from "../src/drafting/answerOwner.js";
import { outstandingNextStep } from "../src/tools/drafting.js";
import { makeCampaign, makeProfile } from "./factories.js";

const profile = makeProfile();
const campaign = makeCampaign();

function question(label: string, overrides: Partial<FormQuestion> = {}): FormQuestion {
  return { key: label.toLowerCase().replace(/\W+/g, "_"), label, required: true, type: "input_text", ...overrides };
}

/**
 * Essays used to be blocked as "must be written and approved by a human",
 * which sent every free-text box to the person. They are still never
 * auto-filled, but the block now hands them to the agent.
 */
describe("essays are agent-draftable", () => {
  it("blocks a free-text box with no narrative as agent-draftable, with drafting guidance", () => {
    const { answers, blockingQuestions } = draftAnswers(
      [question("Tell us about a project you are proud of", { type: "textarea" })],
      profile,
      campaign,
    );
    const [answer] = answers;
    expect(answer?.answer).toBe("");
    expect(answer?.requiresHuman).toBe(true);
    expect(answer?.category).toBe("essay");
    expect(answer?.citation).toBe(AGENT_DRAFT_REASON);
    expect(answer?.guidance).toContain("claimsToAvoid");
    expect(answer?.guidance).toContain("set_application_content");
    expect(blockingQuestions).toHaveLength(1);
  });

  it("treats an essay-category question in a one-line box the same way", () => {
    const { answers } = draftAnswers([question("Why do you want to work at Example Corp?")], profile, campaign);
    expect(answers[0]?.citation).toBe(AGENT_DRAFT_REASON);
    expect(answers[0]?.requiresHuman).toBe(true);
    expect(answerOwner(answers[0]!.label, answers[0]!.category)).toBe("agent");
  });

  it("still routes a sensitive question to the person", () => {
    const { answers } = draftAnswers([question("What are your salary expectations?")], profile, campaign);
    expect(answers[0]?.requiresHuman).toBe(true);
    expect(answerOwner(answers[0]!.label, answers[0]!.category)).toBe("person");
  });
});

describe("answerOwner", () => {
  it.each([
    ["Are you legally authorized to work in Spain?", "work-authorization"],
    ["Will you now or in the future require visa sponsorship?", "sponsorship"],
    ["What is your citizenship?", "citizenship"],
    ["Do you hold an active security clearance?", "clearance"],
    ["Have you ever been convicted of a felony?", "criminal-history"],
    ["What is your expected salary?", "compensation"],
    ["What is your gender?", "demographic"],
    ["Are you a protected veteran?", "veteran"],
    ["Do you have a disability?", "disability"],
    ["I certify that I have never been convicted of a crime", "legal-attestation"],
  ])("leaves %s to the person", (label, category) => {
    expect(answerOwner(label, category)).toBe("person");
  });

  it.each([
    ["Tell us about a time you shipped under pressure", "essay"],
    ["How many years of Go experience do you have?", "general"],
    ["How did you hear about us?", "source"],
    ["When can you start?", "start-date"],
    ["I acknowledge the privacy notice", "legal-attestation"],
  ])("lets the agent answer %s", (label, category) => {
    expect(answerOwner(label, category)).toBe("agent");
  });

  it("reclassifies a question read off a live form, whose stored category says nothing", () => {
    expect(answerOwner("Do you require sponsorship for an employment visa?", "employer-specific")).toBe("person");
    expect(answerOwner("Which cloud providers have you used?", "employer-specific")).toBe("agent");
  });
});

describe("prepare_application next step", () => {
  it("tells the agent to write its own answers and group the person's", () => {
    const step = outstandingNextStep([{ who: "agent" }, { who: "agent" }, { who: "person" }]);
    expect(step).toContain("Write the 2 answers marked who=agent yourself");
    expect(step).toContain("claimsToAvoid");
    expect(step).toContain("one message");
    expect(step).toContain("approve_application");
  });

  it("does not mention the person's questions when there are none", () => {
    const step = outstandingNextStep([{ who: "agent" }]);
    expect(step).not.toContain("who=person");
  });

  it("goes straight to approval when nothing is outstanding", () => {
    expect(outstandingNextStep([])).toMatch(/^Review with preview_application/);
  });
});
