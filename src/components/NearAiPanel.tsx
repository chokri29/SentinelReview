import { AlertTriangle, Lock, RefreshCw, Send, ShieldAlert } from "lucide-react";
import type {
  AiAnalysisResponse,
  MetaAnalysisResponse,
  ReviewResponse,
} from "../types/review.ts";

interface NearAiPanelProps {
  review: ReviewResponse | null;
  consentChecked: boolean;
  onConsentChange: (checked: boolean) => void;
  tokenConsumed: boolean;
  aiLoading: boolean;
  aiError: string | null;
  aiResponse: AiAnalysisResponse | null;
  onRunAiAnalysis: () => Promise<void>;
  metaConsentChecked: boolean;
  onMetaConsentChange: (checked: boolean) => void;
  metaTokenConsumed: boolean;
  metaLoading: boolean;
  metaError: string | null;
  metaResponse: MetaAnalysisResponse | null;
  onRunMetaAnalysis: () => Promise<void>;
  onRefreshReviewForToken: () => Promise<void>;
}

function verificationTone(status: string): string {
  switch (status) {
    case "verified":
    case "passed":
    case "complete":
    case "completed":
    case "configured":
      return "text-emerald-400";
    case "partial":
    case "not_run":
    case "incomplete":
    case "attempted":
    case "not_applicable":
    case "not_verified":
      return "text-amber-400";
    case "failed":
    case "rejected":
    case "unavailable":
      return "text-rose-400";
    default:
      return "text-slate-300";
  }
}

export function NearAiPanel({
  review,
  consentChecked,
  onConsentChange,
  tokenConsumed,
  aiLoading,
  aiError,
  aiResponse,
  onRunAiAnalysis,
  metaConsentChecked,
  onMetaConsentChange,
  metaTokenConsumed,
  metaLoading,
  metaError,
  metaResponse,
  onRunMetaAnalysis,
  onRefreshReviewForToken,
}: NearAiPanelProps) {
  if (!review) return null;

  const {
    report,
    snapshotFiles,
    aiConfig,
    metaConfig,
    consentToken,
    consentTokenExpiresAt,
  } = review;
  const matchingAiResponse =
    aiResponse && aiResponse.snapshotHash === report.snapshot.sourceHash
      ? aiResponse
      : null;
  const matchingMetaResponse =
    metaResponse && metaResponse.snapshotHash === report.snapshot.sourceHash
      ? metaResponse
      : null;
  const canRun =
    consentChecked && !aiLoading && !tokenConsumed && Boolean(consentToken);

  const metaStatus: "configured" | "unavailable" | "failed" | "completed" =
    matchingMetaResponse
      ? matchingMetaResponse.metaAnalysis.status
      : metaError
        ? "failed"
        : metaConfig?.apiKeyConfigured
          ? "configured"
          : "unavailable";
  const isFixtureMode = review.sourceKind === "fixture" && Boolean(metaConfig?.fixtureAllowed);
  const canRunMeta =
    isFixtureMode &&
    Boolean(metaConfig?.apiKeyConfigured) &&
    metaConsentChecked &&
    !metaLoading &&
    !metaTokenConsumed &&
    Boolean(metaConfig?.consentToken);

  return (
    <section
      id="near-ai"
      className="rounded-xl border border-slate-800 bg-[#111A2E]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div>
          <h2 className="font-display text-base font-semibold text-slate-100">
            Optional NEAR AI hypothesis path
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Strictly separated from deterministic verification · Requires explicit outbound consent to NEAR AI
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-slate-300">
          <Lock className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
          {aiConfig.modelId}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-6 p-5 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-5">
          <div className="space-y-2 rounded-lg border border-slate-800 bg-[#0B1120] p-4 text-xs leading-relaxed text-slate-300">
            <p className="font-semibold text-slate-100">Execution & trust boundary</p>
            <p className="text-slate-400">
              1. <span className="text-slate-200">AI Studio backend</span>: Deterministic AST checks and SHA-256 evidence verification run on the hosted AI Studio backend without contacting any AI provider.
            </p>
            <p className="text-slate-400">
              2. <span className="text-slate-200">Optional NEAR AI transmission</span>: Authorizing this action transmits the full displayed snapshot from the AI Studio backend to the NEAR AI provider (where the model processes the source to propose hypotheses) only if API credentials, operator-approved deployment measurements, and TCB checks pass.
            </p>
            <p className="text-slate-400">
              3. <span className="text-slate-200">Verification limits</span>: Cryptographic hashes and TEE attestation verify snapshot integrity and deployment identity; they do not imply source code is uninspected by the remote provider or replace human review.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 rounded-lg border border-slate-800 bg-[#0B1120] p-4 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-400">NEARAI_API_KEY</span>
              <span
                className={`font-medium ${
                  aiConfig.apiKeyConfigured ? "text-emerald-400" : "text-amber-400"
                }`}
              >
                {aiConfig.apiKeyConfigured ? "Configured" : "Not configured"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-400">Approved TEE measurements</span>
              <span
                className={`font-medium ${
                  aiConfig.approvedMeasurementsConfigured
                    ? "text-emerald-400"
                    : "text-amber-400"
                }`}
              >
                {aiConfig.approvedMeasurementsConfigured
                  ? "Configured"
                  : "Not configured"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-400">Single-use consent token (2m TTL)</span>
              <span className="font-mono tabular-nums text-slate-300">
                {tokenConsumed
                  ? "Consumed"
                  : `Expires ${new Date(consentTokenExpiresAt).toLocaleTimeString()}`}
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-[#0B1120] p-4 text-xs">
            <div className="font-medium text-slate-300">
              Payload scope if authorized
            </div>
            <div className="mt-2 font-mono text-slate-400">
              Snapshot: {report.snapshot.sourceHash.slice(0, 24)}…
            </div>
            <ul className="mt-2 space-y-1 font-mono text-slate-300">
              {snapshotFiles.map((file) => (
                <li key={file.path}>
                  {file.path} ({file.lineCount} lines · {file.byteLength} B)
                </li>
              ))}
            </ul>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-800 bg-[#0B1120] p-4 text-xs leading-relaxed text-slate-200">
            <input
              type="checkbox"
              checked={consentChecked}
              disabled={tokenConsumed}
              onChange={(event) => onConsentChange(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-900 text-teal-500 focus:ring-teal-500 disabled:opacity-50"
            />
            <span>
              I explicitly authorize transmitting the displayed Rust source snapshot and deterministic findings from the AI Studio backend to{" "}
              <span className="font-mono text-teal-300">{aiConfig.modelId}</span>{" "}
              for hypothesis-only review.
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!canRun}
              onClick={() => void onRunAiAnalysis()}
              className="inline-flex w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-teal-600 px-4 py-2.5 text-xs font-semibold text-white transition-colors duration-150 hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-45 sm:w-auto"
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {aiLoading ? "Verifying attestation & running..." : "Run NEAR AI Hypothesis"}
              </span>
            </button>

            {tokenConsumed && (
              <button
                type="button"
                onClick={() => void onRefreshReviewForToken()}
                className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border border-slate-700 bg-[#0B1120] px-3.5 py-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-800"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Refresh review for new token</span>
              </button>
            )}
          </div>
        </div>

        <div className="lg:col-span-7">
          {aiError && (
            <div
              role="alert"
              className="rounded-lg border border-rose-800/70 bg-rose-950/30 p-4 text-xs leading-relaxed text-rose-200"
            >
              {aiError}
            </div>
          )}

          {!matchingAiResponse && !aiError && !aiLoading && (
            <div className="flex h-full min-h-[240px] flex-col items-center justify-center rounded-lg border border-slate-800 bg-[#0B1120] px-6 py-10 text-center">
              <p className="text-sm font-medium text-slate-200">
                No source transmitted to NEAR AI
              </p>
              <p className="mt-2 max-w-md text-xs leading-relaxed text-slate-400">
                Deterministic analysis runs on the AI Studio backend without external AI calls. Check the authorization box and submit to invoke the gated NEAR AI adapter with single-use consent-token verification.
              </p>
            </div>
          )}

          {aiLoading && (
            <div className="space-y-3 rounded-lg border border-slate-800 bg-[#0B1120] p-5">
              <div className="h-4 w-48 animate-pulse rounded bg-slate-800" />
              <div className="h-20 w-full animate-pulse rounded bg-slate-800/70" />
              <div className="h-20 w-full animate-pulse rounded bg-slate-800/70" />
            </div>
          )}

          {matchingAiResponse && !aiLoading && (
            <div className="space-y-4 rounded-lg border border-slate-800 bg-[#0B1120] p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3 text-xs">
                <span className="font-semibold text-slate-100">
                  AI hypothesis result ({matchingAiResponse.aiAnalysis.status})
                </span>
                <div className="flex flex-wrap items-center gap-2 text-slate-400">
                  <span>
                    Transmission:{" "}
                    <span
                      title={
                        matchingAiResponse.execution.sourceTransmission === "attempted"
                          ? "A source-bearing request was attempted at the SDK call boundary; network delivery is unverified."
                          : "No source-bearing inference request was attempted."
                      }
                      className={`font-mono ${verificationTone(
                        matchingAiResponse.execution.sourceTransmission,
                      )}`}
                    >
                      {matchingAiResponse.execution.sourceTransmission}
                    </span>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Coverage:{" "}
                    <span
                      className={`font-mono ${verificationTone(
                        matchingAiResponse.aiAnalysis.coverage,
                      )}`}
                    >
                      {matchingAiResponse.aiAnalysis.coverage}
                    </span>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Policy:{" "}
                    <span
                      className={`font-mono ${verificationTone(
                        matchingAiResponse.aiAnalysis.provenance.privateModelPolicy,
                      )}`}
                    >
                      {matchingAiResponse.aiAnalysis.provenance.privateModelPolicy}
                    </span>
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2.5 text-xs sm:grid-cols-3">
                <div>
                  <span className="text-slate-400">Gateway verification</span>
                  <div
                    className={`mt-0.5 font-mono ${verificationTone(
                      matchingAiResponse.aiAnalysis.provenance.gatewayVerification,
                    )}`}
                  >
                    {matchingAiResponse.aiAnalysis.provenance.gatewayVerification}
                  </div>
                </div>
                <div>
                  <span className="text-slate-400">Model attestation</span>
                  <div
                    className={`mt-0.5 font-mono ${verificationTone(
                      matchingAiResponse.aiAnalysis.provenance.modelAttestationVerification,
                    )}`}
                  >
                    {matchingAiResponse.aiAnalysis.provenance.modelAttestationVerification}
                  </div>
                </div>
                <div>
                  <span className="text-slate-400">Response signature</span>
                  <div
                    className={`mt-0.5 font-mono ${verificationTone(
                      matchingAiResponse.aiAnalysis.provenance.responseVerification,
                    )}`}
                  >
                    {matchingAiResponse.aiAnalysis.provenance.responseVerification}
                  </div>
                </div>
              </div>

              {(matchingAiResponse.aiAnalysis.limitations.length > 0 ||
                matchingAiResponse.aiAnalysis.errorCode) && (
                <div className="rounded-lg border border-slate-800 bg-[#111A2E] p-3.5 text-xs text-slate-300">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-100">
                      Limitations & status notes
                    </span>
                    {matchingAiResponse.aiAnalysis.errorCode && (
                      <span className="font-mono text-xs text-rose-400">
                        code: {matchingAiResponse.aiAnalysis.errorCode}
                      </span>
                    )}
                  </div>
                  {matchingAiResponse.aiAnalysis.errorCode ===
                    "model_attestation_required" && (
                    <p className="mt-1.5 text-rose-300">
                      Classification: model attestation required — the provider did not advertise or supply model TEE attestation (distinct from a measurement mismatch).
                    </p>
                  )}
                  {matchingAiResponse.aiAnalysis.limitations.length > 0 && (
                    <ul className="mt-1.5 space-y-1 text-slate-400">
                      {matchingAiResponse.aiAnalysis.limitations.map(
                        (item, index) => (
                          <li key={index}>{item}</li>
                        ),
                      )}
                    </ul>
                  )}
                </div>
              )}

              {matchingAiResponse.aiAnalysis.findings.length > 0 && (
                <div className="space-y-3">
                  <div className="text-xs font-medium text-slate-300">
                    AI-proposed hypotheses (unverified)
                  </div>
                  {matchingAiResponse.aiAnalysis.findings.map((finding) => {
                    const excerpt = matchingAiResponse.aiAnalysis.evidenceExcerpts.find(
                      (item) =>
                        finding.evidenceRefs.some(
                          (ref) => ref.evidenceId === item.evidenceId,
                        ),
                    );
                    return (
                      <article
                        key={finding.findingId}
                        className="rounded-lg border border-slate-800 bg-[#111A2E] p-4"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <h4 className="font-display text-sm font-semibold text-slate-100">
                            {finding.title}
                          </h4>
                          <span className="font-mono text-xs capitalize text-amber-400">
                            {finding.severity} · {finding.origin}
                          </span>
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-slate-300">
                          {finding.rationale}
                        </p>
                        {excerpt && (
                          <pre className="mt-2.5 overflow-x-auto rounded border border-slate-800 bg-[#0B1120] p-2.5 font-mono text-xs text-slate-200">
                            {excerpt.path}:{excerpt.startLine}-{excerpt.endLine}
                            {"\n"}
                            {excerpt.excerpt}
                          </pre>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Separate Meta Model API optional provider section */}
      <div className="border-t border-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
          <div>
            <h3 className="font-display text-base font-semibold text-slate-100">
              Optional Meta Model API hypothesis path
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              Separate non-TEE standard model · Public/synthetic fixtures only · Isolated from NEAR AI and deterministic findings
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
            <span className="text-slate-300">
              Provider: {metaConfig?.provider ?? "Meta Model API"}
            </span>
            <span className="text-slate-500" aria-hidden="true">·</span>
            <span className="text-slate-300">
              Model: {metaConfig?.modelId ?? "muse-spark-1.3"}
            </span>
            <span className="text-slate-500" aria-hidden="true">·</span>
            <span className="text-slate-400">
              Status:{" "}
              <span className={verificationTone(metaStatus)}>{metaStatus}</span>
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 p-5 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-5">
            <div className="rounded-lg border border-amber-800/70 bg-amber-950/25 p-4 text-xs leading-relaxed text-amber-200">
              <div className="flex items-start gap-2.5">
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-400"
                  aria-hidden="true"
                />
                <div className="space-y-1.5">
                  <p className="font-semibold text-amber-100">
                    Free-credit data-use warning (Meta Model API)
                  </p>
                  <p>
                    {metaConfig?.freeCreditWarning ??
                      "Meta's dashboard warns that content submitted while using free credits may be used for product improvement. Standard models (muse-spark-1.3) do not automatically exempt free-credit submissions."}
                  </p>
                  <p className="text-amber-300/90">
                    Only public or synthetic Rust fixtures may be sent. Uploaded or custom Rust code is rejected on the server.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 rounded-lg border border-slate-800 bg-[#0B1120] p-4 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">Provider</span>
                <span className="font-mono text-slate-200">
                  {metaConfig?.provider ?? "Meta Model API"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">Model (Standard)</span>
                <span className="font-mono text-slate-200">
                  {metaConfig?.modelId ?? "muse-spark-1.3"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">Status</span>
                <span className={`font-mono font-medium ${verificationTone(metaStatus)}`}>
                  {metaStatus}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">META_MODEL_API_KEY</span>
                <span
                  className={`font-medium ${
                    metaConfig?.apiKeyConfigured
                      ? "text-emerald-400"
                      : "text-amber-400"
                  }`}
                >
                  {metaConfig?.apiKeyConfigured ? "Configured" : "Not configured"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">TEE attestation / signature</span>
                <span className="font-mono text-amber-400">
                  Not applicable (non-TEE)
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">Separate Meta consent token</span>
                <span className="font-mono tabular-nums text-slate-300">
                  {!isFixtureMode
                    ? "Blocked for custom/private source"
                    : metaTokenConsumed
                      ? "Consumed"
                      : metaConfig?.consentTokenExpiresAt
                        ? `Expires ${new Date(metaConfig.consentTokenExpiresAt).toLocaleTimeString()}`
                        : "Unavailable"}
                </span>
              </div>
            </div>

            {!isFixtureMode ? (
              <div className="flex items-start gap-2.5 rounded-lg border border-rose-800/70 bg-rose-950/30 p-4 text-xs leading-relaxed text-rose-200">
                <ShieldAlert
                  className="mt-0.5 h-4 w-4 shrink-0 text-rose-400"
                  aria-hidden="true"
                />
                <span>
                  Meta Model API is disabled for custom or private Rust uploads. Only public/synthetic demo fixtures are eligible, enforced on the server.
                </span>
              </div>
            ) : (
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-800 bg-[#0B1120] p-4 text-xs leading-relaxed text-slate-200">
                <input
                  type="checkbox"
                  checked={metaConsentChecked}
                  disabled={metaTokenConsumed || !metaConfig?.apiKeyConfigured}
                  onChange={(event) => onMetaConsentChange(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500 disabled:opacity-50"
                />
                <span>
                  I acknowledge the Meta free-credit data-use warning and separately authorize transmitting this public/synthetic fixture snapshot to{" "}
                  <span className="font-mono text-sky-300">
                    Meta Model API ({metaConfig?.modelId ?? "muse-spark-1.3"})
                  </span>{" "}
                  for unverified, non-TEE hypothesis review.
                </span>
              </label>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={!canRunMeta}
                onClick={() => void onRunMetaAnalysis()}
                className="inline-flex w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-sky-600 px-4 py-2.5 text-xs font-semibold text-white transition-colors duration-150 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-45 sm:w-auto"
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {metaLoading
                    ? "Running Meta Model API..."
                    : "Run Meta Model Hypothesis"}
                </span>
              </button>

              {metaTokenConsumed && (
                <button
                  type="button"
                  onClick={() => void onRefreshReviewForToken()}
                  className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border border-slate-700 bg-[#0B1120] px-3.5 py-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-800"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Refresh review for new token</span>
                </button>
              )}
            </div>
          </div>

          <div className="lg:col-span-7">
            {metaError && (
              <div
                role="alert"
                className="rounded-lg border border-rose-800/70 bg-rose-950/30 p-4 text-xs leading-relaxed text-rose-200"
              >
                {metaError}
              </div>
            )}

            {!matchingMetaResponse && !metaError && !metaLoading && (
              <div className="flex h-full min-h-[220px] flex-col items-center justify-center rounded-lg border border-slate-800 bg-[#0B1120] px-6 py-10 text-center">
                <p className="text-sm font-medium text-slate-200">
                  No source transmitted to Meta Model API
                </p>
                <p className="mt-2 max-w-md text-xs leading-relaxed text-slate-400">
                  {metaConfig?.apiKeyConfigured
                    ? "Meta requests never run automatically. Select a public/synthetic fixture, check the separate Meta consent box, and initiate the request explicitly."
                    : "META_MODEL_API_KEY is not configured on the server (status: unavailable). Deterministic verification and NEAR AI remain unaffected."}
                </p>
              </div>
            )}

            {metaLoading && (
              <div className="space-y-3 rounded-lg border border-slate-800 bg-[#0B1120] p-5">
                <div className="h-4 w-48 animate-pulse rounded bg-slate-800" />
                <div className="h-20 w-full animate-pulse rounded bg-slate-800/70" />
                <div className="h-20 w-full animate-pulse rounded bg-slate-800/70" />
              </div>
            )}

            {matchingMetaResponse && !metaLoading && (
              <div className="space-y-4 rounded-lg border border-slate-800 bg-[#0B1120] p-5">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3 text-xs">
                  <span className="font-semibold text-slate-100">
                    {matchingMetaResponse.provider} ({matchingMetaResponse.modelId}) ·{" "}
                    <span className={verificationTone(matchingMetaResponse.metaAnalysis.status)}>
                      {matchingMetaResponse.metaAnalysis.status}
                    </span>
                  </span>
                  <div className="flex flex-wrap items-center gap-2 text-slate-400">
                    <span>
                      Transmission:{" "}
                      <span
                        title={
                          matchingMetaResponse.execution.sourceTransmission === "attempted"
                            ? "A fixture request was attempted to Meta Model API."
                            : "No source-bearing Meta request was attempted."
                        }
                        className={`font-mono ${verificationTone(
                          matchingMetaResponse.execution.sourceTransmission,
                        )}`}
                      >
                        {matchingMetaResponse.execution.sourceTransmission}
                      </span>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Coverage:{" "}
                      <span
                        className={`font-mono ${verificationTone(
                          matchingMetaResponse.metaAnalysis.coverage,
                        )}`}
                      >
                        {matchingMetaResponse.metaAnalysis.coverage}
                      </span>
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2.5 text-xs sm:grid-cols-3">
                  <div>
                    <span className="text-slate-400">TEE attestation</span>
                    <div className="mt-0.5 font-mono text-amber-400">
                      {matchingMetaResponse.metaAnalysis.provenance.teeAttestation}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-400">Cryptographic signature</span>
                    <div className="mt-0.5 font-mono text-amber-400">
                      {matchingMetaResponse.metaAnalysis.provenance.cryptographicVerification}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-400">Model</span>
                    <div className="mt-0.5 font-mono text-slate-200">
                      {matchingMetaResponse.metaAnalysis.modelId}
                    </div>
                  </div>
                </div>

                {(matchingMetaResponse.metaAnalysis.limitations.length > 0 ||
                  matchingMetaResponse.metaAnalysis.errorCode) && (
                  <div className="rounded-lg border border-slate-800 bg-[#111A2E] p-3.5 text-xs text-slate-300">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-slate-100">
                        Meta Model API limitations & notices
                      </span>
                      {matchingMetaResponse.metaAnalysis.errorCode && (
                        <span className="font-mono text-xs text-rose-400">
                          code: {matchingMetaResponse.metaAnalysis.errorCode}
                        </span>
                      )}
                    </div>
                    {matchingMetaResponse.metaAnalysis.limitations.length > 0 && (
                      <ul className="mt-1.5 space-y-1 text-slate-400">
                        {matchingMetaResponse.metaAnalysis.limitations.map(
                          (item, index) => (
                            <li key={index}>{item}</li>
                          ),
                        )}
                      </ul>
                    )}
                  </div>
                )}

                {matchingMetaResponse.metaAnalysis.hypotheses.length > 0 && (
                  <div className="space-y-3">
                    <div className="text-xs font-medium text-slate-300">
                      Meta Model API hypotheses (unverified · non-TEE · separate from deterministic findings)
                    </div>
                    {matchingMetaResponse.metaAnalysis.hypotheses.map((hypothesis) => (
                      <article
                        key={hypothesis.hypothesisId}
                        className="rounded-lg border border-slate-800 bg-[#111A2E] p-4"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <h4 className="font-display text-sm font-semibold text-slate-100">
                            {hypothesis.title}
                          </h4>
                          <span className="font-mono text-xs capitalize text-sky-400">
                            {hypothesis.severity} · {hypothesis.provider} ({hypothesis.modelId})
                          </span>
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-slate-300">
                          {hypothesis.rationale}
                        </p>
                        <pre className="mt-2.5 overflow-x-auto rounded border border-slate-800 bg-[#0B1120] p-2.5 font-mono text-xs text-slate-200">
                          {hypothesis.path}:{hypothesis.startLine}-{hypothesis.endLine}
                          {"\n"}
                          {hypothesis.excerpt}
                        </pre>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
