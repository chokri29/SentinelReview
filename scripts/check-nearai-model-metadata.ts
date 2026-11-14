import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AttestationClient,
  isApiError,
  isVerificationError,
  type AttestationClientOptions,
  type ModelMetadata,
} from "@nearai/inference-sdk/node";

export const DIAGNOSTIC_MODEL_ID = "z-ai/glm-5.3-flash" as const;

const NETWORK_ERROR_CODES = new Set<string>([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export interface MetadataDiagnosticClient {
  fetchModelMetadata(model: string): Promise<ModelMetadata>;
}

export interface MetadataDiagnosticDependencies {
  readonly getApiKey?: () => string | undefined;
  readonly createClient?: (
    options: AttestationClientOptions,
  ) => MetadataDiagnosticClient;
  readonly writeLine?: (line: string) => void;
  readonly writeErrorLine?: (line: string) => void;
}

export interface MetadataDiagnosticResult {
  readonly ok: boolean;
  readonly providerType: string | null;
  readonly attestationSupported: boolean | null;
  readonly diagnostic: string;
}

function defaultClientFactory(
  options: AttestationClientOptions,
): MetadataDiagnosticClient {
  return new AttestationClient(options);
}

function getNetworkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current !== undefined && current !== null;
    depth += 1
  ) {
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) {
        return code;
      }
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return undefined;
}

function sanitizeMetadataError(error: unknown): string {
  if (isApiError(error)) {
    const failure = error.failure;
    if (failure.code === "api.http_status") {
      if (failure.details.status === 401 || failure.details.status === 403) {
        return `Metadata request failed authentication/authorization (HTTP ${failure.details.status}).`;
      }
      return `Metadata request failed with gateway HTTP status ${failure.details.status}.`;
    }
    if (failure.code === "api.transport_failed") {
      return "Metadata request failed due to a network transport error.";
    }
    if (
      failure.code === "api.invalid_json" ||
      failure.code === "api.invalid_response"
    ) {
      return "NEAR AI gateway returned a malformed metadata response.";
    }
    return `Metadata request failed with SDK error code ${failure.code}.`;
  }

  if (isVerificationError(error)) {
    return `Metadata request failed SDK verification (${error.failure.code}).`;
  }

  const networkCode = getNetworkErrorCode(error);
  if (networkCode !== undefined) {
    return `Metadata request failed due to network error (${networkCode}).`;
  }

  return "Metadata request failed due to an unexpected error.";
}

function isValidModelMetadata(value: unknown): value is ModelMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { providerType?: unknown }).providerType === "string" &&
    typeof (value as { attestationSupported?: unknown })
      .attestationSupported === "boolean"
  );
}

function buildSuccessDiagnostic(metadata: ModelMetadata): string {
  if (metadata.providerType === "vllm" && metadata.attestationSupported) {
    return "Model advertises vLLM NEAR model-attestation support; inference still requires cryptographic attestation and operator-approved measurement verification.";
  }
  if (metadata.attestationSupported) {
    return "Model advertises attestationSupported=true, but providerType is not vllm; InferenceClient rejects model attestation policies for non-vllm providers.";
  }
  return "Model does not advertise model-attestation support (gateway-only / Incognito); required model attestation policies will fail with policy.model_attestation_required.";
}

export async function runNearAiModelMetadataDiagnostic(
  dependencies: MetadataDiagnosticDependencies = {},
): Promise<MetadataDiagnosticResult> {
  const getApiKey =
    dependencies.getApiKey ?? (() => process.env.NEARAI_API_KEY);
  const createClient = dependencies.createClient ?? defaultClientFactory;
  const writeLine = dependencies.writeLine ?? ((line) => console.log(line));
  const writeErrorLine =
    dependencies.writeErrorLine ?? ((line) => console.error(line));

  const rawApiKey = getApiKey();
  if (typeof rawApiKey !== "string" || rawApiKey.trim().length === 0) {
    const diagnostic =
      "NEARAI_API_KEY is not configured; cannot query NEAR AI model metadata.";
    writeErrorLine("providerType: unavailable");
    writeErrorLine("attestationSupported: unavailable");
    writeErrorLine(`diagnostic: ${diagnostic}`);
    return {
      ok: false,
      providerType: null,
      attestationSupported: null,
      diagnostic,
    };
  }

  try {
    const client = createClient({ apiKey: rawApiKey.trim() });
    const metadata = await client.fetchModelMetadata(DIAGNOSTIC_MODEL_ID);
    if (!isValidModelMetadata(metadata)) {
      const diagnostic =
        "NEAR AI gateway returned an invalid model metadata payload.";
      writeErrorLine("providerType: unavailable");
      writeErrorLine("attestationSupported: unavailable");
      writeErrorLine(`diagnostic: ${diagnostic}`);
      return {
        ok: false,
        providerType: null,
        attestationSupported: null,
        diagnostic,
      };
    }

    const diagnostic = buildSuccessDiagnostic(metadata);
    writeLine(`providerType: ${metadata.providerType}`);
    writeLine(`attestationSupported: ${metadata.attestationSupported}`);
    writeLine(`diagnostic: ${diagnostic}`);
    return {
      ok: true,
      providerType: metadata.providerType,
      attestationSupported: metadata.attestationSupported,
      diagnostic,
    };
  } catch (error) {
    const diagnostic = sanitizeMetadataError(error);
    writeErrorLine("providerType: unavailable");
    writeErrorLine("attestationSupported: unavailable");
    writeErrorLine(`diagnostic: ${diagnostic}`);
    return {
      ok: false,
      providerType: null,
      attestationSupported: null,
      diagnostic,
    };
  }
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  runNearAiModelMetadataDiagnostic()
    .then((result) => {
      if (!result.ok) {
        process.exitCode = 1;
      }
    })
    .catch(() => {
      console.error("providerType: unavailable");
      console.error("attestationSupported: unavailable");
      console.error(
        "diagnostic: Metadata diagnostic failed due to an unexpected error.",
      );
      process.exitCode = 1;
    });
}
