import { describe, expect, it } from "vitest";
import {
  AnalysisResultSchema,
  EvidenceSchema,
  FindingSchema,
  ReviewReportSchema,
  schemaVersion,
  SourceManifestSchema,
} from "../src/contracts/v1.js";

const VALID_SHA256 = "a".repeat(64);
const VALID_SHA256_B = "b".repeat(64);

describe("contracts/v1 schemas", () => {
  it("exports schemaVersion 1.0.0", () => {
    expect(schemaVersion).toBe("1.0.0");
  });

  it("validates a well-formed Evidence record and rejects inverted line ranges", () => {
    const valid = EvidenceSchema.safeParse({
      evidenceId: "ev-1",
      sourceHash: VALID_SHA256,
      path: "src/lib.rs",
      startLine: 2,
      endLine: 5,
      excerptHash: VALID_SHA256_B,
      producer: "deterministic_rule",
      validationStatus: "validated",
    });
    expect(valid.success).toBe(true);

    const inverted = EvidenceSchema.safeParse({
      evidenceId: "ev-1",
      sourceHash: VALID_SHA256,
      path: "src/lib.rs",
      startLine: 6,
      endLine: 3,
      producer: "deterministic_rule",
      validationStatus: "validated",
    });
    expect(inverted.success).toBe(false);

    const badHash = EvidenceSchema.safeParse({
      evidenceId: "ev-1",
      sourceHash: "not-a-sha256",
      path: "src/lib.rs",
      startLine: 1,
      endLine: 1,
      producer: "deterministic_rule",
      validationStatus: "validated",
    });
    expect(badHash.success).toBe(false);
  });

  it("validates FindingSchema, SourceManifestSchema, AnalysisResultSchema, and ReviewReportSchema", () => {
    const manifest = SourceManifestSchema.parse({
      schemaVersion,
      files: [
        {
          path: "lib.rs",
          sha256: VALID_SHA256,
          byteLength: 42,
          lineCount: 3,
        },
      ],
      fileManifestHash: VALID_SHA256,
      sourceHash: VALID_SHA256_B,
    });

    const finding = FindingSchema.parse({
      findingId: "finding-1",
      origin: "deterministic_rule",
      ruleId: "NEAR-RUST-CALLBACK-PRIVATE-001",
      severity: "info",
      title: "Unguarded callback",
      rationale: "Missing #[private]",
      evidenceRefs: [{ evidenceId: "ev-1" }],
      limitations: ["Not an exploitability determination."],
    });

    const analysis = AnalysisResultSchema.parse({
      schemaVersion,
      deterministicAnalysis: {
        status: "finding",
        toolchain: ["NEAR-RUST-CALLBACK-PRIVATE-001@1"],
        findings: [finding],
      },
      aiAnalysis: {
        status: "not_run",
        responseVerification: "not_run",
        findings: [],
        limitations: [],
      },
    });

    const report = ReviewReportSchema.parse({
      schemaVersion,
      reportId: "rep-1",
      createdAt: "2026-11-14T00:00:00.000Z",
      source: manifest,
      policyHash: VALID_SHA256,
      analysis,
      evidence: [
        {
          evidenceId: "ev-1",
          sourceHash: VALID_SHA256_B,
          path: "lib.rs",
          startLine: 1,
          endLine: 3,
          producer: "deterministic_rule",
          validationStatus: "validated",
        },
      ],
      reportIntegrity: "verified",
      limitations: [],
    });

    expect(report.reportId).toBe("rep-1");
  });
});
