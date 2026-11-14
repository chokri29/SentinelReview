import { describe, expect, it } from "vitest";
import { createSnapshotFromEntries } from "../../src/source/custom-snapshot.js";
import { validateEvidence } from "../../src/source/validate-evidence.js";
import { runNearRustCallbackPrivateRule } from "../../src/rules/near-rust-callback-private.js";

describe("validateEvidence", () => {
  const sampleCode = [
    "#[near]",
    "impl Contract {",
    "    pub fn on_cb(#[callback_result] r: Result<(), PromiseError>) {",
    "        self.ok = true;",
    "    }",
    "}",
  ].join("\n");

  it("returns validated for matching snapshot and excerpt hash, partial without excerptHash, and unavailable without snapshot", () => {
    const snapshot = createSnapshotFromEntries([
      { path: "src/lib.rs", content: sampleCode },
    ]);
    const ruleResult = runNearRustCallbackPrivateRule(snapshot);
    const ev = ruleResult.evidence[0]!;

    expect(validateEvidence(ev, snapshot).status).toBe("validated");
    expect(validateEvidence(ev, undefined).status).toBe("unavailable");

    const { excerptHash: _omitted, ...withoutExcerpt } = ev;
    expect(validateEvidence(withoutExcerpt, snapshot).status).toBe("partial");
  });

  it("rejects tampered sourceHash, excerptHash, out-of-bounds lines, missing files, and tampered manifests", () => {
    const snapshot = createSnapshotFromEntries([
      { path: "src/lib.rs", content: sampleCode },
    ]);
    const ev = runNearRustCallbackPrivateRule(snapshot).evidence[0]!;

    const wrongSourceHash = validateEvidence(
      { ...ev, sourceHash: "0".repeat(64) },
      snapshot,
    );
    expect(wrongSourceHash.status).toBe("invalid");
    expect(wrongSourceHash.issues.some((i) => i.code === "source_hash_mismatch")).toBe(true);

    const wrongExcerpt = validateEvidence(
      { ...ev, excerptHash: "f".repeat(64) },
      snapshot,
    );
    expect(wrongExcerpt.status).toBe("invalid");
    expect(wrongExcerpt.issues.some((i) => i.code === "excerpt_hash_mismatch")).toBe(true);

    const outOfBounds = validateEvidence(
      { ...ev, endLine: 999 },
      snapshot,
    );
    expect(outOfBounds.status).toBe("invalid");
    expect(outOfBounds.issues.some((i) => i.code === "line_range_out_of_bounds")).toBe(true);

    const missingFile = validateEvidence(
      { ...ev, path: "src/missing.rs" },
      snapshot,
    );
    expect(missingFile.status).toBe("invalid");
    expect(missingFile.issues.some((i) => i.code === "evidence_file_not_found")).toBe(true);

    const tamperedSnapshot = {
      ...snapshot,
      manifest: {
        ...snapshot.manifest,
        sourceHash: "0".repeat(64),
      },
    };
    const tamperedResult = validateEvidence(ev, tamperedSnapshot);
    expect(tamperedResult.status).toBe("invalid");
    expect(
      tamperedResult.issues.some((i) => i.code === "manifest_source_hash_mismatch"),
    ).toBe(true);
  });

  it("validates excerptHash consistently across CRLF and isolated CR line terminators", () => {
    for (const eol of ["\r\n", "\r"] as const) {
      const code = [
        "#[near]",
        "impl Contract {",
        "    pub fn on_cb(#[callback_result] r: Result<(), PromiseError>) {}",
        "}",
      ].join(eol);
      const snapshot = createSnapshotFromEntries([{ path: "src/lib.rs", content: code }]);
      const ev = runNearRustCallbackPrivateRule(snapshot).evidence[0]!;
      expect(validateEvidence(ev, snapshot).status).toBe("validated");
    }
  });
});

