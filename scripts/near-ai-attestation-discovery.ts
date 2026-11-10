import {
  getSdkError,
  InferenceClient,
  isApiError,
  isVerificationError,
  type ApiError,
  type DeploymentProvenanceStatus,
  type GpuEvidenceStatus,
  type InferenceClientOptions,
  type RuntimeMeasurements,
  type TcbStatus,
  type VerificationError,
} from "@nearai/inference-sdk/node";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NEAR_AI_DISCOVERY_MODEL_ID = "z-ai/glm-5.3-flash" as const;

interface DiscoveryAttestationResult {
  readonly gateway: {
    readonly tcbStatus: TcbStatus;
  };
  readonly models: readonly {
    readonly tcbStatus: TcbStatus;
    readonly gpuEvidence: GpuEvidenceStatus;
    readonly deploymentProvenance: DeploymentProvenanceStatus;
    readonly deployment: {
      readonly runtimeMeasurements: RuntimeMeasurements;
    };
  }[];
}

interface ModelAttestationSummary {
  readonly tcbStatus: "UpToDate";
  readonly gpuEvidence: "verified";
  readonly deploymentProvenance: "not_checked";
  readonly measurementApproval: "not_approved";
  readonly composeHash: string;
  readonly osImageHash: string;
}

export interface NearAiDiscoveryReport {
  readonly model: typeof NEAR_AI_DISCOVERY_MODEL_ID;
  readonly gatewayTcbStatus: "UpToDate";
  readonly modelAttestations: readonly ModelAttestationSummary[];
}

interface DiscoveryClient {
  verify(model: string): Promise<DiscoveryAttestationResult>;
}

type DiscoveryClientFactory = (
  options: InferenceClientOptions,
) => DiscoveryClient;

type FailureStage =
  | "configuration"
  | "SDK initialization"
  | "network/TLS connectivity"
  | "gateway attestation retrieval"
  | "model attestation retrieval"
  | "attestation response validation"
  | "attestation verification"
  | "report validation"
  | "attestation discovery";

interface FailureDiagnostic {
  readonly stage: FailureStage;
  readonly classification: string;
}

const createDiscoveryClient: DiscoveryClientFactory = (options) =>
  new InferenceClient(options);

export function createDiscoveryClientOptions(
  apiKey: string,
): InferenceClientOptions {
  return {
    apiKey,
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
  };
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function stageForApiResource(resource: string): FailureStage {
  if (resource === "gateway_attestation") {
    return "gateway attestation retrieval";
  }
  if (resource === "model_metadata" || resource === "model_attestation") {
    return "model attestation retrieval";
  }
  return "attestation discovery";
}

function classifyApiError(error: ApiError): FailureDiagnostic {
  const { failure } = error;
  if (failure.code === "api.transport_failed") {
    return {
      stage: "network/TLS connectivity",
      classification: "attestation service transport failure",
    };
  }
  if (failure.code === "api.http_status") {
    return {
      stage: stageForApiResource(failure.details.resource),
      classification: `attestation service returned HTTP status ${failure.details.status}`,
    };
  }
  if (failure.code === "api.invalid_json") {
    return {
      stage: stageForApiResource(failure.details.resource),
      classification: "attestation service returned invalid JSON",
    };
  }
  if (failure.code === "api.nonce_mismatch") {
    return {
      stage: stageForApiResource(failure.details.resource),
      classification: "attestation request binding failed",
    };
  }
  if (
    failure.code === "api.ambiguous_model_attestation_signer" ||
    failure.code === "api.model_attestation_signer_not_found"
  ) {
    return {
      stage: "model attestation retrieval",
      classification: "model attestation signer selection failed",
    };
  }
  return {
    stage: "attestation discovery",
    classification: "SDK request or response processing failed",
  };
}

function classifyVerificationError(
  error: VerificationError,
): FailureDiagnostic {
  const { code } = error.failure;
  let classification = "cryptographic attestation verification failed";
  if (code.startsWith("policy.")) {
    classification = "attestation policy was not satisfied";
  } else if (code.startsWith("quote.")) {
    classification = "hardware quote verification failed";
  } else if (code.startsWith("binding.")) {
    classification = "attestation binding verification failed";
  } else if (code.startsWith("measurement.")) {
    classification = "runtime measurement verification failed";
  } else if (code.startsWith("gpu.")) {
    classification = "GPU evidence verification failed";
  }
  return { stage: "attestation verification", classification };
}

function classifyDiscoveryFailure(error: unknown): FailureDiagnostic {
  const sdkError = getSdkError(error);
  if (sdkError !== undefined) {
    if (isApiError(sdkError)) {
      return classifyApiError(sdkError);
    }
    if (isVerificationError(sdkError)) {
      return classifyVerificationError(sdkError);
    }
  }
  return {
    stage: "attestation discovery",
    classification: "unexpected runtime or SDK failure",
  };
}

function writeFailure(
  writeError: (message: string) => void,
  diagnostic: FailureDiagnostic,
): void {
  writeError(
    `NEAR AI attestation discovery failed during ${diagnostic.stage}: ${diagnostic.classification}.\n`,
  );
}

export function buildDiscoveryReport(
  result: DiscoveryAttestationResult,
): NearAiDiscoveryReport {
  if (result.gateway.tcbStatus !== "UpToDate") {
    throw new Error("Gateway TCB policy was not satisfied.");
  }
  if (result.models.length === 0) {
    throw new Error("No model attestation was returned.");
  }

  const modelAttestations = result.models.map((attestation) => {
    if (attestation.tcbStatus !== "UpToDate") {
      throw new Error("Model TCB policy was not satisfied.");
    }
    if (attestation.gpuEvidence !== "verified") {
      throw new Error("Required GPU evidence was not verified.");
    }
    if (attestation.deploymentProvenance !== "not_checked") {
      throw new Error("Unexpected deployment provenance status.");
    }

    const { composeHash, osImageHash } =
      attestation.deployment.runtimeMeasurements;
    if (
      !isNonEmptyString(composeHash) ||
      !isNonEmptyString(osImageHash)
    ) {
      throw new Error("Required deployment measurements are unavailable.");
    }

    return {
      tcbStatus: "UpToDate" as const,
      gpuEvidence: "verified" as const,
      deploymentProvenance: "not_checked" as const,
      measurementApproval: "not_approved" as const,
      composeHash,
      osImageHash,
    };
  });

  return {
    model: NEAR_AI_DISCOVERY_MODEL_ID,
    gatewayTcbStatus: "UpToDate",
    modelAttestations,
  };
}

export async function collectDiscoveryReport(
  client: DiscoveryClient,
): Promise<NearAiDiscoveryReport> {
  const result = await client.verify(NEAR_AI_DISCOVERY_MODEL_ID);
  return buildDiscoveryReport(result);
}

export async function executeNearAiAttestationDiscovery(
  apiKey: string | undefined,
  writeOutput: (output: string) => void,
  writeError: (message: string) => void,
  clientFactory: DiscoveryClientFactory = createDiscoveryClient,
): Promise<boolean> {
  if (!isNonEmptyString(apiKey)) {
    writeFailure(writeError, {
      stage: "configuration",
      classification: "NEARAI_API_KEY is missing or blank",
    });
    return false;
  }

  let client: DiscoveryClient;
  try {
    client = clientFactory(createDiscoveryClientOptions(apiKey));
  } catch {
    writeFailure(writeError, {
      stage: "SDK initialization",
      classification: "SDK client initialization failed",
    });
    return false;
  }

  let result: DiscoveryAttestationResult;
  try {
    result = await client.verify(NEAR_AI_DISCOVERY_MODEL_ID);
  } catch (error) {
    writeFailure(writeError, classifyDiscoveryFailure(error));
    return false;
  }

  let report: NearAiDiscoveryReport;
  try {
    report = buildDiscoveryReport(result);
  } catch {
    writeFailure(writeError, {
      stage: "report validation",
      classification: "attestation report did not satisfy required fields or policies",
    });
    return false;
  }

  writeOutput(`${JSON.stringify(report, null, 2)}\n`);
  return true;
}

async function main(): Promise<void> {
  const succeeded = await executeNearAiAttestationDiscovery(
    process.env.NEARAI_API_KEY,
    (output) => process.stdout.write(output),
    (message) => process.stderr.write(message),
  );
  if (!succeeded) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main().catch(() => {
    process.stderr.write(
      "NEAR AI attestation discovery failed during CLI execution: unexpected runtime failure.\n",
    );
    process.exitCode = 1;
  });
}
