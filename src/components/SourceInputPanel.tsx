import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { FileCode2, Play, Trash2, Upload } from "lucide-react";
import type { FixtureName, SourceKind } from "../types/review.ts";

export interface CustomFileDraft {
  path: string;
  content: string;
  byteLength: number;
  lineCount: number;
}

interface SourceInputPanelProps {
  activeSourceKind: SourceKind;
  activeFixture: FixtureName;
  customPanelOpen: boolean;
  onSelectFixture: (fixture: FixtureName) => void;
  onOpenCustomPanel: () => void;
  onSubmitCustomReview: (files: { path: string; content: string }[]) => Promise<void>;
  submittingCustom: boolean;
  customError: string | null;
}

const SAMPLE_UNGUARDED_RUST = `#[near]
impl Contract {
    pub fn on_transfer_callback(
        #[callback_result] call_result: Result<u128, PromiseError>,
    ) {
        if let Ok(amount) = call_result {
            self.settled_amount += amount;
        }
    }
}
`;

const SAMPLE_MULTI_SAFE_RUST = `#[near]
impl Contract {
    #[private]
    pub fn on_transfer_callback(
        #[callback_result] call_result: Result<u128, PromiseError>,
    ) {
        if let Ok(amount) = call_result {
            self.settled_amount += amount;
        }
    }
}
`;

const MAX_CUSTOM_FILES = 200;
const MAX_CUSTOM_FILE_BYTES = 1024 * 1024;
const MAX_CUSTOM_TOTAL_BYTES = 5 * 1024 * 1024;

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const matches = content.match(/\r\n|\r|\n/g)?.length ?? 0;
  return matches + (content.endsWith("\n") || content.endsWith("\r") ? 0 : 1);
}

function byteSize(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function validateClientCanonicalRustPath(rawPath: string): string | null {
  if (rawPath.length === 0 || rawPath.length > 1024) {
    return "Snapshot file path must be between 1 and 1024 characters.";
  }
  if (rawPath !== rawPath.trim()) {
    return "Snapshot file path must not have leading or trailing whitespace.";
  }
  if (rawPath.includes("\0")) {
    return "Snapshot file path contains invalid null bytes.";
  }
  if (rawPath.includes("\\")) {
    return "Snapshot file path must use forward slashes (/).";
  }
  if (rawPath.startsWith("/") || /^[a-zA-Z]:/.test(rawPath)) {
    return "Absolute file paths are not allowed.";
  }
  const segments = rawPath.split("/");
  if (segments.some((s) => s.length === 0 || s === "." || s === "..")) {
    return "Invalid path segment (empty, '.', or '..') in snapshot file path.";
  }
  const fileName = segments[segments.length - 1]!;
  if (!fileName.endsWith(".rs") || fileName === ".rs") {
    return "Only named Rust (.rs) source files are supported (e.g. src/lib.rs).";
  }
  return null;
}

export function SourceInputPanel({
  activeSourceKind,
  activeFixture,
  customPanelOpen,
  onSelectFixture,
  onOpenCustomPanel,
  onSubmitCustomReview,
  submittingCustom,
  customError,
}: SourceInputPanelProps) {
  const [inputTab, setInputTab] = useState<"paste" | "upload">("paste");
  const [pastePath, setPastePath] = useState("src/lib.rs");
  const [pasteContent, setPasteContent] = useState(SAMPLE_UNGUARDED_RUST);
  const [uploadedFiles, setUploadedFiles] = useState<CustomFileDraft[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stagedTotalBytes = uploadedFiles.reduce(
    (sum, item) => sum + item.byteLength,
    0,
  );

  async function ingestFileList(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setLocalError(null);

    const accepted: CustomFileDraft[] = [];
    const rejected: string[] = [];

    for (const file of Array.from(fileList)) {
      const normalizedName = (file.webkitRelativePath || file.name)
        .replaceAll("\\", "/")
        .replace(/^\/+/, "");

      const pathIssue = validateClientCanonicalRustPath(normalizedName);
      if (pathIssue !== null) {
        rejected.push(file.name);
        continue;
      }

      if (file.size > MAX_CUSTOM_FILE_BYTES) {
        setLocalError(
          `File "${file.name}" exceeds the 1 MB single-file snapshot limit.`,
        );
        return;
      }

      const content = await file.text();
      if (content.includes("\0")) {
        setLocalError(`File "${file.name}" contains invalid null bytes.`);
        return;
      }

      const actualBytes = byteSize(content);
      if (actualBytes > MAX_CUSTOM_FILE_BYTES) {
        setLocalError(
          `File "${file.name}" exceeds the 1 MB single-file UTF-8 snapshot limit.`,
        );
        return;
      }

      accepted.push({
        path: normalizedName,
        content,
        byteLength: actualBytes,
        lineCount: countLines(content),
      });
    }

    if (accepted.length > 0) {
      const merged = new Map<string, CustomFileDraft>();
      for (const item of uploadedFiles) merged.set(item.path, item);
      for (const item of accepted) merged.set(item.path, item);

      if (merged.size > MAX_CUSTOM_FILES) {
        setLocalError(
          `Snapshot exceeds the ${MAX_CUSTOM_FILES}-file limit (${merged.size} staged).`,
        );
        return;
      }

      const nextTotalBytes = Array.from(merged.values()).reduce(
        (sum, item) => sum + item.byteLength,
        0,
      );
      if (nextTotalBytes > MAX_CUSTOM_TOTAL_BYTES) {
        setLocalError(
          `Staged files exceed the 5 MB aggregate snapshot limit (${nextTotalBytes} bytes).`,
        );
        return;
      }

      setUploadedFiles(
        Array.from(merged.values()).sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        ),
      );
    }

    if (rejected.length > 0) {
      setLocalError(
        `Ignored non-Rust or invalid-path files (${rejected.join(", ")}). Only canonical .rs files are accepted.`,
      );
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    void ingestFileList(event.target.files);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    void ingestFileList(event.dataTransfer.files);
  }

  function handleRunPaste() {
    setLocalError(null);
    const trimmedPath = pastePath.trim();
    if (!trimmedPath) {
      setLocalError("Enter a relative Rust file path such as src/lib.rs.");
      return;
    }
    const pathIssue = validateClientCanonicalRustPath(trimmedPath);
    if (pathIssue !== null) {
      setLocalError(pathIssue);
      return;
    }
    if (pasteContent.trim().length === 0) {
      setLocalError("Paste NEAR Rust contract source before running the review.");
      return;
    }
    if (pasteContent.includes("\0")) {
      setLocalError("Source content contains invalid null bytes.");
      return;
    }
    if (byteSize(pasteContent) > MAX_CUSTOM_FILE_BYTES) {
      setLocalError("Pasted source exceeds the 1 MB single-file snapshot limit.");
      return;
    }
    void onSubmitCustomReview([{ path: trimmedPath, content: pasteContent }]);
  }

  function handleRunUpload() {
    setLocalError(null);
    if (uploadedFiles.length === 0) {
      setLocalError("Upload at least one .rs file first.");
      return;
    }
    void onSubmitCustomReview(
      uploadedFiles.map((file) => ({ path: file.path, content: file.content })),
    );
  }

  const displayedError = localError ?? customError;

  return (
    <section id="overview" className="space-y-5">
      <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
        <div className="max-w-2xl">
          <p className="text-xs font-medium text-teal-400">
            Deterministic Evidence Workbench · NEAR Rust
          </p>
          <h1 className="mt-1.5 text-balance font-display text-3xl font-bold tracking-tight text-slate-50 sm:text-4xl">
            Smart-contract security review
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-300">
            Inspect bundled demo fixtures or evaluate your own NEAR Rust source files through an immutable SHA-256 snapshot, deterministic AST check, and independent evidence verification.
          </p>
        </div>

        <div
          role="group"
          aria-label="Source snapshot selector"
          className="inline-flex shrink-0 flex-wrap items-center gap-1 rounded-xl border border-slate-800 bg-[#111A2E] p-1"
        >
          <button
            type="button"
            onClick={() => onSelectFixture("triggering")}
            className={`cursor-pointer whitespace-nowrap rounded-lg px-3.5 py-2 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-400 ${
              activeSourceKind === "fixture" && activeFixture === "triggering" && !customPanelOpen
                ? "bg-teal-600 text-white"
                : "text-slate-300 hover:bg-slate-800/70 hover:text-slate-100"
            }`}
          >
            Callback candidate
          </button>
          <button
            type="button"
            onClick={() => onSelectFixture("safe")}
            className={`cursor-pointer whitespace-nowrap rounded-lg px-3.5 py-2 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-400 ${
              activeSourceKind === "fixture" && activeFixture === "safe" && !customPanelOpen
                ? "bg-teal-600 text-white"
                : "text-slate-300 hover:bg-slate-800/70 hover:text-slate-100"
            }`}
          >
            Safe example
          </button>
          <button
            type="button"
            onClick={onOpenCustomPanel}
            className={`cursor-pointer whitespace-nowrap rounded-lg px-3.5 py-2 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-400 ${
              activeSourceKind === "custom" || customPanelOpen
                ? "bg-teal-600 text-white"
                : "text-slate-300 hover:bg-slate-800/70 hover:text-slate-100"
            }`}
          >
            Custom Rust
          </button>
        </div>
      </div>

      {customPanelOpen && (
        <div
          id="custom-input"
          className="rounded-xl border border-slate-800 bg-[#111A2E] p-5 sm:p-6"
        >
          <div className="flex flex-col justify-between gap-4 border-b border-slate-800 pb-4 sm:flex-row sm:items-center">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-100">
                Custom Rust source snapshot
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                Custom Rust files are sent from your browser to the AI Studio backend in bounded memory for SHA-256 manifest hashing and deterministic AST analysis. They are not forwarded to NEAR AI unless explicitly authorized below.
              </p>
            </div>

            <div className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-800 bg-[#0B1120] p-1">
              <button
                type="button"
                onClick={() => {
                  setInputTab("paste");
                  setLocalError(null);
                }}
                className={`cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150 ${
                  inputTab === "paste"
                    ? "bg-slate-800 text-slate-100"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Paste Rust code
              </button>
              <button
                type="button"
                onClick={() => {
                  setInputTab("upload");
                  setLocalError(null);
                }}
                className={`cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150 ${
                  inputTab === "upload"
                    ? "bg-slate-800 text-slate-100"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Upload .rs files
              </button>
            </div>
          </div>

          {inputTab === "paste" ? (
            <div className="mt-4 space-y-4">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <label
                    htmlFor="custom-rust-path"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Canonical snapshot path
                  </label>
                  <input
                    id="custom-rust-path"
                    type="text"
                    value={pastePath}
                    onChange={(event) => {
                      setPastePath(event.target.value);
                      setLocalError(null);
                    }}
                    placeholder="src/lib.rs"
                    className="mt-1.5 w-full rounded-lg border border-slate-700 bg-[#0B1120] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-teal-500 focus:outline-none sm:max-w-sm"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-400">Load snippet:</span>
                  <button
                    type="button"
                    onClick={() => {
                      setPasteContent(SAMPLE_UNGUARDED_RUST);
                      setLocalError(null);
                    }}
                    className="cursor-pointer whitespace-nowrap rounded-md border border-slate-700 bg-[#0B1120] px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100"
                  >
                    Unguarded callback
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPasteContent(SAMPLE_MULTI_SAFE_RUST);
                      setLocalError(null);
                    }}
                    className="cursor-pointer whitespace-nowrap rounded-md border border-slate-700 bg-[#0B1120] px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100"
                  >
                    Private callback
                  </button>
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs text-slate-400">
                  <label htmlFor="custom-rust-editor" className="font-medium text-slate-300">
                    Rust contract source
                  </label>
                  <span className="font-mono tabular-nums">
                    {countLines(pasteContent)} lines · {byteSize(pasteContent)} B
                  </span>
                </div>
                <textarea
                  id="custom-rust-editor"
                  value={pasteContent}
                  onChange={(event) => {
                    setPasteContent(event.target.value);
                    setLocalError(null);
                  }}
                  rows={10}
                  spellCheck={false}
                  placeholder="Paste NEAR Rust contract code here..."
                  className="w-full rounded-lg border border-slate-700 bg-[#0B1120] p-3.5 font-mono text-xs leading-relaxed text-slate-100 placeholder:text-slate-500 focus:border-teal-500 focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-slate-400">
                  Deterministic rule: NEAR-RUST-CALLBACK-PRIVATE-001 · SHA-256 manifest computed server-side
                </span>
                <button
                  type="button"
                  disabled={submittingCustom}
                  onClick={handleRunPaste}
                  className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white transition-colors duration-150 hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{submittingCustom ? "Analyzing snapshot..." : "Run Deterministic Review"}</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                className={`flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-8 text-center transition-colors ${
                  dragActive
                    ? "border-teal-400 bg-teal-950/20"
                    : "border-slate-700 bg-[#0B1120]"
                }`}
              >
                <Upload className="h-6 w-6 text-slate-400" aria-hidden="true" />
                <p className="mt-2.5 text-sm font-medium text-slate-200">
                  Drop Rust (.rs) files here, or browse from disk
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Up to 200 files · 1 MB per file · 5 MB total snapshot limit
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".rs"
                  multiple
                  onChange={handleFileChange}
                  className="sr-only"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-4 cursor-pointer whitespace-nowrap rounded-lg border border-slate-700 bg-[#111A2E] px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-800"
                >
                  Select .rs Files
                </button>
              </div>

              {uploadedFiles.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-slate-800 bg-[#0B1120]">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-800 text-slate-400">
                      <tr>
                        <th className="px-4 py-2.5 font-medium">Path</th>
                        <th className="px-4 py-2.5 text-right font-medium">Lines</th>
                        <th className="px-4 py-2.5 text-right font-medium">Bytes</th>
                        <th className="px-4 py-2.5 text-right font-medium">Remove</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {uploadedFiles.map((file) => (
                        <tr key={file.path} className="hover:bg-slate-900/50">
                          <td className="px-4 py-2.5 font-mono text-slate-200">
                            <span className="inline-flex items-center gap-2">
                              <FileCode2 className="h-3.5 w-3.5 text-teal-400" aria-hidden="true" />
                              {file.path}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-300">
                            {file.lineCount}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-300">
                            {file.byteLength}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <button
                              type="button"
                              aria-label={`Remove ${file.path}`}
                              onClick={() => {
                                setUploadedFiles((prev) =>
                                  prev.filter((item) => item.path !== file.path),
                                );
                                setLocalError(null);
                              }}
                              className="cursor-pointer rounded p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-rose-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-xs tabular-nums text-slate-400">
                    {uploadedFiles.length}{" "}
                    {uploadedFiles.length === 1 ? "file" : "files"} staged ({stagedTotalBytes} B)
                  </span>
                  {uploadedFiles.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setUploadedFiles([]);
                        setLocalError(null);
                      }}
                      className="cursor-pointer text-xs text-slate-400 underline underline-offset-4 transition-colors hover:text-slate-200"
                    >
                      Clear all
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  disabled={submittingCustom || uploadedFiles.length === 0}
                  onClick={handleRunUpload}
                  className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white transition-colors duration-150 hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{submittingCustom ? "Analyzing snapshot..." : "Run Deterministic Review"}</span>
                </button>
              </div>
            </div>
          )}

          {displayedError && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-rose-800/70 bg-rose-950/30 px-4 py-3 text-xs text-rose-200"
            >
              {displayedError}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
