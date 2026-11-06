import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import {
  schemaVersion,
  SourceManifestSchema,
  type SourceManifest,
} from "../contracts/v1.js";

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
};

const FILE_MANIFEST_DOMAIN = "SentinelReview:file-manifest:v1\0";
const SOURCE_MANIFEST_DOMAIN = "SentinelReview:source:v1\0";

function hashWithDomain(domain: string, value: string): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

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

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCanonicalPaths(left.name, right.name));

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
        await walk(absolutePath);
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
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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

  await walk(root);

  manifestEntries.sort((left, right) =>
    compareCanonicalPaths(left.path, right.path),
  );
  files.sort((left, right) => compareCanonicalPaths(left.path, right.path));

  const fileManifestHash = hashWithDomain(
    FILE_MANIFEST_DOMAIN,
    JSON.stringify(manifestEntries),
  );
  const sourceHash = hashWithDomain(
    SOURCE_MANIFEST_DOMAIN,
    JSON.stringify({ schemaVersion, fileManifestHash }),
  );
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
