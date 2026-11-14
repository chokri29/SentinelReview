import { describe, expect, it } from "vitest";
import {
  countPhysicalLines,
  isLineHighlighted,
  splitPhysicalLines,
} from "../../src/lib/source-lines.js";

describe("source-lines helpers", () => {
  it("splits physical lines accurately across LF, CRLF, and trailing newline", () => {
    expect(splitPhysicalLines("")).toEqual([]);
    expect(splitPhysicalLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitPhysicalLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
    expect(countPhysicalLines("a\nb\n")).toBe(2);
    expect(countPhysicalLines("a\nb")).toBe(2);
  });

  it("highlights only lines within inclusive target path and line range", () => {
    const highlight = {
      path: "src/lib.rs",
      startLine: 3,
      endLine: 5,
    };

    expect(isLineHighlighted(2, "src/lib.rs", highlight)).toBe(false);
    expect(isLineHighlighted(3, "src/lib.rs", highlight)).toBe(true);
    expect(isLineHighlighted(4, "src/lib.rs", highlight)).toBe(true);
    expect(isLineHighlighted(5, "src/lib.rs", highlight)).toBe(true);
    expect(isLineHighlighted(6, "src/lib.rs", highlight)).toBe(false);

    // Different file must not highlight
    expect(isLineHighlighted(3, "src/other.rs", highlight)).toBe(false);
    // Null or inverted highlight must not highlight
    expect(isLineHighlighted(3, "src/lib.rs", null)).toBe(false);
    expect(
      isLineHighlighted(3, "src/lib.rs", {
        path: "src/lib.rs",
        startLine: 5,
        endLine: 2,
      }),
    ).toBe(false);
  });
});
