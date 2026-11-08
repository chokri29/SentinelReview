import { parser } from "@lezer/rust";

export type RustSyntaxNode = ReturnType<typeof parser.parse>["topNode"];

export interface RustParseResult {
  readonly root: RustSyntaxNode;
  readonly syntaxErrorCount: number;
}

export function parseRust(source: string): RustParseResult {
  const tree = parser.parse(source);
  let syntaxErrorCount = 0;

  tree.iterate({
    enter(node) {
      if (node.type.isError) {
        syntaxErrorCount += 1;
      }
    },
  });

  return Object.freeze({
    root: tree.topNode,
    syntaxErrorCount,
  });
}
