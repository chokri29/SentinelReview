import { InferenceClient } from "@nearai/inference-sdk/node";
import type {
  AttestationVerificationResult,
  InferenceClientOptions,
  VerifiedCompletionResult,
  VerifiedGatewayCompletionResult,
  VerifiedModelCompletionResult,
} from "@nearai/inference-sdk/node";
import { expect, it } from "vitest";

const clientOptions = {
  apiKey: "test-only-not-a-real-key",
  e2ee: true,
} satisfies InferenceClientOptions;

async function checkVerificationTypes(client: InferenceClient): Promise<void> {
  const attestation: AttestationVerificationResult =
    await client.verify("example/model");
  const modelAttestations = attestation.models;

  const completion = await client.chat.completions.create({
    model: "example/model",
    messages: [{ role: "user", content: "type-check only" }],
    stream: false,
  });
  const verified: VerifiedCompletionResult = await client.verifyResponse(
    completion.id,
  );

  if (verified.signatureKind === "provider_tee") {
    const modelSignature: VerifiedModelCompletionResult = verified;
    void modelSignature.attestations;
  } else {
    const gatewaySignature: VerifiedGatewayCompletionResult = verified;
    void gatewaySignature.attestation;
  }

  void modelAttestations;
}

it("constructs the typed Node client without making a request", () => {
  const client = new InferenceClient(clientOptions);

  expect(client).toBeInstanceOf(InferenceClient);
  expect(checkVerificationTypes).toBeTypeOf("function");
});
