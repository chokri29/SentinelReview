import { describe, expect, it, vi } from "vitest";
import {
  createNearAiAdapter,
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
    tlsBinding: { kind: "none" },
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
    expect(nonFrozenRes.provenance.privateModelPolicy).toBe("rejected");
    expect(createClient).not.toHaveBeenCalled();

    const emptySnapshot = createSnapshotFromEntries([
      { path: "empty.rs", content: "" },
    ]);
    const emptyRes = await adapter(emptySnapshot, []);
    expect(emptyRes.status).toBe("partial");
    expect(emptyRes.coverage).toBe("incomplete");
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
    expect(res.provenance.privateModelPolicy).toBe("passed");
    expect(res.provenance.responseVerification).toBe("verified");
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.origin).toBe("ai_hypothesis");
    expect(res.evidence[0]?.validationStatus).toBe("validated");
    expect(res.evidenceExcerpts[0]?.excerpt).toContain("pub fn on_cb");
  });
});
