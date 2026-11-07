import type { Evidence, Finding } from "../contracts/v1.js";
import type { SourceLoadResult } from "./load-source.js";
import {
  validateEvidence,
  type EvidenceValidationResult,
} from "./validate-evidence.js";

export type EvidenceIntegrationStatus = "complete" | "partial" | "invalid";

export interface EvidenceIntegrationEntry {
  readonly evidence: Evidence;
  readonly validation: EvidenceValidationResult;
}

export type FindingEvidenceReferenceStatus =
  | "resolved"
  | "missing"
  | "ambiguous";

export interface FindingEvidenceReferenceResult {
  readonly evidenceRef: Finding["evidenceRefs"][number];
  readonly status: FindingEvidenceReferenceStatus;
  readonly evidenceEntry?: EvidenceIntegrationEntry;
}

export interface FindingReferenceResult {
  readonly finding: Finding;
  readonly evidenceRefs: readonly FindingEvidenceReferenceResult[];
}

export type EvidenceIntegrationIssueCode =
  | "duplicate_evidence_id"
  | "missing_evidence_reference"
  | "ambiguous_evidence_reference";

export interface EvidenceIntegrationIssue {
  readonly code: EvidenceIntegrationIssueCode;
  readonly message: string;
  readonly evidenceId: string;
  readonly findingId?: string;
}

export interface EvidenceIntegrationResult {
  /**
   * complete means all evidence is validated and all references resolve uniquely;
   * partial means at least one evidence record is partial or the snapshot is
   * unavailable, provided no invalid condition exists; invalid means evidence
   * is invalid, IDs are duplicated, or references are missing or ambiguous.
   * Invalid takes precedence over partial, which takes precedence over complete.
   */
  readonly status: EvidenceIntegrationStatus;
  readonly evidenceEntries: readonly EvidenceIntegrationEntry[];
  readonly evidenceById: Readonly<
    Record<string, readonly EvidenceIntegrationEntry[]>
  >;
  readonly findings: readonly FindingReferenceResult[];
  readonly issues: readonly EvidenceIntegrationIssue[];
}

function createIssue(
  code: EvidenceIntegrationIssueCode,
  evidenceId: string,
  message: string,
  findingId?: string,
): EvidenceIntegrationIssue {
  return Object.freeze({
    code,
    evidenceId,
    message,
    ...(findingId === undefined ? {} : { findingId }),
  });
}

export function integrateEvidence(
  evidenceRecords: readonly Evidence[],
  findings: readonly Finding[],
  snapshot?: SourceLoadResult,
): EvidenceIntegrationResult {
  const issues: EvidenceIntegrationIssue[] = [];
  const evidenceEntries = evidenceRecords.map((evidence) =>
    Object.freeze({
      evidence,
      validation: validateEvidence(evidence, snapshot),
    }),
  );
  const mutableEvidenceById: Record<string, EvidenceIntegrationEntry[]> =
    Object.create(null);

  for (const entry of evidenceEntries) {
    const evidenceId = entry.evidence.evidenceId;
    const existingEntries = mutableEvidenceById[evidenceId];

    if (existingEntries === undefined) {
      mutableEvidenceById[evidenceId] = [entry];
      continue;
    }

    existingEntries.push(entry);
    if (existingEntries.length === 2) {
      issues.push(
        createIssue(
          "duplicate_evidence_id",
          evidenceId,
          "Multiple evidence records use the same evidence ID.",
        ),
      );
    }
  }

  const evidenceById: Record<
    string,
    readonly EvidenceIntegrationEntry[]
  > = Object.create(null);
  for (const evidenceId of Object.keys(mutableEvidenceById)) {
    evidenceById[evidenceId] = Object.freeze(mutableEvidenceById[evidenceId]!);
  }

  const findingResults = findings.map((finding) => {
    const evidenceRefs = finding.evidenceRefs.map((evidenceRef) => {
      const matchingEntries = evidenceById[evidenceRef.evidenceId];

      if (matchingEntries === undefined) {
        issues.push(
          createIssue(
            "missing_evidence_reference",
            evidenceRef.evidenceId,
            "Finding references an evidence ID that does not exist.",
            finding.findingId,
          ),
        );
        return Object.freeze({ evidenceRef, status: "missing" as const });
      }

      if (matchingEntries.length > 1) {
        issues.push(
          createIssue(
            "ambiguous_evidence_reference",
            evidenceRef.evidenceId,
            "Finding references an evidence ID used by multiple evidence records.",
            finding.findingId,
          ),
        );
        return Object.freeze({ evidenceRef, status: "ambiguous" as const });
      }

      return Object.freeze({
        evidenceRef,
        status: "resolved" as const,
        evidenceEntry: matchingEntries[0]!,
      });
    });

    return Object.freeze({
      finding,
      evidenceRefs: Object.freeze(evidenceRefs),
    });
  });

  const hasInvalidEvidence = evidenceEntries.some(
    ({ validation }) => validation.status === "invalid",
  );
  const hasPartialEvidence = evidenceEntries.some(
    ({ validation }) => validation.status === "partial",
  );
  const hasUnresolvedReferences = issues.some(
    (issue) =>
      issue.code === "missing_evidence_reference" ||
      issue.code === "ambiguous_evidence_reference",
  );
  const hasDuplicateEvidenceIds = issues.some(
    (issue) => issue.code === "duplicate_evidence_id",
  );
  const status: EvidenceIntegrationStatus =
    hasInvalidEvidence || hasUnresolvedReferences || hasDuplicateEvidenceIds
      ? "invalid"
      : hasPartialEvidence || snapshot === undefined
        ? "partial"
        : "complete";

  return Object.freeze({
    status,
    evidenceEntries: Object.freeze(evidenceEntries),
    evidenceById: Object.freeze(evidenceById),
    findings: Object.freeze(findingResults),
    issues: Object.freeze(issues),
  });
}
