import { describe, expect, it } from "vitest";
import {
  IN_PROGRESS_PERCENT_MAX,
  PERCENT_MAX,
  clampPercent,
  percentFromBytes,
  percentFromRatio,
} from "../src/core/progress.js";

describe("progress percentage helpers", () => {
  it("pins the scale the panel renders", () => {
    expect(PERCENT_MAX).toBe(100);
    expect(IN_PROGRESS_PERCENT_MAX).toBe(99);
  });

  it("converts ratios into 0..100 percentages", () => {
    expect(percentFromRatio(0)).toBe(0);
    expect(percentFromRatio(0.25)).toBe(25);
    expect(percentFromRatio(0.5)).toBe(50);
    expect(percentFromRatio(1)).toBe(100);
  });

  it("clamps out-of-range ratios instead of wrapping", () => {
    expect(percentFromRatio(-0.5)).toBe(0);
    expect(percentFromRatio(2)).toBe(100);
    expect(percentFromRatio(Number.NaN)).toBe(0);
  });

  it("honours the in-progress cap", () => {
    expect(percentFromRatio(1, IN_PROGRESS_PERCENT_MAX)).toBe(99);
    expect(percentFromBytes(4_000, 4_000, IN_PROGRESS_PERCENT_MAX)).toBe(99);
  });

  it("converts fetched bytes against a known total", () => {
    expect(percentFromBytes(0, 4_000)).toBe(0);
    expect(percentFromBytes(2_000, 4_000)).toBe(50);
    expect(percentFromBytes(4_000, 4_000)).toBe(100);
  });

  it("omits the percentage when the total is unknown or unusable", () => {
    expect(percentFromBytes(1_000, undefined)).toBeUndefined();
    expect(percentFromBytes(1_000, 0)).toBeUndefined();
    expect(percentFromBytes(1_000, -1)).toBeUndefined();
    expect(percentFromBytes(1_000, Number.NaN)).toBeUndefined();
    expect(percentFromBytes(Number.NaN, 1_000)).toBeUndefined();
  });

  it("clamps stored percentages and ignores non-finite values", () => {
    expect(clampPercent(0.5)).toBe(0.5);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(-4)).toBe(0);
    expect(clampPercent(Number.NaN)).toBeUndefined();
    expect(clampPercent(undefined)).toBeUndefined();
  });
});
