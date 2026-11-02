import { describe, expect, it } from "vitest";
import {
  EvidenceSchema,
  FindingSchema,
  ReviewReportSchema,
  schemaVersion,
} from "../src/contracts/v1.js";

const digest = "a".repeat(64);

describe("versioned contract schemas", () => {
  it("rejects evidence with an inverted line range", () => {
    const result = EvidenceSchema.safeParse({
      evidenceId: "ev-1",
      sourceHash: digest,
      path: "src/lib.rs",
      startLine: 12,
      endLine: 4,
      producer: "deterministic_rule",
      validationStatus: "validated",
    });

    expect(result.success).toBe(false);
  });

  it("requires evidence references and bounded finding fields", () => {
    const result = FindingSchema.safeParse({
      findingId: "f-1",
      origin: "deterministic_rule",
      severity: "high",
      title: "Unsafe state transition",
      rationale: "A state transition is not guarded by the required invariant.",
      evidenceRefs: [{ evidenceId: "ev-1" }],
      limitations: [],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a report with an unsupported schema version", () => {
    const result = ReviewReportSchema.safeParse({
      schemaVersion: "2.0.0",
      reportId: "report-1",
    });

    expect(result.success).toBe(false);
  });

  it("exports the initial contract version", () => {
    expect(schemaVersion).toBe("1.0.0");
  });
});
