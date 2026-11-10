import { InferenceClient } from "@nearai/inference-sdk/node";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runNearAiControlledCanary,
  type NearAiControlledCanaryOperatorApprovedDeployment,
  type NearAiControlledCanaryClientFactory,
} from "../src/ai/near-ai-controlled-canary.ts";

// These values are an operator-controlled allowlist, not independent NEAR approval.
const createClient: NearAiControlledCanaryClientFactory = (options) =>
  new InferenceClient(options);

export async function executeNearAiControlledCanary(
  apiKey: string | undefined,
  writeOutput: (output: string) => void,
  clientFactory: NearAiControlledCanaryClientFactory = createClient,
  approvedDeployment?: NearAiControlledCanaryOperatorApprovedDeployment,
): Promise<void> {
  const report = await runNearAiControlledCanary(
    apiKey,
    clientFactory,
    approvedDeployment,
  );
  writeOutput(`${JSON.stringify(report, null, 2)}\n`);
}

function getOperatorApprovedDeploymentFromEnvironment():
  | NearAiControlledCanaryOperatorApprovedDeployment
  | undefined {
  const {
    NEARAI_OPERATOR_APPROVED_MODEL_ID,
    NEARAI_OPERATOR_APPROVED_COMPOSE_HASH,
    NEARAI_OPERATOR_APPROVED_OS_IMAGE_HASH,
  } = process.env;
  if (
    NEARAI_OPERATOR_APPROVED_MODEL_ID === undefined ||
    NEARAI_OPERATOR_APPROVED_COMPOSE_HASH === undefined ||
    NEARAI_OPERATOR_APPROVED_OS_IMAGE_HASH === undefined
  ) {
    return undefined;
  }
  return {
    model: NEARAI_OPERATOR_APPROVED_MODEL_ID,
    composeHash: NEARAI_OPERATOR_APPROVED_COMPOSE_HASH,
    osImageHash: NEARAI_OPERATOR_APPROVED_OS_IMAGE_HASH,
  };
}

export async function executeNearAiControlledCanaryCli(
  apiKey: string | undefined,
  approvedDeployment: NearAiControlledCanaryOperatorApprovedDeployment | undefined,
  writeOutput: (output: string) => void,
  writeError: (output: string) => void,
  clientFactory: NearAiControlledCanaryClientFactory = createClient,
): Promise<boolean> {
  try {
    await executeNearAiControlledCanary(
      apiKey,
      writeOutput,
      clientFactory,
      approvedDeployment,
    );
    return true;
  } catch {
    writeError("NEAR AI controlled canary failed.\n");
    return false;
  }
}

async function main(): Promise<void> {
  const succeeded = await executeNearAiControlledCanaryCli(
    process.env.NEARAI_API_KEY,
    getOperatorApprovedDeploymentFromEnvironment(),
    (output) => process.stdout.write(output),
    (output) => process.stderr.write(output),
  );
  if (!succeeded) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main();
}
