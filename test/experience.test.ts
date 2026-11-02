import { describe, expect, it } from "vitest";
import { resolveExperience } from "../src/drafting/experience.js";
import type { DraftAnswer } from "../src/domain/job.js";
import { makeProfile } from "./factories.js";

function answer(label: string, value: string): DraftAnswer {
  return {
    questionKey: label.toLowerCase().replace(/\W+/g, "_"),
    label,
    answer: value,
    source: "profile",
    citation: "",
    requiresHuman: false,
    category: "contact",
  };
}

const profile = makeProfile();

describe("resolveExperience", () => {
  it("answers Workday's combined employment start date", () => {
    expect(resolveExperience("Employment start date", profile)?.answer).toBe("02/2021");
  });

  it("offers no employment end date for a current role", () => {
    // Workday hides the control once "I currently work here" is ticked, and
    // inventing an end date for a job still held would be false.
    expect(resolveExperience("Employment end date", profile)?.answer ?? "").toBe("");
  });

  it.each([
    "Desired employment start date",
    "Earliest employment start date",
    "Expected employment start date",
    "Preferred employment start date",
    "Anticipated employment start date",
    "Proposed employment start date",
    "Target employment start date",
  ])("does not answer %s with a past employment date", (label) => {
    expect(resolveExperience(label, profile)?.answer).not.toBe("02/2021");
  });

  it.each(["Education start date", "School employment start date"])(
    "does not answer %s from employment", (label) => {
      expect(resolveExperience(label, profile)?.answer).not.toBe("02/2021");
    },
  );

  it.each(["Education start month", "Education start year", "School start year", "University start month"])(
    "does not substitute employment dates for %s", (label) => {
      expect(resolveExperience(label, profile)).toBeNull();
    },
  );
  it("answers the employment block from the current position", () => {
    expect(resolveExperience("Company name", profile)?.answer).toBe("Acme");
    expect(resolveExperience("Title", profile)?.answer).toBe("Software Engineer III - Security");
    expect(resolveExperience("Start date month", profile)?.answer).toBe("February");
    expect(resolveExperience("Start date year", profile)?.answer).toBe("2021");
  });

  it("leaves the end date blank and reports the role as current", () => {
    expect(resolveExperience("End date month", profile)).toBeNull();
    expect(resolveExperience("End date year", profile)).toBeNull();
    expect(resolveExperience("Current role", profile)?.answer).toBe("Yes");
  });

  // 1Password's "Current job title?" was submitted as "Yes": it contains
  // "current" and "job", so the is-this-your-current-role boolean claimed a
  // free-text field. A question that names the attribute it wants is never the
  // boolean, whatever else it contains.
  it("does not answer an attribute question with the current-role yes/no", () => {
    expect(resolveExperience("Current job title?", profile)?.answer).toBe("Software Engineer III - Security");
    expect(resolveExperience("Current title", profile)?.answer).toBe("Software Engineer III - Security");
    expect(resolveExperience("Current employer", profile)?.answer).toBe("Acme");
    expect(resolveExperience("Current company name", profile)?.answer).toBe("Acme");
  });

  it("still recognises the genuinely boolean phrasings", () => {
    expect(resolveExperience("Current role", profile)?.answer).toBe("Yes");
    expect(resolveExperience("I currently work here", profile)?.answer).toBe("Yes");
    expect(resolveExperience("Is this your current position?", profile)?.answer).toBe("Yes");
    expect(resolveExperience("Do you currently work here?", profile)?.answer).toBe("Yes");
  });

  // Maven Clinic asked "Are you currently employed by Maven Clinic in any
  // capacity? If so, please list current role." It contains "currently" and
  // "current role", so the is-this-your-current-role boolean answered Yes: a
  // false claim of already working for the hiring company.
  it("answers a named-employer question from who the candidate actually works for", () => {
    expect(
      resolveExperience(
        "Are you currently employed by Maven Clinic in any capacity? If so, please list current role.",
        profile,
      )?.answer,
    ).toBe("No");
    expect(resolveExperience("Do you currently work for Maven Clinic or any of its affiliates?", profile)?.answer).toBe("No");
    expect(resolveExperience("Are you currently employed by Acme?", profile)?.answer).toBe("Yes");
    expect(resolveExperience("Are you currently an employee of Acme Corporation?", profile)?.answer).toBe("Yes");
  });

  it.each([
    "Are you currently employed by us in any capacity? If so, please list current role.",
    "Are you currently employed by a federal contractor?",
    "Are you currently employed by any other company in your current role?",
  ])("leaves %s for a person rather than guessing who is meant", (label) => {
    expect(resolveExperience(label, profile)).toBeNull();
  });

  // "Current or former" also asks about past jobs, and a willingness question
  // is not about employment at all. Answering either from the current job
  // alone said "No" for the candidate. Past employment is now read from the
  // whole experience list (see below); willingness still goes to a person.
  it.each([
    "Are you open to working for Stripe on a contract basis?",
    "Are you willing to work for Acme in our SF office?",
    "Are you interested in working for Acme's security team?",
  ])("does not answer %s from the current job alone", (label) => {
    expect(resolveExperience(label, profile)).toBeNull();
  });

  it("does not read a skills question as a named employer", () => {
    expect(resolveExperience("Do you currently work with Python in your current role?", profile)?.answer).not.toBe("No");
  });

  // Snap's question is about past employment at Snap; its trailing note about
  // current Snap employees and the internal "job board" made it read as a
  // current-role question, and the current role answered Yes.
  it.each([
    "Have you ever worked for Snap Inc. or one of its subsidiaries? **If you are a current Snap employee - please apply on the Snap internal job board in Workday***",
    "Have you previously worked at Snap? If you are a current employee, apply on the internal job board.",
    "Have you ever held a job here before? Current employees should use the internal job board.",
  ])("never answers past employment at the hiring company from the current role: %s", (label) => {
    expect(resolveExperience(label, profile)?.answer).not.toBe("Yes");
  });

  it("still answers the plain current-role questions", () => {
    expect(resolveExperience("Is this your current position?", profile)?.answer).toBe("Yes");
    expect(resolveExperience("Do you currently work here?", profile)?.answer).toBe("Yes");
    expect(resolveExperience("Are you currently employed by Acme?", profile)?.answer).toBe("Yes");
  });

  it("gives the end date once a position has one", () => {    const past = makeProfile({
      experience: [{ company: "Phemi", title: "Intern", start: "2018-05", end: "2018-08", highlights: [] }],
    });
    expect(past.experience.length).toBe(1);
    expect(resolveExperience("End date month", past)?.answer).toBe("August");
    expect(resolveExperience("End date year", past)?.answer).toBe("2018");
    expect(resolveExperience("Current role", past)?.answer).toBe("No");
  });

  it("prefers the current position over an older one that started later in the list", () => {
    const many = makeProfile({
      experience: [
        { company: "Phemi", title: "Intern", start: "2018-05", end: "2018-08", highlights: [] },
        { company: "Acme", title: "Engineer", start: "2021-02", end: "present", highlights: [] },
      ],
    });
    expect(resolveExperience("Company name", many)?.answer).toBe("Acme");
  });

  /**
   * "Why this company?" and "Job title you are applying for" are about the
   * employer being applied to. Answering them with the current employer would
   * be a plain misstatement, so bare names only match exactly.
   */
  it("does not answer questions about the company being applied to", () => {
    expect(resolveExperience("Why do you want to work at this company?", profile)).toBeNull();
    expect(resolveExperience("What job title are you applying for?", profile)).toBeNull();
  });

  it("does not take a desired start date for an employment start date", () => {
    expect(resolveExperience("When is your earliest start date?", profile)).toBeNull();
    expect(resolveExperience("Desired start date", profile)).toBeNull();
  });

  it("says nothing when the profile lists no positions", () => {
    expect(resolveExperience("Company name", makeProfile({ experience: [] }))).toBeNull();
  });
});

/**
 * Omnissa's Workday work-history block requires a "Role Description" text box
 * and would not advance past it. The profile's highlights for the job are the
 * verified account of the role, so they are used as written.
 */
describe("the role description in a work-history block", () => {
  it("is the most recent job's highlights", () => {
    expect(resolveExperience("Role Description*", profile)?.answer).toBe("Built guardrails");
  });

  it("is nothing when the profile records no highlights", () => {
    const bare = { ...profile, experience: profile.experience.map((job) => ({ ...job, highlights: [] })) };
    expect(resolveExperience("Role Description", bare)).toBeNull();
  });
});

/**
 * Thomson Reuters' Workday tenant requires "Type to Add Skills" on My
 * Experience. Nothing answered it, so every application there stopped.
 */
describe("a skills question", () => {
  it("is answered from the profile's own skills, strongest first", () => {
    const withWorking = {
      ...profile,
      skills: [...profile.skills, { name: "Cedar", aliases: [], level: "working" as const, tags: [] }],
    };
    expect(resolveExperience("Type to Add Skills*", withWorking)?.answer).toBe(
      "Python, Open Policy Agent, Azure, threat modeling",
    );
  });

  it("does not take over a question that only mentions skills", () => {
    expect(resolveExperience("Which skills would you like to develop in this role?", profile)).toBeNull();
  });
});
