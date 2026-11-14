import { describe, expect, it, vi } from "vitest";
import {
  createNearAiControlledCanaryClientOptions,
  NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
  NEAR_AI_CONTROLLED_CANARY_SYNTHETIC_PROMPT,
  runNearAiControlledCanary,
  type NearAiControlledCanaryClient,
  type NearAiControlledCanaryOperatorApprovedDeployment,
} from "../../src/ai/near-ai-controlled-canary.js";

const APPROVED: NearAiControlledCanaryOperatorApprovedDeployment = {
  model: NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
  composeHash: "canary-compose-hash-approved",
  osImageHash: "canary-os-image-hash-approved",
};

type CanaryVerifyResult = Awaited<ReturnType<NearAiControlledCanaryClient["verify"]>>;

function makeAttestation(overrides: {
  gateway?: Partial<CanaryVerifyResult["gateway"]>;
  models?: CanaryVerifyResult["models"];
} = {}): CanaryVerifyResult {
  return {
    gateway: {
      tcbStatus: "UpToDate",
      tlsBinding: { kind: "attested" },
      ...overrides.gateway,
    },
    models: overrides.models ?? [
      {
        tcbStatus: "UpToDate",
        gpuEvidence: "verified",
        deploymentProvenance: "verified",
        deployment: {
          appCompose: "services:\n  model: {}\n",
          runtimeMeasurements: {
            composeHash: APPROVED.composeHash,
            osImageHash: APPROVED.osImageHash,
          },
        },
      },
    ],
  };
}

describe("near-ai-controlled-canary", () => {
  it("constructs strict client options and enforces deploymentPolicy / model verifier", () => {
    expect(() =>
      createNearAiControlledCanaryClientOptions("", APPROVED),
    ).toThrow(/NEARAI_API_KEY/i);

    expect(() =>
      createNearAiControlledCanaryClientOptions("key", {
        ...APPROVED,
        model: "other/model",
      }),
    ).toThrow(/unavailable/i);

    const options = createNearAiControlledCanaryClientOptions("key", APPROVED);
    expect(options.e2ee).toBe(true);
    expect(options.signingAlgo).toBe("ed25519");
    expect(options.attestationCacheTimeToLiveMs).toBe(0);
    expect(options.gatewayVerification?.policy?.acceptedTcbStatuses).toEqual([
      "UpToDate",
    ]);
    expect(options.modelVerification?.policy?.acceptedTcbStatuses).toEqual([
      "UpToDate",
    ]);
    expect(options.modelVerification?.policy?.gpuEvidence).toBe("required");

    expect(() =>
      options.deploymentPolicy?.({
        model: NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
        deployment: {
          appCompose: "x",
          runtimeMeasurements: {
            composeHash: "wrong-compose",
            osImageHash: APPROVED.osImageHash,
          },
        },
      }),
    ).toThrow(/do not match/i);
  });

  it("refuses execution before client creation when API key or measurements are unavailable", async () => {
    const factory = vi.fn();

    await expect(
      runNearAiControlledCanary(undefined, factory, APPROVED),
    ).rejects.toThrow(/NEARAI_API_KEY/i);

    await expect(
      runNearAiControlledCanary("key", factory, undefined),
    ).rejects.toThrow(/measurements are unavailable/i);

    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects non-attested gateway TLS, unverified GPU, or wrong measurements and clears cache", async () => {
    const clearResponseCache = vi.fn();
    const createCompletion = vi.fn();

    const makeMockClient = (
      attestation: ReturnType<typeof makeAttestation>,
    ): NearAiControlledCanaryClient => ({
      verify: async () => attestation,
      chat: { completions: { create: createCompletion } },
      verifyResponse: vi.fn(),
      clearResponseCache,
    });

    await expect(
      runNearAiControlledCanary(
        "key",
        () =>
          makeMockClient(
            makeAttestation({ gateway: { tcbStatus: "UpToDate", tlsBinding: { kind: "none" } } }),
          ),
        APPROVED,
      ),
    ).rejects.toThrow(/Attested Gateway TLS binding/i);

    await expect(
      runNearAiControlledCanary(
        "key",
        () =>
          makeMockClient(
            makeAttestation({
              models: [
                {
                  tcbStatus: "UpToDate",
                  gpuEvidence: "missing",
                  deploymentProvenance: "verified",
                  deployment: {
                    appCompose: "x",
                    runtimeMeasurements: {
                      composeHash: APPROVED.composeHash,
                      osImageHash: APPROVED.osImageHash,
                    },
                  },
                },
              ],
            }),
          ),
        APPROVED,
      ),
    ).rejects.toThrow(/GPU evidence/i);

    expect(createCompletion).not.toHaveBeenCalled();
    expect(clearResponseCache).toHaveBeenCalledTimes(2);
  });

  it("requires provider_tee response signature and matching completion ID, and verifies synthetic prompt result", async () => {
    const clearResponseCache = vi.fn();
    const createCompletion = vi.fn(async () => ({ id: "canary-resp-1" }));

    await expect(
      runNearAiControlledCanary(
        "key",
        () => ({
          verify: async () => makeAttestation(),
          chat: { completions: { create: createCompletion } },
          verifyResponse: async () => ({
            id: "canary-resp-1",
            signatureKind: "gateway",
          }),
          clearResponseCache,
        }),
        APPROVED,
      ),
    ).rejects.toThrow(/Provider TEE response signature/i);

    const report = await runNearAiControlledCanary(
      "key",
      () => ({
        verify: async () => makeAttestation(),
        chat: { completions: { create: createCompletion } },
        verifyResponse: async () => ({
          id: "canary-resp-1",
          signatureKind: "provider_tee",
        }),
        clearResponseCache,
      }),
      APPROVED,
    );

    expect(createCompletion).toHaveBeenCalledWith({
      model: NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
      messages: [
        { role: "user", content: NEAR_AI_CONTROLLED_CANARY_SYNTHETIC_PROMPT },
      ],
      max_tokens: 8,
    });
    expect(report).toEqual({
      model: NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
      cryptographicAttestation: "verified",
      gatewayTlsBinding: "attested",
      localTofuPin: "not_used",
      operatorApprovedMeasurements: "matched",
      independentNearApproval: "not_established",
      responseSignature: "provider_tee",
      responseId: "canary-resp-1",
    });
    expect(clearResponseCache).toHaveBeenCalledTimes(2);
  });
});
