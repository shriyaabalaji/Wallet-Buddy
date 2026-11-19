import { describe, expect, it } from "vitest";
import { formatPhone, normalizePhone } from "./phone";

describe("normalizePhone", () => {
  it("accepts common ways of typing an international number", () => {
    expect(normalizePhone("+1 604 555 0100")).toBe("+16045550100");
    expect(normalizePhone(" +1 (604) 555-0100 ")).toBe("+16045550100");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("+1.604.555.0100")).toBe("+16045550100");
  });
  it("rejects numbers without a country code or with junk", () => {
    expect(normalizePhone("604 555 0100")).toBeNull();
    expect(normalizePhone("+0 604 555 0100")).toBeNull();
    expect(normalizePhone("+1 604 555 01OO")).toBeNull();
    expect(normalizePhone("+123")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });
});

describe("formatPhone", () => {
  it("groups North American numbers and leaves others alone", () => {
    expect(formatPhone("+16045550100")).toBe("+1 604 555 0100");
    expect(formatPhone("+442079460958")).toBe("+442079460958");
  });
});
