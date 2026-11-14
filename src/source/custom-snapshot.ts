import { createHash } from "node:crypto";
import path from "node:path";
import {
  schemaVersion,
  SourceManifestSchema,
  type SourceManifest,
} from "../contracts/v1.js";
import type {
  SourceFile,
  SourceLoadOptions,
  SourceLoadResult,
} from "./load-source.js";
import { calculateManifestHashes } from "./manifest-hash.js";

export interface CustomSourceEntry {
  readonly path: string;
  readonly content: string;
}

const DEFAULT_CUSTOM_LIMITS = {
  maxFiles: 200,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function normalizeCanonicalRustPath(rawPath: string): string {
  if (typeof rawPath !== "string") {
    throw new Error("File path must be a string.");
  }
  if (rawPath !== rawPath.trim()) {
    throw new Error("File path must not have leading or trailing whitespace.");
  }
  if (rawPath.length === 0 || rawPath.length > 1024) {
    throw new Error("File path must be between 1 and 1024 characters.");
  }
  if (rawPath.includes("\0")) {
    throw new Error("File path contains invalid null bytes.");
  }
  if (rawPath.includes("\\")) {
    throw new Error("File path must use forward slashes (POSIX canonical format).");
  }
  if (rawPath.startsWith("/") || /^[a-zA-Z]:/.test(rawPath)) {
    throw new Error(`Absolute file paths are not allowed: ${rawPath}`);
  }

  const segments = rawPath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Invalid path segment in file path: ${rawPath}`);
  }

  if (path.posix.extname(rawPath) !== ".rs") {
    throw new Error(`Only Rust (.rs) source files are supported: ${rawPath}`);
  }

  return rawPath;
}

function validateUtf8Content(content: string, canonicalPath: string): Buffer {
  if (typeof content !== "string") {
    throw new Error(`Source file content must be a string: ${canonicalPath}`);
  }
  if (content.includes("\0")) {
    throw new Error(`Source file contains unsafe null bytes: ${canonicalPath}`);
  }

  const bytes = Buffer.from(content, "utf8");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch (error) {
    throw new Error(`Source file is not valid UTF-8: ${canonicalPath}`, {
      cause: error,
    });
  }

  if (decoded !== content) {
    throw new Error(
      `Source file is not a reversible UTF-8 representation: ${canonicalPath}`,
    );
  }

  return bytes;
}

export function createSnapshotFromEntries(
  entries: readonly CustomSourceEntry[],
  options: Pick<SourceLoadOptions, "maxFiles" | "maxFileBytes" | "maxTotalBytes"> = {},
): SourceLoadResult {
  const limits = { ...DEFAULT_CUSTOM_LIMITS, ...options };

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid source limit: ${name}`);
    }
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Provide at least one Rust (.rs) source file.");
  }
  if (entries.length > limits.maxFiles) {
    throw new Error(
      `Source file-count limit exceeded (maxFiles: ${limits.maxFiles}).`,
    );
  }

  const files: SourceFile[] = [];
  const manifestEntries: SourceManifest["files"][number][] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Each source entry must be an object with path and content.");
    }

    const canonicalPath = normalizeCanonicalRustPath(entry.path);
    if (seenPaths.has(canonicalPath)) {
      throw new Error(`Duplicate Rust file path in snapshot: ${canonicalPath}`);
    }
    seenPaths.add(canonicalPath);

    const bytes = validateUtf8Content(entry.content, canonicalPath);
    if (bytes.byteLength > limits.maxFileBytes) {
      throw new Error(
        `Source file too large (${limits.maxFileBytes} byte limit): ${canonicalPath}`,
      );
    }

    totalBytes += bytes.byteLength;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(
        `Total source-size limit exceeded (${limits.maxTotalBytes} bytes).`,
      );
    }

    const lineCount = countPhysicalLines(entry.content);
    const fileHash = sha256(bytes);

    files.push(
      Object.freeze({
        path: canonicalPath,
        content: entry.content,
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
  }

  manifestEntries.sort((left, right) =>
    compareCanonicalPaths(left.path, right.path),
  );
  files.sort((left, right) => compareCanonicalPaths(left.path, right.path));

  const { fileManifestHash, sourceHash } = calculateManifestHashes(
    schemaVersion,
    manifestEntries,
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
      parsedManifest.files.map((item) => Object.freeze(item)),
    ),
  });

  return Object.freeze({
    root: "custom-snapshot",
    files: Object.freeze(files),
    totalBytes,
    manifest,
  });
}
