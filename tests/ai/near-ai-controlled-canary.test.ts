import { describe, expect, it, vi, type Mock } from "vitest";
import {
  executeNearAiControlledCanaryCli,
  executeNearAiControlledCanary,
} from "../../scripts/near-ai-controlled-canary.js";
import {
  createNearAiControlledCanaryClientOptions,
  NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
  NEAR_AI_CONTROLLED_CANARY_SYNTHETIC_PROMPT,
  runNearAiControlledCanary,
  type NearAiControlledCanaryOperatorApprovedDeployment,
  type NearAiControlledCanaryClient,
  type NearAiControlledCanaryClientFactory,
} from "../../src/ai/near-ai-controlled-canary.js";
import type { InferenceClientOptions } from "@nearai/inference-sdk/node";

const matchingMeasurements = {
  composeHash: "approved-compose-hash",
  osImageHash: "approved-os-image-hash",
};
const approvedDeployment: NearAiControlledCanaryOperatorApprovedDeployment = {
  model: NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
  ...matchingMeasurements,
};

type CanaryAttestation = Awaited<
  ReturnType<NearAiControlledCanaryClient["verify"]>
>;
type CanaryChatRequest =
  Parameters<NearAiControlledCanaryClient["chat"]["completions"]["create"]>[0];
type CanaryCompletion = Awaited<
  ReturnType<NearAiControlledCanaryClient["chat"]["completions"]["create"]>
>;
type CanaryVerifiedResponse = Awaited<
  ReturnType<NearAiControlledCanaryClient["verifyResponse"]>
>;

interface ClientMocks {
  readonly verify: Mock<(model: string) => Promise<CanaryAttestation>>;
  readonly completionCreate: Mock<
    (request: CanaryChatRequest) => Promise<CanaryCompletion>
  >;
  readonly verifyResponse: Mock<
    (id: string) => Promise<CanaryVerifiedResponse>
  >;
  readonly clearResponseCache: Mock<() => void>;
}

interface TestCanaryClient extends NearAiControlledCanaryClient {
  readonly verify: ClientMocks["verify"];
  readonly chat: {
    readonly completions: {
      readonly create: ClientMocks["completionCreate"];
    };
  };
  readonly verifyResponse: ClientMocks["verifyResponse"];
  readonly clearResponseCache: ClientMocks["clearResponseCache"];
}

function successfulModelAttestation(): CanaryAttestation["models"][number] {
  return {
    tcbStatus: "UpToDate",
    gpuEvidence: "verified",
    deploymentProvenance: "verified",
    deployment: {
      appCompose: "test-compose",
      runtimeMeasurements: { ...matchingMeasurements },
    },
  };
}

function successfulAttestation(): CanaryAttestation {
  return {
    gateway: {
      tcbStatus: "UpToDate",
      tlsBinding: { kind: "attested" },
    },
    models: [successfulModelAttestation()],
  };
}

function makeClient(overrides: {
  readonly verify?: ClientMocks["verify"];
  readonly create?: ClientMocks["completionCreate"];
  readonly verifyResponse?: ClientMocks["verifyResponse"];
  readonly clearResponseCache?: ClientMocks["clearResponseCache"];
} = {}): TestCanaryClient {
  return {
    verify:
      overrides.verify ??
      vi.fn(async (_model: string) => successfulAttestation()),
    chat: {
      completions: {
        create:
          overrides.create ??
          vi.fn(async (_request: CanaryChatRequest) => ({
            id: "completion-1",
            choices: [{ message: { content: "private response test value" } }],
          })),
      },
    },
    verifyResponse:
      overrides.verifyResponse ??
      vi.fn(async (id: string) => ({
        id,
        signatureKind: "provider_tee",
      })),
    clearResponseCache:
      overrides.clearResponseCache ?? vi.fn(() => {}),
  } satisfies TestCanaryClient;
}

function factoryFor(
  client: TestCanaryClient,
  onOptions?: (options: InferenceClientOptions) => void,
): NearAiControlledCanaryClientFactory {
  return (options) => {
    onOptions?.(options);
    return client;
  };
}

function runCanary(client: TestCanaryClient) {
  return runNearAiControlledCanary(
    "test-key",
    factoryFor(client),
    approvedDeployment,
  );
}

describe("NEAR AI controlled canary", () => {
  it("configures E2EE, Ed25519, strict TCB/GPU policy, TLS binding, and zero attestation cache", () => {
    const options = createNearAiControlledCanaryClientOptions(
      "test-key",
      approvedDeployment,
    );

    expect(options).toMatchObject({
      e2ee: true,
      signingAlgo: "ed25519",
      attestationCacheTimeToLiveMs: 0,
      gatewayVerification: {
        includeSpkiFingerprint: true,
        policy: { acceptedTcbStatuses: ["UpToDate"] },
      },
      modelVerification: {
        policy: {
          acceptedTcbStatuses: ["UpToDate"],
          gpuEvidence: "required",
        },
      },
    });
    expect(options.deploymentPolicy).toBeTypeOf("function");
    const deploymentVerifier =
      options.modelVerification?.verifiers?.deployment;
    expect(deploymentVerifier).toBeTypeOf("function");
    expect(() =>
      deploymentVerifier?.({
        appCompose: "test-compose",
        runtimeMeasurements: matchingMeasurements,
      }),
    ).not.toThrow();
    expect(() =>
      deploymentVerifier?.({
        appCompose: "test-compose",
        runtimeMeasurements: {
          ...matchingMeasurements,
          osImageHash: "unapproved-os-image-hash",
        },
      }),
    ).toThrow(
      "Canary deployment measurements do not match operator-approved measurements.",
    );
  });

  it("matches operator-approved measurements without claiming independent NEAR approval", async () => {
    const client = makeClient();
    const report = await runCanary(client);

    expect(report).toEqual({
      model: NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
      cryptographicAttestation: "verified",
      gatewayTlsBinding: "attested",
      localTofuPin: "not_used",
      operatorApprovedMeasurements: "matched",
      independentNearApproval: "not_established",
      responseSignature: "provider_tee",
      responseId: "completion-1",
    });
    expect(client.verify).toHaveBeenCalledExactlyOnceWith(
      NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
    );
    expect(client.chat.completions.create).toHaveBeenCalledExactlyOnceWith({
      model: NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
      messages: [
        { role: "user", content: NEAR_AI_CONTROLLED_CANARY_SYNTHETIC_PROMPT },
      ],
      max_tokens: 8,
    });
    expect(client.verifyResponse).toHaveBeenCalledExactlyOnceWith("completion-1");
    expect(client.clearResponseCache).toHaveBeenCalledOnce();
    expect(report.operatorApprovedMeasurements).toBe("matched");
    expect(report.independentNearApproval).toBe("not_established");
  });

  it.each([
    ["changed compose hash", { ...matchingMeasurements, composeHash: "changed" }],
    ["changed OS hash", { ...matchingMeasurements, osImageHash: "changed" }],
    ["missing compose hash", { osImageHash: matchingMeasurements.osImageHash }],
    ["missing OS hash", { composeHash: matchingMeasurements.composeHash }],
    ["empty compose hash", { ...matchingMeasurements, composeHash: "" }],
    ["empty OS hash", { ...matchingMeasurements, osImageHash: "" }],
    ["whitespace compose hash", { ...matchingMeasurements, composeHash: " \t\n " }],
    ["whitespace OS hash", { ...matchingMeasurements, osImageHash: " \t\n " }],
  ])("rejects %s before inference", async (_label, runtimeMeasurements) => {
    const client = makeClient({
      verify: vi.fn(async (_model: string): Promise<CanaryAttestation> => ({
        ...successfulAttestation(),
        models: [
          {
            ...successfulModelAttestation(),
            deployment: { appCompose: "test-compose", runtimeMeasurements },
          },
        ],
      })),
    });

    await expect(
      runCanary(client),
    ).rejects.toThrow();
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("rejects unchecked deployment provenance before inference", async () => {
    const client = makeClient({
      verify: vi.fn(async (_model: string): Promise<CanaryAttestation> => ({
        ...successfulAttestation(),
        models: [
          {
            ...successfulModelAttestation(),
            deploymentProvenance: "not_checked",
          },
        ],
      })),
    });

    await expect(runCanary(client)).rejects.toThrow(
      "Verified deployment provenance is required.",
    );
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(client.clearResponseCache).toHaveBeenCalledOnce();
  });

  it("rejects a wrong model ID in the deployment-policy callback", async () => {
    const options = createNearAiControlledCanaryClientOptions(
      "test-key",
      approvedDeployment,
    );
    const deploymentPolicy = options.deploymentPolicy;

    expect(deploymentPolicy).toBeDefined();
    await expect(async () =>
      deploymentPolicy?.({
        model: "another/model",
        deployment: {
          appCompose: "test-compose",
          runtimeMeasurements: matchingMeasurements,
        },
      }),
    ).rejects.toThrow(
      "Canary model does not match the fixed operator-approved model ID.",
    );
  });

  it.each([
    ["stale Gateway TCB", {
      ...successfulAttestation(),
      gateway: { tcbStatus: "OutOfDate", tlsBinding: { kind: "attested" } },
    }],
    ["stale model TCB", {
      ...successfulAttestation(),
      models: [{ ...successfulModelAttestation(), tcbStatus: "OutOfDate" }],
    }],
    ["missing model attestation", {
      ...successfulAttestation(),
      models: [],
    }],
    ["GPU evidence not provided", {
      ...successfulAttestation(),
      models: [{ ...successfulModelAttestation(), gpuEvidence: "not_provided" }],
    }],
    ["missing GPU evidence", {
      ...successfulAttestation(),
      models: [{
        tcbStatus: "UpToDate",
        deploymentProvenance: "verified",
        deployment: {
          appCompose: "test-compose",
          runtimeMeasurements: { ...matchingMeasurements },
        },
      }],
    }],
    ["unverified GPU evidence", {
      ...successfulAttestation(),
      models: [{ ...successfulModelAttestation(), gpuEvidence: "invalid" }],
    }],
    ["missing attested TLS binding", {
      ...successfulAttestation(),
      gateway: { tcbStatus: "UpToDate", tlsBinding: { kind: "none" } },
    }],
  ])("rejects %s before inference", async (_label, attestation) => {
    const client = makeClient({
      verify: vi.fn(async (_model: string): Promise<CanaryAttestation> => attestation),
    });

    await expect(
      runCanary(client),
    ).rejects.toThrow();
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it.each(["", " \t\n ", undefined])(
    "rejects a missing or blank API key (%s)",
    async (apiKey) => {
      const createClient = vi.fn();

      await expect(
        runNearAiControlledCanary(apiKey, createClient, approvedDeployment),
      ).rejects.toThrow("NEARAI_API_KEY is unavailable.");
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it("rejects missing operator approval before client creation", async () => {
    const createClient = vi.fn();

    await expect(
      runNearAiControlledCanary("test-key", createClient),
    ).rejects.toThrow("Operator-approved deployment measurements are unavailable.");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects an incorrect operator-approved model before client creation", async () => {
    const createClient = vi.fn();

    await expect(
      runNearAiControlledCanary("test-key", createClient, {
        ...approvedDeployment,
        model: "another/model",
      }),
    ).rejects.toThrow("Operator-approved deployment measurements are unavailable.");
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(["composeHash", "osImageHash"] as const)(
    "rejects a missing operator-approved %s before client creation",
    async (field) => {
      const createClient = vi.fn();
      const deployment = {
        ...approvedDeployment,
        ...(field === "composeHash"
          ? { composeHash: "" }
          : { osImageHash: "" }),
      };

      await expect(
        runNearAiControlledCanary("test-key", createClient, deployment),
      ).rejects.toThrow("Operator-approved deployment measurements are unavailable.");
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it("rejects deployment-policy approval mismatch before inference", async () => {
    const client = makeClient();
    const createClient: NearAiControlledCanaryClientFactory = (options) => {
      const deploymentPolicy = options.deploymentPolicy;
      if (deploymentPolicy === undefined) {
        throw new Error("Missing test deployment policy.");
      }
      return {
        ...client,
        verify: async (model) => {
          await deploymentPolicy({
            model,
            deployment: {
              appCompose: "test-compose",
              runtimeMeasurements: {
                ...matchingMeasurements,
                composeHash: "changed",
              },
            },
          });
          return successfulAttestation();
        },
      };
    };

    await expect(
      runNearAiControlledCanary("test-key", createClient, approvedDeployment),
    ).rejects.toThrow(
      "Canary deployment measurements do not match operator-approved measurements.",
    );
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("does not send inference when SDK verification fails", async () => {
    const client = makeClient({
      verify: vi.fn(async () => {
        throw new Error("sensitive raw SDK error");
      }),
    });

    await expect(
      runCanary(client),
    ).rejects.toThrow("sensitive raw SDK error");
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(client.clearResponseCache).toHaveBeenCalledOnce();
  });

  it("fails closed when the completion request fails", async () => {
    const client = makeClient({
      create: vi.fn(async () => {
        throw new Error("completion failed");
      }),
    });

    await expect(
      runCanary(client),
    ).rejects.toThrow("completion failed");
    expect(client.verifyResponse).not.toHaveBeenCalled();
  });

  it("rejects an absent completion response ID", async () => {
    const client = makeClient({
      create: vi.fn(async () => ({ id: " \t " })),
    });

    await expect(
      runCanary(client),
    ).rejects.toThrow("Canary completion response ID is unavailable.");
    expect(client.verifyResponse).not.toHaveBeenCalled();
  });

  it("rejects a mismatched verified response ID", async () => {
    const client = makeClient({
      verifyResponse: vi.fn(async () => ({
        id: "different-id",
        signatureKind: "provider_tee",
      })),
    });

    await expect(
      runCanary(client),
    ).rejects.toThrow("Verified response ID does not match the completion ID.");
  });

  it("rejects failed provider TEE signature verification", async () => {
    const client = makeClient({
      verifyResponse: vi.fn(async () => {
        throw new Error("invalid signature");
      }),
    });

    await expect(
      runCanary(client),
    ).rejects.toThrow("invalid signature");
  });

  it("rejects Gateway-only completion signatures", async () => {
    const client = makeClient({
      verifyResponse: vi.fn(async (id: string) => ({
        id,
        signatureKind: "gateway",
      })),
    });

    await expect(
      runCanary(client),
    ).rejects.toThrow("Provider TEE response signature is required.");
  });

  it("writes only the non-sensitive status report, never the prompt or response", async () => {
    const client = makeClient();
    const output: string[] = [];

    await executeNearAiControlledCanary(
      "test-key",
      (text) => output.push(text),
      factoryFor(client),
      approvedDeployment,
    );

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('"operatorApprovedMeasurements": "matched"');
    expect(output[0]).toContain('"independentNearApproval": "not_established"');
    expect(output.join("")).not.toContain(NEAR_AI_CONTROLLED_CANARY_SYNTHETIC_PROMPT);
    expect(output.join("")).not.toContain("private response test value");
    expect(output.join("")).not.toContain("test-key");
  });

  it("does not print an API key, prompt, response, or raw SDK error on CLI failure", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const client = makeClient({
      verify: vi.fn(async () => {
        throw new Error(
          "raw SDK error: test-key; prompt: Reply with OK.; private response test value",
        );
      }),
    });

    const succeeded = await executeNearAiControlledCanaryCli(
      "test-key",
      approvedDeployment,
      (text) => output.push(text),
      (text) => errors.push(text),
      factoryFor(client),
    );

    expect(succeeded).toBe(false);
    expect(output).toEqual([]);
    expect(errors).toEqual(["NEAR AI controlled canary failed.\n"]);
    const cliOutput = output.join("") + errors.join("");
    expect(cliOutput).not.toContain("test-key");
    expect(cliOutput).not.toContain(NEAR_AI_CONTROLLED_CANARY_SYNTHETIC_PROMPT);
    expect(cliOutput).not.toContain("private response test value");
    expect(cliOutput).not.toContain("raw SDK error");
    expect(client.clearResponseCache).toHaveBeenCalledOnce();
  });

  it("rejects a deployment-policy callback that receives empty or whitespace measurements", async () => {
    const options = createNearAiControlledCanaryClientOptions(
      "test-key",
      approvedDeployment,
    );
    const deploymentPolicy = options.deploymentPolicy;

    expect(deploymentPolicy).toBeDefined();
    for (const value of ["", " \t\n "]) {
      await expect(
        async () => deploymentPolicy?.({
          model: NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
          deployment: {
            appCompose: "test-compose",
            runtimeMeasurements: {
              composeHash: value,
              osImageHash: matchingMeasurements.osImageHash,
            },
          },
        }),
      ).rejects.toThrow(
        "Canary deployment measurements do not match operator-approved measurements.",
      );
    }
  });
});
