import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadSource, type SourceLoadResult } from "../src/source/load-source.js";
import {
  buildDeterministicDemoReport,
  type DeterministicDemoReport,
} from "../src/demo/deterministic-review.js";
import { runNearRustCallbackPrivateRule } from "../src/rules/near-rust-callback-private.js";
import {
  createNearAiAdapter,
  NEAR_AI_MODEL_ID,
  type NearAiAnalysisResult,
} from "../src/ai/near-ai-adapter.js";

 type FixtureName = "triggering" | "safe";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const CONSENT_HEADER = "x-sentinelreview-ai-consent";
const CONSENT_HEADER_VALUE = "1";
const TOKEN_TTL_MS = 2 * 60 * 1000;
const MAX_CONSENT_TOKENS = 500;
const MAX_BODY_BYTES = 4096;
const portValue = process.env.PORT ?? String(DEFAULT_PORT);
const PORT = Number(portValue);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const ORIGIN = `http://${HOST}:${PORT}`;

interface ConsentTokenRecord {
  readonly fixture: FixtureName;
  readonly snapshotHash: string;
  readonly modelId: typeof NEAR_AI_MODEL_ID;
  readonly modelConfigFingerprint: string;
  readonly expiresAt: number;
}

const consentTokens = new Map<string, ConsentTokenRecord>();

function fixtureDirectory(name: FixtureName): string {
  return fileURLToPath(
    new URL(
      name === "safe"
        ? "../demo-fixtures/callback-safe/"
        : "../demo-fixtures/callback-unguarded/",
      import.meta.url,
    ),
  );
}

function getPhysicalLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r\n|\r|\n/);
  if (content.endsWith("\n") || content.endsWith("\r")) lines.pop();
  return lines;
}

async function loadFixtureSnapshot(fixture: FixtureName): Promise<SourceLoadResult> {
  return loadSource(fixtureDirectory(fixture));
}

async function createReport(fixture: FixtureName): Promise<{
  snapshot: SourceLoadResult;
  report: DeterministicDemoReport;
  sourceExcerpts: Record<string, { startLine: number; content: string }>;
}> {
  const snapshot = await loadFixtureSnapshot(fixture);
  const ruleResult = runNearRustCallbackPrivateRule(snapshot);
  const report = buildDeterministicDemoReport(snapshot, ruleResult);
  const sourceExcerpts: Record<string, { startLine: number; content: string }> = Object.create(null);

  for (const finding of report.findings) {
    for (const location of finding.locations) {
      if (
        location.referenceStatus !== "resolved" ||
        (location.computedValidationStatus !== "validated" &&
          location.computedValidationStatus !== "partial") ||
        location.startLine < 1 ||
        location.endLine < location.startLine
      ) continue;

      const file = snapshot.files.find((candidate) => candidate.path === location.path);
      if (!file) continue;
      const lines = getPhysicalLines(file.content);
      if (location.endLine > lines.length) continue;
      sourceExcerpts[location.evidenceId] = {
        startLine: location.startLine,
        content: lines.slice(location.startLine - 1, location.endLine).join("\n"),
      };
    }
  }

  return { snapshot, report, sourceExcerpts };
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(value));
}

function pruneConsentTokens(now = Date.now()): void {
  for (const [token, record] of consentTokens) {
    if (record.expiresAt <= now) consentTokens.delete(token);
  }
  while (consentTokens.size >= MAX_CONSENT_TOKENS) {
    const oldest = consentTokens.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    consentTokens.delete(oldest);
  }
}

function modelConfigFingerprint(): string {
  const config = {
    sdkVersion: "0.3.0",
    modelId: NEAR_AI_MODEL_ID,
    composeHash: process.env.NEARAI_OPERATOR_APPROVED_COMPOSE_HASH ?? null,
    osImageHash: process.env.NEARAI_OPERATOR_APPROVED_OS_IMAGE_HASH ?? null,
  };
  return createHash("sha256").update(JSON.stringify(config), "utf8").digest("hex");
}

function issueConsentToken(
  fixture: FixtureName,
  snapshot: SourceLoadResult,
): { token: string; expiresAt: string } {
  pruneConsentTokens();
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  consentTokens.set(token, {
    fixture,
    snapshotHash: snapshot.manifest.sourceHash,
    modelId: NEAR_AI_MODEL_ID,
    modelConfigFingerprint: modelConfigFingerprint(),
    expiresAt,
  });
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_BODY_BYTES) {
      throw new Error("body_too_large");
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

function isFixtureName(value: unknown): value is FixtureName {
  return value === "triggering" || value === "safe";
}

function isExactConsentBody(value: unknown): value is {
  fixture: FixtureName;
  snapshotHash: string;
  token: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  return (
    keys.length === 3 &&
    keys[0] === "fixture" && keys[1] === "snapshotHash" && keys[2] === "token" &&
    isFixtureName(body.fixture) &&
    typeof body.snapshotHash === "string" && /^[a-f0-9]{64}$/.test(body.snapshotHash) &&
    typeof body.token === "string" && /^[a-f0-9]{64}$/.test(body.token)
  );
}

function hasApprovedMeasurementsConfigured(): boolean {
  return Boolean(
    process.env.NEARAI_OPERATOR_APPROVED_COMPOSE_HASH &&
    process.env.NEARAI_OPERATOR_APPROVED_OS_IMAGE_HASH,
  );
}

function createAdapter(): ReturnType<typeof createNearAiAdapter> {
  const composeHash = process.env.NEARAI_OPERATOR_APPROVED_COMPOSE_HASH;
  const osImageHash = process.env.NEARAI_OPERATOR_APPROVED_OS_IMAGE_HASH;
  const approvedModelDeployments = composeHash && osImageHash
    ? [{ composeHash, osImageHash }]
    : [];
  return createNearAiAdapter({
    approvedModelDeployments,
    getApiKey: () => process.env.NEARAI_API_KEY,
  });
}

async function handleAiReview(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.headers.origin !== ORIGIN) {
    sendJson(response, 403, { error: "The request origin is not allowed." });
    return;
  }
  if (request.headers[CONSENT_HEADER] !== CONSENT_HEADER_VALUE) {
    sendJson(response, 403, { error: "Explicit AI-review consent header is required." });
    return;
  }
  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    sendJson(response, 415, { error: "Content-Type must be application/json." });
    return;
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_json";
    sendJson(response, code === "body_too_large" ? 413 : 400, {
      error: code === "body_too_large" ? "Request body is too large." : "Request body must be valid JSON.",
    });
    return;
  }
  if (!isExactConsentBody(body)) {
    sendJson(response, 400, { error: "Body must contain exactly fixture, snapshotHash, and token." });
    return;
  }

  // Map deletion is synchronous and occurs before any awaited work: tokens are single-use.
  const tokenRecord = consentTokens.get(body.token);
  if (tokenRecord) consentTokens.delete(body.token);
  if (!tokenRecord || tokenRecord.expiresAt <= Date.now()) {
    sendJson(response, 401, { error: "Consent token is missing, expired, or already used." });
    return;
  }
  if (
    tokenRecord.fixture !== body.fixture ||
    tokenRecord.snapshotHash !== body.snapshotHash ||
    tokenRecord.modelId !== NEAR_AI_MODEL_ID ||
    tokenRecord.modelConfigFingerprint !== modelConfigFingerprint()
  ) {
    sendJson(response, 409, { error: "Consent token does not match this fixture, snapshot, or model." });
    return;
  }

  let sourceTransmission = "none" as "none" | "sent";
  try {
    const snapshot = await loadFixtureSnapshot(body.fixture);
    if (snapshot.manifest.sourceHash !== body.snapshotHash) {
      sendJson(response, 409, {
        error: "The local source snapshot changed; reload and confirm again.",
        execution: { aiInference: "not_run", sourceTransmission: "none" },
      });
      return;
    }

    const ruleResult = runNearRustCallbackPrivateRule(snapshot);
    const aiResult: NearAiAnalysisResult = await createAdapter()(
      snapshot,
      ruleResult.deterministicAnalysis.findings,
      { onSourceTransmission: () => { sourceTransmission = "sent"; } },
    );
    sendJson(response, 200, {
      fixture: body.fixture,
      snapshotHash: snapshot.manifest.sourceHash,
      modelId: NEAR_AI_MODEL_ID,
      approvedMeasurementsConfigured: hasApprovedMeasurementsConfigured(),
      independentNearApproval: "not_established",
      execution: {
        mode: "local_deterministic_plus_near_ai",
        aiInference: aiResult.status,
        sourceTransmission,
      },
      aiAnalysis: aiResult,
    });
  } catch {
    sendJson(response, 500, {
      error: "The optional NEAR AI review failed.",
      execution: { aiInference: "failed", sourceTransmission },
    });
  }
}

const dashboardPath = fileURLToPath(new URL("../dashboard/index.html", import.meta.url));

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", ORIGIN);

  if (requestUrl.pathname === "/") {
    if (request.method !== "GET") {
      send(response, 405, "text/plain; charset=utf-8", "Method not allowed");
      return;
    }
    try {
      const html = await readFile(dashboardPath, "utf8");
      send(response, 200, "text/html; charset=utf-8", html);
    } catch {
      send(response, 500, "text/plain; charset=utf-8", "Dashboard could not be loaded");
    }
    return;
  }

  if (requestUrl.pathname === "/api/review") {
    if (request.method !== "GET") {
      send(response, 405, "text/plain; charset=utf-8", "Method not allowed");
      return;
    }
    const requestedFixture = requestUrl.searchParams.get("fixture") ?? "triggering";
    if (!isFixtureName(requestedFixture)) {
      sendJson(response, 400, { error: "fixture must be triggering or safe" });
      return;
    }
    try {
      const fixture = requestedFixture;
      const result = await createReport(fixture);
      const consent = issueConsentToken(fixture, result.snapshot);
      sendJson(response, 200, {
        fixture,
        generatedAt: new Date().toISOString(),
        execution: {
          mode: "local_deterministic_demo",
          aiInference: "not_run",
          sourceTransmission: "none",
        },
        report: result.report,
        sourceExcerpts: result.sourceExcerpts,
        consent: {
          token: consent.token,
          expiresAt: consent.expiresAt,
          snapshotHash: result.snapshot.manifest.sourceHash,
          modelId: NEAR_AI_MODEL_ID,
          files: result.snapshot.files.map((file) => file.path),
          sourceBytes: result.snapshot.files.reduce(
            (total, file) => total + Buffer.byteLength(file.content, "utf8"), 0,
          ),
        },
      });
    } catch {
      sendJson(response, 500, { error: "The local deterministic review could not be completed." });
    }
    return;
  }

  if (requestUrl.pathname === "/api/ai-review") {
    if (request.method !== "POST") {
      send(response, 405, "text/plain; charset=utf-8", "Method not allowed");
      return;
    }
    await handleAiReview(request, response);
    return;
  }

  send(response, 404, "text/plain; charset=utf-8", "Not found");
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `SentinelReview local dashboard: ${ORIGIN}\n` +
    "Deterministic review is local; AI source transmission requires a separate explicit confirmation.\n" +
    "Press Ctrl+C to stop.\n",
  );
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
