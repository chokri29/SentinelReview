import { ArrowUpRight } from "lucide-react";
import type { ActiveHighlight, ReviewResponse } from "../types/review.ts";

interface FindingsPanelProps {
  review: ReviewResponse | null;
  activeHighlight: ActiveHighlight | null;
  onSelectLocation: (highlight: ActiveHighlight) => void;
}

function severityTextClass(severity: string): string {
  switch (severity) {
    case "critical":
    case "high":
      return "text-rose-400";
    case "medium":
    case "info":
      return "text-amber-400";
    default:
      return "text-slate-300";
  }
}

function validationLabel(status: string): { text: string; className: string } {
  switch (status) {
    case "validated":
      return { text: "Validated", className: "text-emerald-400" };
    case "partial":
      return { text: "Partial match", className: "text-amber-400" };
    case "invalid":
      return { text: "Invalid", className: "text-rose-400" };
    default:
      return { text: "Unavailable", className: "text-slate-400" };
  }
}

export function FindingsPanel({
  review,
  activeHighlight,
  onSelectLocation,
}: FindingsPanelProps) {
  if (!review) return null;

  const { report, sourceExcerpts } = review;

  return (
    <section
      id="findings"
      className="rounded-xl border border-slate-800 bg-[#111A2E]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div>
          <h2 className="font-display text-base font-semibold text-slate-100">
            Deterministic findings
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Informational candidates emitted by static AST analysis
          </p>
        </div>
        <span className="font-mono text-xs text-teal-400">
          {report.deterministicRule.id}
        </span>
      </div>

      <div className="space-y-4 p-5">
        <div className="rounded-lg border border-slate-800 bg-[#0B1120] px-4 py-3 text-xs leading-relaxed text-slate-300">
          <span className="font-semibold text-slate-100">Interpretation: </span>
          {report.interpretation}
        </div>

        {report.findings.length === 0 ? (
          report.overallAnalysisStatus === "inconclusive" ? (
            <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 px-5 py-8 text-center">
              <p className="text-sm font-medium text-amber-400">
                Analysis inconclusive — not all inspected source could be assessed
              </p>
              <p className="mx-auto mt-2 max-w-lg text-xs leading-relaxed text-slate-300">
                {report.deterministicRule.id} could not complete a conclusive check across every file (for example due to Rust syntax errors or unrecognized manual guards). Zero emitted findings does not mean the rule passed.
              </p>
            </div>
          ) : report.overallAnalysisStatus === "no_findings" ? (
            <div className="rounded-lg border border-slate-800 bg-[#0B1120] px-5 py-8 text-center">
              <p className="text-sm font-medium text-slate-100">
                No findings within implemented rule scope ({report.deterministicRule.id})
              </p>
              <p className="mx-auto mt-2 max-w-lg text-xs leading-relaxed text-slate-400">
                This rule checks only for unguarded NEAR <code className="font-mono text-slate-200">#[callback_result]</code> handlers missing <code className="font-mono text-slate-200">#[private]</code>. Emitting zero findings is not proof of contract safety.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 px-5 py-8 text-center">
              <p className="text-sm font-medium text-amber-400">
                No finding locations available for {report.deterministicRule.id}
              </p>
            </div>
          )
        ) : (
          <div className="divide-y divide-slate-800">
            {report.overallAnalysisStatus === "inconclusive" && (
              <div className="mb-4 rounded-lg border border-amber-800/60 bg-amber-950/20 px-4 py-3 text-xs leading-relaxed text-amber-200">
                Inconclusive coverage warning: candidates were emitted, but not all inspected Rust source could be parsed or assessed conclusively.
              </div>
            )}
            {report.findings.map((finding) => (
              <article key={finding.findingId} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-display text-sm font-semibold text-slate-100">
                    {finding.title}
                  </h3>
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`font-medium capitalize ${severityTextClass(finding.severity)}`}>
                      {finding.severity}
                    </span>
                    <span className="text-slate-600" aria-hidden="true">·</span>
                    <span className="font-mono text-slate-400">{finding.origin}</span>
                  </div>
                </div>

                <p className="mt-2 text-sm leading-relaxed text-slate-300">
                  {finding.rationale}
                </p>

                <div className="mt-3 space-y-2.5">
                  {finding.locations.map((loc) => {
                    const validation = validationLabel(loc.computedValidationStatus);
                    const excerpt = sourceExcerpts[loc.evidenceId];
                    const isSelected = activeHighlight?.evidenceId === loc.evidenceId;

                    return (
                      <div key={loc.evidenceId} className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <button
                            type="button"
                            onClick={() =>
                              onSelectLocation({
                                path: loc.path,
                                startLine: loc.startLine,
                                endLine: loc.endLine,
                                evidenceId: loc.evidenceId,
                              })
                            }
                            className={`inline-flex cursor-pointer items-center gap-1.5 font-mono transition-colors ${
                              isSelected
                                ? "text-teal-300 underline underline-offset-4"
                                : "text-teal-400 hover:text-teal-300"
                            }`}
                          >
                            <span className="tabular-nums">
                              {loc.path}:{loc.startLine}-{loc.endLine}
                            </span>
                            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>

                          <div className="flex items-center gap-2 text-slate-400">
                            <span className={validation.className}>
                              {validation.text}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>Ref: {loc.referenceStatus}</span>
                          </div>
                        </div>

                        {excerpt && (
                          <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-[#0B1120] px-3.5 py-2.5 font-mono text-xs leading-relaxed text-slate-200">
                            {excerpt.content}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                </div>

                {finding.limitations.length > 0 && (
                  <ul className="mt-3 space-y-1 text-xs text-slate-400">
                    {finding.limitations.map((limitation, idx) => (
                      <li key={idx}>Limitation: {limitation}</li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        )}

        {report.deterministicRule.limitations.length > 0 && (
          <div className="border-t border-slate-800 pt-4">
            <div className="text-xs font-medium text-slate-300">Rule scope & limitations</div>
            <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-slate-400">
              {report.deterministicRule.limitations.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
