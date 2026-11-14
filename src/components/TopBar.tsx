import { ShieldCheck } from "lucide-react";

interface TopBarProps {
  onSelectCustomMode: () => void;
}

export function TopBar({ onSelectCustomMode }: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-[#0B1120]/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-8 px-6 py-4">
        <a
          href="#overview"
          className="flex shrink-0 items-center gap-2.5 whitespace-nowrap font-display text-lg font-bold tracking-tight text-slate-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-400"
        >
          <ShieldCheck className="h-5 w-5 text-teal-400" aria-hidden="true" />
          <span>SentinelReview</span>
        </a>

        <nav
          aria-label="Primary sections"
          className="hidden items-center gap-7 text-sm font-medium text-slate-400 md:flex"
        >
          <a
            href="#pipeline"
            className="shrink-0 whitespace-nowrap transition-colors duration-150 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-400"
          >
            Pipeline
          </a>
          <a
            href="#findings"
            className="shrink-0 whitespace-nowrap transition-colors duration-150 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-400"
          >
            Findings
          </a>
          <a
            href="#evidence"
            className="shrink-0 whitespace-nowrap transition-colors duration-150 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-400"
          >
            Evidence
          </a>
          <a
            href="#ledger"
            className="shrink-0 whitespace-nowrap transition-colors duration-150 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-400"
          >
            Ledger
          </a>
          <a
            href="#near-ai"
            className="shrink-0 whitespace-nowrap transition-colors duration-150 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-400"
          >
            NEAR AI
          </a>
        </nav>

        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={onSelectCustomMode}
            className="shrink-0 cursor-pointer whitespace-nowrap rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white transition-colors duration-150 hover:bg-teal-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-400"
          >
            New Custom Review
          </button>
        </div>
      </div>
    </header>
  );
}
