import { describe, expect, it } from "vitest";

import { resolvePersonal } from "../src/drafting/personal.js";

const profile = {
  personal: {},
  education: [
    {
      institution: "Example State University",
      credential: "Bachelor of Science (BSc)",
      field: "Computer Science",
      start: "2016-09",
      end: "2020-12",
    },
  ],
} as never;

describe("education date resolution", () => {
  it("reads the start month and year the degree actually began", () => {
    expect(resolvePersonal("Education start month", profile)?.answer).toBe("September");
    expect(resolvePersonal("Education start year", profile)?.answer).toBe("2016");
  });

  it("reads the month the degree ended", () => {
    expect(resolvePersonal("Education end month", profile)?.answer).toBe("December");
  });

  it("still answers the graduation year with the year alone", () => {
    expect(resolvePersonal("Graduation year", profile)?.answer).toBe("2020");
  });
});
