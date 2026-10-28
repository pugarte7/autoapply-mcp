import { describe, expect, it } from "vitest";
import { sameCity, sameLocation } from "../src/submission/place.js";

const madrid = "Madrid, Madrid, Spain";

describe("sameCity", () => {
  it("accepts the approved city however the geocoder writes its region or country", () => {
    expect(sameCity("Madrid, Spain", madrid)).toBe(true);
    expect(sameCity("Madrid, Comunidad de Madrid, Spain", madrid)).toBe(true);
    expect(sameCity("Madrid, ESP", madrid)).toBe(true);
    expect(sameCity("Madrid", madrid)).toBe(true);
  });

  it("refuses another town that contains the city's name", () => {
    expect(sameCity("Humanes de Madrid, Madrid, Spain", madrid)).toBe(false);
    expect(sameCity("Las Rozas de Madrid, Madrid, Spain", madrid)).toBe(false);
    expect(sameCity("Madridejos, Toledo, Spain", madrid)).toBe(false);
  });

  it("refuses a city that only shares its first word", () => {
    expect(sameCity("Los Alamos, New Mexico, United States", "Los Angeles, California, United States")).toBe(false);
  });

  it("refuses the same city in another country", () => {
    expect(sameCity("Vancouver, Washington, United States", "Vancouver, British Columbia, Canada")).toBe(false);
  });
});

describe("sameLocation", () => {
  it("still compares regions when both state one", () => {
    expect(sameLocation("Vancouver, BC, CAN", "Vancouver, British Columbia, Canada")).toBe(true);
    expect(sameLocation("Vancouver, ON, CAN", "Vancouver, British Columbia, Canada")).toBe(false);
  });
});
