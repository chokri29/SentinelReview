import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  schemaVersion,
  SourceManifestSchema,
  type SourceManifest,
} from "../contracts/v1.js";
import { calculateManifestHashes } from "./manifest-hash.js";

export interface SourceFile {
  readonly path: string;
  readonly content: string;
  readonly byteLength: number;
  readonly lineCount: number;
}

export interface SourceLoadOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** Maximum directory entries examined (files, directories, non-Rust). */
  maxEntries?: number;
  /** Maximum directory nesting depth from the source root (root = 0). */
  maxDepth?: number;
}

export type ImmutableSourceManifest = Readonly<
  Omit<SourceManifest, "files"> & {
    files: readonly Readonly<SourceManifest["files"][number]>[];
  }
>;

export interface SourceLoadResult {
  readonly root: string;
  readonly files: readonly Readonly<SourceFile>[];
  readonly totalBytes: number;
  readonly manifest: ImmutableSourceManifest;
}

const DEFAULT_LIMITS = {
  maxFiles: 200,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
  maxEntries: 2000,
  maxDepth: 32,
};

function countPhysicalLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  const terminators = content.match(/\r\n|\r|\n/g)?.length ?? 0;
  const endsWithTerminator = content.endsWith("\n") || content.endsWith("\r");
  return terminators + (endsWithTerminator ? 0 : 1);
}

function compareCanonicalPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasSameMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function loadSource(
  sourceDirectory: string,
  options: SourceLoadOptions = {},
): Promise<SourceLoadResult> {
  const limits = { ...DEFAULT_LIMITS, ...options };

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid source limit: ${name}`);
    }
  }

  const requestedRoot = path.resolve(sourceDirectory);
  const requestedRootStat = await lstat(requestedRoot);

  if (!requestedRootStat.isDirectory() || requestedRootStat.isSymbolicLink()) {
    throw new Error("Source root must be a real directory");
  }

  const root = await realpath(requestedRoot);
  const files: SourceFile[] = [];
  const manifestEntries: SourceManifest["files"][number][] = [];
  let totalBytes = 0;
  let entriesSeen = 0;

  async function readBoundedDirectoryEntries(
    directory: string,
  ): Promise<Dirent[]> {
    const directoryHandle = await opendir(directory);
    const collected: Dirent[] = [];

    try {
      for await (const entry of directoryHandle) {
        // Count immediately on encounter, before any per-entry filesystem work.
        entriesSeen += 1;
        if (entriesSeen > limits.maxEntries) {
          throw new Error(`Source entry-count limit exceeded (maxEntries: ${limits.maxEntries})`);
        }
        collected.push(entry);
      }
    } finally {
      await directoryHandle.close().catch(() => undefined);
    }

    collected.sort((left, right) =>
      compareCanonicalPaths(left.name, right.name),
    );
    return collected;
  }

  async function walk(directory: string, depth: number): Promise<void> {
    const entries = await readBoundedDirectoryEntries(directory);

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath);

      if (
        path.isAbsolute(relativePath) ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`)
      ) {
        throw new Error("Source path escaped its root");
      }

      const beforeOpen = await lstat(absolutePath, { bigint: true });

      if (beforeOpen.isSymbolicLink()) {
        throw new Error(
          `Symbolic links are not allowed: ${relativePath.split(path.sep).join("/")}`,
        );
      }

      if (beforeOpen.isDirectory()) {
        if (depth + 1 > limits.maxDepth) {
          throw new Error(`Source directory-depth limit exceeded (maxDepth: ${limits.maxDepth})`);
        }
        await walk(absolutePath, depth + 1);
        continue;
      }

      if (!beforeOpen.isFile() || path.extname(entry.name) !== ".rs") {
        continue;
      }

      const canonicalPath = relativePath.split(path.sep).join("/");

      if (files.length >= limits.maxFiles) {
        throw new Error("Source file-count limit exceeded");
      }

      if (beforeOpen.size > BigInt(limits.maxFileBytes)) {
        throw new Error(`Source file too large: ${canonicalPath}`);
      }

      if (totalBytes + Number(beforeOpen.size) > limits.maxTotalBytes) {
        throw new Error("Total source-size limit exceeded");
      }

      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
      const handle = await open(absolutePath, flags);

      try {
        const openedBeforeRead = await handle.stat({ bigint: true });

        if (
          !openedBeforeRead.isFile() ||
          !hasSameMetadata(beforeOpen, openedBeforeRead)
        ) {
          throw new Error(`Source file changed while loading: ${canonicalPath}`);
        }

        const permittedBytes = Math.min(
          limits.maxFileBytes,
          limits.maxTotalBytes - totalBytes,
        );
        const chunks: Buffer[] = [];
        let bytesRead = 0;

        while (bytesRead <= permittedBytes) {
          const remainingBytes = permittedBytes - bytesRead;
          const requestedBytes =
            remainingBytes > 0 ? Math.min(64 * 1024, remainingBytes) : 1;
          const chunk = Buffer.allocUnsafe(requestedBytes);
          const result = await handle.read(
            chunk,
            0,
            requestedBytes,
            bytesRead,
          );

          if (result.bytesRead === 0) {
            break;
          }

          chunks.push(chunk.subarray(0, result.bytesRead));
          bytesRead += result.bytesRead;
        }

        const bytes = Buffer.concat(chunks, bytesRead);
        const openedAfterRead = await handle.stat({ bigint: true });
        const pathAfterRead = await lstat(absolutePath, { bigint: true });

        if (
          !hasSameMetadata(openedBeforeRead, openedAfterRead) ||
          !pathAfterRead.isFile() ||
          !hasSameMetadata(openedAfterRead, pathAfterRead) ||
          bytes.byteLength !== Number(openedAfterRead.size)
        ) {
          throw new Error(`Source file changed while loading: ${canonicalPath}`);
        }

        if (bytes.byteLength > limits.maxFileBytes) {
          throw new Error(`Source file too large: ${canonicalPath}`);
        }

        if (totalBytes + bytes.byteLength > limits.maxTotalBytes) {
          throw new Error("Total source-size limit exceeded");
        }

        let content: string;
        try {
          content = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes);
        } catch (error) {
          throw new Error(`Source file is not valid UTF-8: ${canonicalPath}`, {
            cause: error,
          });
        }

        const lineCount = countPhysicalLines(content);
        const fileHash = sha256(bytes);

        files.push(
          Object.freeze({
            path: canonicalPath,
            content,
            byteLength: bytes.byteLength,
            lineCount,
          }),
        );
        manifestEntries.push(
          Object.freeze({
            path: canonicalPath,
            sha256: fileHash,
            byteLength: bytes.byteLength,
            lineCount,
          }),
        );
        totalBytes += bytes.byteLength;
      } finally {
        await handle.close();
      }
    }
  }

  await walk(root, 0);

  manifestEntries.sort((left, right) =>
    compareCanonicalPaths(left.path, right.path),
  );
  files.sort((left, right) => compareCanonicalPaths(left.path, right.path));

  const { fileManifestHash, sourceHash } =
    calculateManifestHashes(schemaVersion, manifestEntries);
  const parsedManifest = SourceManifestSchema.parse({
    schemaVersion,
    files: manifestEntries,
    fileManifestHash,
    sourceHash,
  });
  const manifest = Object.freeze({
    ...parsedManifest,
    files: Object.freeze(
      parsedManifest.files.map((entry) => Object.freeze(entry)),
    ),
  });

  return Object.freeze({
    root,
    files: Object.freeze(files),
    totalBytes,
    manifest,
  });
}
