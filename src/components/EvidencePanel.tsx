import { ArrowDown, ArrowUpRight } from "lucide-react";
import {
  buildEvidenceChainLinks,
  hasNoEmittedEvidence,
} from "../lib/verification-transparency.ts";
import type { ActiveHighlight, ReviewResponse } from "../types/review.ts";

interface EvidencePanelProps {
  review: ReviewResponse | null;
  activeHighlight?: ActiveHighlight | null;
  onSelectLocation: (highlight: ActiveHighlight) => void;
}

function computedColor(status: string): string {
  switch (status) {
    case "validated":
      return "text-emerald-400";
    case "partial":
      return "text-amber-400";
    case "invalid":
      return "text-rose-400";
    default:
      return "text-slate-400";
  }
}

export function EvidencePanel({
  review,
  activeHighlight,
  onSelectLocation,
}: EvidencePanelProps) {
  if (!review) return null;

  const { report, sourceKind, totalBytes } = review;
  const chainLinks = buildEvidenceChainLinks(review);
  const noEmittedEvidence = hasNoEmittedEvidence(review);

  const locationByEvidenceId = new Map<
    string,
    { path: string; startLine: number; endLine: number }
  >();
  for (const finding of report.findings) {
    for (const loc of finding.locations) {
      locationByEvidenceId.set(loc.evidenceId, {
        path: loc.path,
        startLine: loc.startLine,
        endLine: loc.endLine,
      });
    }
  }

  return (
    <section
      id="evidence"
      className="rounded-xl border border-slate-800 bg-[#111A2E]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div>
          <h2 className="font-display text-base font-semibold text-slate-100">
            Evidence chain & snapshot integrity
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Cryptographic linkage from source bytes through manifest hashes to excerpt SHA-256 verification
          </p>
        </div>
        <span
          className={`font-mono text-xs font-medium ${
            noEmittedEvidence
              ? "text-slate-400"
              : computedColor(
                  report.evidenceIntegration.status === "complete"
                    ? "validated"
                    : report.evidenceIntegration.status,
                )
          }`}
        >
          {noEmittedEvidence
            ? "not executed (0 records)"
            : report.evidenceIntegration.status}
        </span>
      </div>

      <div className="space-y-5 p-5">
        <div className="space-y-3 rounded-lg border border-slate-800 bg-[#0B1120] p-4 text-xs">
          <div className="font-medium text-slate-200">
            Snapshot provenance & manifest chain
          </div>

          <div className="space-y-2 border-t border-slate-800 pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-slate-400">1. Source snapshot</span>
              <span className="font-mono tabular-nums text-slate-200">
                {sourceKind === "custom" ? "custom-snapshot" : `fixture:${review.fixture}`} ·{" "}
                {report.snapshot.fileCount} file(s) · {totalBytes} B
              </span>
            </div>
            <ul className="space-y-1 font-mono text-slate-300">
              {report.snapshot.files.map((file) => (
                <li
                  key={file.path}
                  className="flex flex-wrap items-baseline justify-between gap-2 text-xs"
                >
                  <span className="text-slate-200">
                    {file.path} ({file.lineCount} lines · {file.byteLength} B)
                  </span>
                  <span className="break-all text-slate-400">
                    sha256: {file.sha256}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center gap-2 text-slate-500">
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Domain-separated manifest hashing</span>
          </div>

          <div className="space-y-2 border-t border-slate-800 pt-3">
            <div>
              <div className="text-slate-400">2. File manifest hash (SHA-256)</div>
              <div className="mt-0.5 break-all font-mono text-slate-300">
                {report.snapshot.fileManifestHash}
              </div>
            </div>
            <div>
              <div className="text-slate-400">3. Source hash (SHA-256)</div>
              <div className="mt-0.5 break-all font-mono text-teal-300">
                {report.snapshot.sourceHash}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 text-slate-500">
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              Rule {report.deterministicRule.id} ({report.deterministicRule.status})
            </span>
          </div>

          {chainLinks.length === 0 ? (
            <div className="border-t border-slate-800 pt-3 text-slate-400">
              4. Deterministic finding & evidence chain: Not executed (0 candidate findings emitted by {report.deterministicRule.id}; no excerpt hashes were generated or verified).
            </div>
          ) : (
            <div className="space-y-3 border-t border-slate-800 pt-3">
              <div className="text-slate-400">
                4. Finding → location → excerpt hash → independent validation
              </div>
              {chainLinks.map((link) => {
                const isSelected = activeHighlight?.evidenceId === link.evidenceId;
                return (
                  <div
                    key={`${link.findingId}-${link.evidenceId}`}
                    className={`space-y-1.5 rounded-md border border-slate-800/80 p-3 transition-colors ${
                      isSelected ? "bg-teal-950/20" : "bg-[#111A2E]/60"
                    }`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-mono text-slate-300">
                        Finding: {link.findingId}
                      </span>
                      <span className={`font-medium ${computedColor(link.computedValidationStatus)}`}>
                        {link.computedValidationStatus} ({link.passedChecks}/{link.totalApplicableChecks} checks)
                      </span>
                    </div>
                    <div className="break-all font-mono text-slate-400">
                      Evidence: {link.evidenceId}
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          onSelectLocation({
                            path: link.path,
                            startLine: link.startLine,
                            endLine: link.endLine,
                            evidenceId: link.evidenceId,
                          })
                        }
                        className="inline-flex cursor-pointer items-center gap-1 font-mono text-teal-400 transition-colors hover:text-teal-300"
                      >
                        <span className="tabular-nums">
                          Location: {link.path}:{link.startLine}-{link.endLine}
                        </span>
                        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <span className="text-slate-400">Ref: {link.referenceStatus}</span>
                    </div>
                    <div className="break-all font-mono text-slate-300">
                      Excerpt SHA-256: {link.excerptHash ?? "not provided"}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <p className="text-xs leading-relaxed text-slate-400">
          Evidence validation verifies snapshot identity, canonical file reference, physical line bounds, and excerpt-hash match. It confirms correspondence to the loaded snapshot; it does not prove exploitability or contract safety.
        </p>

        {report.evidenceIntegration.evidence.length > 0 && (
          <div className="divide-y divide-slate-800 border-t border-slate-800 pt-2">
            {report.evidenceIntegration.evidence.map((record) => {
              const linkedLocation = locationByEvidenceId.get(record.evidenceId);
              const isSelected = activeHighlight?.evidenceId === record.evidenceId;
              return (
                <div
                  key={record.evidenceId}
                  className={`py-3.5 transition-colors ${
                    isSelected ? "rounded-md bg-teal-950/20 px-3" : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {linkedLocation ? (
                      <button
                        type="button"
                        onClick={() =>
                          onSelectLocation({
                            ...linkedLocation,
                            evidenceId: record.evidenceId,
                          })
                        }
                        className={`cursor-pointer break-all text-left font-mono text-xs underline underline-offset-4 transition-colors ${
                          isSelected
                            ? "text-teal-300 decoration-teal-400"
                            : "text-slate-200 decoration-slate-700 hover:text-teal-300 hover:decoration-teal-400"
                        }`}
                      >
                        {record.evidenceId}
                      </button>
                    ) : (
                      <span className="break-all font-mono text-xs text-slate-200">
                        {record.evidenceId}
                      </span>
                    )}

                    <span className={`text-xs font-medium ${computedColor(record.computedValidationStatus)}`}>
                      Computed: {record.computedValidationStatus}
                    </span>
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span>Declared: {record.declaredValidationStatus}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Presented as validated:{" "}
                      {record.presentedAsValidated ? "yes" : "no"}
                    </span>
                    {record.issues.length > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-amber-400">
                          Issues: {record.issues.join(", ")}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {report.evidenceIntegration.issues.length > 0 && (
          <div className="space-y-2 border-t border-slate-800 pt-4">
            <div className="text-xs font-medium text-amber-400">
              Integration diagnostics
            </div>
            {report.evidenceIntegration.issues.map((issue, index) => (
              <div
                key={`${issue.code}-${index}`}
                className="rounded-lg border border-amber-800/50 bg-amber-950/20 px-3.5 py-2.5 text-xs text-amber-200"
              >
                <span className="font-mono font-medium">{issue.code}</span>
                {" — "}
                {issue.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
