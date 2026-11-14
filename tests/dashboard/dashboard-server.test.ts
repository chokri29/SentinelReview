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
      env: {
        ...process.env,
        PORT: String(port),
        NEARAI_API_KEY: "",
        NEARAI_OPERATOR_APPROVED_COMPOSE_HASH: "",
        NEARAI_OPERATOR_APPROVED_OS_IMAGE_HASH: "",
      },
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
       expect(page).toContain("Evidence matched means the snapshot and manifest integrity checks pass");
      expect(page).toContain("does not confirm a vulnerability or exploitability");
      expect(page).toContain("Candidates detected");
      expect(page).toContain("One deterministic rule executed");
      expect(page).toContain("No candidate detected by this rule — not a safety certification.");
      expect(page).toContain('validated: "Evidence matched"');
      expect(page).toContain("Presented as evidence matched");
      expect(page).toContain("Not presented as evidence matched");
      expect(page).toContain("This rule emitted no candidate — not a safety proof.");
      expect(page).toContain("Rule result");
      expect(page).toContain('report.deterministicRule.findingCount === 0');
      expect(page).toContain('"No candidate"');
      expect(page).toContain('"Candidate detected"');
      expect(page).toContain("SentinelReview · Local deterministic preview");
      expect(page).toContain("badge(finding.severity)");
      expect(page).toContain('id="execution-disclosure"');
      expect(page).toContain("This sends the full source to that model.");
      expect(page).toContain("AI hypothesis · not a confirmed vulnerability");
      expect(page).toContain("X-SentinelReview-AI-Consent");

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
      expect(triggeringPayload.consent).toMatchObject({
        snapshotHash: triggeringPayload.report.snapshot.sourceHash,
        modelId: "z-ai/glm-5.3-flash",
        files: ["lib.rs"],
      });
      expect(triggeringPayload.consent.token).toMatch(/^[a-f0-9]{64}$/);
      expect(triggeringPayload.consent.sourceBytes).toBeGreaterThan(0);

      const consentBody = {
        fixture: "triggering",
        snapshotHash: triggeringPayload.consent.snapshotHash,
        token: triggeringPayload.consent.token,
      };
      const rejectedOrigin = await fetch(`${baseUrl}/api/ai-review`, {
        method: "POST",
        headers: {
          Origin: "http://attacker.invalid",
          "Content-Type": "application/json",
          "X-SentinelReview-AI-Consent": "1",
        },
        body: JSON.stringify(consentBody),
      });
      expect(rejectedOrigin.status).toBe(403);

      const extraField = await fetch(`${baseUrl}/api/ai-review`, {
        method: "POST",
        headers: {
          Origin: baseUrl,
          "Content-Type": "application/json",
          "X-SentinelReview-AI-Consent": "1",
        },
        body: JSON.stringify({ ...consentBody, source: "attacker-controlled" }),
      });
      expect(extraField.status).toBe(400);

      const missingConsentHeader = await fetch(`${baseUrl}/api/ai-review`, {
        method: "POST",
        headers: { Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify(consentBody),
      });
      expect(missingConsentHeader.status).toBe(403);

      const wrongContentType = await fetch(`${baseUrl}/api/ai-review`, {
        method: "POST",
        headers: { Origin: baseUrl, "Content-Type": "text/plain", "X-SentinelReview-AI-Consent": "1" },
        body: JSON.stringify(consentBody),
      });
      expect(wrongContentType.status).toBe(415);

      const postHeaders = {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-SentinelReview-AI-Consent": "1",
      };
      const concurrent = await Promise.all([
        fetch(`${baseUrl}/api/ai-review`, {
          method: "POST", headers: postHeaders, body: JSON.stringify(consentBody),
        }),
        fetch(`${baseUrl}/api/ai-review`, {
          method: "POST", headers: postHeaders, body: JSON.stringify(consentBody),
        }),
      ]);
      expect(concurrent.map((response) => response.status).sort()).toEqual([200, 401]);
      const acceptedResponse = concurrent.find((response) => response.status === 200)!;
      const acceptedPayload = await acceptedResponse.json();
      expect(acceptedPayload.execution).toEqual({
        mode: "local_deterministic_plus_near_ai",
        aiInference: "failed",
        sourceTransmission: "none",
      });
      expect(acceptedPayload.approvedMeasurementsConfigured).toBe(false);
      expect(acceptedPayload.independentNearApproval).toBe("not_established");
      expect(acceptedPayload.aiAnalysis.findings).toEqual([]);
      expect(acceptedPayload.aiAnalysis.provenance.privateModelPolicy).toBe("unavailable");
      expect(triggeringPayload.report.findings[0].severity).toBeTruthy();
      const location = triggeringPayload.report.findings[0].locations[0];
      const excerpt = triggeringPayload.sourceExcerpts[location.evidenceId] as {
        startLine: number;
        content: string;
      };
      expect(excerpt.startLine).toBe(location.startLine);
      expect(excerpt.content.split("\n")).toHaveLength(
        location.endLine - location.startLine + 1,
      );
      expect(excerpt.content.length).toBeGreaterThan(0);
      expect(location.path).toBeTruthy();

      const safeResponse = await fetch(`${baseUrl}/api/review?fixture=safe`);
      expect(safeResponse.status).toBe(200);
      const safePayload = await safeResponse.json();
      expect(safePayload.fixture).toBe("safe");
      expect(safePayload.report.overallAnalysisStatus).toBe("no_findings");
      expect(safePayload.report.findings).toEqual([]);
      expect(safePayload.report.interpretation).toContain(
        "does not establish that the source is safe",
      );
      const safeConsentMismatch = await fetch(`${baseUrl}/api/ai-review`, {
        method: "POST",
        headers: postHeaders,
        body: JSON.stringify({
          fixture: "triggering",
          snapshotHash: safePayload.consent.snapshotHash,
          token: safePayload.consent.token,
        }),
      });
      expect(safeConsentMismatch.status).toBe(409);
      const consumedMismatchToken = await fetch(`${baseUrl}/api/ai-review`, {
        method: "POST",
        headers: postHeaders,
        body: JSON.stringify({
          fixture: "safe",
          snapshotHash: safePayload.consent.snapshotHash,
          token: safePayload.consent.token,
        }),
      });
      expect(consumedMismatchToken.status).toBe(401);

      const invalidFixtureResponse = await fetch(
        `${baseUrl}/api/review?fixture=unexpected`,
      );
      expect(invalidFixtureResponse.status).toBe(400);
      await expect(invalidFixtureResponse.json()).resolves.toMatchObject({
        error: "fixture must be triggering or safe",
      });

      const missingRouteResponse = await fetch(`${baseUrl}/missing`);
      expect(missingRouteResponse.status).toBe(404);
      const rejectedRootMethodResponse = await fetch(baseUrl, { method: "POST" });
      expect(rejectedRootMethodResponse.status).toBe(405);
      const rejectedReviewMethodResponse = await fetch(`${baseUrl}/api/review`, { method: "POST" });
      expect(rejectedReviewMethodResponse.status).toBe(405);
      const rejectedAiReviewMethodResponse = await fetch(`${baseUrl}/api/ai-review`);
      expect(rejectedAiReviewMethodResponse.status).toBe(405);
    },
    20_000,
  );
});
