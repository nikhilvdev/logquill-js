import { describe, expect, it } from "vitest";
import { CollectingTransport, JSONFormatter, Level, Logger, VERSION, parseLevel } from "../src/index.js";

describe("package entry point", () => {
  it("exports a version string", () => {
    expect(VERSION).toBe("0.1.1");
  });

  it("exports the core public API", () => {
    expect(Level.INFO).toBe(20);
    expect(parseLevel("info")).toBe(Level.INFO);
    expect(new Logger("app")).toBeInstanceOf(Logger);
    expect(new JSONFormatter()).toBeInstanceOf(JSONFormatter);
    expect(new CollectingTransport()).toBeInstanceOf(CollectingTransport);
  });
});
