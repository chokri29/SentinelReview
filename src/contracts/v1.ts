import { z } from "zod";

export const schemaVersion = "1.0.0" as const;

export const JobStatusSchema = z.enum([
  "queued",
  "validating",
  "deterministic_checks",
  "ai_analysis",
  "report_build",
  "complete",
  "failed",
]);

export const CheckStatusSchema = z.enum([
  "finding",
  "passed",
  "inconclusive",
  "not_run",
  "error",
]);

export const SeveritySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
  "info",
  "unknown",
]);

export const FindingOriginSchema = z.enum([
  "deterministic_rule",
  "dependency_tool",
  "ai_hypothesis",
  "human_review",
]);

export const EvidenceValidationSchema = z.enum([
  "validated",
  "partial",
  "unavailable",
  "invalid",
]);

export const VerificationStatusSchema = z.enum([
  "verified",
  "failed",
  "unavailable",
  "not_run",
  "not_required",
]);

export const AiStatusSchema = z.enum([
  "complete",
  "partial",
  "failed",
  "not_run",
]);

export const EvidenceRefSchema = z.object({
  evidenceId: z.string().min(1).max(128),
});

export const EvidenceSchema = z.object({
  evidenceId: z.string().min(1).max(128),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/i),
  path: z.string().min(1).max(1024),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  excerptHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  producer: z.enum(["deterministic_rule", "dependency_tool", "ai_hypothesis"]),
  validationStatus: EvidenceValidationSchema,
}).refine((evidence) => evidence.endLine >= evidence.startLine, {
  message: "endLine must be greater than or equal to startLine",
  path: ["endLine"],
});

export const FindingSchema = z.object({
  findingId: z.string().min(1).max(128),
  origin: FindingOriginSchema,
  ruleId: z.string().min(1).max(128).optional(),
  severity: SeveritySchema,
  title: z.string().min(1).max(300),
  rationale: z.string().min(1).max(8000),
  evidenceRefs: z.array(EvidenceRefSchema).max(100),
  limitations: z.array(z.string().max(2000)).max(50),
});

export const SourceManifestSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  files: z.array(z.object({
    path: z.string().min(1).max(1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    byteLength: z.number().int().nonnegative(),
    lineCount: z.number().int().nonnegative(),
  })).max(1000),
  fileManifestHash: z.string().regex(/^[a-f0-9]{64}$/i),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const AnalysisResultSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  deterministicAnalysis: z.object({
    status: CheckStatusSchema,
    toolchain: z.array(z.string().min(1).max(300)),
    findings: z.array(FindingSchema).max(1000),
  }),
  aiAnalysis: z.object({
    status: AiStatusSchema,
    responseVerification: VerificationStatusSchema,
    findings: z.array(FindingSchema).max(1000),
    limitations: z.array(z.string().max(2000)).max(100),
  }),
});

export const ReviewReportSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  reportId: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
  source: SourceManifestSchema,
  policyHash: z.string().regex(/^[a-f0-9]{64}$/i),
  analysis: AnalysisResultSchema,
  evidence: z.array(EvidenceSchema).max(5000),
  reportIntegrity: VerificationStatusSchema,
  limitations: z.array(z.string().max(2000)).max(100),
});

export type JobStatus = z.infer<typeof JobStatusSchema>;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type FindingOrigin = z.infer<typeof FindingOriginSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type SourceManifest = z.infer<typeof SourceManifestSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
