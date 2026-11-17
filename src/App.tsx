import { useCallback, useEffect, useRef, useState } from "react";
import { EvidencePanel } from "./components/EvidencePanel.tsx";
import { FindingsPanel } from "./components/FindingsPanel.tsx";
import { MetricsStrip } from "./components/MetricsStrip.tsx";
import { NearAiPanel } from "./components/NearAiPanel.tsx";
import { PipelineOverviewPanel } from "./components/PipelineOverviewPanel.tsx";
import { SourceInputPanel } from "./components/SourceInputPanel.tsx";
import { SourceViewer } from "./components/SourceViewer.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { VerificationLedgerPanel } from "./components/VerificationLedgerPanel.tsx";
import type {
  ActiveHighlight,
  AiAnalysisResponse,
  FixtureName,
  MetaAnalysisResponse,
  ReviewResponse,
} from "./types/review.ts";

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function parseJsonApiResponse<T>(
  res: Response,
  endpointLabel: string,
): Promise<T> {
  const contentType = res.headers.get("content-type")?.trim() || "unknown";
  const rawText = await res.text();
  if (!/application\/json/i.test(contentType)) {
    throw new Error(
      `Unexpected non-JSON response from ${endpointLabel} (HTTP ${res.status}, content-type: ${contentType}).`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid JSON object");
    }
    return parsed as T;
  } catch {
    throw new Error(
      `Invalid JSON payload from ${endpointLabel} (HTTP ${res.status}, content-type: ${contentType}).`,
    );
  }
}

export default function App() {
  const [activeFixture, setActiveFixture] = useState<FixtureName>("triggering");
  const [customPanelOpen, setCustomPanelOpen] = useState(false);
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submittingCustom, setSubmittingCustom] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);
  const [activeHighlight, setActiveHighlight] = useState<ActiveHighlight | null>(
    null,
  );

  const [consentChecked, setConsentChecked] = useState(false);
  const [tokenConsumed, setTokenConsumed] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiResponse, setAiResponse] = useState<AiAnalysisResponse | null>(null);

  const [metaConsentChecked, setMetaConsentChecked] = useState(false);
  const [metaTokenConsumed, setMetaTokenConsumed] = useState(false);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaResponse, setMetaResponse] = useState<MetaAnalysisResponse | null>(
    null,
  );

  const reviewRequestSeqRef = useRef(0);
  const aiRequestSeqRef = useRef(0);
  const metaRequestSeqRef = useRef(0);
  const reviewAbortRef = useRef<AbortController | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);
  const metaAbortRef = useRef<AbortController | null>(null);

  const invalidateInFlightAi = useCallback(() => {
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    aiRequestSeqRef.current += 1;
    setAiLoading(false);
    setAiError(null);
    setAiResponse(null);
    setConsentChecked(false);
    setTokenConsumed(false);

    metaAbortRef.current?.abort();
    metaAbortRef.current = null;
    metaRequestSeqRef.current += 1;
    setMetaLoading(false);
    setMetaError(null);
    setMetaResponse(null);
    setMetaConsentChecked(false);
    setMetaTokenConsumed(false);
  }, []);

  const applyNewReview = useCallback(
    (data: ReviewResponse) => {
      invalidateInFlightAi();
      setReview(data);

      const firstLoc = data.report.findings[0]?.locations[0];
      if (firstLoc) {
        setActiveHighlight({
          path: firstLoc.path,
          startLine: firstLoc.startLine,
          endLine: firstLoc.endLine,
          evidenceId: firstLoc.evidenceId,
        });
      } else {
        setActiveHighlight(null);
      }
    },
    [invalidateInFlightAi],
  );

  const loadFixture = useCallback(
    async (fixture: FixtureName) => {
      reviewAbortRef.current?.abort();
      const controller = new AbortController();
      reviewAbortRef.current = controller;
      const seq = ++reviewRequestSeqRef.current;

      invalidateInFlightAi();
      setLoading(true);
      setSubmittingCustom(false);
      setLoadError(null);
      setCustomError(null);

      try {
        const res = await fetch(
          `/api/review?fixture=${encodeURIComponent(fixture)}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const payload = await parseJsonApiResponse<
          ReviewResponse & { error?: string }
        >(res, "/api/review");
        if (seq !== reviewRequestSeqRef.current) return;
        if (!res.ok) {
          throw new Error(payload.error ?? "Failed to load fixture review.");
        }
        applyNewReview(payload);
      } catch (err) {
        if (isAbortError(err) || seq !== reviewRequestSeqRef.current) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load fixture review.",
        );
      } finally {
        if (seq === reviewRequestSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [applyNewReview, invalidateInFlightAi],
  );

  useEffect(() => {
    void loadFixture("triggering");
    return () => {
      reviewAbortRef.current?.abort();
      aiAbortRef.current?.abort();
      metaAbortRef.current?.abort();
    };
  }, [loadFixture]);

  function handleSelectFixture(fixture: FixtureName) {
    setCustomPanelOpen(false);
    setActiveFixture(fixture);
    void loadFixture(fixture);
  }

  function handleOpenCustomPanel() {
    setCustomPanelOpen(true);
    setCustomError(null);
    const el = document.getElementById("overview");
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    }
  }

  async function handleSubmitCustomReview(
    files: { path: string; content: string }[],
  ) {
    reviewAbortRef.current?.abort();
    const controller = new AbortController();
    reviewAbortRef.current = controller;
    const seq = ++reviewRequestSeqRef.current;

    invalidateInFlightAi();
    setSubmittingCustom(true);
    setLoading(false);
    setCustomError(null);
    setLoadError(null);

    try {
      const res = await fetch("/api/review/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
        signal: controller.signal,
      });
      const payload = await parseJsonApiResponse<
        ReviewResponse & { error?: string }
      >(res, "/api/review/custom");
      if (seq !== reviewRequestSeqRef.current) return;
      if (!res.ok) {
        throw new Error(payload.error ?? "Failed to analyze custom Rust snapshot.");
      }
      applyNewReview(payload);
    } catch (err) {
      if (isAbortError(err) || seq !== reviewRequestSeqRef.current) return;
      setCustomError(
        err instanceof Error
          ? err.message
          : "Failed to analyze custom Rust snapshot.",
      );
    } finally {
      if (seq === reviewRequestSeqRef.current) {
        setSubmittingCustom(false);
      }
    }
  }

  async function handleRunAiAnalysis() {
    if (!review || !consentChecked || tokenConsumed) return;
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;
    const seq = ++aiRequestSeqRef.current;
    const expectedSnapshotHash = review.report.snapshot.sourceHash;

    setAiLoading(true);
    setAiError(null);

    try {
      const res = await fetch("/api/ai-review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-sentinelreview-ai-consent": "1",
        },
        body: JSON.stringify({
          sourceKind: review.sourceKind,
          ...(review.fixture ? { fixture: review.fixture } : {}),
          snapshotHash: expectedSnapshotHash,
          token: review.consentToken,
        }),
        signal: controller.signal,
      });
      if (seq !== aiRequestSeqRef.current) return;
      if (res.status !== 403 && res.status !== 400 && res.status !== 415) {
        setTokenConsumed(true);
        setConsentChecked(false);
      }
      const payload = await parseJsonApiResponse<
        AiAnalysisResponse & {
          error?: string;
          errorCode?: string;
        }
      >(res, "/api/ai-review");
      if (seq !== aiRequestSeqRef.current) return;
      if (!res.ok) {
        const baseMessage = payload.error ?? "Optional NEAR AI request failed.";
        throw new Error(
          payload.errorCode
            ? `${baseMessage} (${payload.errorCode})`
            : baseMessage,
        );
      }
      if (payload.snapshotHash !== expectedSnapshotHash) {
        throw new Error("NEAR AI response snapshot hash did not match the active review.");
      }
      setAiResponse(payload);
    } catch (err) {
      if (isAbortError(err) || seq !== aiRequestSeqRef.current) return;
      setAiError(
        err instanceof Error ? err.message : "Optional NEAR AI request failed.",
      );
    } finally {
      if (seq === aiRequestSeqRef.current) {
        setAiLoading(false);
      }
    }
  }

  async function handleRunMetaAnalysis() {
    if (
      !review ||
      review.sourceKind !== "fixture" ||
      !review.fixture ||
      !metaConsentChecked ||
      metaTokenConsumed ||
      !review.metaConfig?.consentToken
    ) {
      return;
    }

    metaAbortRef.current?.abort();
    const controller = new AbortController();
    metaAbortRef.current = controller;
    const seq = ++metaRequestSeqRef.current;
    const expectedSnapshotHash = review.report.snapshot.sourceHash;

    setMetaLoading(true);
    setMetaError(null);

    try {
      const res = await fetch("/api/meta-review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-sentinelreview-meta-consent": "1",
        },
        body: JSON.stringify({
          sourceKind: "fixture",
          fixture: review.fixture,
          snapshotHash: expectedSnapshotHash,
          token: review.metaConfig.consentToken,
        }),
        signal: controller.signal,
      });
      if (seq !== metaRequestSeqRef.current) return;
      if (res.status !== 403 && res.status !== 400 && res.status !== 415) {
        setMetaTokenConsumed(true);
        setMetaConsentChecked(false);
      }
      const payload = await parseJsonApiResponse<
        MetaAnalysisResponse & {
          error?: string;
          errorCode?: string;
        }
      >(res, "/api/meta-review");
      if (seq !== metaRequestSeqRef.current) return;
      if (!res.ok) {
        const baseMessage =
          payload.error ?? "Optional Meta Model API request failed.";
        throw new Error(
          payload.errorCode
            ? `${baseMessage} (${payload.errorCode})`
            : baseMessage,
        );
      }
      if (payload.snapshotHash !== expectedSnapshotHash) {
        throw new Error(
          "Meta Model API response snapshot hash did not match the active review.",
        );
      }
      setMetaResponse(payload);
    } catch (err) {
      if (isAbortError(err) || seq !== metaRequestSeqRef.current) return;
      setMetaError(
        err instanceof Error
          ? err.message
          : "Optional Meta Model API request failed.",
      );
    } finally {
      if (seq === metaRequestSeqRef.current) {
        setMetaLoading(false);
      }
    }
  }

  async function handleRefreshReviewForToken() {
    if (!review) return;
    if (review.sourceKind === "fixture" && review.fixture) {
      await loadFixture(review.fixture);
      return;
    }
    await handleSubmitCustomReview(
      review.snapshotFiles.map((file) => ({
        path: file.path,
        content: file.content,
      })),
    );
  }

  return (
    <div className="min-h-screen bg-[#0B1120] text-slate-100">
      <TopBar onSelectCustomMode={handleOpenCustomPanel} />

      <main className="mx-auto max-w-[1400px] space-y-6 px-6 py-8">
        <SourceInputPanel
          activeSourceKind={review?.sourceKind ?? "fixture"}
          activeFixture={activeFixture}
          customPanelOpen={customPanelOpen}
          onSelectFixture={handleSelectFixture}
          onOpenCustomPanel={handleOpenCustomPanel}
          onSubmitCustomReview={handleSubmitCustomReview}
          submittingCustom={submittingCustom}
          customError={customError}
        />

        {loadError && (
          <div
            role="alert"
            className="rounded-xl border border-rose-800/70 bg-rose-950/30 px-5 py-4 text-sm text-rose-200"
          >
            {loadError}
          </div>
        )}

        <MetricsStrip review={review} loading={loading} />

        {review && !loading && (
          <>
            <PipelineOverviewPanel review={review} />

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <div className="min-w-0 space-y-6 lg:col-span-7">
                <FindingsPanel
                  review={review}
                  activeHighlight={activeHighlight}
                  onSelectLocation={setActiveHighlight}
                />
                <EvidencePanel
                  review={review}
                  activeHighlight={activeHighlight}
                  onSelectLocation={setActiveHighlight}
                />
              </div>

              <div className="min-w-0 lg:col-span-5">
                <div className="lg:sticky lg:top-24">
                  <SourceViewer
                    files={review.snapshotFiles}
                    activeHighlight={activeHighlight}
                    onClearHighlight={() => setActiveHighlight(null)}
                  />
                </div>
              </div>
            </div>

            <VerificationLedgerPanel
              review={review}
              onSelectLocation={setActiveHighlight}
            />

            <NearAiPanel
              review={review}
              consentChecked={consentChecked}
              onConsentChange={setConsentChecked}
              tokenConsumed={tokenConsumed}
              aiLoading={aiLoading}
              aiError={aiError}
              aiResponse={aiResponse}
              onRunAiAnalysis={handleRunAiAnalysis}
              metaConsentChecked={metaConsentChecked}
              onMetaConsentChange={setMetaConsentChecked}
              metaTokenConsumed={metaTokenConsumed}
              metaLoading={metaLoading}
              metaError={metaError}
              metaResponse={metaResponse}
              onRunMetaAnalysis={handleRunMetaAnalysis}
              onRefreshReviewForToken={handleRefreshReviewForToken}
            />
          </>
        )}
      </main>

      <footer className="border-t border-slate-800/80 py-6">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-4 px-6 text-xs text-slate-500">
          <span>SentinelReview · Deterministic NEAR Rust evidence verification</span>
          <span>
            Supports human investigation; not a complete security audit or safety certification
          </span>
        </div>
      </footer>
    </div>
  );
}
