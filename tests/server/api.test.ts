import { ApiError } from "@nearai/inference-sdk/node";
import {
  createServer,
  request as httpRequest,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  DEFAULT_TOKEN_TTL_MS,
  type ServerAppOptions,
} from "../../server.js";
import {
  createMetaModelAdapter,
  META_MODEL_ID,
  META_PROVIDER_NAME,
} from "../../src/ai/meta-model-adapter.js";
import { createNearAiAdapter } from "../../src/ai/near-ai-adapter.js";

const servers: Server[] = [];

async function startTestServer(
  options: ServerAppOptions = {},
): Promise<{ baseUrl: string; origin: string; port: number }> {
  const app = await createApp({ enableVite: false, ...options });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return { baseUrl: origin, origin, port };
}

function sendRawPost(
  port: number,
  pathName: string,
  headers: OutgoingHttpHeaders,
  body: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: pathName,
        headers: {
          ...headers,
          "Content-Length": String(Buffer.byteLength(body, "utf8")),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(text) as Record<string, unknown>,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
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
                tlsBinding: {
                  kind: "attested",
                  spkiFingerprint: "gw-spki-fp-1",
                },
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
      tlsBinding: {
        kind: "attested",
        spkiFingerprint: "gw-spki-fp-1",
      },
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

  it("rejects gateway tlsBinding kind 'none' with tls_binding_rejected and sanitizes unexpected adapter throws on /api/ai-review", async () => {
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

    // 1. Gateway returns tlsBinding: { kind: "none" } -> refused before source transmission
    const tlsNoneServer = await startTestServer({
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
              gateway: {
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
              },
              models: [modelAtt],
              verifiedAt: Date.now(),
            }),
            createChatCompletion: vi.fn(),
            verifyResponse: vi.fn(),
          }),
        }),
    });

    const rev1 = (await fetch(
      `${tlsNoneServer.baseUrl}/api/review?fixture=triggering`,
    ).then((r) => r.json())) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };

    const tlsNoneRes = await fetch(`${tlsNoneServer.baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: tlsNoneServer.origin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: rev1.report.snapshot.sourceHash,
        token: rev1.consentToken,
      }),
    });
    expect(tlsNoneRes.status).toBe(200);
    const tlsNoneJson = (await tlsNoneRes.json()) as {
      execution: { sourceTransmission: string; aiInference: string };
      aiAnalysis: {
        status: string;
        coverage: string;
        errorCode?: string;
        provenance: { gatewayVerification: string };
      };
    };
    expect(tlsNoneJson.execution.sourceTransmission).toBe("none");
    expect(tlsNoneJson.execution.aiInference).toBe("failed");
    expect(tlsNoneJson.aiAnalysis.status).toBe("failed");
    expect(tlsNoneJson.aiAnalysis.coverage).toBe("not_run");
    expect(tlsNoneJson.aiAnalysis.errorCode).toBe("tls_binding_rejected");
    expect(tlsNoneJson.aiAnalysis.provenance.gatewayVerification).toBe("failed");

    // 2. Unexpected throw from adapter preserves attempted and never leaks secret text in HTTP 500
    const throwServer = await startTestServer({
      getAiConfig: () => ({
        apiKey: "test-key",
        composeHash: approved.composeHash,
        osImageHash: approved.osImageHash,
      }),
      createAiAdapter: () => async (_snapshot, _findings, runOptions) => {
        runOptions?.onSourceTransmission?.();
        throw new ApiError(
          {
            code: "api.transport_failed",
            details: { resource: "completion", reason: "request" },
            retryable: true,
          },
          { cause: new Error("Authorization: Bearer super-secret-token-xyz") },
        );
      },
    });

    const rev2 = (await fetch(
      `${throwServer.baseUrl}/api/review?fixture=triggering`,
    ).then((r) => r.json())) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };

    const throwRes = await fetch(`${throwServer.baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: throwServer.origin,
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
    expect(throwRes.status).toBe(500);
    const throwBodyText = await throwRes.text();
    expect(throwBodyText).not.toContain("super-secret-token-xyz");
    expect(throwBodyText).not.toContain("Authorization:");
    const throwJson = JSON.parse(throwBodyText) as {
      error: string;
      errorCode?: string;
      execution: { aiInference: string; sourceTransmission: string };
    };
    expect(throwJson.errorCode).toBe("network_error");
    expect(throwJson.execution.aiInference).toBe("failed");
    expect(throwJson.execution.sourceTransmission).toBe("attempted");
  });

  it("isolates Meta Model API configuration, blocks custom source server-side, enforces separate single-use Meta consent, and sanitizes upstream errors", async () => {
    const metaSecret = "meta-secret-never-leak-777";
    const metaFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "meta-api-ok-1",
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  findings: [
                    {
                      severity: "medium",
                      title: "Callback trust assumption hypothesis",
                      rationale:
                        "Synthetic hypothesis to illustrate isolated Meta Model API analysis.",
                      path: "lib.rs",
                      startLine: 1,
                      endLine: 3,
                    },
                  ],
                }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const { baseUrl, origin } = await startTestServer({
      getMetaConfig: () => ({ apiKey: metaSecret }),
      createMetaAdapter: () =>
        createMetaModelAdapter({
          getApiKey: () => metaSecret,
          fetchFn: metaFetch,
        }),
    });

    // 1. GET /api/review includes fixtureAllowed=true and a separate Meta consent token without leaking secrets
    const fixtureRes = await fetch(`${baseUrl}/api/review?fixture=triggering`);
    expect(fixtureRes.status).toBe(200);
    const fixtureRaw = await fixtureRes.text();
    expect(fixtureRaw).not.toContain(metaSecret);
    const fixtureJson = JSON.parse(fixtureRaw) as {
      consentToken: string;
      report: {
        snapshot: { sourceHash: string };
        overallAnalysisStatus: string;
        findings: { findingId: string }[];
      };
      metaConfig: {
        provider: string;
        modelId: string;
        apiKeyConfigured: boolean;
        status: string;
        fixtureAllowed: boolean;
        freeCreditWarning: string;
        consentToken?: string;
      };
    };
    expect(fixtureJson.metaConfig.provider).toBe(META_PROVIDER_NAME);
    expect(fixtureJson.metaConfig.modelId).toBe(META_MODEL_ID);
    expect(fixtureJson.metaConfig.apiKeyConfigured).toBe(true);
    expect(fixtureJson.metaConfig.status).toBe("configured");
    expect(fixtureJson.metaConfig.fixtureAllowed).toBe(true);
    expect(fixtureJson.metaConfig.consentToken).toMatch(/^[a-f0-9]{64}$/);
    expect(fixtureJson.metaConfig.consentToken).not.toBe(
      fixtureJson.consentToken,
    );

    // 2. POST /api/review/custom sets fixtureAllowed=false and omits metaConfig.consentToken
    const customRes = await fetch(`${baseUrl}/api/review/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "src/lib.rs", content: "pub fn a() {}\n" }],
      }),
    });
    expect(customRes.status).toBe(200);
    const customJson = (await customRes.json()) as {
      consentToken: string;
      report: { snapshot: { sourceHash: string } };
      metaConfig: {
        fixtureAllowed: boolean;
        consentToken?: string;
      };
    };
    expect(customJson.metaConfig.fixtureAllowed).toBe(false);
    expect(customJson.metaConfig.consentToken).toBeUndefined();

    // 3. Passing NEAR AI consent header or NEAR AI token to /api/meta-review is rejected
    const nearHeaderRejected = await fetch(`${baseUrl}/api/meta-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: fixtureJson.report.snapshot.sourceHash,
        token: fixtureJson.metaConfig.consentToken,
      }),
    });
    expect(nearHeaderRejected.status).toBe(403);

    const nearTokenRejected = await fetch(`${baseUrl}/api/meta-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-sentinelreview-meta-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: fixtureJson.report.snapshot.sourceHash,
        token: fixtureJson.consentToken,
      }),
    });
    expect(nearTokenRejected.status).toBe(401);

    // 4. Server-side custom source rejection on /api/meta-review even with explicit header + token
    const customBlockedRes = await fetch(`${baseUrl}/api/meta-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-sentinelreview-meta-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "custom",
        snapshotHash: customJson.report.snapshot.sourceHash,
        token: customJson.consentToken,
      }),
    });
    expect(customBlockedRes.status).toBe(403);
    const customBlockedJson = (await customBlockedRes.json()) as {
      errorCode: string;
      execution: { sourceTransmission: string };
    };
    expect(customBlockedJson.errorCode).toBe("private_source_rejected");
    expect(customBlockedJson.execution.sourceTransmission).toBe("none");
    expect(metaFetch).not.toHaveBeenCalled();

    // 5. Missing origin & wrong Content-Type & 409 hash mismatch
    const noOriginRes = await fetch(`${baseUrl}/api/meta-review`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sentinelreview-meta-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: fixtureJson.report.snapshot.sourceHash,
        token: fixtureJson.metaConfig.consentToken,
      }),
    });
    expect(noOriginRes.status).toBe(403);

    const wrongCtRes = await fetch(`${baseUrl}/api/meta-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "text/plain",
        "x-sentinelreview-meta-consent": "1",
      },
      body: "{}",
    });
    expect(wrongCtRes.status).toBe(415);

    // 6. Successful fixture Meta run + single-use token consumption
    const metaSuccessRes = await fetch(`${baseUrl}/api/meta-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-sentinelreview-meta-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: fixtureJson.report.snapshot.sourceHash,
        token: fixtureJson.metaConfig.consentToken,
      }),
    });
    expect(metaSuccessRes.status).toBe(200);
    const metaSuccessRaw = await metaSuccessRes.text();
    expect(metaSuccessRaw).not.toContain(metaSecret);
    const metaSuccessJson = JSON.parse(metaSuccessRaw) as {
      provider: string;
      modelId: string;
      execution: { sourceTransmission: string; aiInference: string };
      metaAnalysis: {
        status: string;
        coverage: string;
        hypotheses: Array<{ origin: string; provider: string }>;
        provenance: {
          teeAttestation: string;
          cryptographicVerification: string;
        };
      };
    };
    expect(metaSuccessJson.provider).toBe(META_PROVIDER_NAME);
    expect(metaSuccessJson.modelId).toBe(META_MODEL_ID);
    expect(metaSuccessJson.execution.sourceTransmission).toBe("attempted");
    expect(metaSuccessJson.execution.aiInference).toBe("completed");
    expect(metaSuccessJson.metaAnalysis.status).toBe("completed");
    expect(metaSuccessJson.metaAnalysis.coverage).toBe("complete");
    expect(metaSuccessJson.metaAnalysis.provenance.teeAttestation).toBe(
      "not_applicable",
    );
    expect(
      metaSuccessJson.metaAnalysis.provenance.cryptographicVerification,
    ).toBe("not_verified");
    expect(metaSuccessJson.metaAnalysis.hypotheses).toHaveLength(1);
    expect(metaFetch).toHaveBeenCalledTimes(1);

    // Replay of consumed single-use Meta token must return 401
    const replayRes = await fetch(`${baseUrl}/api/meta-review`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-sentinelreview-meta-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: fixtureJson.report.snapshot.sourceHash,
        token: fixtureJson.metaConfig.consentToken,
      }),
    });
    expect(replayRes.status).toBe(401);

    // 7. Sanitized HTTP 429 from mocked Meta upstream & unchanged deterministic review
    const rateLimitServer = await startTestServer({
      getMetaConfig: () => ({ apiKey: metaSecret }),
      createMetaAdapter: () =>
        createMetaModelAdapter({
          getApiKey: () => metaSecret,
          fetchFn: vi.fn(
            async () =>
              new Response(`rate limited ${metaSecret}`, { status: 429 }),
          ),
        }),
    });
    const revRl = (await fetch(
      `${rateLimitServer.baseUrl}/api/review?fixture=triggering`,
    ).then((r) => r.json())) as {
      report: { snapshot: { sourceHash: string } };
      metaConfig: { consentToken: string };
    };
    const rlRes = await fetch(`${rateLimitServer.baseUrl}/api/meta-review`, {
      method: "POST",
      headers: {
        Origin: rateLimitServer.origin,
        "Content-Type": "application/json",
        "x-sentinelreview-meta-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: revRl.report.snapshot.sourceHash,
        token: revRl.metaConfig.consentToken,
      }),
    });
    expect(rlRes.status).toBe(200);
    const rlText = await rlRes.text();
    expect(rlText).not.toContain(metaSecret);
    const rlJson = JSON.parse(rlText) as {
      execution: { sourceTransmission: string; aiInference: string };
      metaAnalysis: { status: string; coverage: string; errorCode: string };
    };
    expect(rlJson.execution.sourceTransmission).toBe("attempted");
    expect(rlJson.execution.aiInference).toBe("failed");
    expect(rlJson.metaAnalysis.errorCode).toBe("rate_limited");
    expect(rlJson.metaAnalysis.coverage).toBe("incomplete");

    // 8. Unexpected adapter throw -> HTTP 500 sanitized response without secret leaks
    const throwMetaServer = await startTestServer({
      getMetaConfig: () => ({ apiKey: metaSecret }),
      createMetaAdapter: () => async (_snapshot, _findings, runOptions) => {
        runOptions.onSourceTransmission?.();
        throw Object.assign(
          new Error(`connect ECONNREFUSED Authorization: Bearer ${metaSecret}`),
          { code: "ECONNREFUSED" },
        );
      },
    });
    const revThrow = (await fetch(
      `${throwMetaServer.baseUrl}/api/review?fixture=triggering`,
    ).then((r) => r.json())) as {
      report: { snapshot: { sourceHash: string } };
      metaConfig: { consentToken: string };
    };
    const metaThrowRes = await fetch(
      `${throwMetaServer.baseUrl}/api/meta-review`,
      {
        method: "POST",
        headers: {
          Origin: throwMetaServer.origin,
          "Content-Type": "application/json",
          "x-sentinelreview-meta-consent": "1",
        },
        body: JSON.stringify({
          sourceKind: "fixture",
          fixture: "triggering",
          snapshotHash: revThrow.report.snapshot.sourceHash,
          token: revThrow.metaConfig.consentToken,
        }),
      },
    );
    expect(metaThrowRes.status).toBe(500);
    const metaThrowText = await metaThrowRes.text();
    expect(metaThrowText).not.toContain(metaSecret);
    expect(metaThrowText).not.toContain("Authorization:");
    const metaThrowJson = JSON.parse(metaThrowText) as {
      errorCode: string;
      execution: { aiInference: string; sourceTransmission: string };
    };
    expect(metaThrowJson.errorCode).toBe("network_error");
    expect(metaThrowJson.execution.aiInference).toBe("failed");
    expect(metaThrowJson.execution.sourceTransmission).toBe("attempted");

    // Deterministic review remains completely unchanged
    const fixtureAfterRes = await fetch(
      `${baseUrl}/api/review?fixture=triggering`,
    );
    const fixtureAfterJson = (await fixtureAfterRes.json()) as {
      report: {
        overallAnalysisStatus: string;
        findings: { findingId: string }[];
      };
    };
    expect(fixtureAfterJson.report.overallAnalysisStatus).toBe(
      fixtureJson.report.overallAnalysisStatus,
    );
    expect(fixtureAfterJson.report.findings[0]?.findingId).toBe(
      fixtureJson.report.findings[0]?.findingId,
    );
  });

  it("enforces strict direct vs trusted AI Studio reverse-proxy Origin validation and rejects missing, empty, malformed, duplicate, or untrusted forwarding headers", async () => {
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
      tlsBinding: {
        kind: "attested",
        spkiFingerprint: "gw-spki-fp-1",
      },
    };

    const metaFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "meta-proxy-ok",
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({ findings: [] }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const trustedServer = await startTestServer({
      trustProxy: true,
      trustedProxyHost: "localhost:3000",
      getAiConfig: () => ({
        apiKey: "test-near-key",
        composeHash: approved.composeHash,
        osImageHash: approved.osImageHash,
      }),
      createAiAdapter: () =>
        createNearAiAdapter({
          approvedModelDeployments: [approved],
          getApiKey: () => "test-near-key",
          createClient: () => ({
            verify: async () => ({
              gateway: gatewayAtt,
              models: [modelAtt],
              verifiedAt: Date.now(),
            }),
            createChatCompletion: async () => ({
              id: "near-proxy-ok",
              choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
            }),
            verifyResponse: async () => ({
              id: "near-proxy-ok",
              completionId: "near-proxy-ok",
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
      getMetaConfig: () => ({ apiKey: "test-meta-key" }),
      createMetaAdapter: () =>
        createMetaModelAdapter({
          getApiKey: () => "test-meta-key",
          fetchFn: metaFetch,
        }),
    });

    const proxyHost = "preview-host.example.run.app";
    const httpsOrigin = `https://${proxyHost}`;
    const httpOrigin = `http://${proxyHost}`;

    const rev = (await fetch(
      `${trustedServer.baseUrl}/api/review?fixture=triggering`,
    ).then((r) => r.json())) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
      metaConfig: { consentToken: string };
    };

    const aiBody = JSON.stringify({
      sourceKind: "fixture",
      fixture: "triggering",
      snapshotHash: rev.report.snapshot.sourceHash,
      token: rev.consentToken,
    });
    const metaBody = JSON.stringify({
      sourceKind: "fixture",
      fixture: "triggering",
      snapshotHash: rev.report.snapshot.sourceHash,
      token: rev.metaConfig.consentToken,
    });

    const validProxyHeaders: OutgoingHttpHeaders = {
      Host: "localhost:3000",
      Origin: httpsOrigin,
      "X-Forwarded-Host": proxyHost,
      "X-Forwarded-Proto": "http",
      "X-Real-IP": "203.0.113.10",
      "X-Forwarded-For": "203.0.113.10, 10.0.0.1",
      "Content-Type": "application/json",
      "x-sentinelreview-ai-consent": "1",
    };

    // 1. Negative proxy header cases MUST all return 403 before consuming tokens:
    // Missing X-Forwarded-Proto
    const { ["X-Forwarded-Proto"]: _omitProto, ...missingProtoHeaders } =
      validProxyHeaders;
    expect(
      (
        await sendRawPost(
          trustedServer.port,
          "/api/ai-review",
          missingProtoHeaders,
          aiBody,
        )
      ).status,
    ).toBe(403);

    // Empty or whitespace X-Forwarded-Proto
    for (const emptyProto of ["", "   "]) {
      expect(
        (
          await sendRawPost(
            trustedServer.port,
            "/api/ai-review",
            { ...validProxyHeaders, "X-Forwarded-Proto": emptyProto },
            aiBody,
          )
        ).status,
      ).toBe(403);
    }

    // Malformed X-Forwarded-Proto
    for (const badProto of ["ftp", "https:", "http://", "HTTPS", "ws"]) {
      expect(
        (
          await sendRawPost(
            trustedServer.port,
            "/api/ai-review",
            { ...validProxyHeaders, "X-Forwarded-Proto": badProto },
            aiBody,
          )
        ).status,
      ).toBe(403);
    }

    // Multiple / duplicated X-Forwarded-Proto values (comma-separated & multi-header array)
    expect(
      (
        await sendRawPost(
          trustedServer.port,
          "/api/ai-review",
          { ...validProxyHeaders, "X-Forwarded-Proto": "http, https" },
          aiBody,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await sendRawPost(
          trustedServer.port,
          "/api/ai-review",
          { ...validProxyHeaders, "X-Forwarded-Proto": ["http", "http"] },
          aiBody,
        )
      ).status,
    ).toBe(403);

    // Missing / empty / multiple / duplicated X-Forwarded-Host
    const { ["X-Forwarded-Host"]: _omitHost, ...missingHostHeaders } =
      validProxyHeaders;
    expect(
      (
        await sendRawPost(
          trustedServer.port,
          "/api/ai-review",
          missingHostHeaders,
          aiBody,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await sendRawPost(
          trustedServer.port,
          "/api/ai-review",
          { ...validProxyHeaders, "X-Forwarded-Host": "" },
          aiBody,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await sendRawPost(
          trustedServer.port,
          "/api/ai-review",
          {
            ...validProxyHeaders,
            "X-Forwarded-Host": `${proxyHost}, other.example`,
          },
          aiBody,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await sendRawPost(
          trustedServer.port,
          "/api/ai-review",
          {
            ...validProxyHeaders,
            "X-Forwarded-Host": [proxyHost, proxyHost],
          },
          aiBody,
        )
      ).status,
    ).toBe(403);

    // Conflicting Forwarded header or missing X-Real-IP / X-Forwarded-For / wrong internal Host
    expect(
      (
        await sendRawPost(
          trustedServer.port,
          "/api/ai-review",
          {
            ...validProxyHeaders,
            Forwarded: `for=203.0.113.10;host=other.example;proto=http`,
          },
          aiBody,
        )
      ).status,
    ).toBe(403);
    const { ["X-Real-IP"]: _omitRealIp, ...missingRealIpHeaders } =
      validProxyHeaders;
    expect(
      (
        await sendRawPost(
          trustedServer.port,
          "/api/ai-review",
          missingRealIpHeaders,
          aiBody,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await sendRawPost(
          trustedServer.port,
          "/api/ai-review",
          {
            ...validProxyHeaders,
            Host: `127.0.0.1:${trustedServer.port}`,
          },
          aiBody,
        )
      ).status,
    ).toBe(403);

    // Scheme downgrade (http Origin under X-Forwarded-Proto: https) rejected
    expect(
      (
        await sendRawPost(
          trustedServer.port,
          "/api/ai-review",
          {
            ...validProxyHeaders,
            Origin: httpOrigin,
            "X-Forwarded-Proto": "https",
          },
          aiBody,
        )
      ).status,
    ).toBe(403);

    // Cross-origin host rejected
    expect(
      (
        await sendRawPost(
          trustedServer.port,
          "/api/meta-review",
          {
            ...validProxyHeaders,
            Origin: "https://evil.example",
            "x-sentinelreview-meta-consent": "1",
          },
          metaBody,
        )
      ).status,
    ).toBe(403);

    // Direct request claiming https Origin over plain HTTP socket rejected
    expect(
      (
        await sendRawPost(
          trustedServer.port,
          "/api/ai-review",
          {
            Host: `127.0.0.1:${trustedServer.port}`,
            Origin: `https://127.0.0.1:${trustedServer.port}`,
            "Content-Type": "application/json",
            "x-sentinelreview-ai-consent": "1",
          },
          aiBody,
        )
      ).status,
    ).toBe(403);

    // 2. Legitimate Cloud Run -> Nginx HTTPS-to-HTTP path succeeds for both /api/ai-review and /api/meta-review
    const nearRes = await sendRawPost(
      trustedServer.port,
      "/api/ai-review",
      validProxyHeaders,
      aiBody,
    );
    expect(nearRes.status).toBe(200);
    expect(
      (nearRes.json.execution as { aiInference: string; sourceTransmission: string })
        .aiInference,
    ).toBe("complete");
    expect(
      (nearRes.json.execution as { sourceTransmission: string }).sourceTransmission,
    ).toBe("attempted");

    const { ["x-sentinelreview-ai-consent"]: _omitNearConsent, ...metaProxyBase } =
      validProxyHeaders;
    const metaRes = await sendRawPost(
      trustedServer.port,
      "/api/meta-review",
      {
        ...metaProxyBase,
        "x-sentinelreview-meta-consent": "1",
      },
      metaBody,
    );
    expect(metaRes.status).toBe(200);
    expect(
      (metaRes.json.execution as { aiInference: string; sourceTransmission: string })
        .aiInference,
    ).toBe("completed");
    expect(
      (metaRes.json.execution as { sourceTransmission: string }).sourceTransmission,
    ).toBe("attempted");

    // 3. When trustProxy is false, arbitrary client-supplied forwarding headers are ALWAYS rejected (403),
    // while genuine direct HTTP requests still succeed.
    const untrustedProxyServer = await startTestServer({
      trustProxy: false,
    });
    const revDirect = (await fetch(
      `${untrustedProxyServer.baseUrl}/api/review?fixture=triggering`,
    ).then((r) => r.json())) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };
    const directBody = JSON.stringify({
      sourceKind: "fixture",
      fixture: "triggering",
      snapshotHash: revDirect.report.snapshot.sourceHash,
      token: revDirect.consentToken,
    });

    const spoofedProxyRes = await sendRawPost(
      untrustedProxyServer.port,
      "/api/ai-review",
      {
        Host: "localhost:3000",
        Origin: httpsOrigin,
        "X-Forwarded-Host": proxyHost,
        "X-Forwarded-Proto": "http",
        "X-Real-IP": "203.0.113.10",
        "X-Forwarded-For": "203.0.113.10",
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      directBody,
    );
    expect(spoofedProxyRes.status).toBe(403);

    const directOkRes = await fetch(
      `${untrustedProxyServer.baseUrl}/api/ai-review`,
      {
        method: "POST",
        headers: {
          Origin: untrustedProxyServer.origin,
          "Content-Type": "application/json",
          "x-sentinelreview-ai-consent": "1",
        },
        body: directBody,
      },
    );
    expect(directOkRes.status).toBe(200);
  });

  it("returns 504 with inference_failed and attempted transmission when NEAR AI adapter times out", async () => {
    const timeoutServer = await startTestServer({
      aiRouteTimeoutMs: 20,
      createAiAdapter: () => (_snapshot, _findings, runOptions) => {
        runOptions?.onSourceTransmission?.();
        return new Promise<never>(() => {});
      },
    });

    const reviewRes = (await fetch(
      `${timeoutServer.baseUrl}/api/review?fixture=triggering`,
    ).then((r) => r.json())) as {
      report: { snapshot: { sourceHash: string } };
      consentToken: string;
    };

    const aiRes = await fetch(`${timeoutServer.baseUrl}/api/ai-review`, {
      method: "POST",
      headers: {
        Origin: timeoutServer.origin,
        "Content-Type": "application/json",
        "x-sentinelreview-ai-consent": "1",
      },
      body: JSON.stringify({
        sourceKind: "fixture",
        fixture: "triggering",
        snapshotHash: reviewRes.report.snapshot.sourceHash,
        token: reviewRes.consentToken,
      }),
    });

    expect(aiRes.status).toBe(504);
    const body = (await aiRes.json()) as {
      error: string;
      errorCode?: string;
      execution: { aiInference: string; sourceTransmission: string };
    };
    expect(body.errorCode).toBe("inference_failed");
    expect(body.execution.aiInference).toBe("failed");
    expect(body.execution.sourceTransmission).toBe("attempted");
  });
});


