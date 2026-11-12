import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Evidence } from "../../src/contracts/v1.js";
import { loadSource } from "../../src/source/load-source.js";
import { runDeterministicDemoCli } from "../../scripts/demo-deterministic-review.js";
import { runNearRustCallbackPrivateRule } from "../../src/rules/near-rust-callback-private.js";
import {
  buildDeterministicDemoReport,
  formatDeterministicDemoReport,
} from "../../src/demo/deterministic-review.js";

describe("deterministic demo pipeline", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "sentinel-demo-"));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function loadFixture(source: string) {
    const directory = path.join(temporaryDirectory, "source");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "lib.rs"), source, "utf8");
    return loadSource(directory);
  }

  const triggeringSource = `#[near]
impl Contract {
    pub fn on_callback(#[callback_result] result: Result<(), PromiseError>) {
        self.completed = true;
    }
}
`;

  const safeSource = `#[near]
impl Contract {
    #[private]
    pub fn on_callback(#[callback_result] result: Result<(), PromiseError>) {
        self.completed = true;
    }
}
`;

  const manuallyGuardedSource = `#[near]
impl Contract {
    pub fn on_callback(#[callback_result] result: Result<(), PromiseError>) {
        if env::predecessor_account_id() != env::current_account_id() {
            env::panic_str("not private");
        }
    }
}
`;

  it("runs the real rule and integrates its evidence against the same snapshot", async () => {
    const snapshot = await loadFixture(triggeringSource);
    const ruleResult = runNearRustCallbackPrivateRule(snapshot);
    const report = buildDeterministicDemoReport(snapshot, ruleResult);

    expect(ruleResult.deterministicAnalysis.findings).toHaveLength(1);
    expect(report.deterministicRule.status).toBe("finding");
    expect(report.evidenceIntegration.status).toBe("complete");
    expect(report.findings[0]?.origin).toBe("deterministic_rule");
    expect(report.findings[0]?.severity).toBe("info");
    expect(report.findings[0]?.locations[0]).toMatchObject({
      path: "lib.rs",
      startLine: 3,
      endLine: 5,
      referenceStatus: "resolved",
      embeddedValidationStatus: "unavailable",
      integrationValidationStatus: "validated",
      presentedAsValidated: true,
    });
    expect(report.snapshot.sourceHash).toBe(snapshot.manifest.sourceHash);
  });

  it("reports no findings for a private callback without claiming the source is safe", async () => {
    const snapshot = await loadFixture(safeSource);
    const report = buildDeterministicDemoReport(snapshot);

    expect(report.deterministicRule.status).toBe("passed");
    expect(report.overallAnalysisStatus).toBe("no_findings");
    expect(report.findings).toEqual([]);
    expect(report.interpretation).toContain("does not establish that the source is safe");
  });

  it("reports inconclusive analysis without describing a no-findings review", async () => {
    const snapshot = await loadFixture(manuallyGuardedSource);
    const report = buildDeterministicDemoReport(snapshot);

    expect(report.deterministicRule.status).toBe("inconclusive");
    expect(report.overallAnalysisStatus).toBe("inconclusive");
    expect(report.interpretation).toContain("could not reach a conclusive result");
    expect(report.interpretation).not.toContain("no findings");
  });

  it("does not present evidence as validated when integration rejects its excerpt hash", async () => {
    const snapshot = await loadFixture(triggeringSource);
    const original = runNearRustCallbackPrivateRule(snapshot);
    const alteredEvidence = {
      ...original.evidence[0]!,
      excerptHash: "0".repeat(64),
    } satisfies Evidence;
    const alteredResult = {
      ...original,
      evidence: [alteredEvidence],
    };
    const report = buildDeterministicDemoReport(snapshot, alteredResult);

    expect(report.evidenceIntegration.status).toBe("invalid");
    expect(report.findings).toHaveLength(1);
    expect(report.evidenceIntegration.evidence[0]).toMatchObject({
      embeddedValidationStatus: "unavailable",
      integrationValidationStatus: "invalid",
      presentedAsValidated: false,
    });
    expect(report.findings[0]?.locations[0]).toMatchObject({
      referenceStatus: "resolved",
      integrationValidationStatus: "invalid",
      presentedAsValidated: false,
    });
  });

  it("does not present unresolved finding references as validated", async () => {
    const snapshot = await loadFixture(triggeringSource);
    const original = runNearRustCallbackPrivateRule(snapshot);
    const finding = original.deterministicAnalysis.findings[0]!;
    const alteredFinding = {
      ...finding,
      evidenceRefs: [{ evidenceId: "missing-evidence-reference" }],
    };
    const alteredResult = {
      ...original,
      deterministicAnalysis: {
        ...original.deterministicAnalysis,
        findings: [alteredFinding],
      },
    };
    const report = buildDeterministicDemoReport(snapshot, alteredResult);

    expect(report.evidenceIntegration.status).toBe("invalid");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.locations[0]).toMatchObject({
      referenceStatus: "missing",
      integrationValidationStatus: "not_available",
      presentedAsValidated: false,
    });
  });

  it("formats detection and evidence validation as separate concepts", async () => {
    const snapshot = await loadFixture(triggeringSource);
    const report = buildDeterministicDemoReport(snapshot);
    const output = formatDeterministicDemoReport(report);

    expect(output).toContain('"status": "finding"');
    expect(output).toContain('"integrationValidationStatus": "validated"');
    expect(output).toContain('"embeddedValidationStatus": "unavailable"');
    expect(output).toContain("not an exploitability determination");
  });

  it("runs both bundled fixtures through the local CLI without credentials", async () => {
    const triggeringOutput: string[] = [];
    const errors: string[] = [];
    const triggeringExit = await runDeterministicDemoCli(
      [],
      (output) => triggeringOutput.push(output),
      (output) => errors.push(output),
    );
    expect(triggeringExit).toBe(0);
    expect(errors).toEqual([]);
    expect(triggeringOutput.join("")).toContain('"overallAnalysisStatus": "finding"');

    const safeOutput: string[] = [];
    const safeExit = await runDeterministicDemoCli(
      ["safe"],
      (output) => safeOutput.push(output),
      (output) => errors.push(output),
    );
    expect(safeExit).toBe(0);
    expect(safeOutput.join("")).toContain('"overallAnalysisStatus": "no_findings"');
  });

});
