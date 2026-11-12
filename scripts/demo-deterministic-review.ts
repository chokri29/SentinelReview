import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSource } from "../src/source/load-source.js";
import {
  buildDeterministicDemoReport,
  formatDeterministicDemoReport,
} from "../src/demo/deterministic-review.js";

type FixtureName = "triggering" | "safe";

function fixtureDirectory(name: FixtureName): string {
  return fileURLToPath(
    new URL(
      name === "safe"
        ? "../demo-fixtures/callback-safe/"
        : "../demo-fixtures/callback-unguarded/",
      import.meta.url,
    ),
  );
}

export async function runDeterministicDemoCli(
  args: readonly string[],
  writeOutput: (output: string) => void,
  writeError: (output: string) => void,
): Promise<number> {
  const selected = args[0] ?? "triggering";
  if (args.length > 1 || (selected !== "triggering" && selected !== "safe")) {
    writeError("Usage: npm run demo:deterministic [triggering|safe]\n");
    return 2;
  }

  try {
    const fixtureName = selected as FixtureName;
    const snapshot = await loadSource(resolve(fixtureDirectory(fixtureName)));
    const report = buildDeterministicDemoReport(snapshot);
    writeOutput(formatDeterministicDemoReport(report));
    return 0;
  } catch {
    writeError("Deterministic demo failed while loading or analyzing its local fixture.\n");
    return 1;
  }
}

async function main(): Promise<void> {
  const exitCode = await runDeterministicDemoCli(
    process.argv.slice(2),
    (output) => process.stdout.write(output),
    (output) => process.stderr.write(output),
  );
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main().catch(() => {
    process.stderr.write("Deterministic demo failed during CLI execution.\n");
    process.exitCode = 1;
  });
}
