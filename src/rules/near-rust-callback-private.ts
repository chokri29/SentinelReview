import { createHash } from "node:crypto";
import {
  type AnalysisResult,
  type Evidence,
  type Finding,
} from "../contracts/v1.js";
import type { SourceLoadResult, SourceFile } from "../source/load-source.js";
import { parseRust, type RustSyntaxNode } from "./parse-rust.js";

const RULE_ID = "NEAR-RUST-CALLBACK-PRIVATE-001";
const EVIDENCE_HASH_DOMAIN = "SentinelReview:evidence-excerpt:v1\0";
const EVIDENCE_ID_DOMAIN = "SentinelReview:rule-evidence:v1\0";
const FINDING_ID_DOMAIN = "SentinelReview:rule-finding:v1\0";

type ImmutableFinding = Readonly<
  Omit<Finding, "evidenceRefs" | "limitations">
> & {
  readonly evidenceRefs: readonly Readonly<Finding["evidenceRefs"][number]>[];
  readonly limitations: readonly string[];
};

export interface NearRustCallbackPrivateRuleResult {
  readonly deterministicAnalysis: Omit<
    AnalysisResult["deterministicAnalysis"],
    "findings" | "toolchain"
  > & {
    readonly toolchain: readonly string[];
    readonly findings: readonly ImmutableFinding[];
  };
  readonly evidence: readonly Readonly<Evidence>[];
  readonly limitations: readonly string[];
}

interface MethodDeclaration {
  readonly node: RustSyntaxNode;
  readonly wrapper: RustSyntaxNode;
  readonly attributes: readonly RustSyntaxNode[];
}

interface MethodEvidenceLocation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

function children(node: RustSyntaxNode): RustSyntaxNode[] {
  const result: RustSyntaxNode[] = [];

  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    result.push(child);
  }

  return result;
}

function nodeText(source: string, node: RustSyntaxNode): string {
  return source.slice(node.from, node.to);
}

function attributeName(
  source: string,
  node: RustSyntaxNode,
): string | undefined {
  if (node.name !== "Attribute") {
    return undefined;
  }

  const metaItem = children(node).find((child) => child.name === "MetaItem");
  return metaItem === undefined ? undefined : nodeText(source, metaItem).trim();
}

function isNearImplAttribute(name: string | undefined): boolean {
  return (
    name === "near" ||
    name === "near_bindgen" ||
    name === "near_sdk::near" ||
    name === "near_sdk::near_bindgen"
  );
}

function isPrivateAttribute(name: string | undefined): boolean {
  return name === "private" || name === "near_sdk::private";
}

function isCallbackResultAttribute(name: string | undefined): boolean {
  return (
    name === "callback_result" ||
    name === "near_sdk::callback_result"
  );
}

function methodDeclaration(node: RustSyntaxNode): MethodDeclaration | undefined {
  if (node.name === "FunctionItem") {
    return { node, wrapper: node, attributes: [] };
  }

  if (node.name !== "AttributeItem") {
    return undefined;
  }

  const nodeChildren = children(node);
  const method = nodeChildren.find((child) => child.name === "FunctionItem");
  if (method === undefined) {
    return undefined;
  }

  return {
    node: method,
    wrapper: node,
    attributes: nodeChildren.filter((child) => child.name === "Attribute"),
  };
}

function hasCallbackResultParameter(
  source: string,
  method: RustSyntaxNode,
): boolean {
  const parameterList = children(method).find(
    (child) => child.name === "ParamList",
  );
  return (
    parameterList !== undefined &&
    children(parameterList).some((child) =>
      isCallbackResultAttribute(attributeName(source, child)),
    )
  );
}

function isCallTo(
  source: string,
  node: RustSyntaxNode,
  functionPath: string,
): boolean {
  if (node.name !== "CallExpression") {
    return false;
  }

  const callee = children(node).find(
    (child) =>
      child.name === "ScopedIdentifier" || child.name === "Identifier",
  );
  const argumentsNode = children(node).find(
    (child) => child.name === "ArgList",
  );
  return (
    callee !== undefined &&
    argumentsNode !== undefined &&
    nodeText(source, callee) === functionPath
  );
}

function hasOneCallArgument(
  node: RustSyntaxNode,
): boolean {
  const argumentsNode = children(node).find(
    (child) => child.name === "ArgList",
  );
  if (argumentsNode === undefined) {
    return false;
  }

  const argumentsCount = children(argumentsNode).filter(
    (child) =>
      child.name !== "(" &&
      child.name !== ")" &&
      child.name !== "," &&
      child.name !== "LineComment" &&
      child.name !== "BlockComment",
  ).length;
  return argumentsCount === 1;
}

function isPredecessorOrCurrentCall(
  source: string,
  node: RustSyntaxNode,
  functionPath: string,
): boolean {
  if (!isCallTo(source, node, functionPath)) {
    return false;
  }

  const argumentsNode = children(node).find(
    (child) => child.name === "ArgList",
  );
  return (
    argumentsNode !== undefined &&
    children(argumentsNode).every(
      (child) => child.name === "(" || child.name === ")",
    )
  );
}

function isDirectFailClosedManualGuard(
  source: string,
  method: RustSyntaxNode,
): boolean {
  const body = children(method).find((child) => child.name === "Block");
  if (body === undefined) {
    return false;
  }

  const bodyStatements = children(body).filter(
    (child) =>
      child.name !== "{" &&
      child.name !== "}" &&
      child.name !== "InnerAttribute" &&
      child.name !== "LineComment" &&
      child.name !== "BlockComment",
  );
  const firstStatement = bodyStatements[0];
  if (firstStatement?.name !== "ExpressionStatement") {
    return false;
  }

  const ifExpression = children(firstStatement).find(
    (child) => child.name === "IfExpression",
  );
  if (ifExpression === undefined) {
    return false;
  }

  const ifChildren = children(ifExpression);
  const condition = ifChildren.find(
    (child) => child.name === "BinaryExpression",
  );
  const rejectionBlock = ifChildren.find((child) => child.name === "Block");
  if (
    condition === undefined ||
    rejectionBlock === undefined ||
    ifChildren.some((child) => child.name === "_else")
  ) {
    return false;
  }

  const conditionChildren = children(condition);
  const leftCall = conditionChildren.find(
    (child) => child.name === "CallExpression",
  );
  const comparison = conditionChildren.find(
    (child) => child.name === "CompareOp",
  );
  const rightCall = conditionChildren
    .filter((child) => child.name === "CallExpression")
    .at(1);
  const predecessorPath = "env::predecessor_account_id";
  const currentPath = "env::current_account_id";
  const validOrder =
    leftCall !== undefined &&
    rightCall !== undefined &&
    ((isPredecessorOrCurrentCall(source, leftCall, predecessorPath) &&
      isPredecessorOrCurrentCall(source, rightCall, currentPath)) ||
      (isPredecessorOrCurrentCall(source, leftCall, currentPath) &&
        isPredecessorOrCurrentCall(source, rightCall, predecessorPath)));

  if (
    !validOrder ||
    comparison === undefined ||
    nodeText(source, comparison) !== "!="
  ) {
    return false;
  }

  const rejectionStatements = children(rejectionBlock).filter(
    (child) =>
      child.name !== "{" &&
      child.name !== "}" &&
      child.name !== "LineComment" &&
      child.name !== "BlockComment",
  );
  if (rejectionStatements.length !== 1) {
    return false;
  }

  const rejectionStatement = rejectionStatements[0]!;
  const panicCall =
    rejectionStatement.name === "ExpressionStatement"
      ? children(rejectionStatement).find(
          (child) => child.name === "CallExpression",
        )
      : undefined;
  return (
    panicCall !== undefined &&
    isCallTo(source, panicCall, "env::panic_str") &&
    hasOneCallArgument(panicCall)
  );
}

function physicalLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const lines = content.split(/\r\n|\r|\n/);
  if (content.endsWith("\n") || content.endsWith("\r")) {
    lines.pop();
  }
  return lines;
}

function lineAtOffset(content: string, offset: number): number {
  return (content.slice(0, offset).match(/\r\n|\r|\n/g)?.length ?? 0) + 1;
}

function hashExcerpt(
  content: string,
  startLine: number,
  endLine: number,
): string {
  const excerpt = physicalLines(content)
    .slice(startLine - 1, endLine)
    .join("\n");
  return createHash("sha256")
    .update(EVIDENCE_HASH_DOMAIN, "utf8")
    .update(excerpt, "utf8")
    .digest("hex");
}

function hashId(domain: string, parts: readonly string[]): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex");
}

function evidenceForMethod(
  snapshot: SourceLoadResult,
  file: SourceFile,
  method: RustSyntaxNode,
  methodWrapper: RustSyntaxNode,
  endLine: number,
): Readonly<Evidence> {
  const manifestFile = snapshot.manifest.files.find(
    (entry) => entry.path === file.path,
  );
  if (manifestFile === undefined) {
    throw new Error(`Source file is missing from the manifest: ${file.path}`);
  }

  const startLine = lineAtOffset(file.content, methodWrapper.from);
  const evidenceId = `ev-${hashId(EVIDENCE_ID_DOMAIN, [
    RULE_ID,
    file.path,
    manifestFile.sha256,
    String(method.from),
  ])}`;

  return Object.freeze({
    evidenceId,
    sourceHash: snapshot.manifest.sourceHash,
    path: file.path,
    startLine,
    endLine,
    excerptHash: hashExcerpt(file.content, startLine, endLine),
    producer: "deterministic_rule",
    validationStatus: "unavailable",
  });
}

function getMethods(impl: RustSyntaxNode): MethodDeclaration[] {
  const declarationList = children(impl).find(
    (child) => child.name === "DeclarationList",
  );
  if (declarationList === undefined) {
    return [];
  }

  return children(declarationList)
    .map(methodDeclaration)
    .filter((method): method is MethodDeclaration => method !== undefined);
}

function hasPrivateAttribute(
  source: string,
  method: MethodDeclaration,
): boolean {
  return method.attributes.some((attribute) =>
    isPrivateAttribute(attributeName(source, attribute)),
  );
}

function findNearImpls(
  root: RustSyntaxNode,
  source: string,
): RustSyntaxNode[] {
  const matches: RustSyntaxNode[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.name === "AttributeItem") {
      const nodeChildren = children(node);
      const impl = nodeChildren.find((child) => child.name === "ImplItem");
      if (
        impl !== undefined &&
        nodeChildren.some((child) =>
          isNearImplAttribute(attributeName(source, child)),
        )
      ) {
        matches.push(impl);
      }
    }

    pending.push(...children(node).reverse());
  }

  return matches;
}

function locationForMethod(
  file: SourceFile,
  method: RustSyntaxNode,
  methodWrapper: RustSyntaxNode,
): MethodEvidenceLocation {
  return {
    path: file.path,
    startLine: lineAtOffset(file.content, methodWrapper.from),
    endLine: lineAtOffset(file.content, method.to),
  };
}

function makeFinding(
  evidence: Evidence,
  location: MethodEvidenceLocation,
  method: RustSyntaxNode,
  source: string,
): ImmutableFinding {
  const findingId = `finding-${hashId(FINDING_ID_DOMAIN, [
    RULE_ID,
    evidence.evidenceId,
  ])}`;
  const limitations = [
    "This syntactic candidate does not establish exploitability. The rule may miss indirect, helper-based, aliased, or alternative authorization checks.",
  ];

  return Object.freeze({
    findingId,
    origin: "deterministic_rule",
    ruleId: RULE_ID,
    severity: "info",
    title: "Callback-result handler has no recognized access guard.",
    rationale:
      "This NEAR callback-result method has neither a recognized #[private] attribute nor the narrowly supported direct predecessor/current-account fail-closed guard. The rule cannot establish exploitability and does not analyze indirect or alternative authorization checks.",
    evidenceRefs: Object.freeze([
      Object.freeze({ evidenceId: evidence.evidenceId }),
    ]),
    limitations: Object.freeze([
      ...limitations,
      `The candidate is in ${location.path} at lines ${location.startLine}-${location.endLine} (method ${methodNameFromSource(source, method)}).`,
    ]),
  });
}

function methodNameFromSource(
  source: string,
  method: RustSyntaxNode,
): string {
  const name = children(method).find(
    (child) => child.name === "BoundIdentifier",
  );
  return name === undefined ? "unknown" : nodeText(source, name);
}

export function runNearRustCallbackPrivateRule(
  snapshot: SourceLoadResult,
): NearRustCallbackPrivateRuleResult {
  const findings: ImmutableFinding[] = [];
  const evidenceRecords: Readonly<Evidence>[] = [];
  const limitations = [
    "This rule cannot establish exploitability and may miss indirect, helper-based, aliased, or alternative authorization checks.",
  ];
  let hasInconclusiveResult = false;

  for (const file of snapshot.files) {
    const parsed = parseRust(file.content);
    if (parsed.syntaxErrorCount > 0) {
      hasInconclusiveResult = true;
      limitations.push(
        `Rust parsing reported ${parsed.syntaxErrorCount} syntax error node(s) in ${file.path}; no findings were emitted from that file.`,
      );
      continue;
    }

    for (const impl of findNearImpls(parsed.root, file.content)) {
      for (const method of getMethods(impl)) {
        if (
          !hasCallbackResultParameter(file.content, method.node) ||
          hasPrivateAttribute(file.content, method)
        ) {
          continue;
        }

        const methodBody = children(method.node).find(
          (child) => child.name === "Block",
        );
        if (methodBody === undefined) {
          hasInconclusiveResult = true;
          limitations.push(
            `The callback-result declaration in ${file.path} has no method body to inspect.`,
          );
          continue;
        }

        const location = locationForMethod(file, method.node, method.wrapper);

        if (isDirectFailClosedManualGuard(file.content, method.node)) {
          hasInconclusiveResult = true;
          limitations.push(
            `A direct predecessor/current-account guard was recognized in ${location.path}:${location.startLine}; its effectiveness was not verified.`,
          );
          continue;
        }

        const evidence = evidenceForMethod(
          snapshot,
          file,
          method.node,
          method.wrapper,
          location.endLine,
        );
        evidenceRecords.push(evidence);
        findings.push(
          makeFinding(evidence, location, method.node, file.content),
        );
      }
    }
  }

  const status = hasInconclusiveResult
    ? "inconclusive"
    : findings.length > 0
      ? "finding"
      : "passed";

  return Object.freeze({
    deterministicAnalysis: Object.freeze({
      status,
      toolchain: Object.freeze([`${RULE_ID}@1`, "@lezer/rust@1.0.3"]),
      findings: Object.freeze(findings),
    }),
    evidence: Object.freeze(evidenceRecords),
    limitations: Object.freeze(limitations),
  });
}
