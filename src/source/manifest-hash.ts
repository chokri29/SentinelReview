import { createHash } from "node:crypto";
import type { SourceManifest } from "../contracts/v1.js";

const FILE_MANIFEST_DOMAIN = "SentinelReview:file-manifest:v1\0";
const SOURCE_MANIFEST_DOMAIN = "SentinelReview:source:v1\0";

type SourceManifestFile = SourceManifest["files"][number];

function hashWithDomain(domain: string, value: string): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function calculateManifestHashes(
  schemaVersion: SourceManifest["schemaVersion"],
  files: readonly SourceManifestFile[],
): { fileManifestHash: string; sourceHash: string } {
  const serializedFiles = files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    byteLength: file.byteLength,
    lineCount: file.lineCount,
  }));
  const fileManifestHash = hashWithDomain(
    FILE_MANIFEST_DOMAIN,
    JSON.stringify(serializedFiles),
  );
  const sourceHash = hashWithDomain(
    SOURCE_MANIFEST_DOMAIN,
    JSON.stringify({ schemaVersion, fileManifestHash }),
  );

  return { fileManifestHash, sourceHash };
}
