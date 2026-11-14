import { InferenceClient } from "@nearai/inference-sdk/node";
import { describe, expect, it } from "vitest";
import {
  createNearAiControlledCanaryClientOptions,
  NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
} from "../../src/ai/near-ai-controlled-canary.js";

describe("@nearai/inference-sdk/node compatibility", () => {
  it("exposes InferenceClient and required verification/chat methods without making network calls on construction", () => {
    expect(typeof InferenceClient).toBe("function");

    const options = createNearAiControlledCanaryClientOptions("dummy-test-key", {
      model: NEAR_AI_CONTROLLED_CANARY_MODEL_ID,
      composeHash: "dummy-compose-hash",
      osImageHash: "dummy-os-image-hash",
    });

    const client = new InferenceClient(options);
    expect(typeof client.verify).toBe("function");
    expect(typeof client.chat?.completions?.create).toBe("function");
    expect(typeof client.verifyResponse).toBe("function");
    expect(typeof client.clearResponseCache).toBe("function");

    client.clearResponseCache();
  });
});
