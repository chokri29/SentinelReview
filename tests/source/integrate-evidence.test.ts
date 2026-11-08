import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Evidence, Finding } from "../../src/contracts/v1.js";
import type { SourceLoadResult } from "../../src/source/load-source.js";
import { loadSource } from "../../src/source/load-source.js";
import { integrateEvidence } from "../../src/source/integrate-evidence.js";

const EXCERPT_HASH_DOMAIN = "SentinelReview:evidence-excerpt:v1\0";

describe("integrateEvidence", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "integrate-evidence-"),
    );
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  async function loadSnapshot(
    files: readonly (readonly [string, string | Uint8Array])[] = [
      ["lib.rs", "first\nsecond"],
    ],
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
    evidenceId = "evidence-1",
    overrides: Partial<Evidence> = {},
  ): Evidence {
    return {
      evidenceId,
      sourceHash: snapshot.manifest.sourceHash,
      path: "lib.rs",
      startLine: 1,
      endLine: 1,
      producer: "ai_hypothesis",
      validationStatus: "invalid",
      excerptHash: expectedExcerptHash(["first"]),
      ...overrides,
    };
  }

  function makeFinding(
    evidenceIds: readonly string[],
    overrides: Partial<Finding> = {},
  ): Finding {
    return {
      findingId: "finding-1",
      origin: "ai_hypothesis",
      severity: "high",
      title: "Potential issue",
      rationale: "Evidence supports further review.",
      evidenceRefs: evidenceIds.map((evidenceId) => ({ evidenceId })),
      limitations: [],
      ...overrides,
    };
  }

  function expectedExcerptHash(lines: readonly string[]): string {
    return createHash("sha256")
      .update(EXCERPT_HASH_DOMAIN, "utf8")
      .update(lines.join("\n"), "utf8")
      .digest("hex");
  }

  it("validates one evidence record and resolves its finding reference", async () => {
    const snapshot = await loadSnapshot();
    const evidence = makeEvidence(snapshot);
    const finding = makeFinding(["evidence-1"]);

    const result = integrateEvidence([evidence], [finding], snapshot);

    expect(result.status).toBe("complete");
    expect(result.evidenceEntries[0]?.validation.status).toBe("validated");
    expect(result.findings[0]?.evidenceRefs[0]).toMatchObject({
      evidenceRef: { evidenceId: "evidence-1" },
      status: "resolved",
      evidenceEntry: { evidence, validation: { status: "validated" } },
    });
    expect(result.issues).toEqual([]);
  });

  it("integrates multiple evidence records and findings in input order", async () => {
    const snapshot = await loadSnapshot([
      ["a.rs", "first"],
      ["lib.rs", "first\nsecond"],
    ]);
    const firstEvidence = makeEvidence(snapshot, "evidence-a", { path: "a.rs" });
    const secondEvidence = makeEvidence(snapshot, "evidence-b");
    const firstFinding = makeFinding(["evidence-b"], {
      findingId: "finding-b",
    });
    const secondFinding = makeFinding(["evidence-a"], {
      findingId: "finding-a",
    });

    const result = integrateEvidence(
      [firstEvidence, secondEvidence],
      [firstFinding, secondFinding],
      snapshot,
    );

    expect(result.status).toBe("complete");
    expect(result.evidenceEntries.map(({ evidence }) => evidence.evidenceId))
      .toEqual(["evidence-a", "evidence-b"]);
    expect(result.findings.map(({ finding }) => finding.findingId)).toEqual([
      "finding-b",
      "finding-a",
    ]);
    expect(result.findings.map(({ evidenceRefs }) => evidenceRefs[0]?.status))
      .toEqual(["resolved", "resolved"]);
  });

  it("marks missing references invalid and adds a structured issue", async () => {
    const snapshot = await loadSnapshot();
    const result = integrateEvidence(
      [],
      [makeFinding(["missing-id"])],
      snapshot,
    );

    expect(result.status).toBe("invalid");
    expect(result.findings[0]?.evidenceRefs[0]?.status).toBe("missing");
    expect(result.issues).toEqual([
      {
        code: "missing_evidence_reference",
        evidenceId: "missing-id",
        findingId: "finding-1",
        message: "Finding references an evidence ID that does not exist.",
      },
    ]);
  });

  it("detects duplicate IDs without overwriting evidence entries", async () => {
    const snapshot = await loadSnapshot();
    const first = makeEvidence(snapshot, "same-id");
    const second = makeEvidence(snapshot, "same-id", { startLine: 2, endLine: 2 });

    const result = integrateEvidence([first, second], [], snapshot);

    expect(result.status).toBe("invalid");
    expect(result.evidenceEntries.map(({ evidence }) => evidence)).toEqual([
      first,
      second,
    ]);
    expect(result.evidenceById["same-id"]).toHaveLength(2);
    expect(result.evidenceEntries.map(({ validation }) => validation.status))
      .toEqual(["validated", "invalid"]);
    expect(result.issues[0]?.code).toBe("duplicate_evidence_id");
  });

  it("marks references to duplicate IDs ambiguous", async () => {
    const snapshot = await loadSnapshot();
    const result = integrateEvidence(
      [makeEvidence(snapshot, "same-id"), makeEvidence(snapshot, "same-id")],
      [makeFinding(["same-id"])],
      snapshot,
    );

    expect(result.status).toBe("invalid");
    expect(result.findings[0]?.evidenceRefs[0]?.status).toBe("ambiguous");
    expect(result.issues.map(({ code }) => code)).toEqual([
      "duplicate_evidence_id",
      "ambiguous_evidence_reference",
    ]);
  });

  it("returns partial when an evidence excerpt hash is absent", async () => {
    const snapshot = await loadSnapshot();
    const result = integrateEvidence(
      [makeEvidence(snapshot, "partial", { excerptHash: undefined })],
      [],
      snapshot,
    );

    expect(result.status).toBe("partial");
    expect(result.evidenceEntries[0]?.validation.status).toBe("partial");
  });

  it("returns invalid for an evidence excerpt hash mismatch", async () => {
    const snapshot = await loadSnapshot();
    const result = integrateEvidence(
      [makeEvidence(snapshot, "invalid", { excerptHash: "0".repeat(64) })],
      [],
      snapshot,
    );

    expect(result.status).toBe("invalid");
    expect(result.evidenceEntries[0]?.validation.status).toBe("invalid");
    expect(result.evidenceEntries[0]?.validation.issues[0]?.code)
      .toBe("excerpt_hash_mismatch");
  });

  it("returns partial when the snapshot is unavailable", async () => {
    const snapshot = await loadSnapshot();
    const result = integrateEvidence([makeEvidence(snapshot)], [], undefined);

    expect(result.status).toBe("partial");
    expect(result.evidenceEntries[0]?.validation.status).toBe("unavailable");
  });

  it("preserves ai_hypothesis origin and the original severity", async () => {
    const snapshot = await loadSnapshot();
    const finding = makeFinding(["evidence-1"], {
      origin: "ai_hypothesis",
      severity: "critical",
    });

    const result = integrateEvidence(
      [makeEvidence(snapshot)],
      [finding],
      snapshot,
    );

    expect(result.findings[0]?.finding).not.toBe(finding);
    expect(result.findings[0]?.finding).toEqual(finding);
    expect(result.findings[0]?.finding.origin).toBe("ai_hypothesis");
    expect(result.findings[0]?.finding.severity).toBe("critical");
  });

  it("calculates validation independently of incoming validationStatus", async () => {
    const snapshot = await loadSnapshot();
    const falselyValidated = makeEvidence(snapshot, "false-positive", {
      validationStatus: "validated",
      sourceHash: "0".repeat(64),
    });
    const validMarkedInvalid = makeEvidence(snapshot, "valid-marked-invalid", {
      validationStatus: "invalid",
    });

    const result = integrateEvidence(
      [falselyValidated, validMarkedInvalid],
      [],
      snapshot,
    );

    expect(result.evidenceEntries.map(({ validation }) => validation.status))
      .toEqual(["invalid", "validated"]);
    expect(result.status).toBe("invalid");
  });

  it("returns a complete result for empty inputs when a snapshot is available", async () => {
    const snapshot = await loadSnapshot();
    const result = integrateEvidence([], [], snapshot);

    expect(result.status).toBe("complete");
    expect(result.evidenceEntries).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("does not mutate inputs and freezes returned structures", async () => {
    const snapshot = await loadSnapshot();
    const evidence = makeEvidence(snapshot, "evidence-1", {
      excerptHash: "0".repeat(64),
    });
    const finding = makeFinding(["missing-evidence"]);
    const snapshotBefore = structuredClone(snapshot);
    const evidenceBefore = structuredClone(evidence);
    const findingBefore = structuredClone(finding);

    const result = integrateEvidence([evidence], [finding], snapshot);

    expect(result.status).toBe("invalid");
    expect(evidence).toEqual(evidenceBefore);
    expect(finding).toEqual(findingBefore);
    expect(snapshot).toEqual(snapshotBefore);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidenceEntries)).toBe(true);
    expect(Object.isFrozen(result.evidenceEntries[0])).toBe(true);
    expect(Object.isFrozen(result.evidenceEntries[0]?.validation)).toBe(true);
    expect(Object.isFrozen(result.evidenceEntries[0]?.validation.checks)).toBe(
      true,
    );
    expect(Object.isFrozen(result.evidenceEntries[0]?.validation.issues)).toBe(
      true,
    );
    expect(
      Object.isFrozen(result.evidenceEntries[0]?.validation.issues[0]),
    ).toBe(true);
    expect(Object.isFrozen(result.evidenceEntries[0]?.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidenceById)).toBe(true);
    expect(Object.isFrozen(result.evidenceById["evidence-1"])).toBe(true);
    expect(Object.isFrozen(result.findings)).toBe(true);
    expect(Object.isFrozen(result.findings[0])).toBe(true);
    expect(Object.isFrozen(result.findings[0]?.finding)).toBe(true);
    expect(
      Object.isFrozen(result.findings[0]?.finding.evidenceRefs),
    ).toBe(true);
    expect(Object.isFrozen(result.findings[0]?.evidenceRefs)).toBe(true);
    expect(Object.isFrozen(result.findings[0]?.evidenceRefs[0])).toBe(true);
    expect(
      Object.isFrozen(result.findings[0]?.finding.evidenceRefs[0]),
    ).toBe(true);
    expect(Object.isFrozen(result.issues)).toBe(true);
    expect(Object.isFrozen(result.issues[0])).toBe(true);
    expect(result.evidenceEntries[0]?.evidence).not.toBe(evidence);
    expect(result.findings[0]?.finding).not.toBe(finding);
    expect(
      Reflect.set(result.evidenceEntries[0]!.evidence, "path", "changed.rs"),
    ).toBe(false);
    expect(
      Reflect.set(result.findings[0]!.finding, "title", "changed"),
    ).toBe(false);
    expect(
      Reflect.set(
        result.findings[0]!.finding.evidenceRefs[0]!,
        "evidenceId",
        "changed",
      ),
    ).toBe(false);
    expect(Object.isFrozen(evidence)).toBe(false);
    expect(Object.isFrozen(finding)).toBe(false);
  });

  it("preserves ordering and produces consistent results across repeated calls", async () => {
    const snapshot = await loadSnapshot();
    const evidence = [
      makeEvidence(snapshot, "second", { startLine: 2, endLine: 2 }),
      makeEvidence(snapshot, "first"),
    ];
    const findings = [
      makeFinding(["first", "missing"], { findingId: "second-finding" }),
      makeFinding(["second"], { findingId: "first-finding" }),
    ];

    const first = integrateEvidence(evidence, findings, snapshot);
    const second = integrateEvidence(evidence, findings, snapshot);

    expect(first).toEqual(second);
    expect(first.evidenceEntries.map(({ evidence: item }) => item.evidenceId))
      .toEqual(["second", "first"]);
    expect(first.findings.map(({ finding }) => finding.findingId)).toEqual([
      "second-finding",
      "first-finding",
    ]);
    expect(first.findings[0]?.evidenceRefs.map(({ status }) => status)).toEqual([
      "resolved",
      "missing",
    ]);
  });

  it("gives invalid status precedence over partial evidence", async () => {
    const snapshot = await loadSnapshot();
    const result = integrateEvidence(
      [
        makeEvidence(snapshot, "partial", { excerptHash: undefined }),
        makeEvidence(snapshot, "invalid", { excerptHash: "0".repeat(64) }),
      ],
      [],
      snapshot,
    );

    expect(result.status).toBe("invalid");
  });

  it("gives partial status precedence over complete evidence", async () => {
    const snapshot = await loadSnapshot();
    const result = integrateEvidence(
      [
        makeEvidence(snapshot, "complete"),
        makeEvidence(snapshot, "partial", { excerptHash: undefined }),
      ],
      [],
      snapshot,
    );

    expect(result.status).toBe("partial");
  });
});
