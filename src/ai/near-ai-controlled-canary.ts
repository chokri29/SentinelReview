import {
  InferenceClient,
  type InferenceClientOptions,
  type MeasuredDeployment,
} from "@nearai/inference-sdk/node";

export const NEAR_AI_CONTROLLED_CANARY_MODEL_ID =
  "z-ai/glm-5.3-flash" as const;

export const NEAR_AI_CONTROLLED_CANARY_SYNTHETIC_PROMPT =
  "Reply with OK.";

// These operator-supplied measurements are not independent NEAR approval evidence.
export interface NearAiControlledCanaryOperatorApprovedDeployment {
  readonly model: string;
  readonly composeHash: string;
  readonly osImageHash: string;
}

interface CanaryAttestationResult {
  readonly gateway: {
    readonly tcbStatus: string;
    readonly tlsBinding: { readonly kind: string };
  };
  readonly models: readonly {
    readonly tcbStatus: string;
    readonly gpuEvidence?: unknown;
    readonly deploymentProvenance: string;
    readonly deployment: MeasuredDeployment;
  }[];
}

interface CanaryCompletion {
  readonly id: unknown;
}

interface CanaryVerifiedResponse {
  readonly id: unknown;
  readonly signatureKind: unknown;
}

interface CanaryChatRequest {
  model: string;
  messages: { role: "user"; content: string }[];
  max_tokens: number;
}

export interface NearAiControlledCanaryClient {
  verify(model: string): Promise<CanaryAttestationResult>;
  chat: {
    completions: {
      create(request: CanaryChatRequest): Promise<CanaryCompletion>;
    };
  };
  verifyResponse(id: string): Promise<CanaryVerifiedResponse>;
  clearResponseCache(): void;
}

export type NearAiControlledCanaryClientFactory = (
  options: InferenceClientOptions,
) => NearAiControlledCanaryClient;

export interface NearAiControlledCanaryReport {
  readonly model: typeof NEAR_AI_CONTROLLED_CANARY_MODEL_ID;
  readonly cryptographicAttestation: "verified";
  readonly gatewayTlsBinding: "attested";
  readonly localTofuPin: "not_used";
  readonly operatorApprovedMeasurements: "matched";
  readonly independentNearApproval: "not_established";
  readonly responseSignature: "provider_tee";
  readonly responseId: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireOperatorApprovedDeployment(
  value: NearAiControlledCanaryOperatorApprovedDeployment | undefined,
): NearAiControlledCanaryOperatorApprovedDeployment {
  if (value === undefined) {
    throw new Error("Operator-approved deployment measurements are unavailable.");
  }
  const { model, composeHash, osImageHash } = value;
  if (
    model !== NEAR_AI_CONTROLLED_CANARY_MODEL_ID ||
    !isNonEmptyString(composeHash) ||
    !isNonEmptyString(osImageHash)
  ) {
    throw new Error("Operator-approved deployment measurements are unavailable.");
  }
  return Object.freeze({ model, composeHash, osImageHash });
}

function assertOperatorApprovedDeployment(
  model: string,
  deployment: MeasuredDeployment,
  approved: NearAiControlledCanaryOperatorApprovedDeployment,
): void {
  if (
    model !== NEAR_AI_CONTROLLED_CANARY_MODEL_ID ||
    approved.model !== NEAR_AI_CONTROLLED_CANARY_MODEL_ID
  ) {
    throw new Error("Canary model does not match the fixed operator-approved model ID.");
  }
  if (
    !isNonEmptyString(approved.composeHash) ||
    !isNonEmptyString(approved.osImageHash)
  ) {
    throw new Error("Operator-approved deployment measurements are unavailable.");
  }
  if (
    deployment.runtimeMeasurements.composeHash !== approved.composeHash ||
    deployment.runtimeMeasurements.osImageHash !== approved.osImageHash
  ) {
    throw new Error("Canary deployment measurements do not match operator-approved measurements.");
  }
}

export function createNearAiControlledCanaryClientOptions(
  apiKey: string,
  approvedDeployment: NearAiControlledCanaryOperatorApprovedDeployment,
): InferenceClientOptions {
  if (!isNonEmptyString(apiKey)) {
    throw new Error("NEARAI_API_KEY is unavailable.");
  }
  const approval = requireOperatorApprovedDeployment(approvedDeployment);

  return {
    apiKey,
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
      verifiers: {
        deployment: (deployment) =>
          assertOperatorApprovedDeployment(
            NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
            deployment,
            approval,
          ),
      },
    },
    deploymentPolicy: ({ model, deployment }) => {
      assertOperatorApprovedDeployment(model, deployment, approval);
    },
  };
}

function validateAttestation(
  result: CanaryAttestationResult,
  approvedDeployment: NearAiControlledCanaryOperatorApprovedDeployment,
): void {
  if (result.gateway.tcbStatus !== "UpToDate") {
    throw new Error("Gateway TCB policy was not satisfied.");
  }
  if (result.gateway.tlsBinding.kind !== "attested") {
    throw new Error("Attested Gateway TLS binding is required.");
  }
  if (result.models.length === 0) {
    throw new Error("No model attestation was returned.");
  }

  for (const attestation of result.models) {
    if (attestation.tcbStatus !== "UpToDate") {
      throw new Error("Model TCB policy was not satisfied.");
    }
    // The SDK marks this verified only after the configured deployment verifier succeeds;
    // that status does not establish independent NEAR approval.
    if (attestation.deploymentProvenance !== "verified") {
      throw new Error("Verified deployment provenance is required.");
    }
    if (attestation.gpuEvidence !== "verified") {
      throw new Error("Required GPU evidence was not verified.");
    }
    assertOperatorApprovedDeployment(
      NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
      attestation.deployment,
      approvedDeployment,
    );
  }
}

const createSdkClient: NearAiControlledCanaryClientFactory = (options) =>
  new InferenceClient(options);

export async function runNearAiControlledCanary(
  apiKey: string | undefined,
  createClient: NearAiControlledCanaryClientFactory = createSdkClient,
  approvedDeployment?: NearAiControlledCanaryOperatorApprovedDeployment,
): Promise<NearAiControlledCanaryReport> {
  if (!isNonEmptyString(apiKey)) {
    throw new Error("NEARAI_API_KEY is unavailable.");
  }
  const approval = requireOperatorApprovedDeployment(approvedDeployment);
  const client = createClient(
    createNearAiControlledCanaryClientOptions(apiKey, approval),
  );

  try {
    const attestation = await client.verify(
      NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
    );
    validateAttestation(attestation, approval);

    const completion = await client.chat.completions.create({
      model: NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
      messages: [
        {
          role: "user",
          content: NEAR_AI_CONTROLLED_CANARY_SYNTHETIC_PROMPT,
        },
      ],
      max_tokens: 8,
    });
    if (!isNonEmptyString(completion.id)) {
      throw new Error("Canary completion response ID is unavailable.");
    }

    const verified = await client.verifyResponse(completion.id);
    if (verified.signatureKind !== "provider_tee") {
      throw new Error("Provider TEE response signature is required.");
    }
    if (verified.id !== completion.id) {
      throw new Error("Verified response ID does not match the completion ID.");
    }

    return {
      model: NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
      cryptographicAttestation: "verified",
      gatewayTlsBinding: "attested",
      localTofuPin: "not_used",
      operatorApprovedMeasurements: "matched",
      independentNearApproval: "not_established",
      responseSignature: "provider_tee",
      responseId: completion.id,
    };
  } finally {
    client.clearResponseCache();
  }
}
