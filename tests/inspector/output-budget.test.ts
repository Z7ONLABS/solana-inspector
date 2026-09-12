// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/inspector/node/input";
import {
  assertInspectorOutputBudget,
  checkInspectorOutputFiles,
} from "../../src/inspector/node/output-budget";

describe("final inspector output byte budget", () => {
  for (const feedback of [false, true]) {
    it.each([-1, 0, 1])(
      `counts all final artifacts at the 128MiB boundary, feedback=${feedback}, delta=%i`,
      (delta) => {
        // Only byte counts: no 128MiB allocation or disk fixture.
        const other = {
          "input.json": 1_048_576,
          "report.html": 2_048_576,
          "manifest.json": 512,
          ...(feedback ? { "feedback.json": 411 } : {}),
        };
        const sizes = {
          ...other,
          "report.json":
            LIMITS.outputBytes -
            Object.values(other).reduce((a, b) => a + b, 0) +
            delta,
        };
        expect(LIMITS.outputBytes).toBe(128 * 1024 * 1024);
        if (delta > 0)
          expect(() => assertInspectorOutputBudget(sizes)).toThrow(
            "output_byte_limit",
          );
        else
          expect(assertInspectorOutputBudget(sizes)).toBe(
            LIMITS.outputBytes + delta,
          );
      },
    );
  }

  it("measures UTF-8, newlines and only the supplied typed-array view", () => {
    const underlying = new Uint8Array(20);
    const files = {
      "input.json": underlying.subarray(3, 6),
      "report.json": "€\n",
      "report.html": "😀",
      "manifest.json": "{}\n",
      "feedback.json": "ñ",
    };
    expect(checkInspectorOutputFiles(files, 16)).toBe(16);
    expect(() => checkInspectorOutputFiles(files, 15)).toThrow(
      "output_byte_limit",
    );
  });

  it("rejects a final manifest or feedback that pushes an otherwise valid result over budget", () => {
    const early = {
      "input.json": 1,
      "report.json": 1,
      "report.html": 1,
      "manifest.json": 1,
    };
    expect(assertInspectorOutputBudget(early, 4)).toBe(4);
    expect(() =>
      assertInspectorOutputBudget({ ...early, "manifest.json": 2 }, 4),
    ).toThrow("output_byte_limit");
    expect(() =>
      assertInspectorOutputBudget({ ...early, "feedback.json": 1 }, 4),
    ).toThrow("output_byte_limit");
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid byte counts rather than wrapping or undercounting %s",
    (bytes) => {
      expect(() =>
        assertInspectorOutputBudget({ "report.json": bytes }),
      ).toThrow("output_byte_limit");
    },
  );
});
