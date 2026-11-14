import { describe, expect, it } from "vitest";
import { createSnapshotFromEntries } from "../../src/source/custom-snapshot.js";
import { integrateEvidence } from "../../src/source/integrate-evidence.js";
import { runNearRustCallbackPrivateRule } from "../../src/rules/near-rust-callback-private.js";

describe("integrateEvidence", () => {
  const sampleCode = [
    "#[near]",
    "impl Contract {",
    "    pub fn on_cb(#[callback_result] r: Result<(), PromiseError>) {",
    "        self.ok = true;",
    "    }",
    "}",
  ].join("\n");

  it("resolves unique references cleanly and preserves complete status", () => {
    const snapshot = createSnapshotFromEntries([
      { path: "lib.rs", content: sampleCode },
    ]);
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const result = integrateEvidence(
      rule.evidence,
      rule.deterministicAnalysis.findings,
      snapshot,
    );

    expect(result.status).toBe("complete");
    expect(result.issues).toHaveLength(0);
    expect(result.findings[0]?.evidenceRefs[0]?.status).toBe("resolved");
    expect(result.evidenceEntries[0]?.evidence.validationStatus).toBe("validated");
  });

  it("marks status invalid on duplicate evidence IDs or missing evidence references", () => {
    const snapshot = createSnapshotFromEntries([
      { path: "lib.rs", content: sampleCode },
    ]);
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const ev = rule.evidence[0]!;
    const finding = rule.deterministicAnalysis.findings[0]!;

    const duplicated = integrateEvidence([ev, ev], [finding], snapshot);
    expect(duplicated.status).toBe("invalid");
    expect(duplicated.issues.some((i) => i.code === "duplicate_evidence_id")).toBe(true);
    expect(duplicated.issues.some((i) => i.code === "ambiguous_evidence_reference")).toBe(true);

    const missingRef = integrateEvidence([], [finding], snapshot);
    expect(missingRef.status).toBe("invalid");
    expect(missingRef.issues.some((i) => i.code === "missing_evidence_reference")).toBe(true);
  });

  it("downgrades to partial when snapshot is omitted even if producer claimed validated", () => {
    const snapshot = createSnapshotFromEntries([
      { path: "lib.rs", content: sampleCode },
    ]);
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const forgedValidated = {
      ...rule.evidence[0]!,
      validationStatus: "validated" as const,
    };

    const result = integrateEvidence(
      [forgedValidated],
      rule.deterministicAnalysis.findings,
      undefined,
    );
    expect(result.status).toBe("partial");
    expect(result.evidenceEntries[0]?.evidence.validationStatus).toBe("unavailable");
  });
});
