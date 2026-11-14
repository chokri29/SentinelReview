import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import {
  createNearAiAdapter,
  NEAR_AI_MODEL_ID,
  type NearAiAnalysisResult,
} from "./src/ai/near-ai-adapter.js";
import {
  buildDeterministicDemoReport,
  type DeterministicDemoReport,
} from "./src/demo/deterministic-review.js";
import { runNearRustCallbackPrivateRule } from "./src/rules/near-rust-callback-private.js";
import { createSnapshotFromEntries } from "./src/source/custom-snapshot.js";
import {
  loadSource,
  type SourceLoadOptions,
  type SourceLoadResult,
} from "./src/source/load-source.js";

type FixtureName = "triggering" | "safe";
type SourceKind = "fixture" | "custom";

const HOST = "0.0.0.0";
const rawPort = process.env.PORT ?? "3000";
const PORT = Number(rawPort);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
const CONSENT_HEADER = "x-sentinelreview-ai-consent";
const CONSENT_HEADER_VALUE = "1";
export const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 1000;
const MAX_CONSENT_TOKENS = 500;
const CUSTOM_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const MAX_CUSTOM_SNAPSHOTS = 50;

interface ConsentTokenRecord {
  readonly sourceKind: SourceKind;
  readonly fixture?: FixtureName;
  readonly snapshotHash: string;
  readonly modelId: typeof NEAR_AI_MODEL_ID;
  readonly modelConfigFingerprint: string;
  readonly expiresAt: number;
}

interface CachedCustomSnapshot {
  readonly snapshot: SourceLoadResult;
  readonly expiresAt: number;
}

export interface ServerAppOptions {
  readonly enableVite?: boolean;
  readonly tokenTtlMs?: number;
  readonly customLimits?: Pick<
    SourceLoadOptions,
    "maxFiles" | "maxFileBytes" | "maxTotalBytes"
  >;
  readonly getAiConfig?: () => {
    readonly apiKey?: string;
    readonly composeHash?: string;
    readonly osImageHash?: string;
  };
  readonly createAiAdapter?: () => ReturnType<typeof createNearAiAdapter>;
  readonly now?: () => number;
}

const CustomReviewRequestSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            content: z.string().max(2 * 1024 * 1024),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

const AiReviewRequestSchema = z
  .object({
    sourceKind: z.enum(["fixture", "custom"]),
    fixture: z.enum(["triggering", "safe"]).optional(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine(
    (value) => value.sourceKind !== "fixture" || value.fixture !== undefined,
    {
      message: "fixture is required when sourceKind is fixture",
      path: ["fixture"],
    },
  );

function fixtureDirectory(name: FixtureName): string {
  return fileURLToPath(
    new URL(
      name === "safe"
        ? "./demo-fixtures/callback-safe/"
        : "./demo-fixtures/callback-unguarded/",
      import.meta.url,
    ),
  );
}

function getPhysicalLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r\n|\r|\n/);
  if (content.endsWith("\n") || content.endsWith("\r")) {
    lines.pop();
  }
  return lines;
}

function buildSourceExcerpts(
  snapshot: SourceLoadResult,
  report: DeterministicDemoReport,
): Record<string, { startLine: number; content: string }> {
  const sourceExcerpts: Record<string, { startLine: number; content: string }> =
    Object.create(null);

  for (const finding of report.findings) {
    for (const location of finding.locations) {
      if (
        location.referenceStatus !== "resolved" ||
        (location.computedValidationStatus !== "validated" &&
          location.computedValidationStatus !== "partial") ||
        location.startLine < 1 ||
        location.endLine < location.startLine
      ) {
        continue;
      }
      const file = snapshot.files.find(
        (candidate) => candidate.path === location.path,
      );
      if (!file) continue;
      const lines = getPhysicalLines(file.content);
      if (location.endLine > lines.length) continue;
      sourceExcerpts[location.evidenceId] = {
        startLine: location.startLine,
        content: lines.slice(location.startLine - 1, location.endLine).join("\n"),
      };
    }
  }

  return sourceExcerpts;
}

function isSameOriginRequest(req: Request): boolean {
  const originHeader = req.headers.origin;
  if (typeof originHeader !== "string" || originHeader.length === 0) {
    return false;
  }

  try {
    const parsedOrigin = new URL(originHeader);
    if (
      (parsedOrigin.protocol !== "http:" &&
        parsedOrigin.protocol !== "https:") ||
      parsedOrigin.username !== "" ||
      parsedOrigin.password !== "" ||
      parsedOrigin.origin !== originHeader
    ) {
      return false;
    }

    const forwardedHost = req.headers["x-forwarded-host"];
    const rawHost =
      (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ??
      req.headers.host;
    if (typeof rawHost !== "string" || rawHost.length === 0) {
      return false;
    }
    const requestHost = rawHost.split(",")[0]!.trim();
    if (parsedOrigin.host !== requestHost) {
      return false;
    }

    const forwardedProto = req.headers["x-forwarded-proto"];
    if (forwardedProto !== undefined) {
      const rawProto = Array.isArray(forwardedProto)
        ? forwardedProto[0]
        : forwardedProto;
      if (typeof rawProto === "string" && rawProto.length > 0) {
        const expectedProtocol = `${rawProto.split(",")[0]!.trim()}:`;
        if (parsedOrigin.protocol !== expectedProtocol) {
          return false;
        }
      }
    }

    return true;
  } catch {
    return false;
  }
}

function isJsonContentType(req: Request): boolean {
  const contentType = req.headers["content-type"] ?? "";
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType);
}

export async function createApp(
  options: ServerAppOptions = {},
): Promise<Express> {
  const tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const getAiConfig =
    options.getAiConfig ??
    (() => ({
      apiKey: process.env.NEARAI_API_KEY,
      composeHash: process.env.NEARAI_OPERATOR_APPROVED_COMPOSE_HASH,
      osImageHash: process.env.NEARAI_OPERATOR_APPROVED_OS_IMAGE_HASH,
    }));

  const consentTokens = new Map<string, ConsentTokenRecord>();
  const customSnapshots = new Map<string, CachedCustomSnapshot>();

  function pruneConsentTokens(currentTime = now()): void {
    for (const [token, record] of consentTokens) {
      if (record.expiresAt <= currentTime) {
        consentTokens.delete(token);
      }
    }
    while (consentTokens.size >= MAX_CONSENT_TOKENS) {
      const oldest = consentTokens.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      consentTokens.delete(oldest);
    }
  }

  function pruneCustomSnapshots(currentTime = now()): void {
    for (const [hash, record] of customSnapshots) {
      if (record.expiresAt <= currentTime) {
        customSnapshots.delete(hash);
      }
    }
    while (customSnapshots.size >= MAX_CUSTOM_SNAPSHOTS) {
      const oldest = customSnapshots.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      customSnapshots.delete(oldest);
    }
  }

  function cacheCustomSnapshot(snapshot: SourceLoadResult): void {
    pruneCustomSnapshots();
    customSnapshots.set(snapshot.manifest.sourceHash, {
      snapshot,
      expiresAt: now() + CUSTOM_SNAPSHOT_TTL_MS,
    });
  }

  function modelConfigFingerprint(): string {
    const cfg = getAiConfig();
    const config = {
      sdkVersion: "0.3.0",
      modelId: NEAR_AI_MODEL_ID,
      composeHash: cfg.composeHash ?? null,
      osImageHash: cfg.osImageHash ?? null,
    };
    return createHash("sha256")
      .update(JSON.stringify(config), "utf8")
      .digest("hex");
  }

  function issueConsentToken(
    sourceKind: SourceKind,
    snapshot: SourceLoadResult,
    fixture?: FixtureName,
  ): { token: string; expiresAt: string } {
    pruneConsentTokens();
    const token = randomBytes(32).toString("hex");
    const expiresAt = now() + tokenTtlMs;
    consentTokens.set(token, {
      sourceKind,
      ...(fixture ? { fixture } : {}),
      snapshotHash: snapshot.manifest.sourceHash,
      modelId: NEAR_AI_MODEL_ID,
      modelConfigFingerprint: modelConfigFingerprint(),
      expiresAt,
    });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  function hasApprovedMeasurementsConfigured(): boolean {
    const cfg = getAiConfig();
    return Boolean(cfg.composeHash && cfg.osImageHash);
  }

  function hasApiKeyConfigured(): boolean {
    const cfg = getAiConfig();
    return Boolean(cfg.apiKey && cfg.apiKey.trim().length > 0);
  }

  function createAdapter(): ReturnType<typeof createNearAiAdapter> {
    if (options.createAiAdapter) {
      return options.createAiAdapter();
    }
    const cfg = getAiConfig();
    const approvedModelDeployments =
      cfg.composeHash && cfg.osImageHash
        ? [{ composeHash: cfg.composeHash, osImageHash: cfg.osImageHash }]
        : [];

    return createNearAiAdapter({
      approvedModelDeployments,
      getApiKey: () => getAiConfig().apiKey,
    });
  }

  function buildReviewPayload(params: {
    sourceKind: SourceKind;
    fixture?: FixtureName;
    snapshot: SourceLoadResult;
    report: DeterministicDemoReport;
  }) {
    const { sourceKind, fixture, snapshot, report } = params;
    const sourceExcerpts = buildSourceExcerpts(snapshot, report);
    const consent = issueConsentToken(sourceKind, snapshot, fixture);

    return {
      sourceKind,
      ...(fixture ? { fixture } : {}),
      execution: {
        mode: "local_deterministic_only",
        aiInference: "not_run",
        sourceTransmission: "none",
      },
      snapshotFiles: snapshot.files.map((file) => ({
        path: file.path,
        content: file.content,
        byteLength: file.byteLength,
        lineCount: file.lineCount,
      })),
      totalBytes: snapshot.totalBytes,
      report,
      sourceExcerpts,
      consentToken: consent.token,
      consentTokenExpiresAt: consent.expiresAt,
      aiConfig: {
        modelId: NEAR_AI_MODEL_ID,
        apiKeyConfigured: hasApiKeyConfigured(),
        approvedMeasurementsConfigured: hasApprovedMeasurementsConfigured(),
        maxSourceContextBytes: 256 * 1024,
        maxPromptBytes: 320 * 1024,
      },
    };
  }

  const app = express();
  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    next();
  });

  app.use(express.json({ limit: "6mb" }));

  app.get("/api/health", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });

  app.get("/api/review", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const fixtureParam = req.query.fixture;
    if (
      fixtureParam !== undefined &&
      fixtureParam !== "triggering" &&
      fixtureParam !== "safe"
    ) {
      res.status(400).json({ error: "Unknown fixture requested." });
      return;
    }

    const fixture: FixtureName =
      fixtureParam === "safe" ? "safe" : "triggering";

    try {
      const snapshot = await loadSource(fixtureDirectory(fixture));
      const ruleResult = runNearRustCallbackPrivateRule(snapshot);
      const report = buildDeterministicDemoReport(snapshot, ruleResult);
      res.json(
        buildReviewPayload({
          sourceKind: "fixture",
          fixture,
          snapshot,
          report,
        }),
      );
    } catch (error) {
      console.error("Failed to load deterministic fixture review:", error);
      res.status(500).json({ error: "Failed to load deterministic fixture review." });
    }
  });

  app.post("/api/review/custom", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    if (!isJsonContentType(req)) {
      res.status(415).json({ error: "Content-Type must be application/json." });
      return;
    }

    const parsed = CustomReviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          parsed.error.issues[0]?.message ??
          "Invalid custom Rust source payload.",
      });
      return;
    }

    try {
      const snapshot = createSnapshotFromEntries(
        parsed.data.files,
        options.customLimits,
      );
      cacheCustomSnapshot(snapshot);
      const ruleResult = runNearRustCallbackPrivateRule(snapshot);
      const report = buildDeterministicDemoReport(snapshot, ruleResult);
      res.json(
        buildReviewPayload({
          sourceKind: "custom",
          snapshot,
          report,
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Custom Rust snapshot validation failed.";
      res.status(400).json({ error: message });
    }
  });

  app.post("/api/ai-review", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    if (!isSameOriginRequest(req)) {
      res.status(403).json({ error: "The request origin is not allowed." });
      return;
    }

    if (req.headers[CONSENT_HEADER] !== CONSENT_HEADER_VALUE) {
      res.status(403).json({
        error: "Explicit AI-review consent header is required.",
      });
      return;
    }

    if (!isJsonContentType(req)) {
      res.status(415).json({ error: "Content-Type must be application/json." });
      return;
    }

    const parsed = AiReviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          parsed.error.issues[0]?.message ??
          "Invalid AI review confirmation payload.",
      });
      return;
    }

    const { sourceKind, fixture, snapshotHash, token } = parsed.data;

    // Single-use token removal occurs synchronously before any awaited work.
    const tokenRecord = consentTokens.get(token);
    if (tokenRecord) {
      consentTokens.delete(token);
    }

    if (!tokenRecord || tokenRecord.expiresAt <= now()) {
      res.status(401).json({
        error:
          "Consent token is missing, expired, or already used. Refresh the deterministic review to mint a fresh token.",
      });
      return;
    }

    if (
      tokenRecord.sourceKind !== sourceKind ||
      tokenRecord.fixture !== fixture ||
      tokenRecord.snapshotHash !== snapshotHash ||
      tokenRecord.modelId !== NEAR_AI_MODEL_ID ||
      tokenRecord.modelConfigFingerprint !== modelConfigFingerprint()
    ) {
      res.status(409).json({
        error:
          "Consent token does not match this snapshot, source mode, or model configuration.",
      });
      return;
    }

    let sourceTransmission: "none" | "sent" = "none";

    try {
      let snapshot: SourceLoadResult | undefined;

      if (sourceKind === "fixture") {
        snapshot = await loadSource(fixtureDirectory(fixture!));
      } else {
        pruneCustomSnapshots();
        snapshot = customSnapshots.get(snapshotHash)?.snapshot;
      }

      if (!snapshot) {
        res.status(404).json({
          error:
            "The custom snapshot expired from server memory. Re-run the deterministic review before requesting AI analysis.",
          execution: { aiInference: "not_run", sourceTransmission: "none" },
        });
        return;
      }

      if (snapshot.manifest.sourceHash !== snapshotHash) {
        res.status(409).json({
          error:
            "The source snapshot changed since review; re-run deterministic review and confirm again.",
          execution: { aiInference: "not_run", sourceTransmission: "none" },
        });
        return;
      }

      const ruleResult = runNearRustCallbackPrivateRule(snapshot);
      const aiResult: NearAiAnalysisResult = await createAdapter()(
        snapshot,
        ruleResult.deterministicAnalysis.findings,
        {
          onSourceTransmission: () => {
            sourceTransmission = "sent";
          },
        },
      );

      res.json({
        sourceKind,
        ...(fixture ? { fixture } : {}),
        snapshotHash: snapshot.manifest.sourceHash,
        modelId: NEAR_AI_MODEL_ID,
        approvedMeasurementsConfigured: hasApprovedMeasurementsConfigured(),
        apiKeyConfigured: hasApiKeyConfigured(),
        independentNearApproval: "not_established",
        execution: {
          mode: "local_deterministic_plus_near_ai",
          aiInference: aiResult.status,
          sourceTransmission,
        },
        aiAnalysis: aiResult,
      });
    } catch {
      res.status(500).json({
        error: "The optional NEAR AI review failed.",
        execution: { aiInference: "failed", sourceTransmission },
      });
    }
  });

  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      next: NextFunction,
    ): void => {
      if (
        typeof err === "object" &&
        err !== null &&
        "type" in err &&
        (err as { type?: string }).type === "entity.too.large"
      ) {
        res.status(413).json({ error: "Request body is too large." });
        return;
      }
      if (err instanceof SyntaxError) {
        res.status(400).json({ error: "Request body must be valid JSON." });
        return;
      }
      next(err);
    },
  );

  const enableVite = options.enableVite ?? true;
  if (enableVite) {
    if (process.env.NODE_ENV !== "production") {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } else {
      const distDir = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "dist",
      );
      app.use(express.static(distDir));
      app.get("*all", (_req: Request, res: Response) => {
        res.sendFile(path.join(distDir, "index.html"));
      });
    }
  }

  return app;
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  createApp()
    .then((app) => {
      const httpServer = app.listen(PORT, HOST, () => {
        console.log(
          `SentinelReview workbench listening on http://${HOST}:${PORT}`,
        );
      });

      const shutdown = () => {
        httpServer.close(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((error) => {
      console.error("Failed to start SentinelReview server:", error);
      process.exit(1);
    });
}
