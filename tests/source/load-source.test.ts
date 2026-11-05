import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSource } from "../../src/source/load-source.js";

describe("loadSource", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "load-source-"));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function createSourceDirectory(): Promise<string> {
    const sourceDirectory = path.join(temporaryDirectory, "source");
    await mkdir(sourceDirectory, { recursive: true });
    return sourceDirectory;
  }

  async function writeSourceFile(
    sourceDirectory: string,
    relativePath: string,
    content: string,
  ): Promise<void> {
    const filePath = path.join(sourceDirectory, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  it("loads Rust files from a directory", async () => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "src/lib.rs", "pub fn answer() -> u8 { 42 }\n");
    await writeSourceFile(sourceDirectory, "main.rs", "fn main() {}\n");

    const result = await loadSource(sourceDirectory);

    expect(result.files.map((file) => file.path)).toEqual(["main.rs", "src/lib.rs"]);
  });

  it("ignores non-Rust files", async () => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "lib.rs", "fn main() {}\n");
    await writeSourceFile(sourceDirectory, "notes.txt", "not Rust");
    await writeSourceFile(sourceDirectory, "UPPER.RS", "not included");

    const result = await loadSource(sourceDirectory);

    expect(result.files.map((file) => file.path)).toEqual(["lib.rs"]);
  });

  it("returns files in deterministic sorted order", async () => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "z.rs", "");
    await writeSourceFile(sourceDirectory, "nested/b.rs", "");
    await writeSourceFile(sourceDirectory, "a.rs", "");

    const firstResult = await loadSource(sourceDirectory);
    const secondResult = await loadSource(sourceDirectory);

    expect(firstResult.files.map((file) => file.path)).toEqual([
      "a.rs",
      "nested/b.rs",
      "z.rs",
    ]);
    expect(secondResult.files.map((file) => file.path)).toEqual(
      firstResult.files.map((file) => file.path),
    );
  });

  it("reports correct byte lengths and line counts", async () => {
    const sourceDirectory = await createSourceDirectory();
    const content = "fn main() {}\r\n// café\n";
    await writeSourceFile(sourceDirectory, "lib.rs", content);

    const result = await loadSource(sourceDirectory);

    expect(result.files).toEqual([
      {
        path: "lib.rs",
        content,
        byteLength: 23,
        lineCount: 3,
      },
    ]);
    expect(result.totalBytes).toBe(23);
  });

  it("rejects a symbolic-link source root", async () => {
    const sourceDirectory = await createSourceDirectory();
    const linkedRoot = path.join(temporaryDirectory, "linked-source");
    await symlink(sourceDirectory, linkedRoot, "dir");

    await expect(loadSource(linkedRoot)).rejects.toThrow(
      "Source root must be a real directory",
    );
  });

  it("rejects symbolic links inside the source tree", async () => {
    const sourceDirectory = await createSourceDirectory();
    const targetFile = path.join(temporaryDirectory, "target.rs");
    await writeFile(targetFile, "fn linked() {}\n");
    await symlink(targetFile, path.join(sourceDirectory, "linked.rs"));

    await expect(loadSource(sourceDirectory)).rejects.toThrow(
      "Symbolic links are not allowed: linked.rs",
    );
  });

  it("enforces the maximum file count", async () => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "a.rs", "");
    await writeSourceFile(sourceDirectory, "b.rs", "");

    await expect(
      loadSource(sourceDirectory, {
        maxFiles: 1,
        maxFileBytes: 10,
        maxTotalBytes: 10,
      }),
    ).rejects.toThrow("Source file-count limit exceeded");
  });

  it("enforces the maximum individual file size", async () => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "large.rs", "four");

    await expect(
      loadSource(sourceDirectory, {
        maxFiles: 10,
        maxFileBytes: 3,
        maxTotalBytes: 10,
      }),
    ).rejects.toThrow("Source file too large: large.rs");
  });

  it("enforces the maximum total source size", async () => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "a.rs", "123");
    await writeSourceFile(sourceDirectory, "b.rs", "456");

    await expect(
      loadSource(sourceDirectory, {
        maxFiles: 10,
        maxFileBytes: 10,
        maxTotalBytes: 5,
      }),
    ).rejects.toThrow("Total source-size limit exceeded");
  });

  it("handles an empty source directory", async () => {
    const sourceDirectory = await createSourceDirectory();

    const result = await loadSource(sourceDirectory);

    expect(result.files).toEqual([]);
    expect(result.totalBytes).toBe(0);
  });
});
