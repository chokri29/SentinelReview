import {
      lstat,
        readFile,
          realpath,
            readdir,
            } from "node:fs/promises";
            import path from "node:path";

            export interface SourceFile {
              path: string;
                content: string;
                  byteLength: number;
                    lineCount: number;
                    }

                    export interface SourceLoadOptions {
                      maxFiles?: number;
                        maxFileBytes?: number;
                          maxTotalBytes?: number;
                          }

                          export interface SourceLoadResult {
                            root: string;
                              files: SourceFile[];
                                totalBytes: number;
                                }

                                const DEFAULT_LIMITS = {
                                  maxFiles: 200,
                                    maxFileBytes: 1024 * 1024,
                                      maxTotalBytes: 5 * 1024 * 1024,
                                      };

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

                                                                    if (
                                                                        !requestedRootStat.isDirectory() ||
                                                                            requestedRootStat.isSymbolicLink()
                                                                              ) {
                                                                                  throw new Error("Source root must be a real directory");
                                                                                    }

                                                                                      const root = await realpath(requestedRoot);

                                                                                        const files: SourceFile[] = [];
                                                                                          let totalBytes = 0;

                                                                                            async function walk(directory: string): Promise<void> {
                                                                                                const entries = await readdir(directory, { withFileTypes: true });

                                                                                                    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));

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

                                                                                                                                                                            const stat = await lstat(absolutePath);

                                                                                                                                                                                  if (stat.isSymbolicLink()) {
                                                                                                                                                                                          throw new Error(`Symbolic links are not allowed: ${relativePath}`);
                                                                                                                                                                                                }

                                                                                                                                                                                                      if (stat.isDirectory()) {
                                                                                                                                                                                                              await walk(absolutePath);
                                                                                                                                                                                                                      continue;
                                                                                                                                                                                                                            }

                                                                                                                                                                                                                                  if (!stat.isFile() || path.extname(entry.name) !== ".rs") {
                                                                                                                                                                                                                                          continue;
                                                                                                                                                                                                                                                }

                                                                                                                                                                                                                                                      if (files.length >= limits.maxFiles) {
                                                                                                                                                                                                                                                              throw new Error("Source file-count limit exceeded");
                                                                                                                                                                                                                                                                    }

                                                                                                                                                                                                                                                                          if (stat.size > limits.maxFileBytes) {
                                                                                                                                                                                                                                                                                  throw new Error(`Source file too large: ${relativePath}`);
                                                                                                                                                                                                                                                                                        }

                                                                                                                                                                                                                                                                                              if (totalBytes + stat.size > limits.maxTotalBytes) {
                                                                                                                                                                                                                                                                                                      throw new Error("Total source-size limit exceeded");
                                                                                                                                                                                                                                                                                                            }

                                                                                                                                                                                                                                                                                                                  const content = await readFile(absolutePath, "utf8");
                                                                                                                                                                                                                                                                                                                        const byteLength = Buffer.byteLength(content, "utf8");

                                                                                                                                                                                                                                                                                                                              if (byteLength !== stat.size) {
                                                                                                                                                                                                                                                                                                                                      throw new Error(`Source file changed while loading: ${relativePath}`);
                                                                                                                                                                                                                                                                                                                                            }

                                                                                                                                                                                                                                                                                                                                                  files.push({
                                                                                                                                                                                                                                                                                                                                                          path: relativePath.split(path.sep).join("/"),
                                                                                                                                                                                                                                                                                                                                                                  content,
                                                                                                                                                                                                                                                                                                                                                                          byteLength,
                                                                                                                                                                                                                                                                                                                                                                                  lineCount: content.length === 0
                                                                                                                                                                                                                                                                                                                                                                                            ? 0
                                                                                                                                                                                                                                                                                                                                                                                                      : content.split(/\r\n|\r|\n/).length,
                                                                                                                                                                                                                                                                                                                                                                                                            });

                                                                                                                                                                                                                                                                                                                                                                                                                  totalBytes += byteLength;
                                                                                                                                                                                                                                                                                                                                                                                                                      }
                                                                                                                                                                                                                                                                                                                                                                                                                        }

                                                                                                                                                                                                                                                                                                                                                                                                                          await walk(root);

                                                                                                                                                                                                                                                                                                                                                                                                                            return {
                                                                                                                                                                                                                                                                                                                                                                                                                                root,
                                                                                                                                                                                                                                                                                                                                                                                                                                    files,
                                                                                                                                                                                                                                                                                                                                                                                                                                        totalBytes,
                                                                                                                                                                                                                                                                                                                                                                                                                                          };
                                                                                                                                                                                                                                                                                                                                                                                                                                          }
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            