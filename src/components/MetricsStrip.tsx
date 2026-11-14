import { buildResultInterpretation } from "../lib/verification-transparency.ts";
import type { ReviewResponse } from "../types/review.ts";

interface MetricsStripProps {
  review: ReviewResponse | null;
  loading: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function toneClass(tone: "emerald" | "amber" | "rose" | "slate"): string {
  switch (tone) {
    case "emerald":
      return "text-emerald-400";
    case "amber":
      return "text-amber-400";
    case "rose":
      return "text-rose-400";
    default:
      return "text-slate-200";
  }
}

export function MetricsStrip({ review, loading }: MetricsStripProps) {
  if (loading || !review) {
    return (
      <section
        aria-label="Review metrics"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {[0, 1, 2, 3].map((slot) => (
          <div
            key={slot}
            className="h-[116px] animate-pulse rounded-xl border border-slate-800 bg-[#111A2E] p-5"
          >
            <div className="h-3 w-28 rounded bg-slate-800" />
            <div className="mt-4 h-7 w-24 rounded bg-slate-800" />
            <div className="mt-3 h-3 w-36 rounded bg-slate-800/70" />
          </div>
        ))}
      </section>
    );
  }

  const { report, totalBytes, sourceKind, fixture } = review;
  const interpretation = buildResultInterpretation(review);
  const sourceLabel =
    sourceKind === "custom"
      ? "Custom Rust snapshot"
      : fixture === "safe"
        ? "Bundled fixture (private callback)"
        : "Bundled fixture (unguarded callback)";

  return (
    <section
      aria-label="Review metrics"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-5">
        <div className="text-xs font-medium text-slate-400">Result interpretation</div>
        <div
          className={`mt-2.5 font-display text-lg font-semibold leading-snug tracking-tight ${toneClass(
            interpretation.tone,
          )}`}
        >
          {interpretation.headline}
        </div>
        <div className="mt-1.5 text-xs text-slate-400">{sourceLabel}</div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-5">
        <div className="text-xs font-medium text-slate-400">Snapshot ingested</div>
        <div className="mt-2.5 font-mono text-2xl font-semibold tabular-nums text-slate-100">
          {report.snapshot.fileCount}{" "}
          <span className="text-sm font-normal text-slate-400">
            {report.snapshot.fileCount === 1 ? "file" : "files"}
          </span>
        </div>
        <div className="mt-1.5 font-mono text-xs tabular-nums text-slate-400">
          {formatBytes(totalBytes)} · {report.snapshot.sourceHash.slice(0, 12)}…
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-5">
        <div className="text-xs font-medium text-slate-400">Deterministic AST rule</div>
        <div className="mt-2.5 font-mono text-2xl font-semibold tabular-nums text-slate-100">
          {report.deterministicRule.findingCount}{" "}
          <span className="text-sm font-normal text-slate-400">
            {report.deterministicRule.findingCount === 1 ? "candidate" : "candidates"}
          </span>
        </div>
        <div className="mt-1.5 text-xs text-slate-400">
          {report.deterministicRule.id} · {report.deterministicRule.status}
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-5">
        <div className="text-xs font-medium text-slate-400">Evidence verification</div>
        <div
          className={`mt-2.5 font-display text-lg font-semibold leading-snug tracking-tight ${toneClass(
            interpretation.evidenceTone,
          )}`}
        >
          {interpretation.evidenceSummary}
        </div>
        <div className="mt-1.5 font-mono text-xs tabular-nums text-slate-400">
          {report.evidenceIntegration.evidence.length} evidence{" "}
          {report.evidenceIntegration.evidence.length === 1 ? "record" : "records"}
        </div>
      </div>
    </section>
  );
}
