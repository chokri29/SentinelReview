export type FixtureName = "triggering" | "safe";
export type SourceKind = "fixture" | "custom";

export interface SnapshotFileRecord {
  path: string;
  content: string;
  byteLength: number;
  lineCount: number;
}

export interface EvidenceLocation {
  path: string;
  startLine: number;
  endLine: number;
  referenceStatus: "resolved" | "missing" | "ambiguous";
  evidenceId: string;
  declaredValidationStatus: "validated" | "partial" | "unavailable" | "invalid" | "not_available";
  computedValidationStatus: "validated" | "partial" | "unavailable" | "invalid" | "not_available";
  presentedAsValidated: boolean;
}

export interface DeterministicFinding {
  findingId: string;
  origin: string;
  severity: string;
  title: string;
  rationale: string;
  locations: EvidenceLocation[];
  limitations: string[];
}

export type EvidenceValidationCheckStatus =
  | "passed"
  | "failed"
  | "not_applicable";

export interface EvidenceValidationChecks {
  evidence: EvidenceValidationCheckStatus;
  snapshot: EvidenceValidationCheckStatus;
  manifestSchema: EvidenceValidationCheckStatus;
  manifestPaths: EvidenceValidationCheckStatus;
  manifestOrdering: EvidenceValidationCheckStatus;
  snapshotFiles: EvidenceValidationCheckStatus;
  fileIntegrity: EvidenceValidationCheckStatus;
  manifestHashes: EvidenceValidationCheckStatus;
  sourceHash: EvidenceValidationCheckStatus;
  evidencePath: EvidenceValidationCheckStatus;
  fileReference: EvidenceValidationCheckStatus;
  lineRange: EvidenceValidationCheckStatus;
  excerptHash: EvidenceValidationCheckStatus;
}

export interface SnapshotManifestFileRecord {
  path: string;
  sha256: string;
  byteLength: number;
  lineCount: number;
}

export interface EvidenceRecord {
  evidenceId: string;
  path: string;
  startLine: number;
  endLine: number;
  sourceHash: string;
  excerptHash?: string;
  declaredValidationStatus: string;
  computedValidationStatus: string;
  presentedAsValidated: boolean;
  checks: EvidenceValidationChecks;
  issues: string[];
}

export interface DeterministicReport {
  snapshot: {
    sourceHash: string;
    fileManifestHash: string;
    fileCount: number;
    files: SnapshotManifestFileRecord[];
  };
  deterministicRule: {
    id: "NEAR-RUST-CALLBACK-PRIVATE-001";
    status: "finding" | "passed" | "inconclusive";
    findingCount: number;
    toolchain: string[];
    limitations: string[];
  };
  evidenceIntegration: {
    status: "complete" | "partial" | "invalid";
    evidence: EvidenceRecord[];
    issues: {
      code: string;
      evidenceId: string;
      findingId?: string;
      message: string;
    }[];
  };
  findings: DeterministicFinding[];
  overallAnalysisStatus: "finding" | "no_findings" | "inconclusive";
  interpretation: string;
}

export interface ReviewResponse {
  sourceKind: SourceKind;
  fixture?: FixtureName;
  execution: {
    mode: string;
    aiInference: string;
    sourceTransmission: string;
  };
  snapshotFiles: SnapshotFileRecord[];
  totalBytes: number;
  report: DeterministicReport;
  sourceExcerpts: Record<string, { startLine: number; content: string }>;
  consentToken: string;
  consentTokenExpiresAt: string;
  aiConfig: {
    modelId: string;
    apiKeyConfigured: boolean;
    approvedMeasurementsConfigured: boolean;
    maxSourceContextBytes: number;
    maxPromptBytes: number;
  };
}

export interface AiAnalysisResponse {
  sourceKind: SourceKind;
  fixture?: FixtureName;
  snapshotHash: string;
  modelId: string;
  approvedMeasurementsConfigured: boolean;
  apiKeyConfigured: boolean;
  independentNearApproval: string;
  execution: {
    mode: string;
    aiInference: string;
    sourceTransmission: "none" | "sent";
  };
  aiAnalysis: {
    status: "complete" | "partial" | "failed" | "not_run";
    coverage: "complete" | "incomplete" | "not_run";
    responseVerification: string;
    findings: {
      findingId: string;
      origin: string;
      severity: string;
      title: string;
      rationale: string;
      evidenceRefs: { evidenceId: string }[];
      limitations: string[];
    }[];
    evidence: {
      evidenceId: string;
      sourceHash: string;
      path: string;
      startLine: number;
      endLine: number;
      validationStatus: string;
    }[];
    evidenceExcerpts: {
      evidenceId: string;
      path: string;
      startLine: number;
      endLine: number;
      excerpt: string;
    }[];
    limitations: string[];
    provenance: {
      sdkVersion: string;
      modelId: string;
      responseId?: string;
      gatewayVerification: string;
      modelAttestationVerification: string;
      responseVerification: string;
      responseSignatureKind?: string;
      gatewayTcbStatus?: string;
      gatewayDeploymentProvenance?: string;
      modelTcbStatuses?: string[];
      modelDeploymentProvenances?: string[];
      privateModelPolicy: string;
    };
  };
}

export interface ActiveHighlight {
  path: string;
  startLine: number;
  endLine: number;
  evidenceId: string;
}
