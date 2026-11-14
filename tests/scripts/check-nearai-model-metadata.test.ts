import { ApiError, AttestationClient } from "@nearai/inference-sdk/node";
import { describe, expect, it, vi } from "vitest";
import {
  DIAGNOSTIC_MODEL_ID,
  runNearAiModelMetadataDiagnostic,
} from "../../scripts/check-nearai-model-metadata.js";

describe("check-nearai-model-metadata diagnostic (offline)", () => {
  it("confirms AttestationClient exposes fetchModelMetadata without making network calls", () => {
    const client = new AttestationClient({ apiKey: "dummy-test-key" });
    expect(typeof client.fetchModelMetadata).toBe("function");
    expect(DIAGNOSTIC_MODEL_ID).toBe("z-ai/glm-5.3-flash");
  });

  it("fails safely without calling client when NEARAI_API_KEY is missing or blank", async () => {
    const createClient = vi.fn();
    const out: string[] = [];
    const err: string[] = [];

    const result = await runNearAiModelMetadataDiagnostic({
      getApiKey: () => "   ",
      createClient,
      writeLine: (line) => out.push(line),
      writeErrorLine: (line) => err.push(line),
    });

    expect(result.ok).toBe(false);
    expect(result.providerType).toBeNull();
    expect(result.attestationSupported).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
    expect(out).toHaveLength(0);
    expect(err.join("\n")).toContain("providerType: unavailable");
    expect(err.join("\n")).toContain("attestationSupported: unavailable");
    expect(err.join("\n")).toContain("NEARAI_API_KEY is not configured");
  });

  it("prints only providerType, attestationSupported, and diagnostic for supported and unsupported metadata", async () => {
    const linesSupported: string[] = [];
    let requestedModel = "";
    let passedApiKey = "";

    const supported = await runNearAiModelMetadataDiagnostic({
      getApiKey: () => "  sk-dummy-test-key  ",
      createClient: (options) => {
        passedApiKey = options.apiKey ?? "";
        return {
          fetchModelMetadata: async (model) => {
            requestedModel = model;
            return { providerType: "vllm", attestationSupported: true };
          },
        };
      },
      writeLine: (line) => linesSupported.push(line),
      writeErrorLine: vi.fn(),
    });

    expect(passedApiKey).toBe("sk-dummy-test-key");
    expect(requestedModel).toBe("z-ai/glm-5.3-flash");
    expect(supported.ok).toBe(true);
    expect(supported.providerType).toBe("vllm");
    expect(supported.attestationSupported).toBe(true);
    expect(linesSupported).toHaveLength(3);
    expect(linesSupported[0]).toBe("providerType: vllm");
    expect(linesSupported[1]).toBe("attestationSupported: true");
    expect(linesSupported[2]).toMatch(/^diagnostic: /);
    expect(linesSupported.join("\n")).not.toContain("sk-dummy-test-key");

    const linesUnsupported: string[] = [];
    const unsupported = await runNearAiModelMetadataDiagnostic({
      getApiKey: () => "sk-dummy-test-key",
      createClient: () => ({
        fetchModelMetadata: async () => ({
          providerType: "incognito",
          attestationSupported: false,
        }),
      }),
      writeLine: (line) => linesUnsupported.push(line),
      writeErrorLine: vi.fn(),
    });

    expect(unsupported.ok).toBe(true);
    expect(unsupported.providerType).toBe("incognito");
    expect(unsupported.attestationSupported).toBe(false);
    expect(linesUnsupported[0]).toBe("providerType: incognito");
    expect(linesUnsupported[1]).toBe("attestationSupported: false");
    expect(linesUnsupported[2]).toContain("policy.model_attestation_required");
  });

  it("sanitizes API errors and never exposes API keys, Bearer headers, or raw error messages", async () => {
    const errLines: string[] = [];
    const secret = "sk-never-leak-this-secret-value";

    const result = await runNearAiModelMetadataDiagnostic({
      getApiKey: () => secret,
      createClient: () => ({
        fetchModelMetadata: async () => {
          throw new ApiError(
            {
              code: "api.http_status",
              details: { resource: "model_metadata", status: 401 },
              retryable: false,
            },
            {
              cause: new Error(
                `Authorization: Bearer ${secret} raw stack secret leak`,
              ),
            },
          );
        },
      }),
      writeLine: vi.fn(),
      writeErrorLine: (line) => errLines.push(line),
    });

    expect(result.ok).toBe(false);
    const combined = errLines.join("\n");
    expect(combined).not.toContain(secret);
    expect(combined).not.toContain("Authorization:");
    expect(combined).not.toContain("raw stack secret leak");
    expect(combined).toContain("HTTP 401");
  });
});
