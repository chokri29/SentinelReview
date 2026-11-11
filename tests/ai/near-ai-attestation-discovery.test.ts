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
    appCompose: JSON.stringify({ docker_compose_file: "services: {}" }),
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
          deploymentImageInventory: { status: "parsed", images: [] },
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
          deploymentImageInventory: { status: "parsed", images: [] },
        },
      ],
    });
  });

  it("extracts a validated SHA-256 digest without promoting provenance status", () => {
    const report = buildDiscoveryReportWithAppCompose(
      JSON.stringify({
        docker_compose_file:
          "services:\n  model:\n    image: ghcr.io/nearai/model@sha256:" +
          "a".repeat(64),
      }),
    );

    expect(report.modelAttestations[0]).toMatchObject({
      deploymentProvenance: "not_checked",
      measurementApproval: "not_approved",
      deploymentImageInventory: {
        status: "parsed",
        images: [
          {
            image: "ghcr.io/nearai/model",
            digest: `sha256:${"a".repeat(64)}`,
            pinnedToDigest: true,
            referenceStatus: "digest_pinned",
          },
        ],
      },
    });
  });

  it("reports tag-only and untagged references without inventing digests", () => {
    const report = buildDiscoveryReportWithAppCompose(
      JSON.stringify({
        docker_compose_file:
          "services:\n  tagged:\n    image: nearai/model:release-1\n  plain:\n    image: nearai/worker\n",
      }),
    );

    expect(report.modelAttestations[0]?.deploymentImageInventory).toEqual({
      status: "parsed",
      images: [
        {
          image: "nearai/model",
          digest: null,
          pinnedToDigest: false,
          referenceStatus: "tag_only",
        },
        {
          image: "nearai/worker",
          digest: null,
          pinnedToDigest: false,
          referenceStatus: "untagged",
        },
      ],
    });
  });

  it("accepts services without image references and returns an empty inventory", () => {
    const report = buildDiscoveryReportWithAppCompose(
      JSON.stringify({
        docker_compose_file:
          "services:\n  builder:\n    command: build\n  optional:\n    image: null\n",
      }),
    );

    expect(report.modelAttestations[0]?.deploymentImageInventory).toEqual({
      status: "parsed",
      images: [],
    });
  });

  it.each([
    ["standard image name", "alpine", "alpine", null, "untagged"],
    [
      "tagged image",
      "library/alpine:latest",
      "library/alpine",
      null,
      "tag_only",
    ],
    [
      "registry hostname",
      "registry.example.com/team/image",
      "registry.example.com/team/image",
      null,
      "untagged",
    ],
    [
      "registry port and tag",
      "registry.example.com:5000/team/image:release_1",
      "registry.example.com:5000/team/image",
      null,
      "tag_only",
    ],
    [
      "localhost registry and port",
      "localhost:5000/team/image",
      "localhost:5000/team/image",
      null,
      "untagged",
    ],
    [
      "IPv4 registry",
      "192.0.2.10:5000/team/image",
      "192.0.2.10:5000/team/image",
      null,
      "untagged",
    ],
    [
      "double underscore repository separator",
      "namespace/team__name/image",
      "namespace/team__name/image",
      null,
      "untagged",
    ],
    [
      "repeated hyphen repository separator",
      "namespace/team---name/image",
      "namespace/team---name/image",
      null,
      "untagged",
    ],
    [
      "mixed repository separators",
      "namespace/repo.a_b__c--d---e/image",
      "namespace/repo.a_b__c--d---e/image",
      null,
      "untagged",
    ],
    [
      "bracketed IPv6 registry",
      "[2001:db8::1]:5000/team/image",
      "[2001:db8::1]:5000/team/image",
      null,
      "untagged",
    ],
    [
      "tag that resembles a port",
      "image:5000",
      "image",
      null,
      "tag_only",
    ],
    [
      "lowercase SHA-256 digest",
      `registry.example.com/team/image@sha256:${"c".repeat(64)}`,
      "registry.example.com/team/image",
      `sha256:${"c".repeat(64)}`,
      "digest_pinned",
    ],
  ] as const)(
    "parses valid image reference: %s",
    (_description, reference, image, digest, referenceStatus) => {
      const report = buildDiscoveryReportWithAppCompose(
        appComposeWithImageReferences([reference]),
      );
      const attestation = report.modelAttestations[0];

      expect(attestation?.deploymentImageInventory).toEqual({
        status: "parsed",
        images: [
          {
            image,
            digest,
            pinnedToDigest: digest !== null,
            referenceStatus,
          },
        ],
      });
      expect(attestation).toMatchObject({
        deploymentProvenance: "not_checked",
        measurementApproval: "not_approved",
      });
    },
  );

  it.each([
    ["short digest", `image@sha256:${"a".repeat(63)}`],
    ["long digest", `image@sha256:${"a".repeat(65)}`],
    ["invalid digest character", `image@sha256:${"g" + "a".repeat(63)}`],
    [
      "uppercase SHA-256 digest (lowercase-only policy)",
      `image@sha256:${"A".repeat(64)}`,
    ],
    ["multiple digest separators", `image@sha256:${"a".repeat(64)}@sha256:${"b".repeat(64)}`],
    ["empty tag", "image:"],
    ["invalid tag start", "image:.release"],
    ["invalid tag character", "image:release?"],
    ["tag longer than 128 characters", `image:${"a".repeat(129)}`],
    ["port zero", "registry.example.com:0/team/image"],
    ["port above 65535", "registry.example.com:65536/team/image"],
    ["nonnumeric registry port", "registry.example.com:port/team/image"],
    ["empty path component", "team//image"],
    ["leading empty path component", "/team/image"],
    ["trailing empty path component", "team/image/"],
    ["uppercase repository component", "Team/image"],
    ["leading repository separator", "_team/image"],
    ["repository component ending in separator", "team-/image"],
    ["whitespace inside reference", "team/ my-image"],
    ["whitespace around reference", " team/image "],
    ["invalid bracketed IPv6 address", "[not-ipv6]:5000/team/image"],
    ["malformed bracketed IPv6 registry", "[2001:db8::1:5000/team/image"],
    ["invalid dotted numeric registry", "192.0.2.999/team/image"],
  ])(
    "marks invalid image reference as unsupported: %s",
    (_description, invalidReference) => {
      const report = buildDiscoveryReportWithAppCompose(
        appComposeWithImageReferences(["valid/image", invalidReference]),
      );

      expect(report.modelAttestations[0]?.deploymentImageInventory).toEqual({
        status: "unsupported",
        images: [],
      });
    },
  );

  it("returns no partial images for malformed YAML", () => {
    const report = buildDiscoveryReportWithAppCompose(
      JSON.stringify({
        docker_compose_file:
          'services:\n  valid:\n    image: "valid/image"\n  broken: [unterminated',
      }),
    );

    expect(report.modelAttestations[0]?.deploymentImageInventory).toEqual({
      status: "malformed",
      images: [],
    });
  });

  it("returns no partial images for unsupported Compose structures", () => {
    const report = buildDiscoveryReportWithAppCompose(
      JSON.stringify({
        docker_compose_file:
          'services:\n  valid:\n    image: "valid/image"\n  invalid: "not-a-service-object"',
      }),
    );

    expect(report.modelAttestations[0]?.deploymentImageInventory).toEqual({
      status: "unsupported",
      images: [],
    });
  });

  it("rejects appCompose larger than 1 MiB without returning an inventory", () => {
    const appCompose = JSON.stringify({
      docker_compose_file: "services: {}",
      padding: "x".repeat(1024 * 1024),
    });

    expect(buildDiscoveryReportWithAppCompose(appCompose).modelAttestations[0]?.deploymentImageInventory).toEqual({
      status: "unsupported",
      images: [],
    });
  });

  it("accepts exactly 200 services", () => {
    const appCompose = appComposeWithServices(200, true);

    const inventory = buildDiscoveryReportWithAppCompose(appCompose)
      .modelAttestations[0]?.deploymentImageInventory;

    expect(inventory?.status).toBe("parsed");
    expect(inventory?.images).toHaveLength(200);
  });

  it("rejects 201 services without returning a partial inventory", () => {
    const appCompose = appComposeWithServices(201, true);

    expect(buildDiscoveryReportWithAppCompose(appCompose).modelAttestations[0]?.deploymentImageInventory).toEqual({
      status: "unsupported",
      images: [],
    });
  });

  it.each([
    ["malformed JSON", "{not-json"],
    [
      "malformed YAML",
      JSON.stringify({ docker_compose_file: "services:\n  model: [unterminated" }),
    ],
    [
      "unsupported compose structure",
      JSON.stringify({ docker_compose_file: "containers:\n  model:\n    image: nearai/model" }),
    ],
    [
      "unsupported image reference",
      JSON.stringify({
        docker_compose_file: "services:\n  model:\n    image: ${IMAGE_FROM_ENV}\n",
      }),
    ],
  ])("returns a sanitized %s status", (_name, appCompose) => {
    const report = buildDiscoveryReportWithAppCompose(appCompose);

    expect(report.modelAttestations[0]?.deploymentImageInventory).toEqual({
      status: _name === "malformed JSON" || _name === "malformed YAML"
        ? "malformed"
        : "unsupported",
      images: [],
    });
  });

  it("extracts multiple images without exposing secret-like compose fields", () => {
    const privateValue = "test-only-secret-environment-value";
    const appCompose = JSON.stringify({
      docker_compose_file:
        "services:\n" +
        "  api:\n" +
        "    image: ghcr.io/nearai/api@sha256:" +
        "b".repeat(64) +
        "\n" +
        "    environment:\n" +
        `      API_TOKEN: ${privateValue}\n` +
        "  worker:\n" +
        "    image: nearai/worker:stable\n" +
        "    command: [do-not-report-this]\n",
    });
    const report = buildDiscoveryReportWithAppCompose(appCompose);
    const serializedReport = JSON.stringify(report);

    expect(report.modelAttestations[0]?.deploymentImageInventory.images).toHaveLength(2);
    expect(serializedReport).not.toContain(privateValue);
    expect(serializedReport).not.toContain("do-not-report-this");
    expect(serializedReport).not.toContain("environment");
    expect(report.modelAttestations[0]).toMatchObject({
      deploymentProvenance: "not_checked",
      measurementApproval: "not_approved",
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
            deployment: {
              appCompose: successfulModelAttestation.deployment.appCompose,
              runtimeMeasurements,
            },
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

function buildDiscoveryReportWithAppCompose(appCompose: string) {
  return buildDiscoveryReport({
    ...successfulResult,
    models: [
      {
        ...successfulModelAttestation,
        deployment: {
          ...successfulModelAttestation.deployment,
          appCompose,
        },
      },
    ],
  });
}

function appComposeWithServices(count: number, includeImages: boolean): string {
  const services = Array.from({ length: count }, (_, index) => {
    const service = `  service-${index}:`;
    return includeImages
      ? `${service}\n    image: nearai/image-${index}`
      : `${service}\n    command: build`;
  }).join("\n");

  return JSON.stringify({ docker_compose_file: `services:\n${services}\n` });
}

function appComposeWithImageReferences(references: readonly string[]): string {
  const services = references
    .map(
      (reference, index) =>
        `  service-${index}:\n    image: ${JSON.stringify(reference)}`,
    )
    .join("\n");
  return JSON.stringify({ docker_compose_file: `services:\n${services}\n` });
}
