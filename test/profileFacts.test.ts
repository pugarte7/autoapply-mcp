import { describe, expect, it } from "vitest";
import { ProfileSchema } from "../src/domain/profile.js";
import { draftAnswers } from "../src/drafting/answers.js";
import { resolveExperience } from "../src/drafting/experience.js";
import { resolveLanguage } from "../src/drafting/languages.js";
import { resolveSkillYears, yearsSince } from "../src/drafting/skillYears.js";
import { makeCampaign, makeProfile } from "./factories.js";

const NOW = new Date(2026, 10, 2);

describe("years of experience per skill", () => {
  const profile = ProfileSchema.parse({
    ...makeProfile(),
    skills: [
      { name: "Python", aliases: ["py"], level: "expert", since: 2018 },
      { name: "Kubernetes", aliases: ["k8s"], level: "strong", since: "2020-03" },
      { name: "C++", level: "working", since: 2015 },
      { name: "Go", level: "working" },
    ],
  });
  const answer = (label: string) => resolveSkillYears(label, profile, NOW)?.answer ?? null;

  it("never counts more years than the person has", () => {
    // A bare year may have started in December, so 2018 is seven full years in 2026.
    expect(yearsSince(2018, NOW)).toBe(7);
    expect(yearsSince("2020-03", NOW)).toBe(6);
    expect(yearsSince("2026-10", NOW)).toBe(0);
  });

  it("answers how many years from since", () => {
    expect(answer("How many years of experience do you have with Python?")).toBe("7");
    expect(answer("How many years of professional Python experience do you have?")).toBe("7");
    expect(answer("Years of experience with k8s")).toBe("6");
    expect(answer("How many years of experience in C++ do you have?")).toBe("10");
  });

  it("answers thresholds as yes or no", () => {
    expect(answer("Do you have 5+ years of experience with Kubernetes?")).toBe("Yes");
    expect(answer("Do you have over 7 years of experience with Python?")).toBe("No");
    expect(answer("Do you have at least 7 years of Python experience?")).toBe("Yes");
  });

  it("answers only when the subject is exactly a dated skill", () => {
    expect(answer("How many years of experience do you have with Python and Django?")).toBeNull();
    expect(answer("How many years of experience with backend Python?")).toBeNull();
    expect(answer("How many years of experience do you have with C?")).toBeNull();
    expect(answer("How many years of experience in Go do you have?")).toBeNull();
    expect(answer("How many years of experience do you have with Rust?")).toBeNull();
  });

  it("reaches drafting through the experience resolver", () => {
    expect(resolveExperience("Do you have 5+ years of experience with Kubernetes?", profile)?.citation).toBe("skills[1].since");
  });
});

describe("language levels", () => {
  const profile = ProfileSchema.parse({
    ...makeProfile(),
    languages: [
      { name: "Spanish", level: "native", aliases: ["Castilian"] },
      { name: "English", level: "C1" },
      { name: "German", level: "B2" },
      { name: "French", level: "A2" },
    ],
  });
  const answer = (label: string, options: string[] = []) => resolveLanguage(label, profile, options)?.answer ?? null;

  it("gives the level in free text", () => {
    expect(answer("What is your level of English?")).toBe("C1 (advanced)");
    expect(answer("Spanish proficiency")).toBe("Native");
  });

  it("picks the offered option that states the level", () => {
    expect(answer("English level", ["A2", "B1", "B2", "C1", "C2"])).toBe("C1");
    expect(answer("English proficiency", ["Basic", "Intermediate", "Advanced", "Native"])).toBe("Advanced");
    expect(answer("Spanish proficiency", ["Basic", "Conversational", "Fluent"])).toBe("Fluent");
    expect(answer("German level", ["Basic", "Intermediate", "Advanced", "Native"])).toBeNull();
  });

  it("answers fluency and speaking questions only when the level settles them", () => {
    expect(answer("Are you fluent in English?")).toBe("Yes");
    expect(answer("Are you fluent in French?")).toBe("No");
    expect(answer("Are you fluent in German?")).toBeNull();
    expect(answer("Do you speak German?", ["Yes", "No"])).toBe("Yes");
    expect(answer("Do you speak Castilian?")).toBe("Yes");
  });

  it("leaves unlisted languages, several languages and other questions to a person", () => {
    expect(answer("Do you speak Italian?")).toBeNull();
    expect(answer("Do you speak English and Italian?")).toBeNull();
    expect(answer("Are you willing to learn German?")).toBeNull();
  });

  it("drafts a language answer without asking", () => {
    const { answers } = draftAnswers(
      [{ key: "lang", label: "What is your level of English?", required: true, type: "input_text" }],
      profile,
      makeCampaign(),
    );
    expect(answers[0]).toMatchObject({ answer: "C1 (advanced)", requiresHuman: false, citation: "languages[1].level" });
  });
});

describe("previous employment from the experience list", () => {
  const profile = ProfileSchema.parse({
    ...makeProfile(),
    experience: [
      { company: "Acme", title: "Engineer", start: "2021-02", end: "present" },
      { company: "Stripe", title: "Engineer", start: "2018-01", end: "2020-12" },
    ],
  });
  const answer = (label: string, employer?: string) => resolveExperience(label, profile, employer)?.answer ?? null;

  it("answers for a named employer from the whole history", () => {
    expect(answer("Were you previously employed by Stripe?")).toBe("Yes");
    expect(answer("Are you a current or former employee of Stripe?")).toBe("Yes");
    expect(answer("Have you ever been employed by Maven Clinic in any role?")).toBe("No");
  });

  it("answers for the hiring company when the question calls it this company", () => {
    expect(answer("Have you previously been employed by this company?", "Stripe")).toBe("Yes");
    expect(answer("Have you ever worked for us before?", "Globex")).toBe("No");
    expect(answer("Have you previously been employed by this company?")).toBeNull();
  });

  it("leaves subsidiaries, relatives and a recorded answer alone", () => {
    expect(answer("Have you ever worked for Snap Inc. or one of its subsidiaries?")).toBeNull();
    expect(answer("Has a relative of yours ever worked for Stripe?")).toBeNull();
    const recorded = ProfileSchema.parse({ ...profile, personal: { previousEmployment: { value: "No", autoFill: true } } });
    expect(resolveExperience("Were you previously employed by Stripe?", recorded)).toBeNull();
  });

  it("drafts it with the posting's company", () => {
    const { answers } = draftAnswers(
      [{ key: "prev", label: "Have you previously worked for this company?", required: true, type: "input_text" }],
      profile,
      makeCampaign(),
      { company: "Stripe", role: "Engineer", location: "", topics: [] },
    );
    expect(answers[0]).toMatchObject({ answer: "Yes", requiresHuman: false });
  });
});

describe("pay questions in the plural", () => {
  it("classifies salary expectations as compensation, so a standing answer to it needs the person", async () => {
    const { classifyQuestion } = await import("../src/drafting/blockedQuestions.js");
    expect(classifyQuestion("What are your salary expectations?")).toBe("compensation");
    expect(classifyQuestion("Salary requirements")).toBe("compensation");
  });
});
