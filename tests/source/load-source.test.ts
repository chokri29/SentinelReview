import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadSource } from "../../src/source/load-source.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sentinelreview-load-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("loadSource", () => {
  it("loads the bundled callback-unguarded fixture as a deeply frozen snapshot", async () => {
    const fixtureDir = fileURLToPath(
      new URL("../../demo-fixtures/callback-unguarded/", import.meta.url),
    );
    const snapshot = await loadSource(fixtureDir);

    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]?.path).toBe("lib.rs");
    expect(snapshot.files[0]?.lineCount).toBe(6);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.files)).toBe(true);
    expect(Object.isFrozen(snapshot.files[0])).toBe(true);
    expect(Object.isFrozen(snapshot.manifest)).toBe(true);
    expect(Object.isFrozen(snapshot.manifest.files)).toBe(true);
    expect(Object.isFrozen(snapshot.manifest.files[0])).toBe(true);
  });

  it("ignores non-.rs files, sorts canonically, and counts physical lines consistently", async () => {
    const dir = await makeTempDir();
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "README.md"), "# ignore me\n");
    await writeFile(path.join(dir, "sub", "b.rs"), "fn b() {}\r\nfn c() {}");
    await writeFile(path.join(dir, "a.rs"), "");

    const snapshot = await loadSource(dir);
    expect(snapshot.files.map((f) => f.path)).toEqual(["a.rs", "sub/b.rs"]);
    expect(snapshot.files[0]?.lineCount).toBe(0);
    expect(snapshot.files[0]?.byteLength).toBe(0);
    expect(snapshot.files[1]?.lineCount).toBe(2);
  });

  it("rejects symbolic links and invalid UTF-8 files", async () => {
    const dirWithLink = await makeTempDir();
    await writeFile(path.join(dirWithLink, "real.rs"), "fn main() {}\n");
    await symlink(
      path.join(dirWithLink, "real.rs"),
      path.join(dirWithLink, "link.rs"),
    );

    await expect(loadSource(dirWithLink)).rejects.toThrow(/Symbolic links/i);

    const dirWithBadUtf8 = await makeTempDir();
    await writeFile(
      path.join(dirWithBadUtf8, "bad.rs"),
      Buffer.from([0xff, 0xfe, 0xfd]),
    );
    await expect(loadSource(dirWithBadUtf8)).rejects.toThrow(/UTF-8/i);
  });

  it("enforces file-count, per-file, total-size, and depth limits", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "a.rs"), "fn a() {}\n");
    await writeFile(path.join(dir, "b.rs"), "fn b() {}\n");

    await expect(loadSource(dir, { maxFiles: 1 })).rejects.toThrow(
      /file-count limit/i,
    );
    await expect(loadSource(dir, { maxFileBytes: 4 })).rejects.toThrow(
      /too large/i,
    );
    await expect(loadSource(dir, { maxTotalBytes: 12 })).rejects.toThrow(
      /Total source-size limit/i,
    );

    const deepDir = await makeTempDir();
    await mkdir(path.join(deepDir, "a", "b"), { recursive: true });
    await expect(loadSource(deepDir, { maxDepth: 1 })).rejects.toThrow(
      /depth limit/i,
    );
  });
});
