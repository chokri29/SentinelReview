import type { Evidence } from "../contracts/v1.js";
import type { SourceLoadResult } from "../source/load-source.js";
import {
  integrateEvidence,
  type EvidenceIntegrationStatus,
  type FindingEvidenceReferenceStatus,
} from "../source/integrate-evidence.js";
import {
  runNearRustCallbackPrivateRule,
  type NearRustCallbackPrivateRuleResult,
} from "../rules/near-rust-callback-private.js";

type EvidenceValidationStatus = Evidence["validationStatus"];

export interface DeterministicDemoReport {
  readonly snapshot: {
    readonly sourceHash: string;
    readonly fileManifestHash: string;
    readonly fileCount: number;
  };
  readonly deterministicRule: {
    readonly id: "NEAR-RUST-CALLBACK-PRIVATE-001";
    readonly status: "finding" | "passed" | "inconclusive";
    readonly findingCount: number;
    readonly limitations: readonly string[];
  };
  readonly evidenceIntegration: {
    readonly status: EvidenceIntegrationStatus;
    readonly evidence: readonly {
      readonly evidenceId: string;
      readonly embeddedValidationStatus: Evidence["validationStatus"];
      readonly integrationValidationStatus: EvidenceValidationStatus;
      readonly presentedAsValidated: boolean;
      readonly issues: readonly string[];
    }[];
    readonly issues: readonly {
      readonly code: string;
      readonly evidenceId: string;
      readonly findingId?: string;
      readonly message: string;
    }[];
  };
  readonly findings: readonly {
    readonly findingId: string;
    readonly origin: string;
    readonly severity: string;
    readonly title: string;
    readonly rationale: string;
    readonly locations: readonly {
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly referenceStatus: FindingEvidenceReferenceStatus;
      readonly evidenceId: string;
      readonly embeddedValidationStatus: Evidence["validationStatus"] | "not_available";
      readonly integrationValidationStatus: EvidenceValidationStatus | "not_available";
      readonly presentedAsValidated: boolean;
    }[];
    readonly limitations: readonly string[];
  }[];
  readonly overallAnalysisStatus: "finding" | "no_findings" | "inconclusive";
  readonly interpretation: string;
}

export function buildDeterministicDemoReport(
  snapshot: SourceLoadResult,
  ruleResult: NearRustCallbackPrivateRuleResult = runNearRustCallbackPrivateRule(snapshot),
): DeterministicDemoReport {
  const integration = integrateEvidence(
    ruleResult.evidence,
    ruleResult.deterministicAnalysis.findings,
    snapshot,
  );

  const findings = integration.findings.map(({ finding, evidenceRefs }) => ({
    findingId: finding.findingId,
    origin: finding.origin,
    severity: finding.severity,
    title: finding.title,
    rationale: finding.rationale,
    locations: evidenceRefs.map((reference) => {
      const entry = reference.evidenceEntry;
      const validationStatus = entry?.validation.status ?? "not_available";
      return {
        path: entry?.evidence.path ?? "unavailable",
        startLine: entry?.evidence.startLine ?? 0,
        endLine: entry?.evidence.endLine ?? 0,
        referenceStatus: reference.status,
        evidenceId: reference.evidenceRef.evidenceId,
        embeddedValidationStatus:
          entry?.evidence.validationStatus ?? "not_available",
        integrationValidationStatus: validationStatus,
        presentedAsValidated:
          reference.status === "resolved" && validationStatus === "validated",
      };
    }),
    limitations: finding.limitations,
  }));

  const evidence = integration.evidenceEntries.map(({ evidence: record, validation }) => ({
    evidenceId: record.evidenceId,
    embeddedValidationStatus: record.validationStatus,
    integrationValidationStatus: validation.status,
    presentedAsValidated: validation.status === "validated",
    issues: validation.issues.map((issue) => issue.code),
  }));

  const overallAnalysisStatus =
    ruleResult.deterministicAnalysis.status === "inconclusive"
      ? "inconclusive"
      : ruleResult.deterministicAnalysis.status === "finding"
        ? "finding"
        : "no_findings";

  const interpretation =
    overallAnalysisStatus === "finding"
      ? "The deterministic rule emitted one or more informational candidates. Review the locations and limitations; this is not an exploitability determination or a complete audit."
      : overallAnalysisStatus === "inconclusive"
        ? "The deterministic rule could not reach a conclusive result for all inspected source. This is not a safety determination."
        : "The selected deterministic rule emitted no findings. This does not establish that the source is safe or free of vulnerabilities.";

  return Object.freeze({
    snapshot: Object.freeze({
      sourceHash: snapshot.manifest.sourceHash,
      fileManifestHash: snapshot.manifest.fileManifestHash,
      fileCount: snapshot.files.length,
    }),
    deterministicRule: Object.freeze({
      id: "NEAR-RUST-CALLBACK-PRIVATE-001",
      status: ruleResult.deterministicAnalysis.status,
      findingCount: ruleResult.deterministicAnalysis.findings.length,
      limitations: Object.freeze([...ruleResult.limitations]),
    }),
    evidenceIntegration: Object.freeze({
      status: integration.status,
      evidence: Object.freeze(evidence.map((entry) => Object.freeze(entry))),
      issues: Object.freeze(integration.issues.map((issue) => Object.freeze({
        code: issue.code,
        evidenceId: issue.evidenceId,
        ...(issue.findingId === undefined ? {} : { findingId: issue.findingId }),
        message: issue.message,
      }))),
    }),
    findings: Object.freeze(findings.map((finding) => Object.freeze({
      ...finding,
      locations: Object.freeze(finding.locations.map((location) => Object.freeze(location))),
      limitations: Object.freeze([...finding.limitations]),
    }))),
    overallAnalysisStatus,
    interpretation,
  });
}

export function formatDeterministicDemoReport(report: DeterministicDemoReport): string {
  return `SentinelReview deterministic demo (local fixture; no AI inference)\n${JSON.stringify(report, null, 2)}\n`;
}
