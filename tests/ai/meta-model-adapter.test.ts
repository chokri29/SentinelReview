import { describe, expect, it, vi } from "vitest";
import {
  classifyMetaHttpStatus,
  classifyMetaOperationalError,
  createMetaModelAdapter,
  META_CHAT_COMPLETIONS_ENDPOINT,
  META_FREE_CREDIT_WARNING,
  META_MAX_PROMPT_BYTES,
  META_MAX_SOURCE_CONTEXT_BYTES,
  META_MODEL_ID,
  META_PROVIDER_NAME,
  type MetaFetchFn,
} from "../../src/ai/meta-model-adapter.js";
import { runNearRustCallbackPrivateRule } from "../../src/rules/near-rust-callback-private.js";
import { createSnapshotFromEntries } from "../../src/source/custom-snapshot.js";

function makeSampleSnapshot() {
  return createSnapshotFromEntries([
    {
      path: "src/lib.rs",
      content: [
        "#[near]",
        "impl Contract {",
        "    pub fn on_cb(#[callback_result] r: Result<(), PromiseError>) {",
        "        self.ok = true;",
        "    }",
        "}",
      ].join("\n"),
    },
  ]);
}

function makeCompletionResponse(
  content: unknown,
  options: { id?: string; status?: number; headers?: Record<string, string> } = {},
): Response {
  const body =
    typeof content === "string"
      ? content
      : JSON.stringify({
          id: options.id ?? "meta-resp-1",
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify(content),
              },
            },
          ],
        });

  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
}

describe("createMetaModelAdapter isolation, limits, and offline mocked flows", () => {
  it("refuses custom/private source before API key lookup or network fetch", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const fetchFn = vi.fn();
    let transmitted = false;

    const adapter = createMetaModelAdapter({
      getApiKey: () => "meta-test-secret",
      fetchFn,
    });

    const result = await adapter(snapshot, rule.deterministicAnalysis.findings, {
      sourceKind: "custom",
      onSourceTransmission: () => {
        transmitted = true;
      },
    });

    expect(result.provider).toBe(META_PROVIDER_NAME);
    expect(result.modelId).toBe(META_MODEL_ID);
    expect(result.status).toBe("failed");
    expect(result.coverage).toBe("not_run");
    expect(result.errorCode).toBe("private_source_rejected");
    expect(result.hypotheses).toEqual([]);
    expect(result.provenance.teeAttestation).toBe("not_applicable");
    expect(result.provenance.cryptographicVerification).toBe("not_verified");
    expect(transmitted).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns unavailable with missing_api_key when META_MODEL_API_KEY is unset or blank", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const fetchFn = vi.fn();

    for (const rawKey of [undefined, "", "   "]) {
      const adapter = createMetaModelAdapter({
        getApiKey: () => rawKey,
        fetchFn,
      });

      let transmitted = false;
      const result = await adapter(snapshot, rule.deterministicAnalysis.findings, {
        sourceKind: "fixture",
        onSourceTransmission: () => {
          transmitted = true;
        },
      });

      expect(result.status).toBe("unavailable");
      expect(result.coverage).toBe("not_run");
      expect(result.errorCode).toBe("missing_api_key");
      expect(transmitted).toBe(false);
    }

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects non-frozen, empty, or oversized snapshots before calling fetch", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const fetchFn = vi.fn();
    const adapter = createMetaModelAdapter({
      getApiKey: () => "meta-test-secret",
      fetchFn,
    });

    const unfrozenSnapshot = {
      ...snapshot,
      files: [...snapshot.files],
    };
    const nonFrozenRes = await adapter(
      unfrozenSnapshot,
      rule.deterministicAnalysis.findings,
      { sourceKind: "fixture" },
    );
    expect(nonFrozenRes.status).toBe("failed");
    expect(nonFrozenRes.coverage).toBe("not_run");
    expect(nonFrozenRes.errorCode).toBe("request_failed");

    const emptyLineSnapshot = createSnapshotFromEntries([
      { path: "src/empty.rs", content: "" },
    ]);
    const emptyRes = await adapter(emptyLineSnapshot, [], {
      sourceKind: "fixture",
    });
    expect(emptyRes.status).toBe("failed");
    expect(emptyRes.coverage).toBe("not_run");
    expect(emptyRes.errorCode).toBe("request_failed");

    const bigSnapshot = createSnapshotFromEntries([
      {
        path: "src/big.rs",
        content: `// ${"a".repeat(META_MAX_SOURCE_CONTEXT_BYTES + 32)}\n`,
      },
    ]);
    const bigRes = await adapter(bigSnapshot, [], { sourceKind: "fixture" });
    expect(bigRes.status).toBe("failed");
    expect(bigRes.coverage).toBe("not_run");
    expect(bigRes.errorCode).toBe("payload_too_large");

    const mediumSnapshot = createSnapshotFromEntries([
      {
        path: "src/medium.rs",
        content: `// ${"b".repeat(META_MAX_SOURCE_CONTEXT_BYTES - 1024)}\n`,
      },
    ]);
    const oversizedFinding = {
      findingId: "det-oversize",
      origin: "deterministic_rule",
      ruleId: "rule-1",
      severity: "high",
      title: "Oversized context",
      rationale: "x".repeat(META_MAX_PROMPT_BYTES),
      evidenceRefs: [],
    };
    const bigPromptRes = await adapter(mediumSnapshot, [oversizedFinding], {
      sourceKind: "fixture",
    });
    expect(bigPromptRes.status).toBe("failed");
    expect(bigPromptRes.coverage).toBe("not_run");
    expect(bigPromptRes.errorCode).toBe("payload_too_large");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("calls https://api.meta.ai/v1/chat/completions with muse-spark-1.3 Bearer auth and isolates non-TEE hypotheses", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const findingsSnapshotBefore = JSON.stringify(
      rule.deterministicAnalysis.findings,
    );

    const fetchFn = vi.fn<MetaFetchFn>(async () =>
      makeCompletionResponse(
        {
          findings: [
            {
              severity: "medium",
              title: "State update occurs without checking cross-contract promise status",
              rationale:
                "on_cb marks state ok regardless of whether Result is Ok or Err.",
              path: "src/lib.rs",
              startLine: 3,
              endLine: 5,
            },
          ],
        },
        { id: "meta-completion-abc" },
      ),
    );

    const adapter = createMetaModelAdapter({
      getApiKey: () => "meta-secret-xyz",
      fetchFn,
    });

    let transmissionCallbacks = 0;
    const result = await adapter(snapshot, rule.deterministicAnalysis.findings, {
      sourceKind: "fixture",
      onSourceTransmission: () => {
        transmissionCallbacks += 1;
      },
    });

    expect(transmissionCallbacks).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(META_CHAT_COMPLETIONS_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer meta-secret-xyz",
    });

    const parsedBody = JSON.parse(String(init?.body)) as {
      model: string;
      stream: boolean;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(parsedBody.model).toBe(META_MODEL_ID);
    expect(parsedBody.stream).toBe(false);
    expect(parsedBody.max_tokens).toBe(4096);
    expect(parsedBody.messages).toHaveLength(2);
    expect(parsedBody.messages[1]?.content).toContain("src/lib.rs");

    expect(result.provider).toBe(META_PROVIDER_NAME);
    expect(result.modelId).toBe(META_MODEL_ID);
    expect(result.status).toBe("completed");
    expect(result.coverage).toBe("complete");
    expect(result.errorCode).toBeUndefined();
    expect(result.provenance.teeAttestation).toBe("not_applicable");
    expect(result.provenance.cryptographicVerification).toBe("not_verified");
    expect(result.provenance.dataUseWarning).toBe(META_FREE_CREDIT_WARNING);
    expect(result.provenance.responseId).toBe("meta-completion-abc");

    expect(result.hypotheses).toHaveLength(1);
    const hyp = result.hypotheses[0]!;
    expect(hyp.hypothesisId).toMatch(/^meta-hyp-[a-f0-9]{64}$/);
    expect(hyp.provider).toBe(META_PROVIDER_NAME);
    expect(hyp.modelId).toBe(META_MODEL_ID);
    expect(hyp.origin).toBe("ai_hypothesis");
    expect(hyp.path).toBe("src/lib.rs");
    expect(hyp.startLine).toBe(3);
    expect(hyp.endLine).toBe(5);
    expect(hyp.excerpt).toContain("pub fn on_cb");

    // Deterministic findings must remain completely untouched
    expect(JSON.stringify(rule.deterministicAnalysis.findings)).toBe(
      findingsSnapshotBefore,
    );
  });

  it("rejects malformed JSON, schema violations, out-of-range lines, and duplicate ranges without accepting hypotheses", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);

    const invalidResponses: Response[] = [
      makeCompletionResponse("{not json"),
      makeCompletionResponse(JSON.stringify({ id: "bad-env", choices: [] })),
      makeCompletionResponse(
        JSON.stringify({
          id: "empty-content",
          choices: [{ message: { content: "   " } }],
        }),
      ),
      makeCompletionResponse(
        JSON.stringify({
          id: "non-json-content",
          choices: [{ message: { content: "plain markdown text" } }],
        }),
      ),
      makeCompletionResponse({
        findings: [
          {
            severity: "high",
            title: "Extra field should fail strict schema",
            rationale: "rationale",
            path: "src/lib.rs",
            startLine: 1,
            endLine: 2,
            confidence: 0.99,
          },
        ],
      }),
      makeCompletionResponse({
        findings: [
          {
            severity: "high",
            title: "Out of snapshot file",
            rationale: "rationale",
            path: "../outside.rs",
            startLine: 1,
            endLine: 1,
          },
        ],
      }),
      makeCompletionResponse({
        findings: [
          {
            severity: "high",
            title: "Out of bounds line",
            rationale: "rationale",
            path: "src/lib.rs",
            startLine: 1,
            endLine: 99,
          },
        ],
      }),
      makeCompletionResponse({
        findings: [
          {
            severity: "high",
            title: "First",
            rationale: "rationale",
            path: "src/lib.rs",
            startLine: 3,
            endLine: 4,
          },
          {
            severity: "low",
            title: "Duplicate range",
            rationale: "rationale",
            path: "src/lib.rs",
            startLine: 3,
            endLine: 4,
          },
        ],
      }),
    ];

    for (const mockResponse of invalidResponses) {
      const fetchFn = vi.fn(async () => mockResponse);
      const adapter = createMetaModelAdapter({
        getApiKey: () => "meta-secret",
        fetchFn,
      });

      const result = await adapter(
        snapshot,
        rule.deterministicAnalysis.findings,
        { sourceKind: "fixture" },
      );

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("failed");
      expect(result.coverage).toBe("incomplete");
      expect(result.errorCode).toBe("invalid_response");
      expect(result.hypotheses).toEqual([]);
    }
  });

  it("classifies HTTP 401/403, 429, 5xx, timeout, network errors, and oversized responses with zero retries and zero secret leaks", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const leakedSecret = "meta-super-secret-value-999";

    const httpCases = [
      { status: 401, expectedCode: "auth_failed" },
      { status: 403, expectedCode: "auth_failed" },
      { status: 429, expectedCode: "rate_limited" },
      { status: 500, expectedCode: "upstream_error" },
      { status: 503, expectedCode: "upstream_error" },
      { status: 400, expectedCode: "request_failed" },
    ] as const;

    for (const testCase of httpCases) {
      const fetchFn = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: `Upstream failed Authorization: Bearer ${leakedSecret}`,
            }),
            {
              status: testCase.status,
              headers: { "x-debug-secret": leakedSecret },
            },
          ),
      );

      const adapter = createMetaModelAdapter({
        getApiKey: () => leakedSecret,
        fetchFn,
      });

      const result = await adapter(
        snapshot,
        rule.deterministicAnalysis.findings,
        { sourceKind: "fixture" },
      );

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("failed");
      expect(result.coverage).toBe("incomplete");
      expect(result.errorCode).toBe(testCase.expectedCode);
      expect(JSON.stringify(result)).not.toContain(leakedSecret);
    }

    // Timeout / AbortError -> single attempt, no retry
    const abortFetch = vi.fn(async () => {
      throw new DOMException(
        `Timed out sending ${leakedSecret}`,
        "AbortError",
      );
    });
    const abortResult = await createMetaModelAdapter({
      getApiKey: () => leakedSecret,
      fetchFn: abortFetch,
    })(snapshot, rule.deterministicAnalysis.findings, { sourceKind: "fixture" });
    expect(abortFetch).toHaveBeenCalledTimes(1);
    expect(abortResult.status).toBe("failed");
    expect(abortResult.coverage).toBe("incomplete");
    expect(abortResult.errorCode).toBe("timeout");
    expect(JSON.stringify(abortResult)).not.toContain(leakedSecret);

    // Network transport failure -> single attempt, no retry
    const netError = Object.assign(
      new Error(`connect ECONNREFUSED 127.0.0.1 Bearer ${leakedSecret}`),
      { code: "ECONNREFUSED" },
    );
    const netFetch = vi.fn(async () => {
      throw netError;
    });
    const netResult = await createMetaModelAdapter({
      getApiKey: () => leakedSecret,
      fetchFn: netFetch,
    })(snapshot, rule.deterministicAnalysis.findings, { sourceKind: "fixture" });
    expect(netFetch).toHaveBeenCalledTimes(1);
    expect(netResult.status).toBe("failed");
    expect(netResult.coverage).toBe("incomplete");
    expect(netResult.errorCode).toBe("network_error");
    expect(JSON.stringify(netResult)).not.toContain(leakedSecret);

    // Oversized response -> bounded reader stops cleanly
    const hugeFetch = vi.fn(
      async () =>
        new Response("x".repeat(2048), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const hugeResult = await createMetaModelAdapter({
      getApiKey: () => leakedSecret,
      fetchFn: hugeFetch,
      maxResponseBytes: 512,
    })(snapshot, rule.deterministicAnalysis.findings, { sourceKind: "fixture" });
    expect(hugeFetch).toHaveBeenCalledTimes(1);
    expect(hugeResult.status).toBe("failed");
    expect(hugeResult.coverage).toBe("incomplete");
    expect(hugeResult.errorCode).toBe("response_too_large");
  });

  it("sanitizes helper classifications across status and operational error branches", () => {
    expect(classifyMetaHttpStatus(401).code).toBe("auth_failed");
    expect(classifyMetaHttpStatus(429).code).toBe("rate_limited");
    expect(classifyMetaHttpStatus(502).code).toBe("upstream_error");
    expect(
      classifyMetaOperationalError(new DOMException("aborted", "AbortError"))
        .code,
    ).toBe("timeout");
    expect(
      classifyMetaOperationalError(new TypeError("fetch failed")).code,
    ).toBe("network_error");
    expect(classifyMetaOperationalError(new Error("boom")).code).toBe(
      "request_failed",
    );
  });
});
