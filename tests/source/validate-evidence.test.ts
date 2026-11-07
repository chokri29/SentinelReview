import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceManifest } from "../../src/contracts/v1.js";
import type { SourceLoadResult } from "../../src/source/load-source.js";
import { loadSource } from "../../src/source/load-source.js";
import { validateEvidence } from "../../src/source/validate-evidence.js";

const EXCERPT_HASH_DOMAIN = "SentinelReview:evidence-excerpt:v1\0";

describe("validateEvidence", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "validate-evidence-"),
    );
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function loadSnapshot(
    files: readonly (readonly [string, string | Uint8Array])[],
  ): Promise<SourceLoadResult> {
    const sourceDirectory = path.join(temporaryDirectory, "source");
    await mkdir(sourceDirectory, { recursive: true });

    for (const [relativePath, content] of files) {
      const filePath = path.join(sourceDirectory, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }

    return loadSource(sourceDirectory);
  }

  function makeEvidence(
    snapshot: SourceLoadResult,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      evidenceId: "evidence-1",
      sourceHash: snapshot.manifest.sourceHash,
      path: snapshot.manifest.files[0]?.path ?? "lib.rs",
      startLine: 1,
      endLine: 1,
      producer: "ai_hypothesis",
      validationStatus: "invalid",
      ...overrides,
    };
  }

  function expectedExcerptHash(lines: readonly string[]): string {
    return createHash("sha256")
      .update(EXCERPT_HASH_DOMAIN, "utf8")
      .update(lines.join("\n"), "utf8")
      .digest("hex");
  }

  function expectedManifestHashes(
    schemaVersion: SourceManifest["schemaVersion"],
    files: readonly SourceManifest["files"][number][],
  ): { fileManifestHash: string; sourceHash: string } {
    const serializedFiles = files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      byteLength: file.byteLength,
      lineCount: file.lineCount,
    }));
    const fileManifestHash = createHash("sha256")
      .update("SentinelReview:file-manifest:v1\0", "utf8")
      .update(JSON.stringify(serializedFiles), "utf8")
      .digest("hex");
    const sourceHash = createHash("sha256")
      .update("SentinelReview:source:v1\0", "utf8")
      .update(
        JSON.stringify({ schemaVersion, fileManifestHash }),
        "utf8",
      )
      .digest("hex");

    return { fileManifestHash, sourceHash };
  }

  function cloneWithManifest(
    snapshot: SourceLoadResult,
    mutate: (manifest: SourceLoadResult["manifest"]) => void,
  ): SourceLoadResult {
    const copy = structuredClone(snapshot);
    mutate(copy.manifest);
    return copy;
  }

  function setManifestFiles(
    snapshot: SourceLoadResult,
    files: readonly SourceManifest["files"][number][],
    rehash = false,
  ): SourceLoadResult {
    return cloneWithManifest(snapshot, (manifest) => {
      Reflect.set(manifest, "files", files);
      if (rehash) {
        const hashes = expectedManifestHashes(manifest.schemaVersion, files);
        Reflect.set(manifest, "fileManifestHash", hashes.fileManifestHash);
        Reflect.set(manifest, "sourceHash", hashes.sourceHash);
      }
    });
  }

  it("validates evidence when its excerpt hash matches", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first\nsecond"]]);
    const result = validateEvidence(
      makeEvidence(snapshot, {
        excerptHash: expectedExcerptHash(["first"]),
      }),
      snapshot,
    );

    expect(result.status).toBe("validated");
    expect(result.checks.excerptHash).toBe("passed");
    expect(result.issues).toEqual([]);
  });

  it("returns partial when the optional excerpt hash is absent", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first\nsecond"]]);
    const result = validateEvidence(makeEvidence(snapshot), snapshot);

    expect(result.status).toBe("partial");
    expect(result.checks.lineRange).toBe("passed");
    expect(result.checks.excerptHash).toBe("not_applicable");
  });

  it("does not trust the incoming validation status", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first"]]);
    const falselyValidated = validateEvidence(
      makeEvidence(snapshot, {
        validationStatus: "validated",
        sourceHash: "0".repeat(64),
      }),
      snapshot,
    );
    const validButMarkedInvalid = validateEvidence(
      makeEvidence(snapshot, {
        validationStatus: "invalid",
        excerptHash: expectedExcerptHash(["first"]),
      }),
      snapshot,
    );

    expect(falselyValidated.status).toBe("invalid");
    expect(falselyValidated.issues[0]?.code).toBe("source_hash_mismatch");
    expect(validButMarkedInvalid.status).toBe("validated");
  });

  it("parses evidence before checking snapshot availability", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first"]]);
    const malformed = validateEvidence({ evidenceId: "missing-fields" }, undefined);
    const validWithoutSnapshot = validateEvidence(
      makeEvidence(snapshot),
      undefined,
    );

    expect(malformed.status).toBe("invalid");
    expect(malformed.issues[0]?.code).toBe("malformed_evidence");
    expect(validWithoutSnapshot.status).toBe("unavailable");
    expect(validWithoutSnapshot.issues[0]?.code).toBe("snapshot_unavailable");
  });

  it("rejects evidence with a mismatched source hash", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first"]]);
    const result = validateEvidence(
      makeEvidence(snapshot, { sourceHash: "0".repeat(64) }),
      snapshot,
    );

    expect(result.status).toBe("invalid");
    expect(result.issues[0]?.code).toBe("source_hash_mismatch");
  });

  it.each([
    ["../lib.rs", "traversal"],
    ["/lib.rs", "absolute"],
    ["C:/lib.rs", "drive-prefixed"],
    ["C:lib.rs", "drive-relative"],
    ["src\\lib.rs", "backslash"],
    ["src//lib.rs", "empty path segment"],
    ["./lib.rs", "dot segment"],
    ["src/../lib.rs", "parent segment"],
    ["lib\0.rs", "NUL"],
    ["src/", "trailing separator"],
  ])("rejects %s evidence paths (%s)", async (evidencePath) => {
    const snapshot = await loadSnapshot([["lib.rs", "first"]]);
    const result = validateEvidence(
      makeEvidence(snapshot, { path: evidencePath }),
      snapshot,
    );

    expect(result.status).toBe("invalid");
    expect(result.issues.some((issue) => issue.code === "invalid_evidence_path"))
      .toBe(true);
  });

  it("rejects a canonical evidence path that does not exist", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first"]]);
    const result = validateEvidence(
      makeEvidence(snapshot, { path: "missing.rs" }),
      snapshot,
    );

    expect(result.status).toBe("invalid");
    expect(result.issues.some((issue) => issue.code === "evidence_file_not_found"))
      .toBe(true);
  });

  it("rejects noncanonical manifest paths", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first"]]);
    const entry = snapshot.manifest.files[0]!;
    const result = validateEvidence(
      makeEvidence(snapshot),
      setManifestFiles(snapshot, [{ ...entry, path: "../lib.rs" }]),
    );

    expect(result.status).toBe("invalid");
    expect(result.issues.some(
      (issue) => issue.code === "noncanonical_manifest_path",
    )).toBe(true);
  });

  it("rejects unsorted manifest entries before hashing them", async () => {
    const snapshot = await loadSnapshot([
      ["a.rs", "a"],
      ["b.rs", "b"],
    ]);
    const result = validateEvidence(
      makeEvidence(snapshot),
      setManifestFiles(snapshot, [...snapshot.manifest.files].reverse()),
    );

    expect(result.status).toBe("invalid");
    expect(result.issues.some(
      (issue) => issue.code === "unsorted_manifest_entries",
    )).toBe(true);
    expect(result.checks.manifestHashes).toBe("not_applicable");
  });

  it("rejects duplicate manifest entries", async () => {
    const snapshot = await loadSnapshot([
      ["a.rs", "a"],
      ["b.rs", "b"],
    ]);
    const first = snapshot.manifest.files[0]!;
    const result = validateEvidence(
      makeEvidence(snapshot),
      setManifestFiles(snapshot, [first, { ...first }]),
    );

    expect(result.status).toBe("invalid");
    expect(result.issues.some(
      (issue) => issue.code === "duplicate_manifest_path",
    )).toBe(true);
  });

  it("rejects duplicate snapshot file paths", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first"]]);
    const copy = structuredClone(snapshot);
    Reflect.set(copy, "files", [...snapshot.files, snapshot.files[0]]);
    const result = validateEvidence(makeEvidence(snapshot), copy);

    expect(result.status).toBe("invalid");
    expect(result.issues.some(
      (issue) => issue.code === "duplicate_snapshot_path",
    )).toBe(true);
  });

  it("rejects a snapshot file list that differs from its manifest", async () => {
    const snapshot = await loadSnapshot([
      ["a.rs", "a"],
      ["b.rs", "b"],
    ]);
    const copy = structuredClone(snapshot);
    Reflect.set(copy, "files", [snapshot.files[0]]);
    const result = validateEvidence(makeEvidence(snapshot), copy);

    expect(result.status).toBe("invalid");
    expect(result.issues.some(
      (issue) => issue.code === "snapshot_manifest_file_mismatch",
    )).toBe(true);
  });

  it("rejects inconsistent aggregate manifest hashes", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first"]]);
    const badFileManifestHash = cloneWithManifest(snapshot, (manifest) => {
      Reflect.set(manifest, "fileManifestHash", "0".repeat(64));
    });
    const badSourceHash = cloneWithManifest(snapshot, (manifest) => {
      Reflect.set(manifest, "sourceHash", "0".repeat(64));
    });

    const fileManifestResult = validateEvidence(
      makeEvidence(snapshot),
      badFileManifestHash,
    );
    const sourceManifestResult = validateEvidence(
      makeEvidence(snapshot),
      badSourceHash,
    );

    expect(fileManifestResult.status).toBe("invalid");
    expect(fileManifestResult.issues.some(
      (issue) => issue.code === "manifest_file_hash_mismatch",
    )).toBe(true);
    expect(sourceManifestResult.status).toBe("invalid");
    expect(sourceManifestResult.issues.some(
      (issue) => issue.code === "manifest_source_hash_mismatch",
    )).toBe(true);
  });

  it("rejects changed file content", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first"]]);
    const copy = structuredClone(snapshot);
    Reflect.set(copy.files[0]!, "content", "other");
    const result = validateEvidence(makeEvidence(snapshot), copy);

    expect(result.status).toBe("invalid");
    expect(result.issues.some((issue) => issue.code === "file_hash_mismatch"))
      .toBe(true);
  });

  it("rejects file byte-length mismatches even with consistent aggregate hashes", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first"]]);
    const entry = snapshot.manifest.files[0]!;
    const alteredFiles = [{ ...entry, byteLength: entry.byteLength + 1 }];
    const copy = setManifestFiles(snapshot, alteredFiles, true);
    const result = validateEvidence(makeEvidence(snapshot), copy);

    expect(result.status).toBe("invalid");
    expect(result.issues.some(
      (issue) => issue.code === "file_byte_length_mismatch",
    )).toBe(true);
  });

  it("rejects snapshot file line-count mismatches", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first\nsecond"]]);
    const copy = structuredClone(snapshot);
    Reflect.set(copy.files[0]!, "lineCount", 1);
    const result = validateEvidence(makeEvidence(snapshot), copy);

    expect(result.status).toBe("invalid");
    expect(result.issues.some(
      (issue) => issue.code === "file_line_count_mismatch",
    )).toBe(true);
  });

  it("rejects manifest line-count mismatches with consistent aggregate hashes", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first\nsecond"]]);
    const entry = snapshot.manifest.files[0]!;
    const alteredFiles = [{ ...entry, lineCount: 1 }];
    const copy = setManifestFiles(snapshot, alteredFiles, true);
    const result = validateEvidence(makeEvidence(snapshot), copy);

    expect(result.status).toBe("invalid");
    expect(result.issues.some(
      (issue) => issue.code === "file_line_count_mismatch",
    )).toBe(true);
  });

  it("validates first, last, and empty physical lines", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first\n\nlast"]]);
    const first = validateEvidence(
      makeEvidence(snapshot, {
        startLine: 1,
        endLine: 1,
        excerptHash: expectedExcerptHash(["first"]),
      }),
      snapshot,
    );
    const empty = validateEvidence(
      makeEvidence(snapshot, {
        startLine: 2,
        endLine: 2,
        excerptHash: expectedExcerptHash([""]),
      }),
      snapshot,
    );
    const last = validateEvidence(
      makeEvidence(snapshot, {
        startLine: 3,
        endLine: 3,
        excerptHash: expectedExcerptHash(["last"]),
      }),
      snapshot,
    );

    expect(first.status).toBe("validated");
    expect(empty.status).toBe("validated");
    expect(last.status).toBe("validated");
  });

  it("rejects out-of-range lines and ranges into an empty file", async () => {
    const snapshot = await loadSnapshot([
      ["lib.rs", "first"],
      ["empty.rs", ""],
    ]);
    const outOfRange = validateEvidence(
      makeEvidence(snapshot, {
        path: "lib.rs",
        startLine: 2,
        endLine: 2,
      }),
      snapshot,
    );
    const emptyRange = validateEvidence(
      makeEvidence(snapshot, {
        path: "empty.rs",
        startLine: 1,
        endLine: 1,
      }),
      snapshot,
    );

    expect(outOfRange.status).toBe("invalid");
    expect(outOfRange.issues.some(
      (issue) => issue.code === "line_range_out_of_bounds",
    )).toBe(true);
    expect(emptyRange.status).toBe("invalid");
    expect(emptyRange.issues.some(
      (issue) => issue.code === "line_range_out_of_bounds",
    )).toBe(true);
  });

  it.each([
    ["LF", "first\nsecond\nthird", 3],
    ["CRLF", "first\r\nsecond\r\n", 2],
    ["CR", "first\rsecond\r", 2],
    ["no final newline", "first\nlast", 2],
  ])("counts %s physical lines for evidence", async (_name, content, lastLine) => {
    const snapshot = await loadSnapshot([["lib.rs", content]]);
    const result = validateEvidence(
      makeEvidence(snapshot, {
        startLine: lastLine,
        endLine: lastLine,
      }),
      snapshot,
    );

    expect(result.status).toBe("partial");
    expect(result.checks.lineRange).toBe("passed");
  });

  it("hashes selected lines after newline normalization without a final newline", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first\r\nsecond\r"]]);
    const result = validateEvidence(
      makeEvidence(snapshot, {
        startLine: 1,
        endLine: 2,
        excerptHash: expectedExcerptHash(["first", "second"]),
      }),
      snapshot,
    );

    expect(result.status).toBe("validated");
  });

  it("preserves Unicode and a UTF-8 BOM in excerpt hashing", async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("café 🌙\nnext", "utf8"),
    ]);
    const snapshot = await loadSnapshot([["lib.rs", bytes]]);
    const result = validateEvidence(
      makeEvidence(snapshot, {
        excerptHash: expectedExcerptHash(["\uFEFFcafé 🌙"]),
      }),
      snapshot,
    );

    expect(snapshot.files[0]?.content).toBe("\uFEFFcafé 🌙\nnext");
    expect(result.status).toBe("validated");
  });

  it("rejects a mismatched excerpt hash", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first"]]);
    const result = validateEvidence(
      makeEvidence(snapshot, { excerptHash: "0".repeat(64) }),
      snapshot,
    );

    expect(result.status).toBe("invalid");
    expect(result.checks.excerptHash).toBe("failed");
    expect(result.issues[0]?.code).toBe("excerpt_hash_mismatch");
  });

  it("does not mutate evidence or the snapshot", async () => {
    const snapshot = await loadSnapshot([["lib.rs", "first\nsecond"]]);
    const evidence = makeEvidence(snapshot, {
      excerptHash: expectedExcerptHash(["first"]),
    });
    const snapshotBefore = structuredClone(snapshot);
    const evidenceBefore = structuredClone(evidence);

    const result = validateEvidence(evidence, snapshot);

    expect(result.status).toBe("validated");
    expect(snapshot).toEqual(snapshotBefore);
    expect(evidence).toEqual(evidenceBefore);
  });
});
