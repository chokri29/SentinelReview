import { useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react";
import {
  buildVerificationLedger,
  type PipelineStageStatus,
} from "../lib/verification-transparency.ts";
import type { ActiveHighlight, ReviewResponse } from "../types/review.ts";

interface VerificationLedgerPanelProps {
  review: ReviewResponse;
  onSelectLocation: (highlight: ActiveHighlight) => void;
}

function resultTone(status: PipelineStageStatus): string {
  switch (status) {
    case "Completed":
      return "text-emerald-400";
    case "Finding detected":
    case "Inconclusive":
    case "Unavailable":
      return "text-amber-400";
    case "Failed":
      return "text-rose-400";
    case "Not executed":
      return "text-slate-400";
  }
}

function subCheckTone(status: "passed" | "failed" | "not_applicable"): string {
  switch (status) {
    case "passed":
      return "text-emerald-400";
    case "failed":
      return "text-rose-400";
    case "not_applicable":
      return "text-slate-500";
  }
}

export function VerificationLedgerPanel({
  review,
  onSelectLocation,
}: VerificationLedgerPanelProps) {
  const entries = buildVerificationLedger(review);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <section
      id="ledger"
      aria-label="Deterministic verification ledger"
      className="rounded-xl border border-slate-800 bg-[#111A2E]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div>
          <h2 className="font-display text-base font-semibold text-slate-100">
            Deterministic verification ledger
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Inspectable record of executed checks, exact outputs, snapshot references, and verification limits
          </p>
        </div>
        <span className="font-mono text-xs tabular-nums text-slate-400">
          {entries.length} ledger {entries.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[780px] border-collapse text-left text-xs">
          <thead className="border-b border-slate-800 text-slate-400">
            <tr>
              <th className="px-5 py-3 font-medium">Check / Rule ID</th>
              <th className="px-4 py-3 font-medium">What was checked</th>
              <th className="px-4 py-3 font-medium">Actual result</th>
              <th className="px-4 py-3 font-medium">Reference</th>
              <th className="px-5 py-3 font-medium">Limitations</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {entries.map((entry) => {
              const isExpanded = Boolean(expandedIds[entry.id]);
              return (
                <tr key={entry.id} className="align-top">
                  <td className="px-5 py-3.5 font-medium text-slate-100">
                    <div className="font-mono text-xs text-slate-100">
                      {entry.checkName}
                    </div>
                    {entry.subChecks && entry.subChecks.length > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(entry.id)}
                        className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-xs font-normal text-teal-400 transition-colors hover:text-teal-300"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        <span>
                          {isExpanded ? "Hide" : "Inspect"} {entry.subChecks.length} checks
                        </span>
                      </button>
                    )}
                    {isExpanded && entry.subChecks && (
                      <dl className="mt-2.5 space-y-1 border-t border-slate-800 pt-2">
                        {entry.subChecks.map((sub) => (
                          <div
                            key={sub.name}
                            className="flex items-center justify-between gap-3 font-sans text-xs"
                          >
                            <dt className="text-slate-400">{sub.name}</dt>
                            <dd className={`font-mono ${subCheckTone(sub.status)}`}>
                              {sub.status}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </td>
                  <td className="px-4 py-3.5 leading-relaxed text-slate-300">
                    {entry.whatWasChecked}
                  </td>
                  <td className="px-4 py-3.5">
                    <div className={`font-semibold ${resultTone(entry.result)}`}>
                      {entry.result}
                    </div>
                    <div className="mt-1 leading-relaxed text-slate-400">
                      {entry.resultDetail}
                    </div>
                  </td>
                  <td className="px-4 py-3.5 font-mono text-slate-300">
                    {entry.targetLocation ? (
                      <button
                        type="button"
                        onClick={() => onSelectLocation(entry.targetLocation!)}
                        className="inline-flex cursor-pointer items-center gap-1 text-left text-teal-400 transition-colors hover:text-teal-300"
                      >
                        <span className="tabular-nums">{entry.reference}</span>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      </button>
                    ) : (
                      <span className="break-all text-slate-400">{entry.reference}</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 leading-relaxed text-slate-400">
                    {entry.limitations}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
