import { describe, expect, it } from "vitest";
import { runNearRustCallbackPrivateRule } from "../../src/rules/near-rust-callback-private.js";
import { createSnapshotFromEntries } from "../../src/source/custom-snapshot.js";
import { validateEvidence } from "../../src/source/validate-evidence.js";

describe("NEAR-RUST-CALLBACK-PRIVATE-001", () => {
  it("flags an unguarded #[callback_result] method inside #[near] impl and emits validated evidence", () => {
    const snapshot = createSnapshotFromEntries([
      {
        path: "src/lib.rs",
        content: [
          "#[near]",
          "impl Contract {",
          "    pub fn on_done(#[callback_result] res: Result<u64, PromiseError>) {",
          "        self.done = true;",
          "    }",
          "}",
        ].join("\n"),
      },
    ]);

    const result = runNearRustCallbackPrivateRule(snapshot);
    expect(result.deterministicAnalysis.status).toBe("finding");
    expect(result.deterministicAnalysis.findings).toHaveLength(1);
    expect(result.evidence).toHaveLength(1);

    const validation = validateEvidence(result.evidence[0], snapshot);
    expect(validation.status).toBe("validated");
  });

  it("passes when #[private] or #[near_sdk::private] protects the callback", () => {
    const snapshot = createSnapshotFromEntries([
      {
        path: "src/lib.rs",
        content: [
          "#[near_bindgen]",
          "impl Contract {",
          "    #[private]",
          "    pub fn on_a(#[callback_result] res: Result<(), PromiseError>) {",
          "        self.a = true;",
          "    }",
          "    #[near_sdk::private]",
          "    pub fn on_b(#[near_sdk::callback_result] res: Result<(), PromiseError>) {",
          "        self.b = true;",
          "    }",
          "}",
        ].join("\n"),
      },
    ]);

    const result = runNearRustCallbackPrivateRule(snapshot);
    expect(result.deterministicAnalysis.status).toBe("passed");
    expect(result.deterministicAnalysis.findings).toHaveLength(0);
  });

  it("marks direct predecessor/current-account fail-closed manual guard as inconclusive", () => {
    const snapshot = createSnapshotFromEntries([
      {
        path: "src/lib.rs",
        content: [
          "#[near]",
          "impl Contract {",
          "    pub fn on_done(#[callback_result] res: Result<(), PromiseError>) {",
          '        if env::predecessor_account_id() != env::current_account_id() { env::panic_str("unauthorized"); }',
          "        self.done = true;",
          "    }",
          "}",
        ].join("\n"),
      },
    ]);

    const result = runNearRustCallbackPrivateRule(snapshot);
    expect(result.deterministicAnalysis.status).toBe("inconclusive");
    expect(result.deterministicAnalysis.findings).toHaveLength(0);
  });

  it("reports inconclusive on Rust syntax errors without emitting findings from the broken file", () => {
    const snapshot = createSnapshotFromEntries([
      {
        path: "src/broken.rs",
        content: "#[near] impl Contract { pub fn broken( {",
      },
    ]);

    const result = runNearRustCallbackPrivateRule(snapshot);
    expect(result.deterministicAnalysis.status).toBe("inconclusive");
    expect(result.deterministicAnalysis.findings).toHaveLength(0);
    expect(result.limitations.some((l) => /syntax error/i.test(l))).toBe(true);
  });
});
