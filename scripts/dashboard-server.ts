import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadSource } from "../src/source/load-source.js";
import {
  buildDeterministicDemoReport,
  type DeterministicDemoReport,
} from "../src/demo/deterministic-review.js";

type FixtureName = "triggering" | "safe";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const portValue = process.env.PORT ?? String(DEFAULT_PORT);
const PORT = Number(portValue);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

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

async function createReport(fixture: FixtureName): Promise<DeterministicDemoReport> {
  const snapshot = await loadSource(fixtureDirectory(fixture));
  return buildDeterministicDemoReport(snapshot);
}

function send(
  response: import("node:http").ServerResponse,
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
  });
  response.end(body);
}

const dashboardPath = fileURLToPath(
  new URL("../dashboard/index.html", import.meta.url),
);

const server = createServer(async (request, response) => {
  if (request.method !== "GET") {
    send(response, 405, "text/plain; charset=utf-8", "Method not allowed");
    return;
  }

  const requestUrl = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  if (requestUrl.pathname === "/") {
    try {
      const html = await readFile(dashboardPath, "utf8");
      send(response, 200, "text/html; charset=utf-8", html);
    } catch {
      send(response, 500, "text/plain; charset=utf-8", "Dashboard could not be loaded");
    }
    return;
  }

  if (requestUrl.pathname === "/api/review") {
    const requestedFixture = requestUrl.searchParams.get("fixture") ?? "triggering";
    if (requestedFixture !== "triggering" && requestedFixture !== "safe") {
      send(response, 400, "application/json; charset=utf-8", JSON.stringify({
        error: "fixture must be triggering or safe",
      }));
      return;
    }

    try {
      const fixture = requestedFixture as FixtureName;
      const report = await createReport(fixture);
      send(response, 200, "application/json; charset=utf-8", JSON.stringify({
        fixture,
        generatedAt: new Date().toISOString(),
        report,
      }));
    } catch {
      send(response, 500, "application/json; charset=utf-8", JSON.stringify({
        error: "The local deterministic review could not be completed.",
      }));
    }
    return;
  }

  send(response, 404, "text/plain; charset=utf-8", "Not found");
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `SentinelReview local dashboard: http://${HOST}:${PORT}\n` +
    "Local fixture data only; no AI inference or source upload.\n" +
    "Press Ctrl+C to stop.\n",
  );
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
