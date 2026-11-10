import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  VerificationError,
} from "@nearai/inference-sdk/node";
import {
  buildDiscoveryReport,
  collectDiscoveryReport,
  createDiscoveryClientOptions,
  executeNearAiAttestationDiscovery,
  NEAR_AI_DISCOVERY_MODEL_ID,
  runNearAiAttestationDiscoveryCli,
} from "../../scripts/near-ai-attestation-discovery.js";

const successfulModelAttestation = {
  tcbStatus: "UpToDate" as const,
  gpuEvidence: "verified" as const,
  deploymentProvenance: "not_checked" as const,
  deployment: {
    runtimeMeasurements: {
      composeHash: "compose-measurement",
      osImageHash: "os-measurement",
    },
  },
};

const successfulResult = {
  gateway: { tcbStatus: "UpToDate" as const },
  models: [successfulModelAttestation],
};

function httpStatusFailureWithResource(resource: string | undefined): ApiError {
  const error = new ApiError({
    code: "api.http_status",
    details: { resource: "model_attestation", status: 500 },
    retryable: true,
  });
  Object.defineProperty(error, "failure", {
    value: {
      code: "api.http_status",
      details:
        resource === undefined
          ? { status: 500 }
          : { resource, status: 500 },
      retryable: true,
    },
  });
  return error;
}

describe("NEAR AI attestation discovery", () => {
  it("uses strict attestation settings without deployment callbacks", () => {
    const options = createDiscoveryClientOptions("test-only-not-a-real-key");

    expect(options).toMatchObject({
      e2ee: true,
      signingAlgo: "ed25519",
      attestationCacheTimeToLiveMs: 0,
      gatewayVerification: {
        policy: { acceptedTcbStatuses: ["UpToDate"] },
      },
      modelVerification: {
        policy: {
          acceptedTcbStatuses: ["UpToDate"],
          gpuEvidence: "required",
        },
      },
    });
    expect(options.deploymentPolicy).toBeUndefined();
    expect(options.modelVerification?.verifiers).toBeUndefined();
  });

  it("verifies exactly the target model and returns only approved summary fields", async () => {
    const verify = vi.fn(async (model: string) => {
      expect(model).toBe(NEAR_AI_DISCOVERY_MODEL_ID);
      return successfulResult;
    });

    const report = await collectDiscoveryReport({ verify });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith("z-ai/glm-5.3-flash");
    expect(report).toEqual({
      model: "z-ai/glm-5.3-flash",
      gatewayTcbStatus: "UpToDate",
      modelAttestations: [
        {
          tcbStatus: "UpToDate",
          gpuEvidence: "verified",
          deploymentProvenance: "not_checked",
          measurementApproval: "not_approved",
          composeHash: "compose-measurement",
          osImageHash: "os-measurement",
        },
      ],
    });
  });

  it.each(["", " \t\n ", undefined])(
    "reports a missing or blank API key without initializing the SDK (%s)",
    async (apiKey) => {
      const createClient = vi.fn();
      const output: string[] = [];
      const errors: string[] = [];

      const succeeded = await executeNearAiAttestationDiscovery(
        apiKey,
        (text) => output.push(text),
        (text) => errors.push(text),
        createClient,
      );

      expect(succeeded).toBe(false);
      expect(createClient).not.toHaveBeenCalled();
      expect(output).toEqual([]);
      expect(errors.join("")).toContain(
        "during configuration: NEARAI_API_KEY is missing or blank",
      );
    },
  );

  it("reports SDK initialization failure without exposing the error", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const succeeded = await executeNearAiAttestationDiscovery(
      "test-only-not-a-real-key",
      (text) => output.push(text),
      (text) => errors.push(text),
      () => {
        throw new Error(
          "test-only-not-a-real-key Authorization: Bearer private-token; request body and source code",
        );
      },
    );

    expect(succeeded).toBe(false);
    expect(output).toEqual([]);
    expect(errors.join("")).toContain(
      "during SDK initialization: SDK client initialization failed",
    );
    expect(errors.join("")).not.toContain("test-only-not-a-real-key");
    expect(errors.join("")).not.toContain("private-token");
    expect(errors.join("")).not.toContain("request body");
    expect(errors.join("")).not.toContain("source code");
  });

  it("classifies transport failures without exposing SDK error details", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const transportFailure = new ApiError({
      code: "api.transport_failed",
      details: { resource: "gateway_attestation", reason: "request" },
      retryable: true,
    });

    const succeeded = await executeNearAiAttestationDiscovery(
      "test-only-not-a-real-key",
      (text) => output.push(text),
      (text) => errors.push(text),
      () => ({
        verify: async () => {
          throw transportFailure;
        },
      }),
    );

    expect(succeeded).toBe(false);
    expect(output).toEqual([]);
    expect(errors.join("")).toContain(
      "during network/TLS connectivity: attestation service transport failure",
    );
    expect(errors.join("")).not.toContain(transportFailure.message);
  });

  it.each([
    ["gateway_attestation", "gateway attestation retrieval", 500],
    ["model_metadata", "model metadata retrieval", 503],
    ["model_attestation", "model attestation retrieval", 500],
    ["model_attestation", "model attestation retrieval", 503],
  ] as const)(
    "classifies resource %s as %s for HTTP %s",
    async (resource, stage, status) => {
      const errors: string[] = [];
      const responseFailure = new ApiError({
        code: "api.http_status",
        details: { resource, status },
        retryable: true,
      });

      const succeeded = await executeNearAiAttestationDiscovery(
        "test-only-not-a-real-key",
        () => {},
        (text) => errors.push(text),
        () => ({
          verify: async () => {
            throw responseFailure;
          },
        }),
      );

      expect(succeeded).toBe(false);
      expect(errors.join("")).toContain(
        `during ${stage}: attestation service returned HTTP status ${status}`,
      );
      expect(errors.join("")).not.toContain(responseFailure.message);
    },
  );

  it.each([
    ["unknown resource", "untrusted-resource-name"],
    ["absent resource", undefined],
  ])("falls back safely for an %s", async (_label, resource) => {
    const errors: string[] = [];
    const responseFailure = httpStatusFailureWithResource(resource);

    const succeeded = await executeNearAiAttestationDiscovery(
      "test-only-not-a-real-key",
      () => {},
      (text) => errors.push(text),
      () => ({
        verify: async () => {
          throw responseFailure;
        },
      }),
    );

    expect(succeeded).toBe(false);
    expect(errors.join("")).toContain(
      "during attestation discovery: attestation service returned HTTP status 500",
    );
    expect(errors.join("")).not.toContain("untrusted-resource-name");
    expect(errors.join("")).not.toContain(responseFailure.message);
  });

  it("classifies invalid SDK responses without exposing untrusted details", async () => {
    const errors: string[] = [];
    const responseFailure = new ApiError(
      {
        code: "api.invalid_response",
        details: {
          path: "Authorization header",
          expected: "valid response",
          actual: "private-token and raw-response-body",
        },
      },
      { cause: new Error("source code and request headers") },
    );

    const succeeded = await executeNearAiAttestationDiscovery(
      "test-only-not-a-real-key",
      () => {},
      (text) => errors.push(text),
      () => ({
        verify: async () => {
          throw responseFailure;
        },
      }),
    );

    expect(succeeded).toBe(false);
    expect(errors.join("")).toContain(
      "during attestation response validation: attestation service returned an invalid response",
    );
    for (const sensitiveValue of [
      responseFailure.message,
      "Authorization header",
      "private-token",
      "raw-response-body",
      "source code",
      "request headers",
    ]) {
      expect(errors.join("")).not.toContain(sensitiveValue);
    }
  });

  it("returns a nonzero CLI exit code for a sanitized discovery failure", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const responseFailure = new ApiError({
      code: "api.http_status",
      details: { resource: "model_attestation", status: 500 },
      retryable: true,
    });

    const exitCode = await runNearAiAttestationDiscoveryCli(
      "test-only-not-a-real-key",
      (text) => output.push(text),
      (text) => errors.push(text),
      () => ({
        verify: async () => {
          throw responseFailure;
        },
      }),
    );

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors.join("")).toContain(
      "during model attestation retrieval: attestation service returned HTTP status 500",
    );
    expect(errors.join("")).not.toContain(responseFailure.message);
  });

  it("classifies attestation policy failures without exposing SDK details", async () => {
    const errors: string[] = [];
    const verificationFailure = new VerificationError({
      code: "policy.debug_enabled",
    });

    const succeeded = await executeNearAiAttestationDiscovery(
      "test-only-not-a-real-key",
      () => {},
      (text) => errors.push(text),
      () => ({
        verify: async () => {
          throw verificationFailure;
        },
      }),
    );

    expect(succeeded).toBe(false);
    expect(errors.join("")).toContain(
      "during attestation verification: attestation policy was not satisfied",
    );
    expect(errors.join("")).not.toContain(verificationFailure.message);
  });

  it("reports invalid reports separately and writes no JSON on failure", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const succeeded = await executeNearAiAttestationDiscovery(
      "test-only-not-a-real-key",
      (text) => output.push(text),
      (text) => errors.push(text),
      () => ({
        verify: async () => ({ ...successfulResult, models: [] }),
      }),
    );

    expect(succeeded).toBe(false);
    expect(output).toEqual([]);
    expect(errors.join("")).toContain(
      "during report validation: attestation report did not satisfy required fields or policies",
    );
  });

  it("preserves the successful JSON report output", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const succeeded = await executeNearAiAttestationDiscovery(
      "test-only-not-a-real-key",
      (text) => output.push(text),
      (text) => errors.push(text),
      () => ({ verify: async () => successfulResult }),
    );

    expect(succeeded).toBe(true);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(""))).toEqual({
      model: "z-ai/glm-5.3-flash",
      gatewayTcbStatus: "UpToDate",
      modelAttestations: [
        {
          tcbStatus: "UpToDate",
          gpuEvidence: "verified",
          deploymentProvenance: "not_checked",
          measurementApproval: "not_approved",
          composeHash: "compose-measurement",
          osImageHash: "os-measurement",
        },
      ],
    });
  });

  it.each([
    [
      "missing composeHash",
      { osImageHash: "os-measurement" },
    ],
    [
      "missing osImageHash",
      { composeHash: "compose-measurement" },
    ],
    [
      "empty composeHash",
      { composeHash: "", osImageHash: "os-measurement" },
    ],
    [
      "empty osImageHash",
      { composeHash: "compose-measurement", osImageHash: "" },
    ],
    [
      "whitespace-only composeHash",
      { composeHash: " \t\n ", osImageHash: "os-measurement" },
    ],
    [
      "whitespace-only osImageHash",
      { composeHash: "compose-measurement", osImageHash: " \t\n " },
    ],
  ])("rejects unavailable measurement fields: %s", (_name, runtimeMeasurements) => {
    expect(() =>
      buildDiscoveryReport({
        ...successfulResult,
        models: [
          {
            ...successfulModelAttestation,
            deployment: { runtimeMeasurements },
          },
        ],
      }),
    ).toThrow("Required deployment measurements are unavailable.");
  });

  it.each([
    ["Gateway TCB", { ...successfulResult, gateway: { tcbStatus: "OutOfDate" as const } }],
    ["missing model attestation", { ...successfulResult, models: [] }],
    [
      "model TCB",
      {
        ...successfulResult,
        models: [{ ...successfulModelAttestation, tcbStatus: "OutOfDate" as const }],
      },
    ],
    [
      "GPU evidence",
      {
        ...successfulResult,
        models: [{ ...successfulModelAttestation, gpuEvidence: "not_provided" as const }],
      },
    ],
    [
      "deployment provenance",
      {
        ...successfulResult,
        models: [
          {
            ...successfulModelAttestation,
            deploymentProvenance: "verified" as const,
          },
        ],
      },
    ],
  ])("rejects unavailable or unexpected %s verification", (_name, result) => {
    expect(() => buildDiscoveryReport(result)).toThrow();
  });
});
