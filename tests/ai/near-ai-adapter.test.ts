import { ApiError, VerificationError } from "@nearai/inference-sdk/node";
import { describe, expect, it, vi } from "vitest";
import {
  classifyNearAiOperationalError,
  createNearAiAdapter,
  NEAR_AI_SDK_VERSION,
  type NearAiClient,
} from "../../src/ai/near-ai-adapter.js";
import { runNearRustCallbackPrivateRule } from "../../src/rules/near-rust-callback-private.js";
import { createSnapshotFromEntries } from "../../src/source/custom-snapshot.js";

const APPROVED_DEPLOYMENT = {
  composeHash: "compose-hash-approved",
  osImageHash: "os-image-hash-approved",
} as const;

function makeModelAttestation(overrides: Record<string, unknown> = {}) {
  return {
    signer: {
      signingAlgo: "ed25519",
      signingAddress: "model-signer-1",
    },
    tcbStatus: "UpToDate",
    advisoryIds: [],
    deployment: {
      appCompose: "services:\n  model: {}\n",
      runtimeMeasurements: {
        composeHash: APPROVED_DEPLOYMENT.composeHash,
        osImageHash: APPROVED_DEPLOYMENT.osImageHash,
      },
    },
    deploymentProvenance: "verified",
    report: { mrtd: "ok" },
    gpuEvidence: "verified",
    signingPublicKey: "ed25519-pub-key",
    ...overrides,
  };
}

function makeGatewayAttestation(overrides: Record<string, unknown> = {}) {
  return {
    signer: {
      signingAlgo: "ed25519",
      signingAddress: "gateway-signer-1",
    },
    tcbStatus: "UpToDate",
    advisoryIds: [],
    deployment: {
      appCompose: "services:\n  gateway: {}\n",
      runtimeMeasurements: {
        composeHash: "gw-compose",
        osImageHash: "gw-os",
      },
    },
    deploymentProvenance: "verified",
    report: { mrtd: "ok" },
    tlsBinding: {
      kind: "attested",
      spkiFingerprint: "gateway-spki-fp-1",
    },
    ...overrides,
  };
}

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

describe("createNearAiAdapter policy and verification", () => {
  it("refuses to run without calling provider when approved measurements or API key are missing", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const verify = vi.fn();
    const createChatCompletion = vi.fn();

    const noDeployments = createNearAiAdapter({
      approvedModelDeployments: [],
      getApiKey: () => "test-key",
      createClient: () =>
        ({
          verify,
          createChatCompletion,
          verifyResponse: vi.fn(),
        }) satisfies NearAiClient,
    });

    let transmitted = false;
    const res1 = await noDeployments(
      snapshot,
      rule.deterministicAnalysis.findings,
      { onSourceTransmission: () => { transmitted = true; } },
    );
    expect(res1.status).toBe("failed");
    expect(res1.coverage).toBe("not_run");
    expect(res1.provenance.privateModelPolicy).toBe("unavailable");
    expect(transmitted).toBe(false);
    expect(verify).not.toHaveBeenCalled();

    const noApiKey = createNearAiAdapter({
      approvedModelDeployments: [APPROVED_DEPLOYMENT],
      getApiKey: () => undefined,
      createClient: () =>
        ({
          verify,
          createChatCompletion,
          verifyResponse: vi.fn(),
        }) satisfies NearAiClient,
    });

    const res2 = await noApiKey(
      snapshot,
      rule.deterministicAnalysis.findings,
    );
    expect(res2.status).toBe("not_run");
    expect(res2.coverage).toBe("not_run");
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects non-frozen snapshots and empty 0-line snapshots before contacting provider", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const mutableSnapshot = { ...snapshot };
    const createClient = vi.fn();

    const adapter = createNearAiAdapter({
      approvedModelDeployments: [APPROVED_DEPLOYMENT],
      getApiKey: () => "test-key",
      createClient,
    });

    const nonFrozenRes = await adapter(
      mutableSnapshot,
      rule.deterministicAnalysis.findings,
    );
    expect(nonFrozenRes.status).toBe("failed");
    expect(nonFrozenRes.coverage).toBe("not_run");
    expect(nonFrozenRes.provenance.privateModelPolicy).toBe("rejected");
    expect(createClient).not.toHaveBeenCalled();

    const emptySnapshot = createSnapshotFromEntries([
      { path: "empty.rs", content: "" },
    ]);
    const emptyRes = await adapter(emptySnapshot, []);
    expect(emptyRes.status).toBe("partial");
    expect(emptyRes.coverage).toBe("not_run");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("blocks source transmission if model measurements or TCB status are unapproved", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const createChatCompletion = vi.fn();

    const adapter = createNearAiAdapter({
      approvedModelDeployments: [APPROVED_DEPLOYMENT],
      getApiKey: () => "test-key",
      createClient: () => ({
        verify: async () => ({
          gateway: makeGatewayAttestation(),
          models: [
            makeModelAttestation({
              deployment: {
                appCompose: "bad",
                runtimeMeasurements: {
                  composeHash: "wrong-compose-hash",
                  osImageHash: APPROVED_DEPLOYMENT.osImageHash,
                },
              },
            }),
          ],
          verifiedAt: Date.now(),
        }),
        createChatCompletion,
        verifyResponse: vi.fn(),
      }),
    });

    let transmitted = false;
    const res = await adapter(snapshot, rule.deterministicAnalysis.findings, {
      onSourceTransmission: () => {
        transmitted = true;
      },
    });
    expect(res.status).toBe("failed");
    expect(res.coverage).toBe("not_run");
    expect(res.provenance.modelAttestationVerification).toBe("failed");
    expect(res.provenance.privateModelPolicy).toBe("rejected");
    expect(transmitted).toBe(false);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("rejects gateway-signed responses and out-of-range AI candidate lines", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const modelAtt = makeModelAttestation();

    const gatewaySignedAdapter = createNearAiAdapter({
      approvedModelDeployments: [APPROVED_DEPLOYMENT],
      getApiKey: () => "test-key",
      createClient: () => ({
        verify: async () => ({
          gateway: makeGatewayAttestation(),
          models: [modelAtt],
          verifiedAt: Date.now(),
        }),
        createChatCompletion: async () => ({
          id: "resp-1",
          choices: [
            {
              message: {
                content: JSON.stringify({ findings: [] }),
              },
            },
          ],
        }),
        verifyResponse: async () => ({
          id: "resp-1",
          completionId: "resp-1",
          signatureKind: "gateway",
          signature: {
            kind: "gateway",
            signer: { signingAlgo: "ed25519", signingAddress: "gateway-signer-1" },
            signedText: "{}",
            signature: "sig",
          },
          attestation: makeGatewayAttestation(),
        }),
      }),
    });

    const gatewayRes = await gatewaySignedAdapter(
      snapshot,
      rule.deterministicAnalysis.findings,
    );
    expect(gatewayRes.status).toBe("failed");
    expect(gatewayRes.coverage).toBe("incomplete");
    expect(gatewayRes.provenance.privateModelPolicy).toBe("rejected");
    expect(gatewayRes.findings).toHaveLength(0);

    const outOfRangeAdapter = createNearAiAdapter({
      approvedModelDeployments: [APPROVED_DEPLOYMENT],
      getApiKey: () => "test-key",
      createClient: () => ({
        verify: async () => ({
          gateway: makeGatewayAttestation(),
          models: [modelAtt],
          verifiedAt: Date.now(),
        }),
        createChatCompletion: async () => ({
          id: "resp-2",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  findings: [
                    {
                      severity: "medium",
                      title: "Out of bounds claim",
                      rationale: "References line 999",
                      path: "src/lib.rs",
                      startLine: 1,
                      endLine: 999,
                    },
                  ],
                }),
              },
            },
          ],
        }),
        verifyResponse: async () => ({
          id: "resp-2",
          completionId: "resp-2",
          signatureKind: "provider_tee",
          signature: {
            kind: "provider_tee",
            signer: { signingAlgo: "ed25519", signingAddress: "model-signer-1" },
            signedText: "{}",
            signature: "sig",
          },
          attestations: [modelAtt],
          attestation: modelAtt,
        }),
      }),
    });

    const rangeRes = await outOfRangeAdapter(
      snapshot,
      rule.deterministicAnalysis.findings,
    );
    expect(rangeRes.status).toBe("failed");
    expect(rangeRes.coverage).toBe("incomplete");
    expect(rangeRes.findings).toHaveLength(0);
  });

  it("accepts verified provider_tee hypotheses and validates their snapshot evidence", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const modelAtt = makeModelAttestation();

    const adapter = createNearAiAdapter({
      approvedModelDeployments: [APPROVED_DEPLOYMENT],
      getApiKey: () => "test-key",
      createClient: () => ({
        verify: async () => ({
          gateway: makeGatewayAttestation(),
          models: [modelAtt],
          verifiedAt: Date.now(),
        }),
        createChatCompletion: async () => ({
          id: "resp-valid",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  findings: [
                    {
                      severity: "low",
                      title: "Potential state mutation without event log",
                      rationale: "Consider emitting an event after updating state.",
                      path: "src/lib.rs",
                      startLine: 3,
                      endLine: 5,
                    },
                  ],
                }),
              },
            },
          ],
        }),
        verifyResponse: async () => ({
          id: "resp-valid",
          completionId: "resp-valid",
          signatureKind: "provider_tee",
          signature: {
            kind: "provider_tee",
            signer: { signingAlgo: "ed25519", signingAddress: "model-signer-1" },
            signedText: "{}",
            signature: "sig",
          },
          attestations: [modelAtt],
          attestation: modelAtt,
        }),
      }),
    });

    let transmitted = false;
    const res = await adapter(snapshot, rule.deterministicAnalysis.findings, {
      onSourceTransmission: () => {
        transmitted = true;
      },
    });
    expect(transmitted).toBe(true);
    expect(res.status).toBe("complete");
    expect(res.coverage).toBe("complete");
    expect(res.provenance.sdkVersion).toBe(NEAR_AI_SDK_VERSION);
    expect(res.provenance.privateModelPolicy).toBe("passed");
    expect(res.provenance.responseVerification).toBe("verified");
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.origin).toBe("ai_hypothesis");
    expect(res.evidence[0]?.validationStatus).toBe("validated");
    expect(res.evidenceExcerpts[0]?.excerpt).toContain("pub fn on_cb");
  });

  it("reports coverage: incomplete (never complete) when SDK completion or response verification fails after transmission attempt", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const modelAtt = makeModelAttestation();

    // 1. SDK completion call throws after onSourceTransmission
    const completionFailureAdapter = createNearAiAdapter({
      approvedModelDeployments: [APPROVED_DEPLOYMENT],
      getApiKey: () => "test-key",
      createClient: () => ({
        verify: async () => ({
          gateway: makeGatewayAttestation(),
          models: [modelAtt],
          verifiedAt: Date.now(),
        }),
        createChatCompletion: async () => {
          throw new Error("network timeout");
        },
        verifyResponse: vi.fn(),
      }),
    });

    let call1Attempted = false;
    const call1Res = await completionFailureAdapter(
      snapshot,
      rule.deterministicAnalysis.findings,
      {
        onSourceTransmission: () => {
          call1Attempted = true;
        },
      },
    );
    expect(call1Attempted).toBe(true);
    expect(call1Res.status).toBe("failed");
    expect(call1Res.coverage).toBe("incomplete");
    expect(call1Res.provenance.privateModelPolicy).toBe("unavailable");

    // 2. verifyResponse throws after completion succeeds
    const verifyThrowsAdapter = createNearAiAdapter({
      approvedModelDeployments: [APPROVED_DEPLOYMENT],
      getApiKey: () => "test-key",
      createClient: () => ({
        verify: async () => ({
          gateway: makeGatewayAttestation(),
          models: [modelAtt],
          verifiedAt: Date.now(),
        }),
        createChatCompletion: async () => ({
          id: "resp-verify-err",
          choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
        }),
        verifyResponse: async () => {
          throw new Error("signature check failed");
        },
      }),
    });

    let call2Attempted = false;
    const call2Res = await verifyThrowsAdapter(
      snapshot,
      rule.deterministicAnalysis.findings,
      {
        onSourceTransmission: () => {
          call2Attempted = true;
        },
      },
    );
    expect(call2Attempted).toBe(true);
    expect(call2Res.status).toBe("failed");
    expect(call2Res.coverage).toBe("incomplete");
    expect(call2Res.provenance.responseVerification).toBe("failed");

    // 3. Invalid JSON returned from model
    const badJsonAdapter = createNearAiAdapter({
      approvedModelDeployments: [APPROVED_DEPLOYMENT],
      getApiKey: () => "test-key",
      createClient: () => ({
        verify: async () => ({
          gateway: makeGatewayAttestation(),
          models: [modelAtt],
          verifiedAt: Date.now(),
        }),
        createChatCompletion: async () => ({
          id: "resp-bad-json",
          choices: [{ message: { content: "{not valid json" } }],
        }),
        verifyResponse: async () => ({
          id: "resp-bad-json",
          completionId: "resp-bad-json",
          signatureKind: "provider_tee",
          signature: {
            kind: "provider_tee",
            signer: { signingAlgo: "ed25519", signingAddress: "model-signer-1" },
            signedText: "{}",
            signature: "sig",
          },
          attestations: [modelAtt],
          attestation: modelAtt,
        }),
      }),
    });

    const badJsonRes = await badJsonAdapter(
      snapshot,
      rule.deterministicAnalysis.findings,
    );
    expect(badJsonRes.status).toBe("failed");
    expect(badJsonRes.coverage).toBe("incomplete");
    expect(badJsonRes.errorCode).toBe("invalid_response");
  });

  it("requires includeSpkiFingerprint and rejects none, missing, empty, or malformed gateway TLS bindings", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const modelAtt = makeModelAttestation();
    let capturedOptions: unknown;

    const rejectedBindings: unknown[] = [
      { kind: "none" },
      undefined,
      { kind: "attested" },
      { kind: "attested", spkiFingerprint: "" },
      { kind: "attested", spkiFingerprint: "   " },
      "malformed",
      {},
    ];

    for (const tlsBinding of rejectedBindings) {
      const createChatCompletion = vi.fn();
      let transmitted = false;
      const gatewayWithBinding = makeGatewayAttestation();
      if (tlsBinding === undefined) {
        delete (gatewayWithBinding as Record<string, unknown>).tlsBinding;
      } else {
        (gatewayWithBinding as Record<string, unknown>).tlsBinding = tlsBinding;
      }

      const adapter = createNearAiAdapter({
        approvedModelDeployments: [APPROVED_DEPLOYMENT],
        getApiKey: () => "test-key",
        createClient: (options) => {
          capturedOptions = options;
          return {
            verify: async () => ({
              gateway: gatewayWithBinding,
              models: [modelAtt],
              verifiedAt: Date.now(),
            }),
            createChatCompletion,
            verifyResponse: vi.fn(),
          };
        },
      });

      const res = await adapter(snapshot, rule.deterministicAnalysis.findings, {
        onSourceTransmission: () => {
          transmitted = true;
        },
      });

      expect(
        (
          capturedOptions as {
            gatewayVerification?: { includeSpkiFingerprint?: boolean };
          }
        )?.gatewayVerification?.includeSpkiFingerprint,
      ).toBe(true);
      expect(res.status).toBe("failed");
      expect(res.coverage).toBe("not_run");
      expect(res.errorCode).toBe("tls_binding_rejected");
      expect(res.provenance.gatewayVerification).toBe("failed");
      expect(res.provenance.privateModelPolicy).toBe("rejected");
      expect(transmitted).toBe(false);
      expect(createChatCompletion).not.toHaveBeenCalled();
    }
  });

  it("classifies SDK and operational failures into sanitized error codes without guessing auth_failed or leaking raw error text", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);
    const modelAtt = makeModelAttestation();

    // 1. client_initialization_failed (raw error message with secret never leaked)
    const initFailAdapter = createNearAiAdapter({
      approvedModelDeployments: [APPROVED_DEPLOYMENT],
      getApiKey: () => "secret-api-key-should-not-leak",
      createClient: () => {
        throw new Error(
          "Authorization: Bearer secret-api-key-should-not-leak failed",
        );
      },
    });
    const initFailRes = await initFailAdapter(
      snapshot,
      rule.deterministicAnalysis.findings,
    );
    expect(initFailRes.errorCode).toBe("client_initialization_failed");
    expect(initFailRes.coverage).toBe("not_run");
    expect(initFailRes.limitations.join(" ")).not.toContain("secret-api-key");

    // 2. auth_failed ONLY for HTTP 401/403 ApiError, never guessed for generic errors
    const auth401 = new ApiError({
      code: "api.http_status",
      details: { resource: "completion", status: 401 },
      retryable: false,
    });
    expect(classifyNearAiOperationalError(auth401, "inference").code).toBe(
      "auth_failed",
    );

    const auth403 = new ApiError({
      code: "api.http_status",
      details: { resource: "gateway_attestation", status: 403 },
      retryable: false,
    });
    expect(classifyNearAiOperationalError(auth403, "attestation").code).toBe(
      "auth_failed",
    );

    const genericUnauthorized = new Error(
      "unauthorized token=raw-secret-value-999",
    );
    const genericClassified = classifyNearAiOperationalError(
      genericUnauthorized,
      "inference",
    );
    expect(genericClassified.code).toBe("inference_failed");
    expect(genericClassified.message).not.toContain("raw-secret-value-999");

    // 3. network_error for transport failure, 5xx ApiError, and Node network error code
    const transportErr = new ApiError({
      code: "api.transport_failed",
      details: { resource: "completion", reason: "request" },
      retryable: true,
    });
    expect(classifyNearAiOperationalError(transportErr, "inference").code).toBe(
      "network_error",
    );

    const server503 = new ApiError({
      code: "api.http_status",
      details: { resource: "completion", status: 503 },
      retryable: true,
    });
    expect(classifyNearAiOperationalError(server503, "inference").code).toBe(
      "network_error",
    );

    const nodeConnRefused = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:443"),
      { code: "ECONNREFUSED" },
    );
    expect(
      classifyNearAiOperationalError(nodeConnRefused, "attestation").code,
    ).toBe("network_error");

    // 4. VerificationError SPKI mismatch -> tls_binding_rejected
    const spkiMismatch = new VerificationError({
      code: "binding.spki_fingerprint_mismatch",
    });
    expect(classifyNearAiOperationalError(spkiMismatch, "attestation").code).toBe(
      "tls_binding_rejected",
    );

    // 5. VerificationError TCB disallowed -> measurement_mismatch
    const tcbRejected = new VerificationError({
      code: "policy.tcb_status_not_allowed",
      details: {
        actual: "OutOfDate",
        accepted: ["UpToDate"],
        advisoryIds: [],
      },
    });
    expect(classifyNearAiOperationalError(tcbRejected, "attestation").code).toBe(
      "measurement_mismatch",
    );

    // 6. ApiError invalid_json -> invalid_response; response verification error -> response_verification_failed
    const invalidJsonErr = new ApiError({
      code: "api.invalid_json",
      details: { resource: "completion" },
    });
    expect(classifyNearAiOperationalError(invalidJsonErr, "inference").code).toBe(
      "invalid_response",
    );

    const sigErr = new VerificationError({ code: "ohttp.signature_invalid" });
    expect(
      classifyNearAiOperationalError(sigErr, "response_verification").code,
    ).toBe("response_verification_failed");

    // 7. End-to-end adapter rejection on 401 ApiError during completion
    const authFailAdapter = createNearAiAdapter({
      approvedModelDeployments: [APPROVED_DEPLOYMENT],
      getApiKey: () => "sk-live-secret-12345",
      createClient: () => ({
        verify: async () => ({
          gateway: makeGatewayAttestation(),
          models: [modelAtt],
          verifiedAt: Date.now(),
        }),
        createChatCompletion: async () => {
          throw new ApiError(
            {
              code: "api.http_status",
              details: { resource: "completion", status: 401 },
              retryable: false,
            },
            { cause: new Error("Bearer sk-live-secret-12345 rejected") },
          );
        },
        verifyResponse: vi.fn(),
      }),
    });

    const authFailRes = await authFailAdapter(
      snapshot,
      rule.deterministicAnalysis.findings,
    );
    expect(authFailRes.status).toBe("failed");
    expect(authFailRes.coverage).toBe("incomplete");
    expect(authFailRes.errorCode).toBe("auth_failed");
    expect(authFailRes.limitations.join(" ")).not.toContain(
      "sk-live-secret-12345",
    );
  });

  it("classifies VerificationError policy.model_attestation_required as model_attestation_required (distinct from measurement_mismatch)", async () => {
    const snapshot = makeSampleSnapshot();
    const rule = runNearRustCallbackPrivateRule(snapshot);

    const modelAttRequiredErr = new VerificationError({
      code: "policy.model_attestation_required",
    });
    const classifiedAtt = classifyNearAiOperationalError(
      modelAttRequiredErr,
      "attestation",
    );
    expect(classifiedAtt.code).toBe("model_attestation_required");
    expect(classifiedAtt.code).not.toBe("measurement_mismatch");

    const composeMismatchErr = new VerificationError({
      code: "provenance.compose_file_hash_mismatch",
      details: {
        repository: "example/repo",
        commit: "0123456789abcdef",
        file: "docker-compose.yml",
      },
    });
    expect(
      classifyNearAiOperationalError(composeMismatchErr, "attestation").code,
    ).toBe("measurement_mismatch");

    const createChatCompletion = vi.fn();
    let transmitted = false;
    const incognitoRejectedAdapter = createNearAiAdapter({
      approvedModelDeployments: [APPROVED_DEPLOYMENT],
      getApiKey: () => "test-key",
      createClient: () => ({
        verify: async () => {
          throw new VerificationError({
            code: "policy.model_attestation_required",
          });
        },
        createChatCompletion,
        verifyResponse: vi.fn(),
      }),
    });

    const res = await incognitoRejectedAdapter(
      snapshot,
      rule.deterministicAnalysis.findings,
      {
        onSourceTransmission: () => {
          transmitted = true;
        },
      },
    );
    expect(res.status).toBe("failed");
    expect(res.coverage).toBe("not_run");
    expect(res.errorCode).toBe("model_attestation_required");
    expect(res.provenance.modelAttestationVerification).toBe("failed");
    expect(res.provenance.privateModelPolicy).toBe("rejected");
    expect(transmitted).toBe(false);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });
});
