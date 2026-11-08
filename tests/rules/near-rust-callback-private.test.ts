import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { integrateEvidence } from "../../src/source/integrate-evidence.js";
import { loadSource } from "../../src/source/load-source.js";
import { validateEvidence } from "../../src/source/validate-evidence.js";
import { runNearRustCallbackPrivateRule } from "../../src/rules/near-rust-callback-private.js";

describe("NEAR-RUST-CALLBACK-PRIVATE-001", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "near-callback-private-"),
    );
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function loadSnapshot(
    files: readonly (readonly [string, string])[],
  ) {
    const sourceDirectory = path.join(temporaryDirectory, "source");
    await mkdir(sourceDirectory, { recursive: true });

    for (const [relativePath, content] of files) {
      const filePath = path.join(sourceDirectory, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }

    return loadSource(sourceDirectory);
  }

  it("does not report a callback with #[private]", async () => {
    const snapshot = await loadSnapshot([
      [
        "lib.rs",
        `#[near]
impl Contract {
    #[private]
    pub fn on_done(#[callback_result] result: Result<(), X>) {}
}
`,
      ],
    ]);

    const result = runNearRustCallbackPrivateRule(snapshot);

    expect(result.deterministicAnalysis.status).toBe("passed");
    expect(result.deterministicAnalysis.findings).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("suppresses the candidate for a direct manual guard and marks analysis inconclusive", async () => {
    const snapshot = await loadSnapshot([
      [
        "lib.rs",
        `#[near]
impl Contract {
    pub fn on_done(#[callback_result] result: Result<(), X>) {
        if env::predecessor_account_id() != env::current_account_id() {
            env::panic_str("not private");
        }
    }
}
`,
      ],
    ]);

    const result = runNearRustCallbackPrivateRule(snapshot);

    expect(result.deterministicAnalysis.status).toBe("inconclusive");
    expect(result.deterministicAnalysis.findings).toEqual([]);
    expect(result.limitations.some((item) => item.includes("lib.rs:3"))).toBe(
      true,
    );
  });

  it("emits an informational candidate with validator-compatible evidence", async () => {
    const snapshot = await loadSnapshot([
      [
        "src/lib.rs",
        `#[near]
impl Contract {
    pub fn on_done(#[callback_result] result: Result<(), X>) {
        self.finished = true;
    }
}
`,
      ],
    ]);

    const result = runNearRustCallbackPrivateRule(snapshot);
    const finding = result.deterministicAnalysis.findings[0]!;
    const evidence = result.evidence[0]!;

    expect(result.deterministicAnalysis.status).toBe("finding");
    expect(finding.title).toBe(
      "Callback-result handler has no recognized access guard.",
    );
    expect(finding.origin).toBe("deterministic_rule");
    expect(finding.ruleId).toBe("NEAR-RUST-CALLBACK-PRIVATE-001");
    expect(finding.severity).toBe("info");
    expect(finding.rationale).toContain("cannot establish exploitability");
    expect(evidence).toMatchObject({
      sourceHash: snapshot.manifest.sourceHash,
      path: "src/lib.rs",
      startLine: 3,
      endLine: 5,
      producer: "deterministic_rule",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.deterministicAnalysis)).toBe(true);
    expect(Object.isFrozen(result.deterministicAnalysis.toolchain)).toBe(true);
    expect(Object.isFrozen(result.deterministicAnalysis.findings)).toBe(true);
    expect(Object.isFrozen(finding)).toBe(true);
    expect(Object.isFrozen(finding.evidenceRefs)).toBe(true);
    expect(Object.isFrozen(finding.evidenceRefs[0])).toBe(true);
    expect(Object.isFrozen(finding.limitations)).toBe(true);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.limitations)).toBe(true);
    expect(Reflect.set(evidence, "path", "changed.rs")).toBe(false);
    expect(Reflect.set(finding, "title", "changed")).toBe(false);
    expect(
      Reflect.set(finding.evidenceRefs[0]!, "evidenceId", "changed"),
    ).toBe(false);

    const validation = validateEvidence(evidence, snapshot);
    expect(validation.status).toBe("validated");

    const integration = integrateEvidence(
      result.evidence,
      result.deterministicAnalysis.findings,
      snapshot,
    );
    expect(integration.status).toBe("complete");
    expect(integration.findings[0]?.evidenceRefs[0]?.status).toBe("resolved");
    expect(
      integration.findings[0]?.evidenceRefs[0]?.evidenceEntry?.evidence
        .evidenceId,
    ).toBe(finding.evidenceRefs[0]?.evidenceId);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["lone CR", "\r"],
  ] as const)(
    "generates validator-compatible evidence with %s line endings",
    async (_name, newline) => {
      const source = [
        "#[near]",
        "impl Contract {",
        "    pub fn on_done(#[callback_result] result: Result<(), X>) {",
        "        self.finished = true;",
        "    }",
        "}",
        "",
      ].join(newline);
      const snapshot = await loadSnapshot([["lib.rs", source]]);

      const result = runNearRustCallbackPrivateRule(snapshot);
      const evidence = result.evidence[0]!;

      expect(evidence).toMatchObject({
        path: "lib.rs",
        startLine: 3,
        endLine: 5,
      });
      expect(validateEvidence(evidence, snapshot).status).toBe("validated");
    },
  );

  it("ignores ordinary methods, comments, and strings containing annotation text", async () => {
    const snapshot = await loadSnapshot([
      [
        "lib.rs",
        `#[near]
impl Contract {
    pub fn ordinary() {
        // #[callback_result] #[private] #[near]
        let annotation = "#[callback_result] #[private] #[near_bindgen]";
    }
    pub fn unwrapped(#[callback_unwrap] result: Result<(), X>) {}
    pub fn collected(#[callback_vec] results: Vec<X>) {}
}
`,
      ],
    ]);

    const result = runNearRustCallbackPrivateRule(snapshot);

    expect(result.deterministicAnalysis.status).toBe("passed");
    expect(result.deterministicAnalysis.findings).toEqual([]);
  });

  it("emits no findings from malformed files and records the path", async () => {
    const snapshot = await loadSnapshot([
      [
        "bad.rs",
        `#[near]
impl Contract {
    pub fn broken(#[callback_result] result: Result<(), X> {
}
`,
      ],
      [
        "good.rs",
        `#[near]
impl Good {
    pub fn on_done(#[callback_result] result: Result<(), X>) {}
}
`,
      ],
    ]);

    const result = runNearRustCallbackPrivateRule(snapshot);

    expect(result.deterministicAnalysis.status).toBe("inconclusive");
    expect(result.deterministicAnalysis.findings).toHaveLength(1);
    expect(result.evidence.map((entry) => entry.path)).toEqual(["good.rs"]);
    expect(
      result.limitations.some(
        (item) => item.includes("bad.rs") && item.includes("no findings"),
      ),
    ).toBe(true);
  });

  it("recognizes both #[near] and legacy #[near_bindgen] impls", async () => {
    const snapshot = await loadSnapshot([
      [
        "current.rs",
        `#[near]
impl Current {
    pub fn on_done(#[callback_result] result: Result<(), X>) {}
}
`,
      ],
      [
        "legacy.rs",
        `#[near_bindgen]
impl Legacy {
    pub fn on_done(#[callback_result] result: Result<(), X>) {}
}
`,
      ],
    ]);

    const result = runNearRustCallbackPrivateRule(snapshot);

    expect(result.deterministicAnalysis.findings).toHaveLength(2);
    expect(result.evidence.map((entry) => entry.path)).toEqual([
      "current.rs",
      "legacy.rs",
    ]);
  });

  it("handles multiple callback methods and files without duplicate evidence IDs", async () => {
    const snapshot = await loadSnapshot([
      [
        "a.rs",
        `#[near]
impl A {
    pub fn first(#[callback_result] result: Result<(), X>) {}
    #[private]
    pub fn guarded(#[callback_result] result: Result<(), X>) {}
    pub fn second(#[callback_result] result: Result<(), X>) {}
}
`,
      ],
      [
        "b.rs",
        `#[near_bindgen]
impl B {
    pub fn third(#[callback_result] result: Result<(), X>) {}
}
`,
      ],
    ]);

    const result = runNearRustCallbackPrivateRule(snapshot);

    expect(result.deterministicAnalysis.findings).toHaveLength(3);
    expect(result.evidence.map((entry) => entry.path)).toEqual([
      "a.rs",
      "a.rs",
      "b.rs",
    ]);
    expect(new Set(result.evidence.map((entry) => entry.evidenceId)).size).toBe(
      3,
    );
  });

  it("produces stable finding and evidence IDs for the same snapshot", async () => {
    const snapshot = await loadSnapshot([
      [
        "lib.rs",
        `#[near]
impl Contract {
    pub fn on_done(#[callback_result] result: Result<(), X>) {}
}
`,
      ],
    ]);

    const first = runNearRustCallbackPrivateRule(snapshot);
    const second = runNearRustCallbackPrivateRule(snapshot);

    expect(first.deterministicAnalysis.findings.map((item) => item.findingId))
      .toEqual(second.deterministicAnalysis.findings.map((item) => item.findingId));
    expect(first.evidence.map((item) => item.evidenceId)).toEqual(
      second.evidence.map((item) => item.evidenceId),
    );
  });
});
