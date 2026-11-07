import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EvidenceSchema,
  EvidenceValidationSchema,
  SourceManifestSchema,
  type SourceManifest,
} from "../contracts/v1.js";
import type { SourceFile, SourceLoadResult } from "./load-source.js";
import { calculateManifestHashes } from "./manifest-hash.js";

export type EvidenceValidation = z.infer<typeof EvidenceValidationSchema>;

export type EvidenceValidationCheckStatus =
  | "passed"
  | "failed"
  | "not_applicable";

export type EvidenceValidationIssueCode =
  | "malformed_evidence"
  | "snapshot_unavailable"
  | "invalid_manifest"
  | "noncanonical_manifest_path"
  | "duplicate_manifest_path"
  | "unsorted_manifest_entries"
  | "invalid_snapshot_files"
  | "noncanonical_snapshot_path"
  | "duplicate_snapshot_path"
  | "snapshot_manifest_file_mismatch"
  | "invalid_snapshot_content"
  | "file_hash_mismatch"
  | "file_byte_length_mismatch"
  | "file_line_count_mismatch"
  | "manifest_file_hash_mismatch"
  | "manifest_source_hash_mismatch"
  | "source_hash_mismatch"
  | "invalid_evidence_path"
  | "evidence_file_not_found"
  | "evidence_file_ambiguous"
  | "line_range_out_of_bounds"
  | "excerpt_hash_mismatch";

export interface EvidenceValidationIssue {
  readonly code: EvidenceValidationIssueCode;
  readonly message: string;
}

export interface EvidenceValidationChecks {
  readonly evidence: EvidenceValidationCheckStatus;
  readonly snapshot: EvidenceValidationCheckStatus;
  readonly manifestSchema: EvidenceValidationCheckStatus;
  readonly manifestPaths: EvidenceValidationCheckStatus;
  readonly manifestOrdering: EvidenceValidationCheckStatus;
  readonly snapshotFiles: EvidenceValidationCheckStatus;
  readonly fileIntegrity: EvidenceValidationCheckStatus;
  readonly manifestHashes: EvidenceValidationCheckStatus;
  readonly sourceHash: EvidenceValidationCheckStatus;
  readonly evidencePath: EvidenceValidationCheckStatus;
  readonly fileReference: EvidenceValidationCheckStatus;
  readonly lineRange: EvidenceValidationCheckStatus;
  readonly excerptHash: EvidenceValidationCheckStatus;
}

export interface EvidenceValidationResult {
  readonly status: EvidenceValidation;
  readonly evidenceId?: string;
  readonly checks: Readonly<EvidenceValidationChecks>;
  readonly issues: readonly EvidenceValidationIssue[];
}

type MutableChecks = {
  -readonly [Key in keyof EvidenceValidationChecks]: EvidenceValidationCheckStatus;
};

const EXCERPT_HASH_DOMAIN = "SentinelReview:evidence-excerpt:v1\0";

function createChecks(): MutableChecks {
  return {
    evidence: "not_applicable",
    snapshot: "not_applicable",
    manifestSchema: "not_applicable",
    manifestPaths: "not_applicable",
    manifestOrdering: "not_applicable",
    snapshotFiles: "not_applicable",
    fileIntegrity: "not_applicable",
    manifestHashes: "not_applicable",
    sourceHash: "not_applicable",
    evidencePath: "not_applicable",
    fileReference: "not_applicable",
    lineRange: "not_applicable",
    excerptHash: "not_applicable",
  };
}

function createResult(
  status: EvidenceValidation,
  evidenceId: string | undefined,
  checks: MutableChecks,
  issues: readonly EvidenceValidationIssue[],
): EvidenceValidationResult {
  return Object.freeze({
    status,
    ...(evidenceId === undefined ? {} : { evidenceId }),
    checks: Object.freeze({ ...checks }),
    issues: Object.freeze(issues.map((issue) => Object.freeze({ ...issue }))),
  });
}

function addIssue(
  issues: EvidenceValidationIssue[],
  code: EvidenceValidationIssueCode,
  message: string,
): void {
  issues.push({ code, message });
}

function compareCanonicalPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-zA-Z]:/.test(value)
  ) {
    return false;
  }

  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function countPhysicalLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  const terminators = content.match(/\r\n|\r|\n/g)?.length ?? 0;
  const endsWithTerminator = content.endsWith("\n") || content.endsWith("\r");
  return terminators + (endsWithTerminator ? 0 : 1);
}

function getPhysicalLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const lines = content.split(/\r\n|\r|\n/);
  if (content.endsWith("\n") || content.endsWith("\r")) {
    lines.pop();
  }
  return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSourceFile(value: unknown): value is SourceFile {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.content === "string" &&
    Number.isSafeInteger(value.byteLength) &&
    Number.isSafeInteger(value.lineCount)
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashExcerpt(content: string, startLine: number, endLine: number): string {
  const excerpt = getPhysicalLines(content)
    .slice(startLine - 1, endLine)
    .join("\n");
  return createHash("sha256")
    .update(EXCERPT_HASH_DOMAIN, "utf8")
    .update(excerpt, "utf8")
    .digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function validateEvidence(
  input: unknown,
  snapshot: SourceLoadResult | undefined,
): EvidenceValidationResult {
  const checks = createChecks();
  const issues: EvidenceValidationIssue[] = [];
  const parsedEvidence = EvidenceSchema.safeParse(input);

  if (!parsedEvidence.success) {
    checks.evidence = "failed";
    addIssue(
      issues,
      "malformed_evidence",
      "Evidence does not match the evidence schema.",
    );
    return createResult("invalid", undefined, checks, issues);
  }

  checks.evidence = "passed";
  const evidence = parsedEvidence.data;

  if (snapshot === undefined) {
    checks.snapshot = "failed";
    addIssue(issues, "snapshot_unavailable", "The source snapshot is unavailable.");
    return createResult("unavailable", evidence.evidenceId, checks, issues);
  }

  checks.snapshot = "passed";
  const parsedManifest = SourceManifestSchema.safeParse(snapshot.manifest);

  if (!parsedManifest.success) {
    checks.manifestSchema = "failed";
    addIssue(
      issues,
      "invalid_manifest",
      "The snapshot manifest does not match the manifest schema.",
    );
    return createResult("invalid", evidence.evidenceId, checks, issues);
  }

  checks.manifestSchema = "passed";
  const manifest = parsedManifest.data;
  const manifestPaths = new Set<string>();
  let manifestPathsValid = true;
  let manifestOrderingValid = true;

  for (let index = 0; index < manifest.files.length; index += 1) {
    const entry = manifest.files[index]!;

    if (!isCanonicalPath(entry.path)) {
      manifestPathsValid = false;
      addIssue(
        issues,
        "noncanonical_manifest_path",
        "The manifest contains a noncanonical source path.",
      );
    }

    if (manifestPaths.has(entry.path)) {
      manifestOrderingValid = false;
      addIssue(
        issues,
        "duplicate_manifest_path",
        "The manifest contains a duplicate file path.",
      );
    } else {
      manifestPaths.add(entry.path);
    }

    const previous = manifest.files[index - 1];
    if (
      previous !== undefined &&
      compareCanonicalPaths(previous.path, entry.path) >= 0
    ) {
      manifestOrderingValid = false;
      if (previous.path !== entry.path) {
        addIssue(
          issues,
          "unsorted_manifest_entries",
          "Manifest file entries are not in canonical path order.",
        );
      }
    }
  }

  checks.manifestPaths = manifestPathsValid ? "passed" : "failed";
  checks.manifestOrdering = manifestOrderingValid ? "passed" : "failed";
  if (!manifestPathsValid || !manifestOrderingValid) {
    return createResult("invalid", evidence.evidenceId, checks, issues);
  }

  if (!Array.isArray(snapshot.files)) {
    checks.snapshotFiles = "failed";
    addIssue(
      issues,
      "invalid_snapshot_files",
      "The snapshot file list is invalid.",
    );
    return createResult("invalid", evidence.evidenceId, checks, issues);
  }

  const snapshotFiles: SourceFile[] = [];
  let snapshotFilesValid = true;
  for (const file of snapshot.files) {
    if (!isSourceFile(file)) {
      snapshotFilesValid = false;
      addIssue(
        issues,
        "invalid_snapshot_files",
        "The snapshot contains an invalid file record.",
      );
      continue;
    }

    if (!isCanonicalPath(file.path)) {
      snapshotFilesValid = false;
      addIssue(
        issues,
        "noncanonical_snapshot_path",
        "The snapshot contains a noncanonical file path.",
      );
    }
    snapshotFiles.push(file);
  }

  const snapshotFilesByPath = new Map<string, SourceFile>();
  for (const file of snapshotFiles) {
    if (snapshotFilesByPath.has(file.path)) {
      snapshotFilesValid = false;
      addIssue(
        issues,
        "duplicate_snapshot_path",
        "The snapshot contains a duplicate file path.",
      );
    } else {
      snapshotFilesByPath.set(file.path, file);
    }
  }

  if (
    snapshotFilesByPath.size !== manifest.files.length ||
    manifest.files.some((entry) => !snapshotFilesByPath.has(entry.path))
  ) {
    snapshotFilesValid = false;
    addIssue(
      issues,
      "snapshot_manifest_file_mismatch",
      "Snapshot files do not correspond exactly to manifest entries.",
    );
  }

  checks.snapshotFiles = snapshotFilesValid ? "passed" : "failed";
  if (!snapshotFilesValid) {
    return createResult("invalid", evidence.evidenceId, checks, issues);
  }

  let fileIntegrityValid = true;
  for (const entry of manifest.files) {
    const file = snapshotFilesByPath.get(entry.path)!;
    const bytes = Buffer.from(file.content, "utf8");
    const decodedContent = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);

    if (decodedContent !== file.content) {
      fileIntegrityValid = false;
      addIssue(
        issues,
        "invalid_snapshot_content",
        "Snapshot file content is not a reversible UTF-8 representation.",
      );
    }

    if (!hashesMatch(sha256(bytes), entry.sha256)) {
      fileIntegrityValid = false;
      addIssue(
        issues,
        "file_hash_mismatch",
        "Snapshot file content does not match its manifest SHA-256.",
      );
    }

    if (bytes.byteLength !== entry.byteLength || bytes.byteLength !== file.byteLength) {
      fileIntegrityValid = false;
      addIssue(
        issues,
        "file_byte_length_mismatch",
        "Snapshot file byte length does not match its content and manifest.",
      );
    }

    const physicalLineCount = countPhysicalLines(file.content);
    if (
      physicalLineCount !== entry.lineCount ||
      physicalLineCount !== file.lineCount
    ) {
      fileIntegrityValid = false;
      addIssue(
        issues,
        "file_line_count_mismatch",
        "Snapshot file physical line count does not match its content and manifest.",
      );
    }
  }

  checks.fileIntegrity = fileIntegrityValid ? "passed" : "failed";
  if (!fileIntegrityValid) {
    return createResult("invalid", evidence.evidenceId, checks, issues);
  }

  const calculatedHashes = calculateManifestHashes(
    manifest.schemaVersion,
    manifest.files,
  );
  let manifestHashesValid = true;

  if (!hashesMatch(calculatedHashes.fileManifestHash, manifest.fileManifestHash)) {
    manifestHashesValid = false;
    addIssue(
      issues,
      "manifest_file_hash_mismatch",
      "The manifest file-manifest hash is inconsistent with its entries.",
    );
  }

  if (!hashesMatch(calculatedHashes.sourceHash, manifest.sourceHash)) {
    manifestHashesValid = false;
    addIssue(
      issues,
      "manifest_source_hash_mismatch",
      "The manifest source hash is inconsistent with its schema version and file-manifest hash.",
    );
  }

  checks.manifestHashes = manifestHashesValid ? "passed" : "failed";
  if (!manifestHashesValid) {
    return createResult("invalid", evidence.evidenceId, checks, issues);
  }

  if (!hashesMatch(evidence.sourceHash, manifest.sourceHash)) {
    checks.sourceHash = "failed";
    addIssue(
      issues,
      "source_hash_mismatch",
      "Evidence source hash does not match the verified snapshot source hash.",
    );
    return createResult("invalid", evidence.evidenceId, checks, issues);
  }

  checks.sourceHash = "passed";

  if (!isCanonicalPath(evidence.path)) {
    checks.evidencePath = "failed";
    addIssue(
      issues,
      "invalid_evidence_path",
      "Evidence path is not a canonical relative POSIX path.",
    );
    return createResult("invalid", evidence.evidenceId, checks, issues);
  }

  checks.evidencePath = "passed";
  const matchingFiles = snapshotFiles.filter((file) => file.path === evidence.path);

  if (matchingFiles.length === 0) {
    checks.fileReference = "failed";
    addIssue(
      issues,
      "evidence_file_not_found",
      "Evidence path does not identify a file in the snapshot.",
    );
    return createResult("invalid", evidence.evidenceId, checks, issues);
  }

  if (matchingFiles.length !== 1) {
    checks.fileReference = "failed";
    addIssue(
      issues,
      "evidence_file_ambiguous",
      "Evidence path identifies more than one snapshot file.",
    );
    return createResult("invalid", evidence.evidenceId, checks, issues);
  }

  checks.fileReference = "passed";
  const file = matchingFiles[0]!;
  const physicalLineCount = countPhysicalLines(file.content);

  if (
    evidence.startLine > physicalLineCount ||
    evidence.endLine > physicalLineCount
  ) {
    checks.lineRange = "failed";
    addIssue(
      issues,
      "line_range_out_of_bounds",
      "Evidence line range is outside the physical lines in the snapshot file.",
    );
    return createResult("invalid", evidence.evidenceId, checks, issues);
  }

  checks.lineRange = "passed";
  if (evidence.excerptHash === undefined) {
    checks.excerptHash = "not_applicable";
    return createResult("partial", evidence.evidenceId, checks, issues);
  }

  const calculatedExcerptHash = hashExcerpt(
    file.content,
    evidence.startLine,
    evidence.endLine,
  );
  if (!hashesMatch(calculatedExcerptHash, evidence.excerptHash)) {
    checks.excerptHash = "failed";
    addIssue(
      issues,
      "excerpt_hash_mismatch",
      "Evidence excerpt hash does not match the selected snapshot lines.",
    );
    return createResult("invalid", evidence.evidenceId, checks, issues);
  }

  checks.excerptHash = "passed";
  return createResult("validated", evidence.evidenceId, checks, issues);
}
