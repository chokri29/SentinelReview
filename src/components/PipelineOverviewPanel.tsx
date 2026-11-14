import {
  AlertTriangle,
  Check,
  Minus,
  Search,
  XCircle,
} from "lucide-react";
import {
  buildPipelineStages,
  buildResultInterpretation,
  IMPLEMENTED_CHECKS,
  UNIMPLEMENTED_CHECKS,
  type PipelineStageStatus,
} from "../lib/verification-transparency.ts";
import type { ReviewResponse } from "../types/review.ts";

interface PipelineOverviewPanelProps {
  review: ReviewResponse;
}

function statusPresentation(status: PipelineStageStatus): {
  textClass: string;
  Icon: typeof Check;
} {
  switch (status) {
    case "Completed":
      return { textClass: "text-emerald-400", Icon: Check };
    case "Finding detected":
      return { textClass: "text-amber-400", Icon: Search };
    case "Inconclusive":
    case "Unavailable":
      return { textClass: "text-amber-400", Icon: AlertTriangle };
    case "Failed":
      return { textClass: "text-rose-400", Icon: XCircle };
    case "Not executed":
      return { textClass: "text-slate-400", Icon: Minus };
  }
}

function interpretationAccent(tone: "amber" | "rose" | "slate"): string {
  switch (tone) {
    case "rose":
      return "text-rose-400";
    case "amber":
      return "text-amber-400";
    default:
      return "text-teal-300";
  }
}

export function PipelineOverviewPanel({ review }: PipelineOverviewPanelProps) {
  const stages = buildPipelineStages(review);
  const interpretation = buildResultInterpretation(review);

  return (
    <section
      id="pipeline"
      aria-label="Verification pipeline and scope"
      className="rounded-xl border border-slate-800 bg-[#111A2E]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-4 border-b border-slate-800 px-5 py-4">
        <div>
          <h2 className="font-display text-base font-semibold text-slate-100">
            Deterministic verification pipeline
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Actual stages executed for this snapshot · Optional NEAR AI remains separate and inactive unless authorized below
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`font-semibold ${interpretationAccent(interpretation.tone)}`}>
            {interpretation.headline}
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="text-slate-300">{interpretation.evidenceSummary}</span>
        </div>
      </div>

      <div className="px-5 py-4">
        <div className="mb-4 border-b border-slate-800/80 pb-4 text-xs leading-relaxed text-slate-300">
          <p>{interpretation.summary}</p>
          <p className="mt-1 text-slate-400">{interpretation.distinctionNote}</p>
        </div>

        <ol className="divide-y divide-slate-800/70">
          {stages.map((stage) => {
            const { textClass, Icon } = statusPresentation(stage.status);
            return (
              <li
                key={stage.id}
                className="grid grid-cols-1 gap-2 py-3 first:pt-1 last:pb-1 md:grid-cols-12 md:items-baseline md:gap-4"
              >
                <div className="flex items-baseline gap-2.5 md:col-span-4">
                  <span className="font-mono text-xs tabular-nums text-slate-500">
                    {String(stage.stepNumber).padStart(2, "0")}.
                  </span>
                  <span className="text-sm font-medium text-slate-100">
                    {stage.name}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 text-xs font-semibold md:col-span-2">
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${textClass}`} aria-hidden="true" />
                  <span className={textClass}>{stage.status}</span>
                </div>

                <div className="text-xs leading-relaxed text-slate-300 md:col-span-4">
                  {stage.summary}
                </div>

                <div className="font-mono text-xs text-slate-500 md:col-span-2 md:text-right">
                  {stage.mechanism}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="grid grid-cols-1 divide-y divide-slate-800 border-t border-slate-800 text-xs lg:grid-cols-3 lg:divide-x lg:divide-y-0">
        <div className="p-5">
          <h3 className="font-display text-xs font-semibold text-slate-100">
            Implemented checks
          </h3>
          <ul className="mt-2.5 space-y-1.5 leading-relaxed text-slate-300">
            {IMPLEMENTED_CHECKS.map((item) => (
              <li key={item}>· {item}</li>
            ))}
          </ul>
        </div>

        <div className="p-5">
          <h3 className="font-display text-xs font-semibold text-amber-300">
            Not implemented (outside scope)
          </h3>
          <ul className="mt-2.5 space-y-1.5 leading-relaxed text-slate-400">
            {UNIMPLEMENTED_CHECKS.map((item) => (
              <li key={item}>· {item}</li>
            ))}
          </ul>
        </div>

        <div className="p-5">
          <h3 className="font-display text-xs font-semibold text-slate-100">
            Optional NEAR AI hypothesis boundary
          </h3>
          <p className="mt-2.5 leading-relaxed text-slate-400">
            AI inference is strictly separated from deterministic verification. It runs only after explicit user consent, single-use token validation, and operator-approved TEE measurement checks. AI hypotheses never create, upgrade, or certify deterministic findings.
          </p>
        </div>
      </div>
    </section>
  );
}
