import { describe, it, expect } from "vitest";
import {
  DEFAULT_MODELS,
  MAX_MODELS,
  parseModels,
  dedupe,
  normalizeModels,
  resolveModels,
  parseIntEnv,
  parseTempEnv,
} from "./config.js";

describe("parseModels", () => {
  it("returns the fallback when undefined or empty", () => {
    expect(parseModels(undefined)).toEqual(DEFAULT_MODELS);
    expect(parseModels("")).toEqual(DEFAULT_MODELS);
    expect(parseModels("  ,  , ")).toEqual(DEFAULT_MODELS);
  });
  it("splits, trims, and drops blanks", () => {
    expect(parseModels("a/x, b/y ,, c/z")).toEqual(["a/x", "b/y", "c/z"]);
  });
  it("does not return a reference to the shared default array", () => {
    const out = parseModels(undefined);
    out.push("mutated");
    expect(DEFAULT_MODELS).not.toContain("mutated");
  });
});

describe("dedupe", () => {
  it("removes duplicates, preserves first-seen order, drops blanks", () => {
    expect(dedupe(["a", "a", "b", " a ", "", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("normalizeModels", () => {
  it("passes through when within the cap", () => {
    expect(normalizeModels(["a", "b"], 8)).toEqual({ models: ["a", "b"], dropped: 0 });
  });
  it("dedupes before counting", () => {
    expect(normalizeModels(["a", "a", "b"], 8)).toEqual({ models: ["a", "b"], dropped: 0 });
  });
  it("caps and reports how many were dropped", () => {
    const r = normalizeModels(["a", "b", "c", "d"], 2);
    expect(r.models).toEqual(["a", "b"]);
    expect(r.dropped).toBe(2);
  });
  it("defaults the cap to MAX_MODELS", () => {
    const many = Array.from({ length: MAX_MODELS + 3 }, (_, i) => `m/${i}`);
    expect(normalizeModels(many).models).toHaveLength(MAX_MODELS);
  });
});

describe("resolveModels", () => {
  const fallback = ["d/one", "d/two"];

  it("uses the requested models when given", () => {
    expect(resolveModels(["a/x"], fallback).models).toEqual(["a/x"]);
  });
  it("falls back when requested is undefined or empty", () => {
    expect(resolveModels(undefined, fallback).models).toEqual(fallback);
    expect(resolveModels([], fallback).models).toEqual(fallback);
  });
  it("falls back when requested normalises to empty (whitespace-only ids)", () => {
    // the schema's min(1) lets "  " through; resolveModels must not yield a 0-model panel
    expect(resolveModels(["  ", "\t"], fallback).models).toEqual(fallback);
  });
  it("caps and reports dropped for an oversized request", () => {
    const r = resolveModels(["a", "b", "c"], fallback, 2);
    expect(r.models).toEqual(["a", "b"]);
    expect(r.dropped).toBe(1);
  });
});

describe("parseIntEnv", () => {
  it.each([
    ["5", 5],
    [undefined, 99],
    ["0", 99],
    ["-3", 99],
    ["abc", 99],
    ["2.9", 2],
  ])("%s -> %s", (raw, expected) => {
    expect(parseIntEnv(raw as string | undefined, 99)).toBe(expected);
  });
});

describe("parseTempEnv", () => {
  it.each([
    [undefined, 0.7],
    ["", 0.7],
    ["0", 0],
    ["1.5", 1.5],
    ["2", 2],
    ["3", 0.7],
    ["-1", 0.7],
    ["abc", 0.7],
  ])("%s -> %s", (raw, expected) => {
    expect(parseTempEnv(raw as string | undefined, 0.7)).toBe(expected);
  });
});
