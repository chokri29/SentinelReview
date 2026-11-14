import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDeterministicDemoReport } from "../../src/demo/deterministic-review.js";
import { loadSource } from "../../src/source/load-source.js";

describe("buildDeterministicDemoReport", () => {
  it("produces 1 validated informational candidate on callback-unguarded fixture", async () => {
    const dir = fileURLToPath(
      new URL("../../demo-fixtures/callback-unguarded/", import.meta.url),
    );
    const snapshot = await loadSource(dir);
    const report = buildDeterministicDemoReport(snapshot);

    expect(report.overallAnalysisStatus).toBe("finding");
    expect(report.deterministicRule.findingCount).toBe(1);
    expect(report.deterministicRule.toolchain).toEqual([
      "NEAR-RUST-CALLBACK-PRIVATE-001@1",
      "@lezer/rust@1.0.3",
    ]);
    expect(report.snapshot.files).toHaveLength(1);
    expect(report.snapshot.files[0]?.path).toBe("lib.rs");
    expect(report.evidenceIntegration.status).toBe("complete");
    expect(report.evidenceIntegration.evidence[0]?.excerptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.evidenceIntegration.evidence[0]?.checks.excerptHash).toBe("passed");
    expect(report.findings[0]?.locations[0]?.presentedAsValidated).toBe(true);
    expect(report.findings[0]?.locations[0]?.path).toBe("lib.rs");
  });

  it("produces 0 findings on callback-safe fixture with non-safety disclaimer", async () => {
    const dir = fileURLToPath(
      new URL("../../demo-fixtures/callback-safe/", import.meta.url),
    );
    const snapshot = await loadSource(dir);
    const report = buildDeterministicDemoReport(snapshot);

    expect(report.overallAnalysisStatus).toBe("no_findings");
    expect(report.deterministicRule.findingCount).toBe(0);
    expect(report.evidenceIntegration.status).toBe("complete");
    expect(report.evidenceIntegration.evidence).toHaveLength(0);
    expect(report.interpretation).toMatch(/does not establish that the source is safe/i);
  });
});

