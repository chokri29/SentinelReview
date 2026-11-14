import { describe, expect, it } from "vitest";
import { schemaVersion } from "../../src/contracts/v1.js";
import { calculateManifestHashes } from "../../src/source/manifest-hash.js";

describe("calculateManifestHashes", () => {
  const baseEntry = {
    path: "src/lib.rs",
    sha256: "a".repeat(64),
    byteLength: 100,
    lineCount: 10,
  };

  it("produces deterministic 64-char hex hashes for identical inputs", () => {
    const first = calculateManifestHashes(schemaVersion, [baseEntry]);
    const second = calculateManifestHashes(schemaVersion, [baseEntry]);

    expect(first.fileManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.fileManifestHash).toBe(second.fileManifestHash);
    expect(first.sourceHash).toBe(second.sourceHash);
    expect(first.fileManifestHash).not.toBe(first.sourceHash);
  });

  it("changes hashes when path, sha256, byteLength, lineCount, or order changes", () => {
    const baseline = calculateManifestHashes(schemaVersion, [
      baseEntry,
      { ...baseEntry, path: "src/mod.rs" },
    ]);

    const changedPath = calculateManifestHashes(schemaVersion, [
      { ...baseEntry, path: "lib.rs" },
      { ...baseEntry, path: "src/mod.rs" },
    ]);
    const changedContentHash = calculateManifestHashes(schemaVersion, [
      { ...baseEntry, sha256: "b".repeat(64) },
      { ...baseEntry, path: "src/mod.rs" },
    ]);
    const changedLength = calculateManifestHashes(schemaVersion, [
      { ...baseEntry, byteLength: 101 },
      { ...baseEntry, path: "src/mod.rs" },
    ]);
    const changedLines = calculateManifestHashes(schemaVersion, [
      { ...baseEntry, lineCount: 11 },
      { ...baseEntry, path: "src/mod.rs" },
    ]);
    const reordered = calculateManifestHashes(schemaVersion, [
      { ...baseEntry, path: "src/mod.rs" },
      baseEntry,
    ]);

    for (const variant of [
      changedPath,
      changedContentHash,
      changedLength,
      changedLines,
      reordered,
    ]) {
      expect(variant.fileManifestHash).not.toBe(baseline.fileManifestHash);
      expect(variant.sourceHash).not.toBe(baseline.sourceHash);
    }
  });
});
