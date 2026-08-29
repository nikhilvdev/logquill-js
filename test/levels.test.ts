import { describe, expect, it } from "vitest";
import { Level, levelName, parseLevel } from "../src/index.js";

describe("levels", () => {
  it("has the same names and numeric weights as the Python contract", () => {
    expect(Level.TRACE).toBe(5);
    expect(Level.DEBUG).toBe(10);
    expect(Level.INFO).toBe(20);
    expect(Level.WARN).toBe(30);
    expect(Level.ERROR).toBe(40);
    expect(Level.FATAL).toBe(50);
  });

  it("levelName returns the name for a numeric level", () => {
    expect(levelName(Level.WARN)).toBe("WARN");
  });

  it("parseLevel accepts a Level", () => {
    expect(parseLevel(Level.ERROR)).toBe(Level.ERROR);
  });

  it("parseLevel accepts a numeric weight", () => {
    expect(parseLevel(30)).toBe(Level.WARN);
  });

  it("parseLevel accepts a level name, case-insensitively", () => {
    expect(parseLevel("info")).toBe(Level.INFO);
    expect(parseLevel("FATAL")).toBe(Level.FATAL);
  });

  it("parseLevel throws on an unknown name", () => {
    expect(() => parseLevel("verbose")).toThrow(/Unknown log level/);
  });

  it("parseLevel throws on an unknown numeric weight", () => {
    expect(() => parseLevel(15)).toThrow(/Unknown log level/);
  });
});
