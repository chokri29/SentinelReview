import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

const HOST = "127.0.0.1";

let child: ChildProcess | undefined;
let childOutput = "";
let childErrors = "";
let baseUrl = "";

async function reserveAvailablePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, HOST, resolve);
  });

  const address = reservation.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve, reject) => {
      reservation.close((error) => error ? reject(error) : resolve());
    });
    throw new Error("Could not determine an available local port");
  }

  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function startDashboard(): Promise<void> {
  const port = await reserveAvailablePort();
  baseUrl = `http://${HOST}:${port}`;
  childOutput = "";
  childErrors = "";

  child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/dashboard-server.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout?.on("data", (chunk: Buffer) => {
    childOutput += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    childErrors += chunk.toString("utf8");
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Dashboard process exited early (${child.exitCode}).\n${childOutput}\n${childErrors}`,
      );
    }

    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      // The server may still be starting.
    }
    await delay(100);
  }

  throw new Error(
    `Dashboard did not become ready within 10 seconds.\n${childOutput}\n${childErrors}`,
  );
}

afterEach(async () => {
  if (child && child.exitCode === null) {
    const process = child;
    const exited = new Promise<void>((resolve) => {
      process.once("exit", () => resolve());
    });
    process.kill("SIGTERM");
    await Promise.race([exited, delay(3_000)]);
  }
  child = undefined;
});

describe("local dashboard HTTP smoke test", () => {
  it(
    "serves the dashboard and both real deterministic fixture reports",
    async () => {
      await startDashboard();

      const pageResponse = await fetch(baseUrl);
      expect(pageResponse.status).toBe(200);
      expect(pageResponse.headers.get("content-type")).toContain("text/html");
      expect(pageResponse.headers.get("cache-control")).toBe("no-store");
      const page = await pageResponse.text();
      expect(page).toContain("SentinelReview — Local Security Review");
      expect(page).toContain("data-fixture=\"triggering\"");
      expect(page).toContain("data-fixture=\"safe\"");

      const triggeringResponse = await fetch(
        `${baseUrl}/api/review?fixture=triggering`,
      );
      expect(triggeringResponse.status).toBe(200);
      const triggeringPayload = await triggeringResponse.json();
      expect(triggeringPayload.fixture).toBe("triggering");
      expect(triggeringPayload.report.overallAnalysisStatus).toBe("finding");
      expect(triggeringPayload.report.findings).toHaveLength(1);
      expect(triggeringPayload.report.evidenceIntegration.evidence[0]).toMatchObject({
        declaredValidationStatus: "unavailable",
        computedValidationStatus: "validated",
        presentedAsValidated: true,
      });
      expect(triggeringPayload.report.snapshot.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(triggeringPayload.execution).toEqual({
        mode: "local_deterministic_demo",
        aiInference: "not_run",
        sourceTransmission: "none",
      });
      expect(triggeringPayload.report.findings[0].severity).toBeTruthy();
      const excerpt = Object.values(triggeringPayload.sourceExcerpts)[0] as {
        startLine: number;
        content: string;
      };
      expect(excerpt.startLine).toBeGreaterThan(0);
      expect(excerpt.content.length).toBeGreaterThan(0);
      expect(triggeringPayload.report.findings[0].locations[0].path).toBeTruthy();

      const safeResponse = await fetch(`${baseUrl}/api/review?fixture=safe`);
      expect(safeResponse.status).toBe(200);
      const safePayload = await safeResponse.json();
      expect(safePayload.fixture).toBe("safe");
      expect(safePayload.report.overallAnalysisStatus).toBe("no_findings");
      expect(safePayload.report.findings).toEqual([]);
      expect(safePayload.report.interpretation).toContain(
        "does not establish that the source is safe",
      );

      const invalidFixtureResponse = await fetch(
        `${baseUrl}/api/review?fixture=unexpected`,
      );
      expect(invalidFixtureResponse.status).toBe(400);
      await expect(invalidFixtureResponse.json()).resolves.toMatchObject({
        error: "fixture must be triggering or safe",
      });

      const missingRouteResponse = await fetch(`${baseUrl}/missing`);
      expect(missingRouteResponse.status).toBe(404);
      const rejectedMethodResponse = await fetch(baseUrl, { method: "POST" });
      expect(rejectedMethodResponse.status).toBe(405);
    },
    20_000,
  );
});
