export interface LineHighlightTarget {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export function splitPhysicalLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r\n|\r|\n/);
  if (content.endsWith("\n") || content.endsWith("\r")) {
    lines.pop();
  }
  return lines;
}

export function countPhysicalLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  const terminators = content.match(/\r\n|\r|\n/g)?.length ?? 0;
  const endsWithTerminator = content.endsWith("\n") || content.endsWith("\r");
  return terminators + (endsWithTerminator ? 0 : 1);
}

export function isLineHighlighted(
  lineNumber: number,
  activeFilePath: string,
  highlight: LineHighlightTarget | null,
): boolean {
  if (!highlight || highlight.path !== activeFilePath) {
    return false;
  }
  if (highlight.startLine < 1 || highlight.endLine < highlight.startLine) {
    return false;
  }
  return lineNumber >= highlight.startLine && lineNumber <= highlight.endLine;
}
