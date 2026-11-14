import { useEffect, useRef, useState } from "react";
import { isLineHighlighted, splitPhysicalLines } from "../lib/source-lines.ts";
import type { ActiveHighlight, SnapshotFileRecord } from "../types/review.ts";

interface SourceViewerProps {
  files: SnapshotFileRecord[];
  activeHighlight: ActiveHighlight | null;
  onClearHighlight: () => void;
}

export function SourceViewer({
  files,
  activeHighlight,
  onClearHighlight,
}: SourceViewerProps) {
  const [selectedPath, setSelectedPath] = useState<string>("");
  const firstHighlightedRowRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    if (activeHighlight && files.some((file) => file.path === activeHighlight.path)) {
      setSelectedPath(activeHighlight.path);
      return;
    }
    if (files.length > 0 && !files.some((file) => file.path === selectedPath)) {
      setSelectedPath(files[0]!.path);
    }
  }, [files, activeHighlight, selectedPath]);

  useEffect(() => {
    if (activeHighlight && firstHighlightedRowRef.current) {
      firstHighlightedRowRef.current.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [activeHighlight, selectedPath]);

  const activeFile = files.find((file) => file.path === selectedPath) ?? files[0];
  if (!activeFile) return null;

  const lines = splitPhysicalLines(activeFile.content);
  const highlightMatchesFile =
    activeHighlight !== null && activeHighlight.path === activeFile.path;

  return (
    <section
      aria-label="Loaded snapshot source viewer"
      className="rounded-xl border border-slate-800 bg-[#111A2E]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div>
          <h2 className="font-display text-base font-semibold text-slate-100">
            Snapshot source inspector
          </h2>
          <p className="mt-0.5 font-mono text-xs tabular-nums text-slate-400">
            {activeFile.path} · {activeFile.lineCount} lines · {activeFile.byteLength} B
          </p>
        </div>

        {highlightMatchesFile && (
          <button
            type="button"
            onClick={onClearHighlight}
            className="cursor-pointer whitespace-nowrap rounded-md border border-slate-700 bg-[#0B1120] px-3 py-1.5 font-mono text-xs text-teal-300 transition-colors hover:border-slate-600"
          >
            Lines {activeHighlight.startLine}–{activeHighlight.endLine} · Clear
          </button>
        )}
      </div>

      {files.length > 1 && (
        <div className="flex flex-wrap gap-1.5 border-b border-slate-800 bg-[#0B1120]/60 px-5 py-2.5">
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => setSelectedPath(file.path)}
              className={`cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1 font-mono text-xs transition-colors ${
                file.path === activeFile.path
                  ? "bg-teal-600 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              }`}
            >
              {file.path}
            </button>
          ))}
        </div>
      )}

      <div className="max-h-[460px] overflow-auto bg-[#0B1120] py-3">
        {lines.length === 0 ? (
          <div className="px-5 py-6 text-xs text-slate-500">
            File is empty (0 lines).
          </div>
        ) : (
          <table className="w-full border-collapse font-mono text-xs leading-6">
            <tbody>
              {lines.map((line, index) => {
                const lineNum = index + 1;
                const isHighlighted = isLineHighlighted(
                  lineNum,
                  activeFile.path,
                  activeHighlight,
                );
                const isFirstHighlighted =
                  isHighlighted && activeHighlight?.startLine === lineNum;

                return (
                  <tr
                    key={lineNum}
                    ref={isFirstHighlighted ? firstHighlightedRowRef : undefined}
                    data-highlighted={isHighlighted ? "true" : "false"}
                    className={
                      isHighlighted
                        ? "bg-amber-500/15"
                        : "hover:bg-slate-900/60"
                    }
                  >
                    <td
                      className={`w-12 select-none px-4 text-right tabular-nums ${
                        isHighlighted ? "font-semibold text-amber-300" : "text-slate-600"
                      }`}
                    >
                      {lineNum}
                    </td>
                    <td className="whitespace-pre pr-5 text-slate-200">
                      {line || " "}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
