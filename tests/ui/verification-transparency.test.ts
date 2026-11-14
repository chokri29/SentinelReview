import { describe, expect, it } from "vitest";
import { buildDeterministicDemoReport } from "../../src/demo/deterministic-review.js";
import {
  buildEvidenceChainLinks,
  buildPipelineStages,
  buildResultInterpretation,
  buildVerificationLedger,
} from "../../src/lib/verification-transparency.js";
import { runNearRustCallbackPrivateRule } from "../../src/rules/near-rust-callback-private.js";
import { createSnapshotFromEntries } from "../../src/source/custom-snapshot.js";
import type { ReviewResponse } from "../../src/types/review.ts";

function toReviewResponse(
  files: { path: string; content: string }[],
): ReviewResponse {
  const snapshot = createSnapshotFromEntries(files);
  const rule = runNearRustCallbackPrivateRule(snapshot);
  const report = buildDeterministicDemoReport(snapshot, rule);

  return {
    sourceKind: "custom",
    execution: {
      mode: "local_deterministic_only",
      aiInference: "not_run",
      sourceTransmission: "none",
    },
    snapshotFiles: snapshot.files.map((file) => ({
      path: file.path,
      content: file.content,
      byteLength: file.byteLength,
      lineCount: file.lineCount,
    })),
    totalBytes: snapshot.totalBytes,
    report: JSON.parse(JSON.stringify(report)) as ReviewResponse["report"],
    sourceExcerpts: {},
    consentToken: "0".repeat(64),
    consentTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    aiConfig: {
      modelId: "z-ai/glm-5.3-flash",
      apiKeyConfigured: false,
      approvedMeasurementsConfigured: false,
      maxSourceContextBytes: 256 * 1024,
      maxPromptBytes: 320 * 1024,
    },
  };
}

describe("verification-transparency view models", () => {
  it("maps finding + validated evidence into accurate stage statuses, ledger, and evidence chain", () => {
    const review = toReviewResponse([
      {
        path: "src/lib.rs",
        content:
          "#[near]\nimpl Contract {\n  pub fn cb(#[callback_result] r: Result<(), Error>) {}\n}\n",
      },
    ]);

    const stages = buildPipelineStages(review);
    expect(stages.map((s) => [s.id, s.status])).toEqual([
      ["ingestion", "Completed"],
      ["snapshot", "Completed"],
      ["hashing", "Completed"],
      ["ast_rule", "Finding detected"],
      ["generation", "Finding detected"],
      ["schema_ref", "Completed"],
      ["integrity_excerpt", "Completed"],
    ]);

    const interp = buildResultInterpretation(review);
    expect(interp.headline).toBe("Finding detected");
    expect(interp.evidenceSummary).toBe("Evidence validated");

    const ledger = buildVerificationLedger(review);
    const evEntry = ledger.find((item) => item.id.startsWith("ledger-ev-"));
    expect(evEntry?.result).toBe("Completed");
    expect(evEntry?.subChecks).toHaveLength(13);
    expect(evEntry?.subChecks?.every((sub) => sub.status === "passed")).toBe(true);

    const chain = buildEvidenceChainLinks(review);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.excerptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(chain[0]?.passedChecks).toBe(13);
    expect(chain[0]?.totalApplicableChecks).toBe(13);
  });

  it("marks generation and evidence validation stages as Not executed when rule emits 0 findings", () => {
    const review = toReviewResponse([
      {
        path: "src/lib.rs",
        content:
          "#[near]\nimpl Contract {\n  #[private]\n  pub fn cb(#[callback_result] r: Result<(), Error>) {}\n}\n",
      },
    ]);

    const stages = buildPipelineStages(review);
    expect(stages.map((s) => [s.id, s.status])).toEqual([
      ["ingestion", "Completed"],
      ["snapshot", "Completed"],
      ["hashing", "Completed"],
      ["ast_rule", "Completed"],
      ["generation", "Not executed"],
      ["schema_ref", "Not executed"],
      ["integrity_excerpt", "Not executed"],
    ]);

    const interp = buildResultInterpretation(review);
    expect(interp.headline).toBe("No findings within implemented rule scope");
    expect(interp.evidenceSummary).toBe("No evidence generated (0 findings)");
    expect(interp.summary).toMatch(/not proof of contract safety/i);

    const ledger = buildVerificationLedger(review);
    expect(ledger.find((e) => e.id === "ledger-evidence-none")?.result).toBe(
      "Not executed",
    );
    expect(buildEvidenceChainLinks(review)).toHaveLength(0);
  });

  it("surfaces Inconclusive stage and interpretation on Rust syntax errors", () => {
    const review = toReviewResponse([
      {
        path: "src/broken.rs",
        content: "#[near] impl Contract { pub fn bad( {",
      },
    ]);

    const stages = buildPipelineStages(review);
    expect(stages.find((s) => s.id === "ast_rule")?.status).toBe("Inconclusive");
    expect(stages.find((s) => s.id === "generation")?.status).toBe("Not executed");

    const interp = buildResultInterpretation(review);
    expect(interp.headline).toBe("Inconclusive or incomplete");
  });

  it("Scenario A: keeps Stage 3 hash generation and Stage 6 schema/reference validation Completed when only excerptHash fails", () => {
    const base = toReviewResponse([
      {
        path: "src/lib.rs",
        content:
          "#[near]\nimpl Contract {\n  pub fn cb(#[callback_result] r: Result<(), Error>) {}\n}\n",
      },
    ]);

    const excerptMismatch: ReviewResponse = {
      ...base,
      report: {
        ...base.report,
        evidenceIntegration: {
          ...base.report.evidenceIntegration,
          status: "invalid",
          evidence: base.report.evidenceIntegration.evidence.map((ev) => ({
            ...ev,
            computedValidationStatus: "invalid",
            presentedAsValidated: false,
            checks: {
              ...ev.checks,
              excerptHash: "failed",
            },
            issues: ["excerpt_hash_mismatch"],
          })),
        },
      },
    };

    const stages = buildPipelineStages(excerptMismatch);
    expect(stages.find((s) => s.id === "hashing")?.status).toBe("Completed");
    expect(stages.find((s) => s.id === "schema_ref")?.status).toBe("Completed");
    expect(stages.find((s) => s.id === "integrity_excerpt")?.status).toBe("Failed");

    const ledger = buildVerificationLedger(excerptMismatch);
    expect(ledger.find((e) => e.id === "ledger-snapshot-hash")?.result).toBe(
      "Completed",
    );
    expect(
      ledger.find((e) => e.id === "ledger-evidence-integration")?.result,
    ).toBe("Completed");
    expect(ledger.find((e) => e.id.startsWith("ledger-ev-"))?.result).toBe(
      "Failed",
    );

    const interp = buildResultInterpretation(excerptMismatch);
    expect(interp.headline).toBe("Invalid evidence");
    expect(interp.evidenceSummary).toBe("Invalid evidence");
  });

  it("Scenario A2: keeps Stage 3 hash generation and Stage 6 schema/reference validation Completed when independent fileIntegrity/manifestHashes fail", () => {
    const base = toReviewResponse([
      {
        path: "src/lib.rs",
        content:
          "#[near]\nimpl Contract {\n  pub fn cb(#[callback_result] r: Result<(), Error>) {}\n}\n",
      },
    ]);

    const integrityMismatch: ReviewResponse = {
      ...base,
      report: {
        ...base.report,
        evidenceIntegration: {
          ...base.report.evidenceIntegration,
          status: "invalid",
          evidence: base.report.evidenceIntegration.evidence.map((ev) => ({
            ...ev,
            computedValidationStatus: "invalid",
            presentedAsValidated: false,
            checks: {
              ...ev.checks,
              fileIntegrity: "failed",
              manifestHashes: "not_applicable",
              sourceHash: "not_applicable",
              evidencePath: "not_applicable",
              fileReference: "not_applicable",
              lineRange: "not_applicable",
              excerptHash: "not_applicable",
            },
            issues: ["file_hash_mismatch"],
          })),
        },
      },
    };

    const stages = buildPipelineStages(integrityMismatch);
    expect(stages.find((s) => s.id === "hashing")?.status).toBe("Completed");
    expect(stages.find((s) => s.id === "schema_ref")?.status).toBe("Completed");
    expect(stages.find((s) => s.id === "integrity_excerpt")?.status).toBe("Failed");

    const ledger = buildVerificationLedger(integrityMismatch);
    expect(ledger.find((e) => e.id === "ledger-snapshot-hash")?.result).toBe(
      "Completed",
    );
    expect(
      ledger.find((e) => e.id === "ledger-evidence-integration")?.result,
    ).toBe("Completed");
    expect(ledger.find((e) => e.id.startsWith("ledger-ev-"))?.result).toBe(
      "Failed",
    );

    const interp = buildResultInterpretation(integrityMismatch);
    expect(interp.headline).toBe("Invalid evidence");
    expect(interp.evidenceSummary).toBe("Invalid evidence");
  });

  it("Scenario B: marks Stage 6 and schema/reference ledger as Failed and surfaces integration issues on missing or duplicate evidence references", () => {
    const base = toReviewResponse([
      {
        path: "src/lib.rs",
        content:
          "#[near]\nimpl Contract {\n  pub fn cb(#[callback_result] r: Result<(), Error>) {}\n}\n",
      },
    ]);

    const missingRef: ReviewResponse = {
      ...base,
      report: {
        ...base.report,
        evidenceIntegration: {
          status: "invalid",
          evidence: [],
          issues: [
            {
              code: "missing_evidence_reference",
              evidenceId: "ev-missing-1",
              findingId: base.report.findings[0]!.findingId,
              message: "Finding references an evidence ID that does not exist.",
            },
          ],
        },
        findings: base.report.findings.map((finding) => ({
          ...finding,
          locations: finding.locations.map((loc) => ({
            ...loc,
            evidenceId: "ev-missing-1",
            referenceStatus: "missing",
            computedValidationStatus: "not_available",
            presentedAsValidated: false,
          })),
        })),
      },
    };

    const missingStages = buildPipelineStages(missingRef);
    expect(missingStages.find((s) => s.id === "hashing")?.status).toBe(
      "Completed",
    );
    const missingSchemaStage = missingStages.find((s) => s.id === "schema_ref");
    expect(missingSchemaStage?.status).toBe("Failed");
    expect(missingSchemaStage?.summary).toContain("missing_evidence_reference");
    expect(missingStages.find((s) => s.id === "integrity_excerpt")?.status).toBe(
      "Not executed",
    );

    const missingLedger = buildVerificationLedger(missingRef);
    const missingLedgerEntry = missingLedger.find(
      (e) => e.id === "ledger-evidence-integration",
    );
    expect(missingLedgerEntry?.result).toBe("Failed");
    expect(missingLedgerEntry?.resultDetail).toContain(
      "missing_evidence_reference",
    );
    expect(buildResultInterpretation(missingRef).headline).toBe(
      "Invalid evidence",
    );

    const duplicateRef: ReviewResponse = {
      ...base,
      report: {
        ...base.report,
        evidenceIntegration: {
          ...base.report.evidenceIntegration,
          status: "invalid",
          evidence: [
            ...base.report.evidenceIntegration.evidence,
            ...base.report.evidenceIntegration.evidence,
          ],
          issues: [
            {
              code: "duplicate_evidence_id",
              evidenceId: base.report.evidenceIntegration.evidence[0]!.evidenceId,
              message: "Multiple evidence records use the same evidence ID.",
            },
          ],
        },
        findings: base.report.findings.map((finding) => ({
          ...finding,
          locations: finding.locations.map((loc) => ({
            ...loc,
            referenceStatus: "ambiguous",
            computedValidationStatus: "not_available",
            presentedAsValidated: false,
          })),
        })),
      },
    };

    const dupStages = buildPipelineStages(duplicateRef);
    const dupSchemaStage = dupStages.find((s) => s.id === "schema_ref");
    expect(dupSchemaStage?.status).toBe("Failed");
    expect(dupSchemaStage?.summary).toContain("duplicate_evidence_id");
    expect(dupStages.find((s) => s.id === "integrity_excerpt")?.status).toBe(
      "Completed",
    );

    const dupLedgerEntry = buildVerificationLedger(duplicateRef).find(
      (e) => e.id === "ledger-evidence-integration",
    );
    expect(dupLedgerEntry?.result).toBe("Failed");
    expect(dupLedgerEntry?.resultDetail).toContain("duplicate_evidence_id");
  });
});
