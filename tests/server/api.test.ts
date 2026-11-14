import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  DEFAULT_TOKEN_TTL_MS,
  type ServerAppOptions,
} from "../../server.js";
import { createNearAiAdapter } from "../../src/ai/near-ai-adapter.js";

const servers: Server[] = [];

async function startTestServer(
  options: ServerAppOptions = {},
): Promise<{ baseUrl: string; origin: string }> {
  const app = await createApp({ enableVite: false, ...options });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return { baseUrl: origin, origin };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe("SentinelReview Express API", () => {
  it("enforces 2-minute default consent-token lifetime", () => {
    expect(DEFAULT_TOKEN_TTL_MS).toBe(120_000);
  });

  it("serves bundled deterministic fixtures and rejects unknown fixtures", async () => {
    const { baseUrl } = await startTestServer();

    const triggeringRes = await fetch(`${baseUrl}/api/review?fixture=triggering`);
    expect(triggeringRes.status).toBe(200);
    const triggering = (await triggeringRes.json()) as {
      report: {
        overallAnalysisStatus: string;
        deterministicRule: { findingCount: number };
        evidenceIntegration: { status: string };
      };
      consentToken: string;
    };
    expect(triggering.report.overallAnalysisStatus).toBe("finding");
    expect(triggering.report.deterministicRule.findingCount).toBe(1);
    expect(triggering.report.evidenceIntegration.status).toBe("complete");
    expect(triggering.consentToken).toMatch(/^[a-f0-9]{64}$/);

    const safeRes = await fetch(`${baseUrl}/api/review?fixture=safe`);
    expect(safeRes.status).toBe(200);
    const safe = (await safeRes.json()) as {
      report: { overallAnalysisStatus: string; deterministicRule: { findingCount: number } };
    };
    expect(safe.report.overallAnalysisStatus).toBe("no_findings");
    expect(safe.report.deterministicRule.findingCount).toBe(0);

    const invalidRes = await fetch(`${baseUrl}/api/review?fixture=unknown`);
    expect(invalidRes.status).toBe(400);
  });

  it("handles custom Rust paste and multi-file .rs uploads while rejecting malformed or unsafe payloads", async () => {
    const { baseUrl } = await startTestServer({
      customLimits: { maxFiles: 3, maxFileBytes: 512, maxTotalBytes: 768 },
    });

    // Valid custom paste
    const pasteRes = await fetch(`${baseUrl}/api/review/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [
          {
            path: "src/lib.rs",
            content:
              "#[near]\nimpl C {\n  pub fn cb(#[callback_result] r: Result<(), E>) {}\n}\n",
          },
        ],
      }),
    });
    expect(pasteRes.status).toBe(200);
    const pasteJson = (await pasteRes.json()) as {
      sourceKind: string;
      report: {
        overallAnalysisStatus: string;
        evidenceIntegration: { status: string };
      };
    };
    expect(pasteJson.sourceKind).toBe("custom");
    expect(pasteJson.report.overallAnalysisStatus).toBe("finding");
    expect(pasteJson.report.evidenceIntegration.status).toBe("complete");

    // Multi-file .rs upload
    const multiRes = await fetch(`${baseUrl}/api/review/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [
          { path: "src/mod.rs", content: "pub fn helper() {}\n" },
          { path: "src/lib.rs", content: "mod helper;\n" },
        ],
      }),
    });
    expect(multiRes.status).toBe(200);

    // Invalid extension
    const badExt = await fetch(`${baseUrl}/api/review/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "notes.txt", content: "hello" }],
      }),
    });
    expect(badExt.status).toBe(400);

    // Path traversal
    const traversal = await fetch(`${baseUrl}/api/review/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "../lib.rs", content: "fn a() {}" }],
      }),
    });
    expect(traversal.status).toBe(400);

    // Malformed JSON
    const malformed = await fetch(`${baseUrl}/api/review/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);

    // Empty files array
    const emptyFiles = await fetch(`${baseUrl}/api/review/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [] }),
    });
    expect(emptyFiles.status).toBe(400);

    // Size limit enforcement (per-file > 512 bytes)
    const oversized = await fetch(`${baseUrl}/api/review/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "src/big.rs", content: "a".repeat(600) }],
      }),
    });
    expect(oversized.status).toBe(400);
  });

  it("enforces same-origin, consent header, Content-Type, and rejects client-supplied model overrides", async () => {
    const { baseUrl, origin } = await startTestServer();
    const review = (await fetch(`${baseUrl}/api/review?fixture=triggering`).then(
      (r) => r.json(),
    )) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };

    const validBody = {
      sourceKind: "fixture",
      fixture: "triggering",
      snapshotHash: review.report.snapshot.sourceHash,
      token: review.consentToken,
    };

    // Missing Origin header
    const missingOrigin = await fetch(`${baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify(validBody),
    });
    expect(missingOrigin.status).toBe(403);

    // Cross-origin header
    const crossOrigin = await fetch(`${baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify(validBody),
    });
    expect(crossOrigin.status).toBe(403);

    // Missing consent header
    const missingConsent = await fetch(`${baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody),
    });
    expect(missingConsent.status).toBe(403);

    // Wrong Content-Type
    const wrongContentType = await fetch(`${baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "text/plain",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify(validBody),
    });
    expect(wrongContentType.status).toBe(415);

    // Client attempting to override modelId or measurements rejected by strict schema
    const extraFields = await fetch(`${baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({ ...validBody, modelId: "attacker/model" }),
    });
    expect(extraFields.status).toBe(400);
  });

  it("enforces single-use consent tokens, blocks concurrent reuse, and enforces expiry", async () => {
    let clock = 1_000_000;
    const { baseUrl, origin } = await startTestServer({
      tokenTtlMs: 5_000,
      now: () => clock,
    });

    // Single-use & concurrent consumption
    const review1 = (await fetch(`${baseUrl}/api/review?fixture=triggering`).then(
      (r) => r.json(),
    )) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${baseUrl}/api/ai-review`, {
          method: "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            "x-sentinelreview-ai-consent": "1",
          },
          body: JSON.stringify({
            sourceKind: "fixture",
            fixture: "triggering",
            snapshotHash: review1.report.snapshot.sourceHash,
            token: review1.consentToken,
          }),
        }),
      ),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 401)).toHaveLength(4);

    // Token expiry
    const review2 = (await fetch(`${baseUrl}/api/review?fixture=safe`).then(
      (r) => r.json(),
    )) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };

    clock += 5_001;
    const expiredRes = await fetch(`${baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "safe",
        snapshotHash: review2.report.snapshot.sourceHash,
        token: review2.consentToken,
      }),
    });
    expect(expiredRes.status).toBe(401);
  });

  it("refuses provider calls when operator-approved measurements are missing or mismatched", async () => {
    const verifySpy = vi.fn();
    const { baseUrl, origin } = await startTestServer({
      getAiConfig: () => ({
        apiKey: "test-key",
        composeHash: undefined,
        osImageHash: undefined,
      }),
    });

    const review = (await fetch(`${baseUrl}/api/review?fixture=triggering`).then(
      (r) => r.json(),
    )) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };

    const res = await fetch(`${baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: review.report.snapshot.sourceHash,
        token: review.consentToken,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      approvedMeasurementsConfigured: boolean;
      execution: { sourceTransmission: string; aiInference: string };
      aiAnalysis: { coverage: string; provenance: { privateModelPolicy: string } };
    };
    expect(body.approvedMeasurementsConfigured).toBe(false);
    expect(body.execution.sourceTransmission).toBe("none");
    expect(body.execution.aiInference).toBe("failed");
    expect(body.aiAnalysis.coverage).toBe("not_run");
    expect(body.aiAnalysis.provenance.privateModelPolicy).toBe("unavailable");
    expect(verifySpy).not.toHaveBeenCalled();

    // Incorrect operator-approved deployment measurements rejected before completion
    const wrongMeasurements = await startTestServer({
      createAiAdapter: () =>
        createNearAiAdapter({
          approvedModelDeployments: [
            { composeHash: "approved-c", osImageHash: "approved-os" },
          ],
          getApiKey: () => "test-key",
          createClient: () => ({
            verify: async () => ({
              gateway: {
                signer: { signingAlgo: "ed25519", signingAddress: "gw" },
                tcbStatus: "UpToDate",
                advisoryIds: [],
                deployment: {
                  appCompose: "gw",
                  runtimeMeasurements: { composeHash: "g1", osImageHash: "g2" },
                },
                deploymentProvenance: "verified",
                report: {},
                tlsBinding: { kind: "none" },
              },
              models: [
                {
                  signer: { signingAlgo: "ed25519", signingAddress: "m" },
                  tcbStatus: "UpToDate",
                  advisoryIds: [],
                  deployment: {
                    appCompose: "m",
                    runtimeMeasurements: {
                      composeHash: "wrong-c",
                      osImageHash: "approved-os",
                    },
                  },
                  deploymentProvenance: "verified",
                  report: {},
                  gpuEvidence: "verified",
                  signingPublicKey: "pub",
                },
              ],
              verifiedAt: Date.now(),
            }),
            createChatCompletion: vi.fn(),
            verifyResponse: vi.fn(),
          }),
        }),
    });

    const rev2 = (await fetch(
      `${wrongMeasurements.baseUrl}/api/review?fixture=triggering`,
    ).then((r) => r.json())) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };

    const res2 = await fetch(`${wrongMeasurements.baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: wrongMeasurements.origin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: rev2.report.snapshot.sourceHash,
        token: rev2.consentToken,
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as {
      execution: { sourceTransmission: string };
      aiAnalysis: { coverage: string; provenance: { privateModelPolicy: string } };
    };
    expect(body2.execution.sourceTransmission).toBe("none");
    expect(body2.aiAnalysis.coverage).toBe("not_run");
    expect(body2.aiAnalysis.provenance.privateModelPolicy).toBe("rejected");
  });

  it("sets security/no-store headers, rejects userinfo Origins, enforces 415 on /api/review/custom, rejects 409 hash/config mismatches, and returns 404 for evicted custom snapshots", async () => {
    let dynamicComposeHash = "compose-v1";
    const { baseUrl, origin } = await startTestServer({
      getAiConfig: () => ({
        apiKey: "test-key",
        composeHash: dynamicComposeHash,
        osImageHash: "os-v1",
      }),
    });

    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("cache-control")).toBe("no-store");
    expect(healthRes.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(healthRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(healthRes.headers.get("referrer-policy")).toBe("no-referrer");

    // 415 on non-JSON /api/review/custom
    const customWrongCt = await fetch(`${baseUrl}/api/review/custom`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ files: [{ path: "lib.rs", content: "fn a() {}" }] }),
    });
    expect(customWrongCt.status).toBe(415);

    const rev = (await fetch(`${baseUrl}/api/review?fixture=triggering`).then(
      (r) => r.json(),
    )) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };

    // Origin with embedded userinfo must be rejected
    const parsedOrigin = new URL(origin);
    const userinfoOrigin = `${parsedOrigin.protocol}//user@${parsedOrigin.host}`;
    const badOriginRes = await fetch(`${baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: userinfoOrigin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: rev.report.snapshot.sourceHash,
        token: rev.consentToken,
      }),
    });
    expect(badOriginRes.status).toBe(403);

    // 409 on snapshotHash mismatch consumes the token
    const mismatchRes = await fetch(`${baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: "0".repeat(64),
        token: rev.consentToken,
      }),
    });
    expect(mismatchRes.status).toBe(409);

    const retryAfter409 = await fetch(`${baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: rev.report.snapshot.sourceHash,
        token: rev.consentToken,
      }),
    });
    expect(retryAfter409.status).toBe(401);

    // 409 when modelConfigFingerprint changes before AI confirmation
    const revConfig = (await fetch(`${baseUrl}/api/review?fixture=triggering`).then(
      (r) => r.json(),
    )) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };
    dynamicComposeHash = "compose-v2";
    const configChangedRes = await fetch(`${baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: revConfig.report.snapshot.sourceHash,
        token: revConfig.consentToken,
      }),
    });
    expect(configChangedRes.status).toBe(409);

    // 404 when a custom snapshot is evicted from the bounded 50-entry cache
    const firstCustom = (await fetch(`${baseUrl}/api/review/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "src/first.rs", content: "pub fn first() {}\n" }],
      }),
    }).then((r) => r.json())) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };

    for (let i = 0; i < 50; i += 1) {
      await fetch(`${baseUrl}/api/review/custom`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{ path: `src/f_${i}.rs`, content: `pub fn f_${i}() {}\n` }],
        }),
      });
    }

    const evictedRes = await fetch(`${baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "custom",
        snapshotHash: firstCustom.report.snapshot.sourceHash,
        token: firstCustom.consentToken,
      }),
    });
    expect(evictedRes.status).toBe(404);
  });

  it("reports sourceTransmission as attempted and coverage as incomplete on post-callback SDK/verification failures while keeping deterministic findings intact", async () => {
    const approved = {
      composeHash: "approved-c",
      osImageHash: "approved-os",
    };
    const modelAtt = {
      signer: { signingAlgo: "ed25519", signingAddress: "model-signer-1" },
      tcbStatus: "UpToDate",
      advisoryIds: [],
      deployment: {
        appCompose: "m",
        runtimeMeasurements: approved,
      },
      deploymentProvenance: "verified",
      report: {},
      gpuEvidence: "verified",
      signingPublicKey: "pub-key",
    };
    const gatewayAtt = {
      signer: { signingAlgo: "ed25519", signingAddress: "gw-signer-1" },
      tcbStatus: "UpToDate",
      advisoryIds: [],
      deployment: {
        appCompose: "gw",
        runtimeMeasurements: { composeHash: "g1", osImageHash: "g2" },
      },
      deploymentProvenance: "verified",
      report: {},
      tlsBinding: { kind: "none" },
    };

    // 1. SDK completion call fails after callback
    const sdkFailServer = await startTestServer({
      getAiConfig: () => ({
        apiKey: "test-key",
        composeHash: approved.composeHash,
        osImageHash: approved.osImageHash,
      }),
      createAiAdapter: () =>
        createNearAiAdapter({
          approvedModelDeployments: [approved],
          getApiKey: () => "test-key",
          createClient: () => ({
            verify: async () => ({
              gateway: gatewayAtt,
              models: [modelAtt],
              verifiedAt: Date.now(),
            }),
            createChatCompletion: async () => {
              throw new Error("gateway timeout");
            },
            verifyResponse: vi.fn(),
          }),
        }),
    });

    const detBefore = (await fetch(
      `${sdkFailServer.baseUrl}/api/review?fixture=triggering`,
    ).then((r) => r.json())) as {
      execution: { sourceTransmission: string };
      report: {
        snapshot: { sourceHash: string };
        overallAnalysisStatus: string;
        findings: { findingId: string }[];
      };
      consentToken: string;
    };
    expect(detBefore.execution.sourceTransmission).toBe("none");
    expect(detBefore.report.overallAnalysisStatus).toBe("finding");
    expect(detBefore.report.findings).toHaveLength(1);

    const sdkFailRes = await fetch(`${sdkFailServer.baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: sdkFailServer.origin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: detBefore.report.snapshot.sourceHash,
        token: detBefore.consentToken,
      }),
    });
    expect(sdkFailRes.status).toBe(200);
    const sdkFailJson = (await sdkFailRes.json()) as {
      execution: { sourceTransmission: string; aiInference: string };
      aiAnalysis: { status: string; coverage: string };
    };
    expect(sdkFailJson.execution.sourceTransmission).toBe("attempted");
    expect(sdkFailJson.execution.aiInference).toBe("failed");
    expect(sdkFailJson.aiAnalysis.status).toBe("failed");
    expect(sdkFailJson.aiAnalysis.coverage).toBe("incomplete");

    // Deterministic review remains intact after AI failure
    const detAfter = (await fetch(
      `${sdkFailServer.baseUrl}/api/review?fixture=triggering`,
    ).then((r) => r.json())) as {
      report: { overallAnalysisStatus: string; findings: { findingId: string }[] };
    };
    expect(detAfter.report.overallAnalysisStatus).toBe("finding");
    expect(detAfter.report.findings).toHaveLength(1);
    expect(detAfter.report.findings[0]?.findingId).toBe(
      detBefore.report.findings[0]?.findingId,
    );

    // 2. Response verification fails after completion -> attempted + incomplete
    const verifyFailServer = await startTestServer({
      getAiConfig: () => ({
        apiKey: "test-key",
        composeHash: approved.composeHash,
        osImageHash: approved.osImageHash,
      }),
      createAiAdapter: () =>
        createNearAiAdapter({
          approvedModelDeployments: [approved],
          getApiKey: () => "test-key",
          createClient: () => ({
            verify: async () => ({
              gateway: gatewayAtt,
              models: [modelAtt],
              verifiedAt: Date.now(),
            }),
            createChatCompletion: async () => ({
              id: "resp-unverified",
              choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
            }),
            verifyResponse: async () => {
              throw new Error("bad signature");
            },
          }),
        }),
    });

    const revVerifyFail = (await fetch(
      `${verifyFailServer.baseUrl}/api/review?fixture=triggering`,
    ).then((r) => r.json())) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };

    const verifyFailRes = await fetch(
      `${verifyFailServer.baseUrl}/api/ai-review`,
      {
        method: "POST",
        headers: {
          Origin: verifyFailServer.origin,
          "Content-Type": "application/json",
          "x-sentinelreview-ai-consent": "1",
        },
        body: JSON.stringify({
          sourceKind: "fixture",
          fixture: "triggering",
          snapshotHash: revVerifyFail.report.snapshot.sourceHash,
          token: revVerifyFail.consentToken,
        }),
      },
    );
    expect(verifyFailRes.status).toBe(200);
    const verifyFailJson = (await verifyFailRes.json()) as {
      execution: { sourceTransmission: string; aiInference: string };
      aiAnalysis: { status: string; coverage: string; responseVerification: string };
    };
    expect(verifyFailJson.execution.sourceTransmission).toBe("attempted");
    expect(verifyFailJson.execution.aiInference).toBe("failed");
    expect(verifyFailJson.aiAnalysis.status).toBe("failed");
    expect(verifyFailJson.aiAnalysis.coverage).toBe("incomplete");
    expect(verifyFailJson.aiAnalysis.responseVerification).toBe("failed");

    // 3. Full success path -> attempted + complete
    const successServer = await startTestServer({
      getAiConfig: () => ({
        apiKey: "test-key",
        composeHash: approved.composeHash,
        osImageHash: approved.osImageHash,
      }),
      createAiAdapter: () =>
        createNearAiAdapter({
          approvedModelDeployments: [approved],
          getApiKey: () => "test-key",
          createClient: () => ({
            verify: async () => ({
              gateway: gatewayAtt,
              models: [modelAtt],
              verifiedAt: Date.now(),
            }),
            createChatCompletion: async () => ({
              id: "resp-ok",
              choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
            }),
            verifyResponse: async () => ({
              id: "resp-ok",
              completionId: "resp-ok",
              signatureKind: "provider_tee",
              signature: {
                kind: "provider_tee",
                signer: {
                  signingAlgo: "ed25519",
                  signingAddress: "model-signer-1",
                },
                signedText: "{}",
                signature: "sig",
              },
              attestations: [modelAtt],
              attestation: modelAtt,
            }),
          }),
        }),
    });

    const revSuccess = (await fetch(
      `${successServer.baseUrl}/api/review?fixture=triggering`,
    ).then((r) => r.json())) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };

    const successRes = await fetch(`${successServer.baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: successServer.origin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: revSuccess.report.snapshot.sourceHash,
        token: revSuccess.consentToken,
      }),
    });
    expect(successRes.status).toBe(200);
    const successJson = (await successRes.json()) as {
      execution: { sourceTransmission: string; aiInference: string };
      aiAnalysis: { status: string; coverage: string; responseVerification: string };
    };
    expect(successJson.execution.sourceTransmission).toBe("attempted");
    expect(successJson.execution.aiInference).toBe("complete");
    expect(successJson.aiAnalysis.status).toBe("complete");
    expect(successJson.aiAnalysis.coverage).toBe("complete");
    expect(successJson.aiAnalysis.responseVerification).toBe("verified");
  });
});

