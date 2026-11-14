import type {
  EvidenceRecord,
  EvidenceValidationCheckStatus,
  ReviewResponse,
} from "../types/review.ts";

export type PipelineStageStatus =
  | "Completed"
  | "Finding detected"
  | "Failed"
  | "Unavailable"
  | "Inconclusive"
  | "Not executed";

export interface PipelineStage {
  readonly id:
    | "ingestion"
    | "snapshot"
    | "hashing"
    | "ast_rule"
    | "generation"
    | "schema_ref"
    | "integrity_excerpt";
  readonly stepNumber: number;
  readonly name: string;
  readonly status: PipelineStageStatus;
  readonly summary: string;
  readonly mechanism: string;
}

export interface VerificationLedgerEntry {
  readonly id: string;
  readonly checkName: string;
  readonly whatWasChecked: string;
  readonly result: PipelineStageStatus;
  readonly resultDetail: string;
  readonly reference: string;
  readonly targetLocation?: {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly evidenceId: string;
  };
  readonly limitations: string;
  readonly subChecks?: readonly {
    readonly name: string;
    readonly status: EvidenceValidationCheckStatus;
  }[];
}

export interface ResultInterpretation {
  readonly headline:
    | "Finding detected"
    | "No findings within implemented rule scope"
    | "Inconclusive or incomplete"
    | "Invalid evidence";
  readonly tone: "amber" | "rose" | "slate";
  readonly evidenceSummary:
    | "Evidence validated"
    | "Invalid evidence"
    | "Evidence incomplete"
    | "Evidence unavailable"
    | "No evidence generated (0 findings)";
  readonly evidenceTone: "emerald" | "amber" | "rose" | "slate";
  readonly summary: string;
  readonly distinctionNote: string;
}

export interface EvidenceChainLink {
  readonly findingId: string;
  readonly ruleId: string;
  readonly evidenceId: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly referenceStatus: string;
  readonly excerptHash: string | undefined;
  readonly computedValidationStatus: string;
  readonly passedChecks: number;
  readonly totalApplicableChecks: number;
}

export const IMPLEMENTED_CHECKS = [
  "Bounded .rs source ingestion (200-file, 1 MB/file, 5 MB total limits; canonical POSIX paths; reversible UTF-8)",
  "Deeply frozen immutable source snapshot with sorted manifest entries",
  "Domain-separated SHA-256 file, manifest, and source hashing",
  "NEAR-RUST-CALLBACK-PRIVATE-001 syntactic AST check via @lezer/rust (flags #[callback_result] methods inside #[near] / #[near_bindgen] impls lacking #[private] or recognized direct guard)",
  "Independent 13-point evidence validation and excerpt SHA-256 recomputation",
] as const;

export const UNIMPLEMENTED_CHECKS = [
  "rustc / Cargo compilation, type checking, and Rust macro expansion",
  "Dynamic test execution, fuzzing, or cross-contract runtime simulation",
  "Control-flow, data-flow, taint, or alias analysis across helper functions or modules",
  "Other vulnerability classes (reentrancy, arithmetic overflow, storage/gas DoS, general owner/role authorization)",
  "Exploitability verification or comprehensive smart-contract safety certification",
] as const;

const VALIDATION_CHECK_LABELS: ReadonlyArray<{
  key: keyof EvidenceRecord["checks"];
  label: string;
}> = [
  { key: "evidence", label: "Evidence schema" },
  { key: "snapshot", label: "Snapshot present" },
  { key: "manifestSchema", label: "Manifest schema" },
  { key: "manifestPaths", label: "Manifest canonical paths" },
  { key: "manifestOrdering", label: "Manifest sorting" },
  { key: "snapshotFiles", label: "Snapshot-manifest match" },
  { key: "fileIntegrity", label: "Per-file SHA-256 / bytes / lines" },
  { key: "manifestHashes", label: "Manifest & source SHA-256" },
  { key: "sourceHash", label: "Evidence sourceHash match" },
  { key: "evidencePath", label: "Evidence canonical path" },
  { key: "fileReference", label: "Target file resolved" },
  { key: "lineRange", label: "Physical line bounds" },
  { key: "excerptHash", label: "Excerpt SHA-256 match" },
];

export function hasNoEmittedEvidence(review: ReviewResponse): boolean {
  const { report } = review;
  return (
    report.evidenceIntegration.evidence.length === 0 &&
    report.findings.length === 0 &&
    report.evidenceIntegration.issues.length === 0
  );
}

interface SchemaReferenceAssessment {
  readonly status: PipelineStageStatus;
  readonly summary: string;
  readonly detail: string;
  readonly reference: string;
}

function assessSchemaAndReferences(
  review: ReviewResponse,
): SchemaReferenceAssessment {
  const { report } = review;
  const evidenceList = report.evidenceIntegration.evidence;
  const integrationIssues = report.evidenceIntegration.issues;

  if (hasNoEmittedEvidence(review)) {
    return {
      status: "Not executed",
      summary:
        "No findings or evidence records were emitted for schema or reference resolution.",
      detail: "0 findings and 0 evidence records emitted.",
      reference: "No evidence records",
    };
  }

  const unresolvedLocations = report.findings.flatMap((finding) =>
    finding.locations.filter((loc) => loc.referenceStatus !== "resolved"),
  );
  const findingsWithoutLocations = report.findings.filter(
    (finding) => finding.locations.length === 0,
  );
  const schemaOrRefCheckFailures = evidenceList.filter(
    (entry) =>
      entry.checks.evidence === "failed" ||
      entry.checks.evidencePath === "failed" ||
      entry.checks.fileReference === "failed",
  );

  const hasFailure =
    integrationIssues.length > 0 ||
    unresolvedLocations.length > 0 ||
    findingsWithoutLocations.length > 0 ||
    schemaOrRefCheckFailures.length > 0;

  if (hasFailure) {
    const reasons: string[] = [];
    if (integrationIssues.length > 0) {
      reasons.push(
        `${integrationIssues.length} issue(s): ${integrationIssues.map((i) => i.code).join(", ")}`,
      );
    } else if (unresolvedLocations.length > 0) {
      reasons.push(
        `${unresolvedLocations.length} unresolved finding reference(s)`,
      );
    } else if (findingsWithoutLocations.length > 0) {
      reasons.push(
        `${findingsWithoutLocations.length} finding(s) missing evidence references`,
      );
    }

    if (schemaOrRefCheckFailures.length > 0) {
      reasons.push(
        `${schemaOrRefCheckFailures.length} evidence schema/reference check failure(s)`,
      );
    }

    const detail = `${reasons.join("; ")}.`;
    return {
      status: "Failed",
      summary: `Evidence schema or finding-reference validation failed (${reasons.join("; ")}).`,
      detail,
      reference:
        integrationIssues[0]?.evidenceId ??
        evidenceList[0]?.evidenceId ??
        "Integration check",
    };
  }

  return {
    status: "Completed",
    summary: `${report.findings.length} finding reference(s) uniquely resolved to ${evidenceList.length} schema-valid evidence record(s).`,
    detail: `${report.findings.length} finding(s) resolved uniquely to ${evidenceList.length} schema-valid evidence record(s).`,
    reference: evidenceList[0]?.evidenceId ?? "Integration check",
  };
}

export function buildPipelineStages(review: ReviewResponse): PipelineStage[] {
  const { report, sourceKind, totalBytes } = review;
  const evidenceList = report.evidenceIntegration.evidence;
  const hasSnapshotHashes =
    report.snapshot.sourceHash.length > 0 &&
    report.snapshot.fileManifestHash.length > 0;

  const ruleStatus: PipelineStageStatus =
    report.deterministicRule.status === "finding"
      ? "Finding detected"
      : report.deterministicRule.status === "inconclusive"
        ? "Inconclusive"
        : "Completed";

  const ruleSummary =
    report.deterministicRule.status === "finding"
      ? `${report.deterministicRule.id} emitted ${report.deterministicRule.findingCount} informational candidate(s).`
      : report.deterministicRule.status === "inconclusive"
        ? `${report.deterministicRule.id} was inconclusive across part of the snapshot (syntax errors or unverified direct manual guard).`
        : `${report.deterministicRule.id} emitted 0 candidates across ${report.snapshot.fileCount} file(s). This does not prove contract safety.`;

  const generationStatus: PipelineStageStatus =
    report.findings.length > 0 || evidenceList.length > 0
      ? "Finding detected"
      : "Not executed";

  const generationSummary =
    report.findings.length > 0 || evidenceList.length > 0
      ? `Emitted ${report.findings.length} finding(s) and ${evidenceList.length} evidence record(s) with physical line coordinates.`
      : "No candidates were emitted by the rule, so no finding or evidence records were generated.";

  const schemaRefAssessment = assessSchemaAndReferences(review);

  let integrityStatus: PipelineStageStatus;
  let integritySummary: string;
  if (evidenceList.length === 0) {
    integrityStatus = "Not executed";
    integritySummary =
      "0 evidence records were present to run independent snapshot and excerpt SHA-256 recomputation.";
  } else if (
    evidenceList.some((entry) => entry.computedValidationStatus === "invalid")
  ) {
    integrityStatus = "Failed";
    integritySummary =
      "Independent recomputation detected invalid snapshot hashes, line bounds, or excerpt SHA-256 mismatches.";
  } else if (
    evidenceList.some((entry) => entry.computedValidationStatus === "unavailable")
  ) {
    integrityStatus = "Unavailable";
    integritySummary =
      "Source snapshot was unavailable for independent integrity and excerpt recomputation.";
  } else if (
    evidenceList.some((entry) => entry.computedValidationStatus === "partial")
  ) {
    integrityStatus = "Inconclusive";
    integritySummary =
      "Snapshot identity and bounds matched, but excerptHash was missing on one or more evidence records.";
  } else {
    integrityStatus = "Completed";
    integritySummary = `Recomputed snapshot hashes, physical line bounds, and excerpt SHA-256 for ${evidenceList.length} record(s); confirms snapshot correspondence only.`;
  }

  return [
    {
      id: "ingestion",
      stepNumber: 1,
      name: "Rust source ingestion & validation",
      status: "Completed",
      summary: `${report.snapshot.fileCount} .rs file(s) (${totalBytes} UTF-8 bytes) validated via ${sourceKind === "fixture" ? "bounded fixture loader" : "custom snapshot validator"}.`,
      mechanism: sourceKind === "fixture" ? "loadSource" : "createSnapshotFromEntries",
    },
    {
      id: "snapshot",
      stepNumber: 2,
      name: "Immutable source snapshot creation",
      status: "Completed",
      summary: `Sorted ${report.snapshot.files.length} canonical relative POSIX path(s) into a deeply frozen snapshot.`,
      mechanism: "Object.freeze + SourceManifestSchema",
    },
    {
      id: "hashing",
      stepNumber: 3,
      name: "SHA-256 source and manifest hashing",
      status: hasSnapshotHashes ? "Completed" : "Unavailable",
      summary: hasSnapshotHashes
        ? `Computed per-file SHA-256, fileManifestHash, and sourceHash (${report.snapshot.sourceHash.slice(0, 12)}…).`
        : "Snapshot and manifest hashes were not present in the report.",
      mechanism: "calculateManifestHashes",
    },
    {
      id: "ast_rule",
      stepNumber: 4,
      name: "Deterministic AST rule execution",
      status: ruleStatus,
      summary: ruleSummary,
      mechanism: report.deterministicRule.toolchain.join(" · "),
    },
    {
      id: "generation",
      stepNumber: 5,
      name: "Finding and evidence generation",
      status: generationStatus,
      summary: generationSummary,
      mechanism: report.deterministicRule.id,
    },
    {
      id: "schema_ref",
      stepNumber: 6,
      name: "Evidence schema and reference validation",
      status: schemaRefAssessment.status,
      summary: schemaRefAssessment.summary,
      mechanism: "integrateEvidence",
    },
    {
      id: "integrity_excerpt",
      stepNumber: 7,
      name: "Independent integrity and excerpt-hash verification",
      status: integrityStatus,
      summary: integritySummary,
      mechanism: "validateEvidence",
    },
  ];
}

export function buildResultInterpretation(
  review: ReviewResponse,
): ResultInterpretation {
  const { report } = review;
  const evidenceList = report.evidenceIntegration.evidence;

  let evidenceSummary: ResultInterpretation["evidenceSummary"];
  let evidenceTone: ResultInterpretation["evidenceTone"];

  if (
    report.evidenceIntegration.status === "invalid" ||
    evidenceList.some((e) => e.computedValidationStatus === "invalid") ||
    report.evidenceIntegration.issues.length > 0
  ) {
    evidenceSummary = "Invalid evidence";
    evidenceTone = "rose";
  } else if (hasNoEmittedEvidence(review)) {
    evidenceSummary = "No evidence generated (0 findings)";
    evidenceTone = "slate";
  } else if (
    evidenceList.some((e) => e.computedValidationStatus === "unavailable")
  ) {
    evidenceSummary = "Evidence unavailable";
    evidenceTone = "amber";
  } else if (
    report.evidenceIntegration.status === "partial" ||
    evidenceList.some((e) => e.computedValidationStatus === "partial")
  ) {
    evidenceSummary = "Evidence incomplete";
    evidenceTone = "amber";
  } else {
    evidenceSummary = "Evidence validated";
    evidenceTone = "emerald";
  }

  if (
    report.evidenceIntegration.status === "invalid" ||
    evidenceList.some((e) => e.computedValidationStatus === "invalid") ||
    report.evidenceIntegration.issues.length > 0
  ) {
    return {
      headline: "Invalid evidence",
      tone: "rose",
      evidenceSummary,
      evidenceTone,
      summary:
        "Evidence integrity or finding-to-evidence reference checks failed. Do not treat the referenced locations as validated.",
      distinctionNote:
        "Invalid evidence indicates a broken or inconsistent verification artifact independent of whether the underlying Rust code is vulnerable.",
    };
  }

  if (report.overallAnalysisStatus === "inconclusive") {
    return {
      headline: "Inconclusive or incomplete",
      tone: "amber",
      evidenceSummary,
      evidenceTone,
      summary: report.interpretation,
      distinctionNote:
        "Inconclusive means syntax errors, missing method bodies, or manual direct guards prevented full assessment; it is never a pass.",
    };
  }

  if (report.overallAnalysisStatus === "finding") {
    return {
      headline: "Finding detected",
      tone: "amber",
      evidenceSummary,
      evidenceTone,
      summary:
        "The deterministic rule emitted an informational candidate. Validate its context manually before acting.",
      distinctionNote:
        "A validated evidence record proves the excerpt matches the snapshot's exact physical lines; it does not prove exploitability or missing indirect guards.",
    };
  }

  return {
    headline: "No findings within implemented rule scope",
    tone: "slate",
    evidenceSummary,
    evidenceTone,
    summary:
      "The implemented AST rule emitted zero candidates on this snapshot. This is not proof of contract safety or a general audit.",
    distinctionNote:
      "Passing NEAR-RUST-CALLBACK-PRIVATE-001 checks only #[callback_result] handlers missing #[private]; all unimplemented vulnerability classes remain unchecked.",
  };
}

export function buildVerificationLedger(
  review: ReviewResponse,
): VerificationLedgerEntry[] {
  const { report, totalBytes } = review;
  const evidenceList = report.evidenceIntegration.evidence;
  const firstFindingLoc = report.findings[0]?.locations[0];
  const fileNames = report.snapshot.files.map((f) => f.path).join(", ");
  const hasSnapshotHashes =
    report.snapshot.sourceHash.length > 0 &&
    report.snapshot.fileManifestHash.length > 0;
  const schemaRefAssessment = assessSchemaAndReferences(review);

  const ruleStatus: PipelineStageStatus =
    report.deterministicRule.status === "finding"
      ? "Finding detected"
      : report.deterministicRule.status === "inconclusive"
        ? "Inconclusive"
        : "Completed";

  const entries: VerificationLedgerEntry[] = [
    {
      id: "ledger-snapshot-hash",
      checkName: "Snapshot Canonicalization & SHA-256 Manifest",
      whatWasChecked:
        "Relative POSIX .rs paths, UTF-8 reversibility, physical line counts, byte lengths, fileManifestHash, and sourceHash generated during snapshot creation.",
      result: hasSnapshotHashes ? "Completed" : "Unavailable",
      resultDetail: hasSnapshotHashes
        ? `${report.snapshot.fileCount} file(s), ${totalBytes} B hashed deterministically during snapshot creation.`
        : "Snapshot manifest hashes were unavailable.",
      reference: `sourceHash ${report.snapshot.sourceHash.slice(0, 16)}…`,
      limitations:
        "Establishes initial snapshot byte identity and hash generation; independent recomputation is reported separately by validateEvidence entries below.",
    },
    {
      id: "ledger-ast-rule",
      checkName: report.deterministicRule.id,
      whatWasChecked:
        "Syntactic @lezer/rust AST scan for #[callback_result] methods inside #[near] / #[near_bindgen] impl blocks lacking #[private] or the direct fail-closed manual guard.",
      result: ruleStatus,
      resultDetail:
        report.deterministicRule.status === "finding"
          ? `${report.deterministicRule.findingCount} candidate(s) emitted.`
          : report.deterministicRule.status === "inconclusive"
            ? "Inconclusive due to parse errors, missing body, or unverified manual guard."
            : "0 candidates emitted within rule scope.",
      reference: firstFindingLoc
        ? `${firstFindingLoc.path}:${firstFindingLoc.startLine}-${firstFindingLoc.endLine}`
        : `Files: ${fileNames}`,
      ...(firstFindingLoc
        ? {
            targetLocation: {
              path: firstFindingLoc.path,
              startLine: firstFindingLoc.startLine,
              endLine: firstFindingLoc.endLine,
              evidenceId: firstFindingLoc.evidenceId,
            },
          }
        : {}),
      limitations:
        "Narrow syntactic check only; does not expand macros, analyze cross-function helper/alias guards, prove exploitability, or cover other NEAR bug classes.",
    },
  ];

  if (hasNoEmittedEvidence(review)) {
    entries.push({
      id: "ledger-evidence-none",
      checkName: "Evidence Schema, Reference & Excerpt-Hash Validation",
      whatWasChecked:
        "Schema validity, unique finding-to-evidence reference resolution, physical line bounds, and domain-separated excerpt SHA-256 recomputation.",
      result: "Not executed",
      resultDetail:
        "0 evidence records emitted because the deterministic rule emitted 0 candidates.",
      reference: "No evidence records",
      limitations:
        "Not executing evidence validation reflects zero emitted findings, not proof of contract security.",
    });
  } else {
    entries.push({
      id: "ledger-evidence-integration",
      checkName: "Evidence Schema & Reference Resolution",
      whatWasChecked:
        "EvidenceSchema validation, canonical evidence path/file existence, duplicate evidenceId detection, and unique finding-to-evidence reference binding.",
      result: schemaRefAssessment.status,
      resultDetail: schemaRefAssessment.detail,
      reference: schemaRefAssessment.reference,
      limitations:
        "Confirms structural consistency between findings and evidence records; independent snapshot integrity and excerpt hashing are tracked separately below.",
    });

    for (const record of evidenceList) {
      const subChecks = VALIDATION_CHECK_LABELS.map(({ key, label }) => ({
        name: label,
        status: record.checks[key],
      }));
      const passedCount = subChecks.filter((c) => c.status === "passed").length;
      const applicableCount = subChecks.filter(
        (c) => c.status !== "not_applicable",
      ).length;

      let recordResult: PipelineStageStatus;
      if (record.computedValidationStatus === "validated") {
        recordResult = "Completed";
      } else if (record.computedValidationStatus === "invalid") {
        recordResult = "Failed";
      } else if (record.computedValidationStatus === "unavailable") {
        recordResult = "Unavailable";
      } else {
        recordResult = "Inconclusive";
      }

      entries.push({
        id: `ledger-ev-${record.evidenceId}`,
        checkName: `Independent Excerpt & Integrity Check (${record.evidenceId.slice(0, 14)}…)`,
        whatWasChecked:
          "Independent recomputation of manifest hashes, target path resolution, physical line range, and excerpt SHA-256 against the immutable snapshot.",
        result: recordResult,
        resultDetail: `${passedCount}/${applicableCount} applicable checks passed (computed status: ${record.computedValidationStatus}).`,
        reference: `${record.path}:${record.startLine}-${record.endLine}`,
        ...(record.path && record.startLine >= 1 && record.endLine >= record.startLine
          ? {
              targetLocation: {
                path: record.path,
                startLine: record.startLine,
                endLine: record.endLine,
                evidenceId: record.evidenceId,
              },
            }
          : {}),
        limitations:
          "Cryptographic correspondence only: proves lines in the snapshot match excerptHash, NOT that the code is exploitable or safe.",
        subChecks,
      });
    }
  }

  return entries;
}

export function buildEvidenceChainLinks(
  review: ReviewResponse,
): EvidenceChainLink[] {
  const { report } = review;
  const byId = new Map(
    report.evidenceIntegration.evidence.map((entry) => [entry.evidenceId, entry]),
  );
  const links: EvidenceChainLink[] = [];

  for (const finding of report.findings) {
    for (const loc of finding.locations) {
      const ev = byId.get(loc.evidenceId);
      const checkValues = ev ? Object.values(ev.checks) : [];
      const passedChecks = checkValues.filter((v) => v === "passed").length;
      const totalApplicableChecks = checkValues.filter(
        (v) => v !== "not_applicable",
      ).length;

      links.push({
        findingId: finding.findingId,
        ruleId: report.deterministicRule.id,
        evidenceId: loc.evidenceId,
        path: loc.path,
        startLine: loc.startLine,
        endLine: loc.endLine,
        referenceStatus: loc.referenceStatus,
        excerptHash: ev?.excerptHash,
        computedValidationStatus: loc.computedValidationStatus,
        passedChecks,
        totalApplicableChecks,
      });
    }
  }

  return links;
}
