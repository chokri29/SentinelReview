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
import { parseDocument } from "yaml";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NEAR_AI_DISCOVERY_MODEL_ID = "z-ai/glm-5.3-flash" as const;

const MAX_APP_COMPOSE_BYTES = 1 * 1024 * 1024;
const MAX_COMPOSE_SERVICES = 200;

interface DiscoveryAttestationResult {
  readonly gateway: {
    readonly tcbStatus: TcbStatus;
  };
  readonly models: readonly {
    readonly tcbStatus: TcbStatus;
    readonly gpuEvidence: GpuEvidenceStatus;
    readonly deploymentProvenance: DeploymentProvenanceStatus;
    readonly deployment: {
      readonly appCompose: string;
      readonly runtimeMeasurements: RuntimeMeasurements;
    };
  }[];
}

interface DeploymentImageReference {
  readonly image: string;
  readonly digest: string | null;
  readonly pinnedToDigest: boolean;
  readonly referenceStatus: "digest_pinned" | "tag_only" | "untagged";
}

interface DeploymentImageInventory {
  readonly status: "parsed" | "malformed" | "unsupported";
  readonly images: readonly DeploymentImageReference[];
}

interface ModelAttestationSummary {
  readonly tcbStatus: "UpToDate";
  readonly gpuEvidence: "verified";
  readonly deploymentProvenance: "not_checked";
  readonly measurementApproval: "not_approved";
  readonly composeHash: string;
  readonly osImageHash: string;
  readonly deploymentImageInventory: DeploymentImageInventory;
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
  | "model metadata retrieval"
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRepositoryComponent(value: string): boolean {
  return /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/.test(value);
}

function isValidRegistryPort(value: string): boolean {
  if (!/^[0-9]+$/.test(value)) {
    return false;
  }
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

function isValidRegistryHostname(value: string): boolean {
  if (value.length > 253) {
    return false;
  }
  const labels = value.split(".");
  return labels.every(
    (label) =>
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

function isValidRegistry(value: string): boolean {
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    if (closingBracket < 0) {
      return false;
    }
    const address = value.slice(1, closingBracket);
    const suffix = value.slice(closingBracket + 1);
    return (
      isIP(address) === 6 &&
      (suffix.length === 0 ||
        (suffix.startsWith(":") &&
          isValidRegistryPort(suffix.slice(1))))
    );
  }

  const colonIndex = value.indexOf(":");
  if (colonIndex !== value.lastIndexOf(":")) {
    return false;
  }
  const hostname = colonIndex < 0 ? value : value.slice(0, colonIndex);
  const port = colonIndex < 0 ? undefined : value.slice(colonIndex + 1);
  if (
    hostname.length === 0 ||
    (port !== undefined && !isValidRegistryPort(port))
  ) {
    return false;
  }
  if (/^[0-9.]+$/.test(hostname)) {
    return isIP(hostname) === 4;
  }
  return isValidRegistryHostname(hostname);
}

function parseImageReference(
  reference: string,
): DeploymentImageReference | undefined {
  if (
    reference.length === 0 ||
    reference.trim() !== reference ||
    /\s/.test(reference)
  ) {
    return undefined;
  }

  const atIndex = reference.indexOf("@");
  const hasDigest = atIndex >= 0;
  const nameAndTag = hasDigest ? reference.slice(0, atIndex) : reference;
  const digest = hasDigest ? reference.slice(atIndex + 1) : null;
  if (
    (hasDigest &&
      (reference.indexOf("@", atIndex + 1) >= 0 ||
        digest === null ||
        !/^sha256:[a-f0-9]{64}$/.test(digest))) ||
    nameAndTag.length === 0
  ) {
    return undefined;
  }

  const lastSlash = nameAndTag.lastIndexOf("/");
  const lastColon = nameAndTag.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const image = hasTag ? nameAndTag.slice(0, lastColon) : nameAndTag;
  const tag = hasTag ? nameAndTag.slice(lastColon + 1) : undefined;
  if (
    image.length === 0 ||
    (tag !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag))
  ) {
    return undefined;
  }

  const components = image.split("/");
  if (components.some((component) => component.length === 0)) {
    return undefined;
  }
  const firstComponent = components[0];
  if (firstComponent === undefined) {
    return undefined;
  }
  const hasRegistry =
    firstComponent.includes(".") ||
    firstComponent.includes(":") ||
    firstComponent === "localhost" ||
    firstComponent.startsWith("[");
  if (
    image.length > 255 ||
    (hasRegistry &&
      (components.length < 2 || !isValidRegistry(firstComponent))) ||
    components
      .slice(hasRegistry ? 1 : 0)
      .some((component) => !isValidRepositoryComponent(component))
  ) {
    return undefined;
  }

  return {
    image,
    digest,
    pinnedToDigest: digest !== null,
    referenceStatus: digest !== null ? "digest_pinned" : hasTag ? "tag_only" : "untagged",
  };
}

function parseDeploymentImageInventory(
  appCompose: string,
): DeploymentImageInventory {
  if (Buffer.byteLength(appCompose, "utf8") > MAX_APP_COMPOSE_BYTES) {
    return { status: "unsupported", images: [] };
  }

  let appConfiguration: unknown;
  try {
    appConfiguration = JSON.parse(appCompose);
  } catch {
    return { status: "malformed", images: [] };
  }
  if (
    !isRecord(appConfiguration) ||
    typeof appConfiguration.docker_compose_file !== "string"
  ) {
    return { status: "unsupported", images: [] };
  }

  let composeDocument;
  try {
    composeDocument = parseDocument(appConfiguration.docker_compose_file, {
      strict: true,
      uniqueKeys: true,
    });
    if (composeDocument.errors.length > 0 || composeDocument.warnings.length > 0) {
      return { status: "malformed", images: [] };
    }
  } catch {
    return { status: "malformed", images: [] };
  }

  let compose: unknown;
  try {
    compose = composeDocument.toJS();
  } catch {
    return { status: "malformed", images: [] };
  }
  if (!isRecord(compose) || !isRecord(compose.services)) {
    return { status: "unsupported", images: [] };
  }
  const services = Object.values(compose.services);
  if (services.length > MAX_COMPOSE_SERVICES) {
    return { status: "unsupported", images: [] };
  }

  const images: DeploymentImageReference[] = [];
  for (const service of services) {
    if (!isRecord(service)) {
      return { status: "unsupported", images: [] };
    }
    const imageValue = service.image;
    if (imageValue === undefined || imageValue === null) {
      continue;
    }
    if (typeof imageValue !== "string") {
      return { status: "unsupported", images: [] };
    }
    const parsedReference = parseImageReference(imageValue);
    if (parsedReference === undefined) {
      return { status: "unsupported", images: [] };
    }
    images.push(parsedReference);
  }

  return { status: "parsed", images };
}

function stageForApiResource(resource: unknown): FailureStage {
  switch (resource) {
    case "gateway_attestation":
      return "gateway attestation retrieval";
    case "model_metadata":
      return "model metadata retrieval";
    case "model_attestation":
      return "model attestation retrieval";
    default:
      return "attestation discovery";
  }
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
  if (failure.code === "api.invalid_response") {
    return {
      stage: "attestation response validation",
      classification: "attestation service returned an invalid response",
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
      deploymentImageInventory: parseDeploymentImageInventory(
        attestation.deployment.appCompose,
      ),
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

export async function runNearAiAttestationDiscoveryCli(
  apiKey: string | undefined,
  writeOutput: (output: string) => void,
  writeError: (message: string) => void,
  clientFactory: DiscoveryClientFactory = createDiscoveryClient,
): Promise<number> {
  const succeeded = await executeNearAiAttestationDiscovery(
    apiKey,
    writeOutput,
    writeError,
    clientFactory,
  );
  return succeeded ? 0 : 1;
}

async function main(): Promise<void> {
  const exitCode = await runNearAiAttestationDiscoveryCli(
    process.env.NEARAI_API_KEY,
    (output) => process.stdout.write(output),
    (message) => process.stderr.write(message),
  );
  if (exitCode !== 0) {
    process.exitCode = exitCode;
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
