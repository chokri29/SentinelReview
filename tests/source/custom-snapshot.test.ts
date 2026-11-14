import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createSnapshotFromEntries,
  normalizeCanonicalRustPath,
} from "../../src/source/custom-snapshot.js";
import { loadSource } from "../../src/source/load-source.js";
import { validateEvidence } from "../../src/source/validate-evidence.js";
import { runNearRustCallbackPrivateRule } from "../../src/rules/near-rust-callback-private.js";
import { integrateEvidence } from "../../src/source/integrate-evidence.js";

describe("createSnapshotFromEntries (custom Rust paste and upload)", () => {
  it("produces identical hashes and deeply frozen snapshot to loadSource for equivalent content", async () => {
    const fixtureDir = fileURLToPath(
      new URL("../../demo-fixtures/callback-unguarded/", import.meta.url),
    );
    const diskSnapshot = await loadSource(fixtureDir);
    const fixtureContent = await readFile(`${fixtureDir}lib.rs`, "utf8");

    const customSnapshot = createSnapshotFromEntries([
      { path: "lib.rs", content: fixtureContent },
    ]);

    expect(customSnapshot.manifest.sourceHash).toBe(
      diskSnapshot.manifest.sourceHash,
    );
    expect(customSnapshot.manifest.fileManifestHash).toBe(
      diskSnapshot.manifest.fileManifestHash,
    );
    expect(customSnapshot.totalBytes).toBe(diskSnapshot.totalBytes);
    expect(Object.isFrozen(customSnapshot)).toBe(true);
    expect(Object.isFrozen(customSnapshot.files)).toBe(true);
    expect(Object.isFrozen(customSnapshot.files[0])).toBe(true);
    expect(Object.isFrozen(customSnapshot.manifest)).toBe(true);
    expect(Object.isFrozen(customSnapshot.manifest.files)).toBe(true);
    expect(Object.isFrozen(customSnapshot.manifest.files[0])).toBe(true);
  });

  it("supports multi-file .rs uploads, sorts canonically, and passes rule + evidence validation", () => {
    const snapshot = createSnapshotFromEntries([
      {
        path: "src/callbacks.rs",
        content:
          "#[near]\nimpl Contract {\n    pub fn on_cb(#[callback_result] r: Result<(), PromiseError>) {}\n}\n",
      },
      {
        path: "src/lib.rs",
        content: "mod callbacks;\n",
      },
    ]);

    expect(snapshot.files.map((f) => f.path)).toEqual([
      "src/callbacks.rs",
      "src/lib.rs",
    ]);

    const ruleResult = runNearRustCallbackPrivateRule(snapshot);
    expect(ruleResult.deterministicAnalysis.status).toBe("finding");
    expect(ruleResult.evidence).toHaveLength(1);

    const validation = validateEvidence(ruleResult.evidence[0], snapshot);
    expect(validation.status).toBe("validated");

    const integrated = integrateEvidence(
      ruleResult.evidence,
      ruleResult.deterministicAnalysis.findings,
      snapshot,
    );
    expect(integrated.status).toBe("complete");
  });

  it("handles 0-byte empty .rs files deterministically while rejecting empty entry arrays", () => {
    expect(() => createSnapshotFromEntries([])).toThrow(/at least one/i);

    const emptyFileSnapshot = createSnapshotFromEntries([
      { path: "empty.rs", content: "" },
    ]);
    expect(emptyFileSnapshot.files[0]?.byteLength).toBe(0);
    expect(emptyFileSnapshot.files[0]?.lineCount).toBe(0);
    const ruleResult = runNearRustCallbackPrivateRule(emptyFileSnapshot);
    expect(ruleResult.deterministicAnalysis.status).toBe("passed");
  });

  it("rejects non-.rs extensions and non-canonical or unsafe paths", () => {
    const badPaths = [
      "",
      " ",
      " lib.rs",
      "lib.rs ",
      "README.md",
      "Cargo.toml",
      ".rs",
      "src/.rs",
      "/etc/passwd.rs",
      "C:\\contract\\lib.rs",
      "src\\lib.rs",
      "../escape.rs",
      "./lib.rs",
      "src//lib.rs",
      "src/lib\0.rs",
    ];

    for (const badPath of badPaths) {
      expect(() => normalizeCanonicalRustPath(badPath)).toThrow();
      expect(() =>
        createSnapshotFromEntries([{ path: badPath, content: "fn a() {}" }]),
      ).toThrow();
    }
  });

  it("rejects duplicate canonical paths, null bytes in content, and lone UTF-16 surrogates", () => {
    expect(() =>
      createSnapshotFromEntries([
        { path: "src/lib.rs", content: "fn a() {}" },
        { path: "src/lib.rs", content: "fn b() {}" },
      ]),
    ).toThrow(/Duplicate/i);

    expect(() =>
      createSnapshotFromEntries([
        { path: "src/lib.rs", content: "fn a() {}\0" },
      ]),
    ).toThrow(/null bytes/i);

    expect(() =>
      createSnapshotFromEntries([
        { path: "src/lib.rs", content: "fn a() {} \uD800" },
      ]),
    ).toThrow(/reversible UTF-8/i);
  });

  it("enforces file-count, per-file byte, and aggregate byte limits using exact UTF-8 byte lengths", () => {
    expect(() =>
      createSnapshotFromEntries(
        [
          { path: "a.rs", content: "fn a() {}" },
          { path: "b.rs", content: "fn b() {}" },
        ],
        { maxFiles: 1 },
      ),
    ).toThrow(/file-count limit/i);

    // 4-byte emoji tests UTF-8 byte count rather than string.length
    expect(() =>
      createSnapshotFromEntries([{ path: "a.rs", content: "// 🚀" }], {
        maxFileBytes: 6,
      }),
    ).toThrow(/too large/i);

    expect(() =>
      createSnapshotFromEntries(
        [
          { path: "a.rs", content: "fn a() {}" },
          { path: "b.rs", content: "fn b() {}" },
        ],
        { maxTotalBytes: 10 },
      ),
    ).toThrow(/Total source-size limit/i);

    expect(() =>
      createSnapshotFromEntries([{ path: "a.rs", content: "fn a() {}" }], {
        maxFiles: 0,
      }),
    ).toThrow(/Invalid source limit/i);

    expect(() =>
      createSnapshotFromEntries([{ path: "a.rs", content: "fn a() {}" }], {
        maxFileBytes: -1,
      }),
    ).toThrow(/Invalid source limit/i);
  });

  it("preserves exact physical line counts and evidence correspondence across LF, CRLF, isolated CR, and UTF-8 BOM", async () => {
    const { splitPhysicalLines } = await import("../../src/lib/source-lines.js");

    const variants = [
      {
        name: "CRLF",
        content:
          "#[near]\r\nimpl Contract {\r\n    pub fn on_cb(#[callback_result] r: Result<(), PromiseError>) {}\r\n}\r\n",
      },
      {
        name: "isolated CR",
        content:
          "#[near]\rimpl Contract {\r    pub fn on_cb(#[callback_result] r: Result<(), PromiseError>) {}\r}\r",
      },
      {
        name: "UTF-8 BOM + LF without trailing newline",
        content:
          "\uFEFF#[near]\nimpl Contract {\n    pub fn on_cb(#[callback_result] r: Result<(), PromiseError>) {}\n}",
      },
    ];

    for (const variant of variants) {
      const snapshot = createSnapshotFromEntries([
        { path: "src/lib.rs", content: variant.content },
      ]);
      const lines = splitPhysicalLines(snapshot.files[0]!.content);
      expect(snapshot.files[0]!.lineCount, variant.name).toBe(lines.length);

      const ruleResult = runNearRustCallbackPrivateRule(snapshot);
      expect(ruleResult.deterministicAnalysis.status, variant.name).toBe("finding");
      expect(ruleResult.evidence, variant.name).toHaveLength(1);

      const validation = validateEvidence(ruleResult.evidence[0], snapshot);
      expect(validation.status, variant.name).toBe("validated");
    }
  });
});

