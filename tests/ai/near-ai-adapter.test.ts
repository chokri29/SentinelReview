import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type {
  AttestationVerificationResult,
  InferenceClientOptions,
  SigningIdentity,
  VerifiedGatewayAttestation,
  VerifiedGatewayCompletionResult,
  VerifiedModelAttestation,
  VerifiedModelCompletionResult,
} from "@nearai/inference-sdk/node";
import type { Finding } from "../../src/contracts/v1.js";
import {
  createNearAiAdapter,
  NEAR_AI_MODEL_ID,
  type ApprovedModelDeployment,
  type NearAiAdapterDependencies,
  type NearAiChatRequest,
  type NearAiClient,
} from "../../src/ai/near-ai-adapter.js";
import { integrateEvidence } from "../../src/source/integrate-evidence.js";
import { loadSource } from "../../src/source/load-source.js";
import type { SourceLoadResult } from "../../src/source/load-source.js";
import { validateEvidence } from "../../src/source/validate-evidence.js";

const source = [
  "#[near]",
  "impl Contract {",
  "    pub fn withdraw() {",
  "        transfer();",
  "    }",
  "}",
  "",
].join("\n");

const sourceFinding: Finding = {
  findingId: "deterministic-1",
  origin: "deterministic_rule",
  ruleId: "NEAR-TEST-001",
  severity: "info",
  title: "Deterministic candidate",
  rationale: "A deterministic review candidate.",
  evidenceRefs: [{ evidenceId: "deterministic-evidence-1" }],
  limitations: [],
};

const approvedDeployment: ApprovedModelDeployment = {
  composeHash: "approved-compose-hash",
  osImageHash: "approved-os-image-hash",
};

const modelSigner: SigningIdentity = {
  signingAlgo: "ed25519",
  signingAddress: "ab".repeat(32),
};

const gatewaySigner: SigningIdentity = {
  signingAlgo: "ed25519",
  signingAddress: "cd".repeat(32),
};

const modelAttestation: VerifiedModelAttestation = {
  signer: modelSigner,
  tcbStatus: "UpToDate",
  advisoryIds: [],
  deployment: {
    appCompose: "{}",
    runtimeMeasurements: {
      composeHash: approvedDeployment.composeHash,
      osImageHash: approvedDeployment.osImageHash,
    },
  },
  deploymentProvenance: "verified",
  report: {
    nonce: "nonce",
    signer: modelSigner,
    intelQuote: "quote",
    eventLog: "event-log",
    appCompose: "{}",
    signingPublicKey: modelSigner.signingAddress,
  },
  gpuEvidence: "verified",
  signingPublicKey: modelSigner.signingAddress,
};

const gatewayAttestation: VerifiedGatewayAttestation = {
  signer: gatewaySigner,
  tcbStatus: "UpToDate",
  advisoryIds: [],
  deployment: {
    appCompose: "{}",
    runtimeMeasurements: {},
  },
  deploymentProvenance: "not_checked",
  report: {
    nonce: "nonce",
    signer: gatewaySigner,
    intelQuote: "quote",
    eventLog: "event-log",
    appCompose: "{}",
    reportedQuoteData: "quote-data",
  },
  tlsBinding: { kind: "none" },
};

const verifiedAttestation: AttestationVerificationResult = {
  gateway: gatewayAttestation,
  models: [modelAttestation],
  verifiedAt: 1,
};

function providerTeeResult(id: string): VerifiedModelCompletionResult {
  return {
    id,
    completionId: id,
    signatureKind: "provider_tee",
    signature: {
      kind: "provider_tee",
      signer: modelSigner,
      signedText: "{}",
      signature: "signature",
    },
    attestations: [modelAttestation],
    attestation: modelAttestation,
  };
}

function gatewayResult(id: string): VerifiedGatewayCompletionResult {
  return {
    id,
    completionId: id,
    signatureKind: "gateway",
    signature: {
      kind: "gateway",
      signer: gatewaySigner,
      signedText: "{}",
      signature: "signature",
    },
    attestation: gatewayAttestation,
  };
}

describe("NEAR AI adapter", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "near-ai-adapter-"),
    );
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function loadSnapshot(content = source): Promise<SourceLoadResult> {
    const sourceDirectory = path.join(temporaryDirectory, "source");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(path.join(sourceDirectory, "lib.rs"), content);
    return loadSource(sourceDirectory);
  }

  function makeClient(options: {
    attestation?: unknown;
    attestationFails?: boolean;
    completion?: unknown;
    completionFails?: boolean;
    verification?: unknown;
    responseVerificationFails?: boolean;
  } = {}): {
    client: NearAiClient;
    calls: {
      verifiedModel?: string;
      request?: NearAiChatRequest;
      verifiedResponseId?: string;
    };
  } {
    const calls: {
      verifiedModel?: string;
      request?: NearAiChatRequest;
      verifiedResponseId?: string;
    } = {};
    const client: NearAiClient = {
      verify: async (model) => {
        calls.verifiedModel = model;
        if (options.attestationFails) {
          throw new Error("test attestation failure");
        }
        return "attestation" in options
          ? options.attestation
          : verifiedAttestation;
      },
      createChatCompletion: async (request) => {
        calls.request = request;
        if (options.completionFails) {
          throw new Error("test inference failure");
        }
        return "completion" in options
          ? options.completion
          : {
            id: "response-1",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    findings: [
                      {
                        severity: "high",
                        title: "Potential unsafe withdrawal",
                        rationale: "The call may transfer funds without checks.",
                        path: "lib.rs",
                        startLine: 3,
                        endLine: 5,
                      },
                    ],
                  }),
                },
              },
            ],
          };
      },
      verifyResponse: async (id) => {
        calls.verifiedResponseId = id;
        if (options.responseVerificationFails) {
          throw new Error("test response verification failure");
        }
        return "verification" in options
          ? options.verification
          : providerTeeResult(id);
      },
    };

    return { client, calls };
  }

  function createAdapter(
    mock: ReturnType<typeof makeClient>,
    apiKey: string | undefined = "test-only-not-a-real-key",
    clientOptions?: {
      called?: (options: InferenceClientOptions) => void;
    },
    approvedModelDeployments: readonly ApprovedModelDeployment[] = [
      approvedDeployment,
    ],
  ) {
    let clientCreated = false;
    const dependencies: NearAiAdapterDependencies = {
      getApiKey: () => apiKey,
      approvedModelDeployments,
      createClient: (options) => {
        clientCreated = true;
        clientOptions?.called?.(options);
        return mock.client;
      },
    };
    return {
      run: createNearAiAdapter(dependencies),
      wasClientCreated: () => clientCreated,
    };
  }

  it("accepts only a verified provider_tee response and builds local evidence", async () => {
    const snapshot = await loadSnapshot();
    const snapshotBefore = structuredClone(snapshot);
    const deterministicBefore = structuredClone(sourceFinding);
    const mock = makeClient();
    let configuredE2ee = false;
    const adapter = createAdapter(mock, undefined, {
      called: (options) => {
        configuredE2ee = options.e2ee === true;
        expect(options.gatewayVerification?.policy?.acceptedTcbStatuses).toEqual([
          "UpToDate",
        ]);
        expect(options.modelVerification?.policy?.acceptedTcbStatuses).toEqual([
          "UpToDate",
        ]);
        expect(options.modelVerification?.policy?.gpuEvidence).toBe("required");
        expect(
          options.modelVerification?.verifiers?.deployment,
        ).toBeTypeOf("function");
        expect(options.deploymentPolicy).toBeTypeOf("function");
        options.modelVerification?.verifiers?.deployment?.(
          modelAttestation.deployment,
        );
        options.deploymentPolicy?.({
          model: NEAR_AI_MODEL_ID,
          deployment: modelAttestation.deployment,
        });
      },
    });

    const result = await adapter.run(snapshot, [sourceFinding]);

    expect(configuredE2ee).toBe(true);
    expect(mock.calls.verifiedModel).toBe(NEAR_AI_MODEL_ID);
    expect(mock.calls.request).toMatchObject({
      model: NEAR_AI_MODEL_ID,
      stream: false,
      max_tokens: 4096,
    });
    expect(mock.calls.verifiedResponseId).toBe("response-1");
    expect(result.status).toBe("complete");
    expect(result.coverage).toBe("complete");
    expect(result.provenance).toMatchObject({
      sdkVersion: "0.3.0",
      modelId: NEAR_AI_MODEL_ID,
      responseId: "response-1",
      gatewayVerification: "verified",
      modelAttestationVerification: "verified",
      responseVerification: "verified",
      responseSignatureKind: "provider_tee",
      gatewayTcbStatus: "UpToDate",
      gatewayDeploymentProvenance: "not_checked",
      modelTcbStatuses: ["UpToDate"],
      modelDeploymentProvenances: ["verified"],
      privateModelPolicy: "passed",
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.origin).toBe("ai_hypothesis");
    expect(result.findings[0]?.findingId).not.toBe(sourceFinding.findingId);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.producer).toBe("ai_hypothesis");
    expect(result.evidenceExcerpts[0]?.excerpt).toBe(
      ["    pub fn withdraw() {", "        transfer();", "    }"].join("\n"),
    );
    expect(validateEvidence(result.evidence[0], snapshot).status).toBe(
      "validated",
    );
    expect(
      integrateEvidence(result.evidence, result.findings, snapshot).status,
    ).toBe("complete");
    expect(sourceFinding).toEqual(deterministicBefore);
    expect(snapshot).toEqual(snapshotBefore);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.provenance)).toBe(true);
    expect(Object.isFrozen(result.findings)).toBe(true);
    expect(Object.isFrozen(result.findings[0]?.evidenceRefs)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidenceExcerpts)).toBe(true);
    expect(Object.isFrozen(result.limitations)).toBe(true);
    expect(Object.isFrozen(result.provenance.modelTcbStatuses)).toBe(true);
    expect(
      Object.isFrozen(result.provenance.modelDeploymentProvenances),
    ).toBe(true);
  });

  it("rejects a Gateway-signed response despite successful SDK verification", async () => {
    const snapshot = await loadSnapshot();
    const mock = makeClient({
      verification: gatewayResult("response-1"),
    });
    const adapter = createAdapter(mock);

    const result = await adapter.run(snapshot, []);

    expect(result.responseVerification).toBe("verified");
    expect(result.provenance.responseSignatureKind).toBe("gateway");
    expect(result.provenance.privateModelPolicy).toBe("rejected");
    expect(result.findings).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("rejects response attestations without verified GPU evidence", async () => {
    const snapshot = await loadSnapshot();
    const unverifiedGpuModel = {
      ...modelAttestation,
      gpuEvidence: "not_provided",
    } satisfies VerifiedModelAttestation;
    const verification = {
      ...providerTeeResult("response-1"),
      attestations: [unverifiedGpuModel],
      attestation: unverifiedGpuModel,
    };
    const mock = makeClient({ verification });
    const adapter = createAdapter(mock);

    const result = await adapter.run(snapshot, []);

    expect(result.status).toBe("failed");
    expect(result.provenance.privateModelPolicy).toBe("rejected");
    expect(result.findings).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("does not infer when the SDK returns no model attestations", async () => {
    const snapshot = await loadSnapshot();
    const mock = makeClient({
      attestation: { ...verifiedAttestation, models: [] },
    });
    const adapter = createAdapter(mock);

    const result = await adapter.run(snapshot, []);

    expect(result.provenance.gatewayVerification).toBe("verified");
    expect(result.provenance.modelAttestationVerification).toBe("failed");
    expect(result.provenance.privateModelPolicy).toBe("rejected");
    expect(mock.calls.request).toBeUndefined();
    expect(result.findings).toEqual([]);
  });

  it("does not create a client when no model deployment is approved", async () => {
    const snapshot = await loadSnapshot();
    const mock = makeClient();
    const adapter = createAdapter(mock, undefined, undefined, []);

    const result = await adapter.run(snapshot, []);

    expect(result.status).toBe("failed");
    expect(result.provenance.privateModelPolicy).toBe("unavailable");
    expect(adapter.wasClientCreated()).toBe(false);
    expect(mock.calls.request).toBeUndefined();
    expect(result.findings).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("rejects model measurements outside the explicit approval list", async () => {
    const snapshot = await loadSnapshot();
    const mock = makeClient();
    let sdkPolicyRejected = false;
    const adapter = createAdapter(
      mock,
      undefined,
      {
        called: (options) => {
          try {
            options.modelVerification?.verifiers?.deployment?.(
              modelAttestation.deployment,
            );
          } catch {
            sdkPolicyRejected = true;
          }
        },
      },
      [{ composeHash: "other-compose", osImageHash: "other-os" }],
    );

    const result = await adapter.run(snapshot, []);

    expect(sdkPolicyRejected).toBe(true);
    expect(result.provenance.modelAttestationVerification).toBe("failed");
    expect(result.provenance.privateModelPolicy).toBe("rejected");
    expect(mock.calls.request).toBeUndefined();
    expect(result.findings).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  const { deploymentProvenance: _missingProvenance, ...missingProvenanceModel } =
    modelAttestation;
  const { tcbStatus: _missingTcbStatus, ...missingTcbModel } = modelAttestation;
  const rejectedAttestationCases: Array<[string, unknown]> = [
    [
      "missing deployment provenance",
      missingProvenanceModel,
    ],
    [
      "not_checked deployment provenance",
      { ...modelAttestation, deploymentProvenance: "not_checked" },
    ],
    [
      "missing verified GPU evidence",
      { ...modelAttestation, gpuEvidence: "not_provided" },
    ],
    ["missing TCB status", missingTcbModel],
    ["unknown TCB status", { ...modelAttestation, tcbStatus: "Unknown" }],
    ["outdated TCB status", { ...modelAttestation, tcbStatus: "OutOfDate" }],
    [
      "disallowed TCB status",
      { ...modelAttestation, tcbStatus: "SWHardeningNeeded" },
    ],
  ];

  it.each(rejectedAttestationCases)(
    "fails closed for %s",
    async (_description, model) => {
      const snapshot = await loadSnapshot();
      const snapshotBefore = structuredClone(snapshot);
      const deterministicBefore = structuredClone(sourceFinding);
      const mock = makeClient({
        attestation: { ...verifiedAttestation, models: [model] },
      });
      const adapter = createAdapter(mock);

      const result = await adapter.run(snapshot, []);

      expect(result.status).toBe("failed");
      expect(result.provenance.privateModelPolicy).toBe("rejected");
      expect(mock.calls.request).toBeUndefined();
      expect(result.findings).toEqual([]);
      expect(result.evidence).toEqual([]);
      expect(snapshot).toEqual(snapshotBefore);
      expect(sourceFinding).toEqual(deterministicBefore);
    },
  );

  it.each([
    ["missing Gateway TCB status", { ...gatewayAttestation, tcbStatus: undefined }],
    ["unknown Gateway TCB status", { ...gatewayAttestation, tcbStatus: "Unknown" }],
    ["outdated Gateway TCB status", { ...gatewayAttestation, tcbStatus: "OutOfDate" }],
  ])("rejects %s before inference", async (_description, gateway) => {
    const snapshot = await loadSnapshot();
    const mock = makeClient({
      attestation: { ...verifiedAttestation, gateway },
    });
    const adapter = createAdapter(mock);

    const result = await adapter.run(snapshot, []);

    expect(["failed", "unavailable"]).toContain(
      result.provenance.gatewayVerification,
    );
    expect(result.provenance.privateModelPolicy).toBe("rejected");
    expect(mock.calls.request).toBeUndefined();
    expect(result.findings).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it.each([
    ["missing attestation result", undefined],
    ["null attestation result", null],
    ["missing Gateway evidence", { models: [modelAttestation], verifiedAt: 1 }],
    [
      "malformed Gateway evidence",
      { ...verifiedAttestation, gateway: { ...gatewayAttestation, signer: null } },
    ],
    [
      "malformed model signer",
      {
        ...verifiedAttestation,
        models: [{ ...modelAttestation, signer: null }],
      },
    ],
    [
      "malformed model deployment",
      {
        ...verifiedAttestation,
        models: [
          {
            ...modelAttestation,
            deployment: { appCompose: "{}", runtimeMeasurements: null },
          },
        ],
      },
    ],
  ])("returns a structured failure for %s", async (_description, attestation) => {
    const snapshot = await loadSnapshot();
    const mock = makeClient({ attestation });
    const adapter = createAdapter(mock);

    const result = await adapter.run(snapshot, []);

    expect(result.status).toBe("failed");
    expect(result.provenance.privateModelPolicy).toBe("rejected");
    expect(result.findings).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(mock.calls.request).toBeUndefined();
  });

  it("does not infer when model evidence has no usable E2EE key", async () => {
    const {
      signingPublicKey: _signingPublicKey,
      ...modelWithoutKey
    } = modelAttestation;
    const snapshot = await loadSnapshot();
    const mock = makeClient({
      attestation: { ...verifiedAttestation, models: [modelWithoutKey] },
    });
    const adapter = createAdapter(mock);

    const result = await adapter.run(snapshot, []);

    expect(result.provenance.modelAttestationVerification).toBe("verified");
    expect(result.provenance.privateModelPolicy).toBe("rejected");
    expect(mock.calls.request).toBeUndefined();
    expect(result.findings).toEqual([]);
  });

  it("fails closed when Gateway or model attestation preflight rejects", async () => {
    const snapshot = await loadSnapshot();
    const mock = makeClient({ attestationFails: true });
    const adapter = createAdapter(mock);

    const result = await adapter.run(snapshot, []);

    expect(result.status).toBe("failed");
    expect(result.provenance.gatewayVerification).toBe("unavailable");
    expect(result.provenance.modelAttestationVerification).toBe("unavailable");
    expect(result.provenance.privateModelPolicy).toBe("rejected");
    expect(mock.calls.request).toBeUndefined();
    expect(result.findings).toEqual([]);
  });

  it("returns unavailable without a key and does not create an SDK client", async () => {
    const snapshot = await loadSnapshot();
    const mock = makeClient();
    const adapter = createAdapter(mock, "");

    const result = await adapter.run(snapshot, []);

    expect(result.status).toBe("not_run");
    expect(result.provenance.privateModelPolicy).toBe("not_run");
    expect(adapter.wasClientCreated()).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it("rejects invalid AI output without accepting any findings", async () => {
    const snapshot = await loadSnapshot();
    const mock = makeClient({
      completion: {
        id: "response-1",
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    severity: "high",
                    title: "Candidate",
                    rationale: "Rationale.",
                    path: "lib.rs",
                    startLine: 3,
                    endLine: 5,
                    excerptHash: "model-supplied-hash",
                  },
                ],
              }),
            },
          },
        ],
      },
    });
    const adapter = createAdapter(mock);

    const result = await adapter.run(snapshot, []);

    expect(result.status).toBe("failed");
    expect(result.provenance.privateModelPolicy).toBe("passed");
    expect(result.findings).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("fails safely and deterministically on duplicate candidate ranges", async () => {
    const snapshot = await loadSnapshot();
    const duplicateCandidate = {
      severity: "medium",
      title: "Repeated candidate",
      rationale: "Same source range is returned twice.",
      path: "lib.rs",
      startLine: 3,
      endLine: 5,
    };
    const mock = makeClient({
      completion: {
        id: "response-1",
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  duplicateCandidate,
                  { ...duplicateCandidate, title: "Duplicate evidence reference" },
                ],
              }),
            },
          },
        ],
      },
    });
    const adapter = createAdapter(mock);
    const first = await adapter.run(snapshot, []);
    const second = await adapter.run(snapshot, []);

    expect(first.status).toBe("failed");
    expect(first.findings).toEqual([]);
    expect(first.evidence).toEqual([]);
    expect(first.evidenceExcerpts).toEqual([]);
    expect(first.limitations).toEqual(second.limitations);
    expect(first.provenance).toEqual(second.provenance);
  });

  it.each([
    ["null response", null],
    ["missing response ID", { choices: [] }],
    ["malformed completion choices", { id: "response-1", choices: "invalid" }],
  ])("returns a structured failure for %s", async (_description, completion) => {
    const snapshot = await loadSnapshot();
    const mock = makeClient({ completion });
    const adapter = createAdapter(mock);

    const result = await adapter.run(snapshot, []);

    expect(result.status).toBe("failed");
    expect(result.findings).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it.each([
    ["null verification result", null],
    ["missing signature", { ...providerTeeResult("response-1"), signature: undefined }],
    [
      "missing model attestations",
      { ...providerTeeResult("response-1"), attestations: undefined },
    ],
    [
      "malformed model attestation",
      {
        ...providerTeeResult("response-1"),
        attestations: [{ ...modelAttestation, deployment: null }],
      },
    ],
    [
      "missing response ID",
      { ...providerTeeResult("response-1"), id: undefined },
    ],
  ])("returns a structured failure for %s", async (_description, verification) => {
    const snapshot = await loadSnapshot();
    const mock = makeClient({ verification });
    const adapter = createAdapter(mock);

    const result = await adapter.run(snapshot, []);

    expect(result.status).toBe("failed");
    expect(result.responseVerification).toBe("failed");
    expect(result.provenance.privateModelPolicy).toBe("rejected");
    expect(result.findings).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("rejects response attestations outside the model deployment policy", async () => {
    const snapshot = await loadSnapshot();
    const unapprovedModelAttestation = {
      ...modelAttestation,
      deploymentProvenance: "not_checked",
    };
    const validResponse = providerTeeResult("response-1");
    const mock = makeClient({
      verification: {
        ...validResponse,
        attestations: [unapprovedModelAttestation],
        attestation: unapprovedModelAttestation,
      },
    });
    const adapter = createAdapter(mock);

    const result = await adapter.run(snapshot, []);

    expect(result.responseVerification).toBe("verified");
    expect(result.provenance.privateModelPolicy).toBe("rejected");
    expect(result.findings).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it.each([
    ["unknown source path", "missing.rs", 1, 1],
    ["out-of-range lines", "lib.rs", 3, 100],
    ["reversed line range", "lib.rs", 5, 3],
    ["noncanonical path", "../lib.rs", 1, 1],
  ])(
    "rejects AI candidate references with %s",
    async (_description, candidatePath, startLine, endLine) => {
      const snapshot = await loadSnapshot();
      const mock = makeClient({
        completion: {
          id: "response-1",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  findings: [
                    {
                      severity: "medium",
                      title: "Candidate",
                      rationale: "Rationale.",
                      path: candidatePath,
                      startLine,
                      endLine,
                    },
                  ],
                }),
              },
            },
          ],
        },
      });
      const adapter = createAdapter(mock);

      const result = await adapter.run(snapshot, []);

      expect(result.status).toBe("failed");
      expect(result.findings).toEqual([]);
      expect(result.evidence).toEqual([]);
    },
  );

  it("reports incomplete coverage instead of truncating oversized source", async () => {
    const snapshot = await loadSnapshot("x".repeat(256 * 1024 + 1));
    const mock = makeClient();
    const adapter = createAdapter(mock);

    const result = await adapter.run(snapshot, []);

    expect(result.status).toBe("partial");
    expect(result.coverage).toBe("incomplete");
    expect(result.provenance.privateModelPolicy).toBe("not_run");
    expect(adapter.wasClientCreated()).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it("rejects a mutable source snapshot without mutating it", async () => {
    const snapshot = await loadSnapshot();
    const mutableSnapshot = structuredClone(snapshot);
    const mock = makeClient();
    const adapter = createAdapter(mock);

    const result = await adapter.run(mutableSnapshot, []);

    expect(result.status).toBe("failed");
    expect(adapter.wasClientCreated()).toBe(false);
    expect(mutableSnapshot.files[0]?.content).toBe(source);
    expect(result.findings).toEqual([]);
  });

  it("marks source transmission immediately before the completion request only", async () => {
    const snapshot = await loadSnapshot();
    const mock = makeClient();
    const events: string[] = [];
    const adapter = createNearAiAdapter({
      getApiKey: () => "test-only-not-a-real-key",
      approvedModelDeployments: [approvedDeployment],
      createClient: () => ({
        ...mock.client,
        createChatCompletion: async (request) => {
          events.push("completion");
          return mock.client.createChatCompletion(request);
        },
      }),
    });

    const result = await adapter(snapshot, [], {
      onSourceTransmission: () => events.push("transmission"),
    });

    expect(result.status).toBe("complete");
    expect(events).toEqual(["transmission", "completion"]);

    const preflightFailure = makeClient({ attestationFails: true });
    let transmissionCalled = false;
    const failed = await createAdapter(preflightFailure).run(snapshot, [], {
      onSourceTransmission: () => { transmissionCalled = true; },
    });
    expect(failed.status).toBe("failed");
    expect(transmissionCalled).toBe(false);
  });

  it("returns no findings when inference or response verification fails", async () => {
    const snapshot = await loadSnapshot();
    const inferenceFailure = makeClient({ completionFails: true });
    const failedInference = await createAdapter(inferenceFailure).run(
      snapshot,
      [],
    );
    const responseFailure = makeClient({
      responseVerificationFails: true,
    });
    let transmissionBeforeFailedVerification = false;
    const failedVerification = await createAdapter(responseFailure).run(
      snapshot,
      [],
      { onSourceTransmission: () => { transmissionBeforeFailedVerification = true; } },
    );

    expect(failedInference.findings).toEqual([]);
    expect(failedInference.evidence).toEqual([]);
    expect(failedVerification.findings).toEqual([]);
    expect(failedVerification.evidence).toEqual([]);
    expect(failedVerification.responseVerification).toBe("failed");
    expect(transmissionBeforeFailedVerification).toBe(true);
  });
});
