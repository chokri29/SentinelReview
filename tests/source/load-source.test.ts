import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceManifestSchema } from "../../src/contracts/v1.js";
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
    content: string | Uint8Array,
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

  it("uses a default global entry limit of 2000", async () => {
    const sourceDirectory = await createSourceDirectory();
    for (let index = 0; index < 2000; index += 1) {
      await writeSourceFile(sourceDirectory, `entry-${index}.txt`, "");
    }

    const result = await loadSource(sourceDirectory);

    expect(result.files).toEqual([]);
    await writeSourceFile(sourceDirectory, "entry-2000.txt", "");
    await expect(loadSource(sourceDirectory)).rejects.toThrow(
      "Source entry-count limit exceeded",
    );
  });

  it("uses a default maximum directory depth of 32", async () => {
    const sourceDirectory = await createSourceDirectory();
    let deepestDirectory = sourceDirectory;
    for (let depth = 1; depth <= 32; depth += 1) {
      deepestDirectory = path.join(deepestDirectory, `level-${depth}`);
      await mkdir(deepestDirectory);
    }
    await writeFile(path.join(deepestDirectory, "lib.rs"), "");

    const result = await loadSource(sourceDirectory);

    expect(result.files.map((file) => file.path)).toHaveLength(1);
    const overDepthDirectory = path.join(deepestDirectory, "level-33");
    await mkdir(overDepthDirectory);
    await expect(loadSource(sourceDirectory)).rejects.toThrow(
      "Source directory-depth limit exceeded",
    );
  });

  it("counts non-Rust files against the global entry budget", async () => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "a.txt", "ignored");
    await writeSourceFile(sourceDirectory, "b.rs", "");

    await expect(
      loadSource(sourceDirectory, { maxEntries: 1 }),
    ).rejects.toThrow("Source entry-count limit exceeded");
  });

  it("counts directories against the global entry budget", async () => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "nested/lib.rs", "");

    await expect(
      loadSource(sourceDirectory, { maxEntries: 1 }),
    ).rejects.toThrow("Source entry-count limit exceeded");
  });

  it("rejects as soon as the global entry budget is exceeded", async () => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "a.rs", "");
    await writeSourceFile(sourceDirectory, "b.rs", "");

    await expect(
      loadSource(sourceDirectory, { maxEntries: 1, maxFiles: 1 }),
    ).rejects.toThrow("Source entry-count limit exceeded");
  });

  it("does not return a partial snapshot after a nested entry-limit violation", async () => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "a.rs", "already read");
    await writeSourceFile(sourceDirectory, "nested/b.rs", "");
    await writeSourceFile(sourceDirectory, "nested/c.rs", "");

    await expect(
      loadSource(sourceDirectory, { maxEntries: 3 }),
    ).rejects.toThrow("Source entry-count limit exceeded");
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
        lineCount: 2,
      },
    ]);
    expect(result.totalBytes).toBe(23);
  });

  it("reads files across multiple bounded chunks without changing their bytes", async () => {
    const sourceDirectory = await createSourceDirectory();
    const bytes = Buffer.alloc(64 * 1024 + 17, 0x61);
    await writeSourceFile(sourceDirectory, "large.rs", bytes);
    const handle = await open(path.join(sourceDirectory, "large.rs"), "r");
    const fileHandlePrototype = Object.getPrototypeOf(handle);
    await handle.close();
    const readSpy = vi.spyOn(fileHandlePrototype, "read");

    try {
      const result = await loadSource(sourceDirectory, {
        maxFileBytes: bytes.byteLength,
        maxTotalBytes: bytes.byteLength,
      });

      expect(result.files[0]?.byteLength).toBe(bytes.byteLength);
      expect(result.files[0]?.content).toBe(bytes.toString("utf8"));
      expect(result.manifest.files[0]?.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(readSpy).toHaveBeenCalled();
      const requestedBytes = readSpy.mock.calls.reduce(
        (total, call) => total + (typeof call[2] === "number" ? call[2] : 0),
        0,
      );
      expect(requestedBytes).toBe(bytes.byteLength + 1);
      const readLengths = readSpy.mock.calls.map((call) =>
        typeof call[2] === "number" ? call[2] : 0,
      );
      expect(readLengths.slice(0, -1).every((length) => length <= 64 * 1024)).toBe(true);
      expect(readLengths.at(-1)).toBe(1);
    } finally {
      readSpy.mockRestore();
    }
  });

  it.each([
    ["empty", "", 0],
    ["terminated", "first\nsecond\n", 2],
    ["unterminated", "first\nsecond", 2],
    ["blank", "\n", 1],
    ["LF", "one\ntwo\nthree", 3],
    ["CRLF", "one\r\ntwo\r\n", 2],
    ["lone CR", "one\rtwo\rthree", 3],
  ])("counts physical lines for %s content", async (_name, content, expected) => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "lines.rs", content);

    const result = await loadSource(sourceDirectory);

    expect(result.files[0]?.lineCount).toBe(expected);
  });

  it("hashes the exact original bytes and reports their byte length", async () => {
    const sourceDirectory = await createSourceDirectory();
    const bytes = Buffer.from([0x66, 0x6e, 0x20, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0x0a]);
    await writeSourceFile(sourceDirectory, "lib.rs", bytes);

    const result = await loadSource(sourceDirectory);

    expect(result.files[0]).toMatchObject({
      content: "fn café\n",
      byteLength: bytes.byteLength,
    });
    expect(result.manifest.files[0]?.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(result.manifest.files[0]?.byteLength).toBe(bytes.byteLength);
    const expectedFileEntry = {
      path: "lib.rs",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      lineCount: 1,
    };
    const expectedFileManifestHash = createHash("sha256")
      .update("SentinelReview:file-manifest:v1\0", "utf8")
      .update(JSON.stringify([expectedFileEntry]), "utf8")
      .digest("hex");
    const expectedSourceHash = createHash("sha256")
      .update("SentinelReview:source:v1\0", "utf8")
      .update(
        JSON.stringify({
          schemaVersion: "1.0.0",
          fileManifestHash: expectedFileManifestHash,
        }),
        "utf8",
      )
      .digest("hex");

    expect(result.manifest.files[0]).toEqual(expectedFileEntry);
    expect(result.manifest.fileManifestHash).toBe(expectedFileManifestHash);
    expect(result.manifest.sourceHash).toBe(expectedSourceHash);
  });

  it("preserves an initial UTF-8 BOM and hashes the original bytes", async () => {
    const sourceDirectory = await createSourceDirectory();
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("fn café() {}\n", "utf8"),
    ]);
    await writeSourceFile(sourceDirectory, "lib.rs", bytes);

    const result = await loadSource(sourceDirectory);
    const file = result.files[0];
    const manifestFile = result.manifest.files[0];

    expect(file?.content).toBe("\uFEFFfn café() {}\n");
    expect(Buffer.from(file!.content, "utf8").equals(bytes)).toBe(true);
    expect(manifestFile?.byteLength).toBe(bytes.byteLength);
    expect(manifestFile?.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });

  it("produces the same manifest hashes regardless of file creation order", async () => {
    const firstDirectory = path.join(temporaryDirectory, "first");
    const secondDirectory = path.join(temporaryDirectory, "second");
    await mkdir(firstDirectory);
    await mkdir(secondDirectory);

    for (const [sourceDirectory, fileNames] of [
      [firstDirectory, ["z.rs", "nested/b.rs", "A.rs", "a.rs"]],
      [secondDirectory, ["a.rs", "A.rs", "nested/b.rs", "z.rs"]],
    ] as const) {
      for (const fileName of fileNames) {
        await writeSourceFile(sourceDirectory, fileName, `${fileName}\n`);
      }
    }

    const first = await loadSource(firstDirectory);
    const second = await loadSource(secondDirectory);

    expect(first.manifest).toEqual(second.manifest);
    expect(first.manifest.files.map((file) => file.path)).toEqual([
      "A.rs",
      "a.rs",
      "nested/b.rs",
      "z.rs",
    ]);

    const expectedEntries = ["A.rs", "a.rs", "nested/b.rs", "z.rs"].map(
      (fileName) => {
        const content = `${fileName}\n`;
        const bytes = Buffer.from(content, "utf8");

        return {
          path: fileName,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.byteLength,
          lineCount: 1,
        };
      },
    );
    const expectedFileManifestHash = createHash("sha256")
      .update("SentinelReview:file-manifest:v1\0", "utf8")
      .update(JSON.stringify(expectedEntries), "utf8")
      .digest("hex");
    const expectedSourceHash = createHash("sha256")
      .update("SentinelReview:source:v1\0", "utf8")
      .update(
        JSON.stringify({
          schemaVersion: "1.0.0",
          fileManifestHash: expectedFileManifestHash,
        }),
        "utf8",
      )
      .digest("hex");

    expect(first.manifest.fileManifestHash).toBe(expectedFileManifestHash);
    expect(first.manifest.sourceHash).toBe(expectedSourceHash);
  });

  it("rejects source files containing invalid UTF-8", async () => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "invalid.rs", Buffer.from([0xc3, 0x28]));

    await expect(loadSource(sourceDirectory)).rejects.toThrow(
      "Source file is not valid UTF-8: invalid.rs",
    );
  });

  it("freezes the snapshot files and manifest at runtime", async () => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "lib.rs", "fn main() {}\n");

    const result = await loadSource(sourceDirectory);
    const file = result.files[0];
    const manifestFile = result.manifest.files[0];

    expect(file).toBeDefined();
    expect(manifestFile).toBeDefined();
    expect(Object.isFrozen(result.files)).toBe(true);
    expect(Object.isFrozen(file)).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.manifest.files)).toBe(true);
    expect(Object.isFrozen(manifestFile)).toBe(true);
    expect(() => Reflect.apply(Array.prototype.push, result.files, [file])).toThrow();
    expect(Reflect.set(file!, "path", "changed.rs")).toBe(false);
    expect(Reflect.set(manifestFile!, "path", "changed.rs")).toBe(false);
    expect(file?.path).toBe("lib.rs");
    expect(manifestFile?.path).toBe("lib.rs");
  });

  it("validates the generated manifest with the shared contract schema", async () => {
    const sourceDirectory = await createSourceDirectory();
    await writeSourceFile(sourceDirectory, "lib.rs", "fn main() {}\n");

    const result = await loadSource(sourceDirectory);

    expect(SourceManifestSchema.safeParse(result.manifest).success).toBe(true);
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
